import "server-only";

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PdfTextItem = {
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

// Node workers need filesystem paths, not webpack module IDs. Resolve from the
// running app first (including standalone), repository-root scripts second, and
// the source module for direct imports from another working directory.
const runtimeRequire = process.getBuiltinModule("module").createRequire(import.meta.url);
const parserSearchPaths = [
  process.cwd(),
  path.join(process.cwd(), "apps/frontend"),
  path.dirname(fileURLToPath(import.meta.url)),
];
const LEGACY_PARSER_PATH = runtimeRequire.resolve("pdf-parse/lib/pdf-parse.js", {
  paths: parserSearchPaths,
});
const MODERN_PARSER_PATH = runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs", {
  paths: parserSearchPaths,
});
const CANVAS_PATH = runtimeRequire.resolve("@napi-rs/canvas", {
  paths: parserSearchPaths,
});
const PDF_PARSE_TIMEOUT_MS = 120_000;
const PDF_LIMITS = {
  inputBytes: 25 * 1024 * 1024,
  pages: 2_000,
  items: 250_000,
  textCharacters: 10_000_000,
};

// PDF.js uses a fake worker under Node. Both engines must therefore run inside
// our worker, including imports, extraction, and accumulated output validation.
const PDF_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { pathToFileURL } = require("node:url");
  const { limits } = workerData;
  const pages = [];
  let itemCount = 0;
  let textCharacters = 0;
  let limitError;
  function rejectLimit() {
    limitError = Object.assign(new Error("PDF_RESOURCE_LIMIT"), { code: "PDF_RESOURCE_LIMIT" });
    throw limitError;
  }
  function checkPages(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > limits.pages) rejectLimit();
  }
  function collect(page, items) {
    checkPages(page);
    const accepted = [];
    for (const item of items) {
      if (!item || typeof item.str !== "string" || !Array.isArray(item.transform)) continue;
      // Keep only the six affine coordinates; arbitrary parser metadata must not
      // become an unbounded structured-clone payload in the parent process.
      if (item.transform.length !== 6 || !item.transform.every(Number.isFinite)) continue;
      itemCount += 1;
      textCharacters += item.str.length;
      if (itemCount > limits.items || textCharacters > limits.textCharacters) rejectLimit();
      accepted.push({
        str: item.str,
        transform: item.transform,
        width: typeof item.width === "number" ? item.width : undefined,
        height: typeof item.height === "number" ? item.height : undefined,
      });
    }
    pages.push({ page, items: accepted });
  }
  async function parseLegacy() {
    const parse = require(workerData.parserPath);
    let pageNumber = 0;
    const result = await parse(Buffer.from(workerData.bytes), {
      version: "v1.10.100",
      max: limits.pages + 1,
      pagerender: async (pageData) => {
        if (limitError) throw limitError;
        checkPages(++pageNumber);
        const content = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });
        collect(pageNumber, content.items);
        return "";
      },
    });
    // pdf-parse swallows pagerender failures. Preserve budget failures explicitly.
    if (limitError) throw limitError;
    checkPages(result.numpages);
    return result.numpages;
  }
  async function parseModern() {
    const canvas = require(workerData.canvasPath);
    for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
      if (!(name in globalThis)) globalThis[name] = canvas[name];
    }
    const pdfJs = await import(pathToFileURL(workerData.parserPath).href);
    const loadingTask = pdfJs.getDocument({
      data: workerData.bytes,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    try {
      const document = await loadingTask.promise;
      checkPages(document.numPages);
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent({
            includeMarkedContent: false,
            disableNormalization: false,
          });
          collect(pageNumber, content.items);
        } finally {
          page.cleanup();
        }
      }
      return document.numPages;
    } finally {
      await loadingTask.destroy();
    }
  }
  (workerData.engine === "legacy" ? parseLegacy() : parseModern()).then(
    (numpages) => parentPort.postMessage({ ok: true, numpages, pages }),
    (error) => parentPort.postMessage({
      ok: false,
      name: error && typeof error.name === "string" ? error.name.slice(0, 100) : "Error",
      code: limitError ? "PDF_RESOURCE_LIMIT" : error && error.code,
      message: error && error.message ? String(error.message).slice(0, 500) : "PDF parsing failed",
    }),
  );
`;

class PdfCompatibilityError extends Error {}

function parseWithIsolatedWorker(
  buffer: Buffer,
  engine: "legacy" | "modern",
): Promise<ParsedPdfPages> {
  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(buffer);
    const worker = new Worker(PDF_WORKER_SOURCE, {
      eval: true,
      workerData: {
        engine,
        parserPath: engine === "legacy" ? LEGACY_PARSER_PATH : MODERN_PARSER_PATH,
        canvasPath: CANVAS_PATH,
        bytes,
        limits: PDF_LIMITS,
      },
      transferList: [bytes.buffer],
      // V8 heap limits do not cap native allocations; byte, page, output and
      // execution bounds complement them, rather than claiming a total RSS cap.
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Await termination before settling, so a compatibility retry cannot
      // overlap the old worker's cleanup or continue its rejected workload.
      void worker.terminate().then(callback, callback);
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("PDF_PARSE_TIMEOUT")));
    }, PDF_PARSE_TIMEOUT_MS);
    worker.once("message", (message: unknown) => {
      finish(() => {
        const result = message as ParsedPdfPages & {
          ok?: boolean;
          name?: string;
          code?: string;
          message?: string;
        };
        if (result.ok) {
          resolve({ numpages: result.numpages, pages: result.pages });
        } else if (result.code === "PDF_RESOURCE_LIMIT") {
          reject(new Error("PDF_RESOURCE_LIMIT"));
        } else {
          const error = new PdfCompatibilityError(result.message || "PDF parsing failed.");
          error.name = result.name || "Error";
          reject(error);
        }
      });
    });
    // Worker OOM, startup and exit failures are terminal, never compatibility.
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`PDF worker exited before returning a result (code ${code}).`)));
    });
  });
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
 * every document. Compatibility failures retry maintained pdf.js in an equally
 * bounded worker; resource failures are terminal.
 */
export async function parsePdf(
  buffer: Buffer,
  renderPage: PageRenderer = (_pageNumber, items) => defaultPageText(items),
) {
  if (buffer.length > PDF_LIMITS.inputBytes) throw new Error("PDF_RESOURCE_LIMIT");
  let parsed: ParsedPdfPages;
  try {
    parsed = await parseWithIsolatedWorker(buffer, "legacy");
  } catch (error) {
    if (!(error instanceof PdfCompatibilityError)) throw error;
    try {
      parsed = await parseWithIsolatedWorker(buffer, "modern");
    } catch (error) {
      if (error instanceof Error && error.name === "InvalidPDFException") {
        throw new Error("INVALID_PDF_DOCUMENT");
      }
      if (error instanceof Error && error.name === "PasswordException") {
        throw new Error("PASSWORD_PROTECTED_PDF");
      }
      throw error;
    }
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
