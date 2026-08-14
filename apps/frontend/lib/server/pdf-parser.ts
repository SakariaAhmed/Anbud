import "server-only";

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export type PdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
};

type PageRenderer = (
  pageNumber: number,
  items: PdfTextItem[],
) => string | Promise<string>;

type ParsedPdfPages = {
  numpages: number;
  pages: Array<{ page: number; items: PdfTextItem[] }>;
};

const require = createRequire(import.meta.url);
const LEGACY_PARSER_PATH = require.resolve("pdf-parse/lib/pdf-parse.js");
const LEGACY_PARSE_TIMEOUT_MS = 120_000;

const LEGACY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const parse = require(workerData.parserPath);
  const pages = [];
  let pageNumber = 0;
  parse(Buffer.from(workerData.bytes), {
    version: "v1.10.100",
    max: 0,
    pagerender: async (pageData) => {
      pageNumber += 1;
      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      pages.push({
        page: pageNumber,
        items: content.items
          .filter((item) => item && typeof item.str === "string" && Array.isArray(item.transform))
          .map((item) => ({
            str: item.str,
            transform: item.transform,
            width: typeof item.width === "number" ? item.width : undefined,
            height: typeof item.height === "number" ? item.height : undefined,
          })),
      });
      return "";
    },
  }).then(
    (result) => parentPort.postMessage({ ok: true, numpages: result.numpages, pages }),
    (error) => parentPort.postMessage({
      ok: false,
      message: error && error.message ? String(error.message) : "Legacy PDF parsing failed",
    }),
  );
`;

let pdfJsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null =
  null;

async function getPdfJs() {
  pdfJsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfJsPromise;
}

function parseWithIsolatedLegacyWorker(buffer: Buffer): Promise<ParsedPdfPages> {
  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(buffer);
    const worker = new Worker(LEGACY_WORKER_SOURCE, {
      eval: true,
      workerData: { parserPath: LEGACY_PARSER_PATH, bytes },
      transferList: [bytes.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error("Legacy PDF parsing timed out."));
    }, LEGACY_PARSE_TIMEOUT_MS);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    worker.once("message", (message: unknown) => {
      finish(() => {
        const result = message as ParsedPdfPages & {
          ok?: boolean;
          message?: string;
        };
        if (result.ok) {
          resolve({ numpages: result.numpages, pages: result.pages });
        } else {
          reject(new Error(result.message || "Legacy PDF parsing failed."));
        }
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`Legacy PDF worker exited with code ${code}.`)));
      }
    });
  });
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== "object" || !("str" in value)) return false;
  const item = value as {
    str?: unknown;
    transform?: unknown;
    width?: unknown;
    height?: unknown;
  };
  return (
    typeof item.str === "string" &&
    Array.isArray(item.transform) &&
    item.transform.every((part) => typeof part === "number") &&
    (item.width === undefined || typeof item.width === "number") &&
    (item.height === undefined || typeof item.height === "number")
  );
}

async function parseWithModernPdfJs(buffer: Buffer): Promise<ParsedPdfPages> {
  const pdfJs = await getPdfJs();
  const loadingTask = pdfJs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const document = await loadingTask.promise;
    const pages: ParsedPdfPages["pages"] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false,
        });
        pages.push({
          page: pageNumber,
          items: content.items.filter(isPdfTextItem) as PdfTextItem[],
        });
      } finally {
        page.cleanup();
      }
    }
    return { numpages: document.numPages, pages };
  } finally {
    await loadingTask.destroy();
  }
}

function defaultPageText(items: PdfTextItem[]) {
  let previousY: number | undefined;
  let text = "";
  for (const item of items) {
    const y = item.transform[5];
    text += previousY === undefined || previousY === y ? item.str : `\n${item.str}`;
    previousY = y;
  }
  return text;
}

/**
 * Runs the production-compatible parser in a fresh, memory-bounded worker for
 * every document. Unsupported modern PDFs fall back to maintained pdf.js with
 * dynamic code evaluation disabled.
 */
export async function parsePdf(
  buffer: Buffer,
  renderPage: PageRenderer = (_pageNumber, items) => defaultPageText(items),
) {
  let parsed: ParsedPdfPages;
  try {
    parsed = await parseWithIsolatedLegacyWorker(buffer);
  } catch {
    parsed = await parseWithModernPdfJs(buffer);
  }

  const pageTexts: string[] = [];
  for (const page of parsed.pages) {
    pageTexts.push(await renderPage(page.page, page.items));
  }
  return {
    numpages: parsed.numpages,
    text: pageTexts.map((text) => `\n\n${text}`).join(""),
  };
}
