import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type { ProjectDocumentRole } from "@/lib/types";
import type { WorkBook, WorkSheet } from "@e965/xlsx";

export interface SourceMapEntry {
  reference: string;
  text: string;
}

export interface ParsedUpload {
  rawText: string;
  contentType: string;
  fileName: string;
  fileFormat: "pdf" | "docx" | "txt" | "md" | "xlsx" | "xls";
  fileBase64: string;
  sourceMap: SourceMapEntry[];
  parserUsed: string;
}

type PdfParseFn = (
  buffer: Buffer,
  options: Record<string, unknown>,
) => Promise<{
  text: string;
}>;

let pdfParsePromise: Promise<PdfParseFn> | null = null;
let mammothPromise: Promise<{
  extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
}> | null = null;
let xlsxPromise: Promise<typeof import("@e965/xlsx")> | null = null;

const MAX_SPREADSHEET_SHEETS = 12;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 2000;
const MAX_SPREADSHEET_COLUMNS_PER_SHEET = 80;
const MAX_SPREADSHEET_CELLS = 80_000;
const DEFAULT_DOCLING_TIMEOUT_MS = 180_000;
const DOCLING_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DOCLING_DEFAULT_IMAGE_EXPORT_MODE = "placeholder";
const DOCLING_SUPPORTED_FORMATS = new Set<ParsedUpload["fileFormat"]>([
  "pdf",
  "docx",
  "xlsx",
]);
const DOCLING_DEFAULT_FORMATS = new Set<ParsedUpload["fileFormat"]>(["pdf"]);

class DoclingCommandError extends Error {
  readonly timedOut: boolean;
  readonly stderr: string;

  constructor(message: string, options: { timedOut: boolean; stderr: string }) {
    super(message);
    this.name = "DoclingCommandError";
    this.timedOut = options.timedOut;
    this.stderr = options.stderr;
  }
}

type ExecFileError = Error & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  code?: string | number | null;
};

async function getPdfParse() {
  if (!pdfParsePromise) {
    pdfParsePromise = import("pdf-parse/lib/pdf-parse.js").then(
      (module) => module.default as unknown as PdfParseFn,
    );
  }
  return pdfParsePromise;
}

async function getMammoth() {
  if (!mammothPromise) {
    mammothPromise = import("mammoth");
  }
  return mammothPromise;
}

async function getXlsx() {
  if (!xlsxPromise) {
    xlsxPromise = import("@e965/xlsx");
  }
  return xlsxPromise;
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function ensureReadableText(rawText: string, fileName: string) {
  if (normalizeText(rawText)) {
    return;
  }

  throw new Error(
    `${fileName} har ingen lesbar tekst. Last opp en tekstbasert fil, eller bruk OCR/eksport til DOCX, Excel, TXT eller Markdown før opplasting.`,
  );
}

export function isDoclingEnabled() {
  return process.env.DOCLING_INGESTION?.trim().toLowerCase() === "on";
}

export function canUseDoclingForFormat(fileFormat: ParsedUpload["fileFormat"]) {
  const configuredFormats = process.env.DOCLING_FORMATS?.trim().toLowerCase();
  if (!configuredFormats) {
    return DOCLING_DEFAULT_FORMATS.has(fileFormat);
  }

  if (configuredFormats === "all") {
    return DOCLING_SUPPORTED_FORMATS.has(fileFormat);
  }

  const formats = new Set(
    configuredFormats
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is ParsedUpload["fileFormat"] =>
        DOCLING_SUPPORTED_FORMATS.has(value as ParsedUpload["fileFormat"]),
      ),
  );

  return formats.size > 0
    ? formats.has(fileFormat)
    : DOCLING_DEFAULT_FORMATS.has(fileFormat);
}

function doclingCommand() {
  return process.env.DOCLING_CLI_COMMAND?.trim() || "docling";
}

function normalizedOptionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function doclingTimeoutMs() {
  const rawValue = normalizedOptionalEnv("DOCLING_TIMEOUT_MS");
  const parsed = rawValue ? Number(rawValue) : DEFAULT_DOCLING_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_DOCLING_TIMEOUT_MS;
  }

  return Math.min(parsed, 600_000);
}

function doclingImageExportMode() {
  return normalizedOptionalEnv("DOCLING_IMAGE_EXPORT_MODE") ?? DOCLING_DEFAULT_IMAGE_EXPORT_MODE;
}

function doclingNumThreads() {
  const rawValue = normalizedOptionalEnv("DOCLING_NUM_THREADS");
  const parsed = rawValue ? Number(rawValue) : null;
  if (!Number.isInteger(parsed) || !parsed || parsed < 1) {
    return null;
  }

  return String(Math.min(parsed, 16));
}

function doclingCliArgs(inputPath: string, outputDir: string) {
  const args = [
    "--to",
    "md",
    "--output",
    outputDir,
    "--image-export-mode",
    doclingImageExportMode(),
    "--document-timeout",
    String(Math.ceil(doclingTimeoutMs() / 1000)),
  ];
  const artifactsPath = normalizedOptionalEnv("DOCLING_ARTIFACTS_PATH");
  const numThreads = doclingNumThreads();
  const tableMode = normalizedOptionalEnv("DOCLING_TABLE_MODE")?.toLowerCase();
  const ocrMode = normalizedOptionalEnv("DOCLING_OCR")?.toLowerCase();

  if (artifactsPath) {
    args.push("--artifacts-path", artifactsPath);
  }

  if (numThreads) {
    args.push("--num-threads", numThreads);
  }

  if (tableMode === "fast" || tableMode === "accurate") {
    args.push("--table-mode", tableMode);
  }

  if (ocrMode === "off" || ocrMode === "false" || ocrMode === "0") {
    args.push("--no-ocr");
  } else if (ocrMode === "on" || ocrMode === "true" || ocrMode === "1") {
    args.push("--ocr");
  }

  args.push(inputPath);
  return args;
}

function execDocling(args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      doclingCommand(),
      args,
      {
        timeout: doclingTimeoutMs(),
        maxBuffer: DOCLING_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileError;
          const timedOut =
            (execError.killed === true && execError.signal === "SIGTERM") ||
            /\b(?:timed out|timeout)\b/i.test(execError.message);
          reject(
            new DoclingCommandError(
              [
                error.message,
                stderr?.trim() ? `stderr: ${stderr.trim()}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              {
                timedOut,
                stderr: stderr?.trim() ?? "",
              },
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function shouldRetryDoclingFallback(error: unknown) {
  if (error instanceof DoclingCommandError && error.timedOut) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:unknown|unrecognized|unsupported|invalid)\b.*\b(?:option|argument|flag)\b/i.test(
      message,
    ) || /\bno such option\b/i.test(message)
  );
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(fullPath)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function stdoutLooksLikeMarkdown(stdout: string) {
  if (!stdout) {
    return false;
  }

  if (
    stdout.length < 160 &&
    /\b(converted|saved|generated|processed|docling|output)\b/i.test(stdout)
  ) {
    return false;
  }

  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(stdout) || stdout.split("\n").length >= 4;
}

async function readDoclingMarkdown(tempDir: string, stdout: string) {
  const markdownFiles = await findMarkdownFiles(tempDir);
  const preferredFiles = markdownFiles.sort((left, right) => {
    const leftSource = /(^|\/)source\.md$/i.test(left) ? 0 : 1;
    const rightSource = /(^|\/)source\.md$/i.test(right) ? 0 : 1;
    return leftSource - rightSource || left.localeCompare(right);
  });

  for (const filePath of preferredFiles) {
    const markdown = normalizeText(await readFile(filePath, "utf8"));
    if (markdown) {
      return markdown;
    }
  }

  const stdoutMarkdown = normalizeText(stdout);
  return stdoutLooksLikeMarkdown(stdoutMarkdown) ? stdoutMarkdown : "";
}

async function tryExtractWithDocling(input: {
  buffer: Buffer;
  fileName: string;
  fileFormat: ParsedUpload["fileFormat"];
  contentType: string;
  role?: ProjectDocumentRole;
}): Promise<ParsedUpload | null> {
  if (!isDoclingEnabled()) {
    return null;
  }

  if (!canUseDoclingForFormat(input.fileFormat)) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "anbud-docling-"));
  const suffix = path.extname(input.fileName) || `.${input.fileFormat}`;
  const inputPath = path.join(tempDir, `source${suffix}`);

  try {
    await writeFile(inputPath, input.buffer);
    const primaryArgs = doclingCliArgs(inputPath, tempDir);
    const fallbackArgs = ["--to", "md", "--output", tempDir, inputPath];
    let markdown = "";
    let lastError: unknown = null;

    try {
      const result = await execDocling(primaryArgs);
      markdown = await readDoclingMarkdown(tempDir, result.stdout);
    } catch (error) {
      lastError = error;
      if (shouldRetryDoclingFallback(error)) {
        console.info(
          JSON.stringify({
            event: "docling_ingestion_cli_fallback",
            file_name: input.fileName,
            reason: error instanceof Error ? error.message : "unknown_error",
          }),
        );

        try {
          const result = await execDocling(fallbackArgs);
          markdown = await readDoclingMarkdown(tempDir, result.stdout);
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
    }

    if (!markdown) {
      if (lastError) {
        console.info(
          JSON.stringify({
            event: "docling_ingestion_fallback",
            file_name: input.fileName,
            reason:
              lastError instanceof Error ? lastError.message : "unknown_error",
          }),
        );
      }
      return null;
    }

    ensureReadableText(markdown, input.fileName);
    console.info(
      JSON.stringify({
        event: "docling_ingestion_success",
        file_name: input.fileName,
        file_format: input.fileFormat,
        chars: markdown.length,
      }),
    );

    return {
      rawText: markdown,
      contentType: input.contentType,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      fileBase64: input.buffer.toString("base64"),
      sourceMap: buildTextSourceMap(markdown, input.role),
      parserUsed: "docling",
    };
  } catch (error) {
    console.info(
      JSON.stringify({
        event: "docling_ingestion_fallback",
        file_name: input.fileName,
        reason: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function documentLabel(role?: ProjectDocumentRole) {
  switch (role) {
    case "primary_solution_document":
      return "Løsningsdokument";
    case "supporting_document":
      return "Støttedokument";
    default:
      return "Kundedokument";
  }
}

function buildTextSourceMap(text: string, role?: ProjectDocumentRole) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: SourceMapEntry[] = [];
  const label = documentLabel(role);
  let currentReference = `${label} – tekstblokk 1`;
  let currentLines: string[] = [];
  let counter = 1;

  const flush = () => {
    if (!currentLines.length) {
      return;
    }
    sections.push({
      reference: currentReference,
      text: currentLines.join("\n").trim(),
    });
    currentLines = [];
  };

  for (const line of lines) {
    const isHeading =
      /^(kapittel|chapter|section|del|vedlegg|appendix)\b/i.test(line) ||
      /^\d+(\.\d+)*\s+\S+/.test(line) ||
      /^[A-ZÆØÅ][A-ZÆØÅ0-9\s-]{5,}$/.test(line);

    if (isHeading) {
      flush();
      currentReference = `${label} – ${line}`;
      continue;
    }

    currentLines.push(line);
    if (currentLines.length >= 10) {
      flush();
      counter += 1;
      currentReference = `${label} – tekstblokk ${counter}`;
    }
  }

  flush();
  return sections.length ? sections : [{ reference: `${label} – tekstblokk 1`, text: normalizeText(text) }];
}

type PdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
};

function renderPdfTextItems(items: PdfTextItem[]) {
  const lines: Array<{ y: number; items: PdfTextItem[] }> = [];

  for (const item of items) {
    const text = item.str.trim();
    const y = item.transform[5] ?? 0;
    if (!text) {
      continue;
    }

    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (line) {
      line.items.push(item);
    } else {
      lines.push({ y, items: [item] });
    }
  }

  return lines
    .sort((left, right) => right.y - left.y)
    .map((line) => {
      let previousEnd: number | null = null;
      return line.items
        .sort((left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0))
        .map((item) => {
          const x = item.transform[4] ?? 0;
          const gap = previousEnd == null ? 0 : x - previousEnd;
          previousEnd = x + (item.width ?? item.str.length * 4);
          return `${gap > 3 ? " " : ""}${item.str.trim()}`;
        })
        .join("")
        .replace(/[ \t]+/g, " ")
        .trim();
    })
    .filter(Boolean)
    .join("\n");
}

async function extractPdf(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  let pageNumber = 0;
  const pageEntries: SourceMapEntry[] = [];
  const label = documentLabel(role);

  const pdfParse = await getPdfParse();
  const parsed = await pdfParse(buffer, {
      pagerender: (pageData: {
        getTextContent: (options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{
          items: PdfTextItem[];
        }>;
      }) => {
        pageNumber += 1;
        return pageData
          .getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false,
          })
          .then((textContent) => {
            const normalized = normalizeText(renderPdfTextItems(textContent.items));
            if (normalized) {
              pageEntries.push({
                reference: `${label} – side ${pageNumber}`,
                text: normalized,
              });
            }

            return `[[SIDE:${pageNumber}]]\n${normalized}`;
          });
      },
    });

  const rawText = normalizeText(parsed.text);
  ensureReadableText(rawText, fileName);

  return {
    rawText,
    contentType: "application/pdf",
    fileName,
    fileFormat: "pdf",
    fileBase64: buffer.toString("base64"),
    sourceMap: pageEntries.filter((entry) => entry.text),
    parserUsed: "pdf-parse",
  };
}

async function extractDocx(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  try {
    return await extractDocxFromWordXml(buffer, fileName, role, null);
  } catch (wordXmlError) {
    try {
      return await extractDocxWithMammoth(buffer, fileName, role);
    } catch {
      throw wordXmlError;
    }
  }
}

async function extractDocxWithMammoth(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  const mammoth = await getMammoth();
  const result = await mammoth.extractRawText({ buffer });
  const rawText = normalizeText(result.value);
  ensureReadableText(rawText, fileName);

  return {
    rawText,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName,
    fileFormat: "docx",
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText, role),
    parserUsed: "mammoth",
  };
}

function elementLocalName(element: Element) {
  return element.localName || element.nodeName.replace(/^.*:/, "");
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function childElements(node: Node) {
  return Array.from(node.childNodes).filter(isElement);
}

function findFirstDescendant(element: Element, localName: string): Element | null {
  if (elementLocalName(element) === localName) {
    return element;
  }

  for (const child of childElements(element)) {
    const match = findFirstDescendant(child, localName);
    if (match) {
      return match;
    }
  }

  return null;
}

function findDescendants(element: Element, localName: string): Element[] {
  const matches: Element[] = [];

  for (const child of childElements(element)) {
    if (elementLocalName(child) === localName) {
      matches.push(child);
    }
    matches.push(...findDescendants(child, localName));
  }

  return matches;
}

function normalizeDocxInlineText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function readWordText(node: Node): string {
  if (isElement(node)) {
    const localName = elementLocalName(node);
    if (localName === "t") {
      return node.textContent ?? "";
    }
    if (localName === "tab") {
      return " ";
    }
    if (localName === "br" || localName === "cr") {
      return "\n";
    }
  }

  return Array.from(node.childNodes).map(readWordText).join("");
}

function extractParagraphText(paragraph: Element) {
  return normalizeDocxInlineText(readWordText(paragraph));
}

function extractTableRows(table: Element) {
  return childElements(table)
    .filter((child) => elementLocalName(child) === "tr")
    .map((row) => {
      const cells = childElements(row)
        .filter((child) => elementLocalName(child) === "tc")
        .map((cell) => {
          const paragraphText = findDescendants(cell, "p")
            .map(extractParagraphText)
            .filter(Boolean)
            .join(" / ");

          return paragraphText || normalizeDocxInlineText(readWordText(cell));
        })
        .map((cell) => cell.trim())
        .filter(Boolean);

      return cells.join(" | ");
    })
    .filter(Boolean);
}

function docxParseErrorMessage(fileName: string, fallbackError: unknown) {
  const detail =
    fallbackError instanceof Error && fallbackError.message.trim()
      ? ` Teknisk detalj: ${fallbackError.message}`
      : "";

  return [
    `${fileName} kunne ikke leses som DOCX.`,
    "Dokumentet kan være låst, korrupt eller lagret i et Word-format parseren ikke støtter.",
    `Lagre det på nytt som .docx, eller eksporter til PDF/Excel og last opp på nytt.${detail}`,
  ].join(" ");
}

async function extractDocxFromWordXml(
  buffer: Buffer,
  fileName: string,
  role: ProjectDocumentRole | undefined,
  originalError: unknown,
): Promise<ParsedUpload> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = zip.file("word/document.xml");

    if (!documentXml) {
      throw new Error("Fant ikke word/document.xml i DOCX-filen.");
    }

    const xml = await documentXml.async("text");
    let parserError = "";
    const xmlDocument = new XmlDomParser({
      errorHandler: {
        warning: () => undefined,
        error: (message) => {
          parserError = String(message);
        },
        fatalError: (message) => {
          parserError = String(message);
        },
      },
    }).parseFromString(xml, "application/xml");

    if (parserError) {
      throw new Error(parserError);
    }

    const body = findFirstDescendant(xmlDocument.documentElement, "body");
    if (!body) {
      throw new Error("Fant ikke dokumentinnhold i DOCX-filen.");
    }

    const label = documentLabel(role);
    const rawBlocks: string[] = [];
    const sourceMap: SourceMapEntry[] = [];
    const pendingParagraphs: string[] = [];
    let textBlockCounter = 1;
    let tableCounter = 1;

    const flushParagraphs = () => {
      if (!pendingParagraphs.length) {
        return;
      }

      sourceMap.push({
        reference: `${label} – tekstblokk ${textBlockCounter}`,
        text: pendingParagraphs.join("\n").trim(),
      });
      pendingParagraphs.length = 0;
      textBlockCounter += 1;
    };

    for (const block of childElements(body)) {
      const localName = elementLocalName(block);

      if (localName === "p") {
        const text = extractParagraphText(block);
        if (!text) {
          continue;
        }

        rawBlocks.push(text);
        pendingParagraphs.push(text);
        if (pendingParagraphs.length >= 10) {
          flushParagraphs();
        }
        continue;
      }

      if (localName === "tbl") {
        const rows = extractTableRows(block);
        if (!rows.length) {
          continue;
        }

        flushParagraphs();
        const tableText = rows
          .map((row, rowIndex) => `Rad ${rowIndex + 1}: ${row}`)
          .join("\n");
        rawBlocks.push(`Tabell ${tableCounter}\n${tableText}`);
        sourceMap.push({
          reference: `${label} – tabell ${tableCounter}`,
          text: tableText,
        });
        tableCounter += 1;
      }
    }

    flushParagraphs();

    const rawText = normalizeText(rawBlocks.join("\n\n"));
    ensureReadableText(rawText, fileName);

    return {
      rawText,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName,
      fileFormat: "docx",
      fileBase64: buffer.toString("base64"),
      sourceMap: sourceMap.length ? sourceMap : buildTextSourceMap(rawText, role),
      parserUsed: "docx-xml",
    };
  } catch (fallbackError) {
    throw new Error(
      docxParseErrorMessage(
        fileName,
        fallbackError instanceof Error ? fallbackError : originalError,
      ),
    );
  }
}

async function extractTxtLike(buffer: Buffer, fileName: string, fileFormat: "txt" | "md", role?: ProjectDocumentRole): Promise<ParsedUpload> {
  const rawText = normalizeText(buffer.toString("utf-8"));
  ensureReadableText(rawText, fileName);

  return {
    rawText,
    contentType: fileFormat === "md" ? "text/markdown" : "text/plain",
    fileName,
    fileFormat,
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText, role),
    parserUsed: fileFormat === "md" ? "markdown" : "text",
  };
}

function cellToText(value: unknown) {
  if (value == null) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).replace(/\s+/g, " ").trim();
}

function getSheetRange(xlsx: typeof import("@e965/xlsx"), sheet: WorkSheet) {
  const ref = sheet["!ref"];
  if (!ref) {
    return null;
  }

  return xlsx.utils.decode_range(ref);
}

function extractSheetRows(
  xlsx: typeof import("@e965/xlsx"),
  workbook: WorkBook,
  role?: ProjectDocumentRole,
) {
  if (workbook.SheetNames.length > MAX_SPREADSHEET_SHEETS) {
    throw new Error(
      `Regnearket har for mange ark. Maks ${MAX_SPREADSHEET_SHEETS} ark kan importeres om gangen.`,
    );
  }

  const sourceMap: SourceMapEntry[] = [];
  const sheetTexts: string[] = [];
  const label = documentLabel(role);
  let scannedCells = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }

    const range = getSheetRange(xlsx, sheet);
    if (!range) {
      continue;
    }
    const rowCount = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;
    if (
      rowCount > MAX_SPREADSHEET_ROWS_PER_SHEET ||
      columnCount > MAX_SPREADSHEET_COLUMNS_PER_SHEET
    ) {
      throw new Error(
        `Arket "${sheetName}" er for stort til direkte import. Maks ${MAX_SPREADSHEET_ROWS_PER_SHEET} rader og ${MAX_SPREADSHEET_COLUMNS_PER_SHEET} kolonner støttes per ark.`,
      );
    }

    const rows: string[] = [];
    let lastNonEmptyRow = 0;

    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const cells: string[] = [];

      for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
        scannedCells += 1;
        if (scannedCells > MAX_SPREADSHEET_CELLS) {
          throw new Error(
            `Regnearket er for stort til direkte import. Maks ${MAX_SPREADSHEET_CELLS} celler kan skannes om gangen.`,
          );
        }

        const address = xlsx.utils.encode_cell({ r: rowIndex, c: colIndex });
        const cell = sheet[address];
        const text = cellToText(cell?.w ?? cell?.v);

        if (text) {
          cells.push(`${address}: ${text}`);
        }
      }

      if (cells.length) {
        lastNonEmptyRow = rowIndex + 1;
        rows.push(`Rad ${rowIndex + 1}: ${cells.join(" | ")}`);
      }
    }

    if (!rows.length) {
      continue;
    }

    const sheetText = [`Ark: ${sheetName}`, ...rows].join("\n");
    sheetTexts.push(sheetText);
    for (let rowOffset = 0; rowOffset < rows.length; rowOffset += 25) {
      const chunkRows = rows.slice(rowOffset, rowOffset + 25);
      const firstRow = rowOffset + 1;
      const lastRow = Math.min(rowOffset + chunkRows.length, lastNonEmptyRow);
      sourceMap.push({
        reference: `${label} – ark "${sheetName}", rad ${firstRow}-${lastRow}`,
        text: [`Ark: ${sheetName}`, ...chunkRows].join("\n"),
      });
    }
  }

  return {
    rawText: normalizeText(sheetTexts.join("\n\n")),
    sourceMap,
  };
}

async function extractSpreadsheet(
  buffer: Buffer,
  fileName: string,
  fileFormat: "xlsx" | "xls",
  role?: ProjectDocumentRole,
): Promise<ParsedUpload> {
  const xlsx = await getXlsx();
  const workbook = xlsx.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellText: true,
  });
  const extracted = extractSheetRows(xlsx, workbook, role);
  ensureReadableText(extracted.rawText, fileName);

  return {
    rawText: extracted.rawText,
    contentType:
      fileFormat === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.ms-excel",
    fileName,
    fileFormat,
    fileBase64: buffer.toString("base64"),
    sourceMap: extracted.sourceMap,
    parserUsed: "spreadsheet",
  };
}

export function inferUploadFileFormat(input: {
  fileName: string;
  contentType?: string | null;
}): ParsedUpload["fileFormat"] {
  const suffix = input.fileName.toLowerCase();
  const contentType = input.contentType || "application/octet-stream";

  if (contentType === "application/pdf" || suffix.endsWith(".pdf")) {
    return "pdf";
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    suffix.endsWith(".docx")
  ) {
    return "docx";
  }
  if (contentType === "application/msword" || suffix.endsWith(".doc")) {
    throw new Error("`.doc` støttes ikke direkte. Lagre dokumentet som `.docx` og last opp på nytt.");
  }
  if (contentType === "text/plain" || suffix.endsWith(".txt")) {
    return "txt";
  }
  if (contentType === "text/markdown" || suffix.endsWith(".md")) {
    return "md";
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    suffix.endsWith(".xlsx")
  ) {
    return "xlsx";
  }
  if (
    contentType === "application/vnd.ms-excel" ||
    contentType === "application/xls" ||
    suffix.endsWith(".xls")
  ) {
    return "xls";
  }

  throw new Error("Kun PDF, DOCX, Excel, TXT og Markdown støttes.");
}

export function contentTypeForUploadFormat(
  fileFormat: ParsedUpload["fileFormat"],
  fallback?: string | null,
) {
  if (fallback && fallback !== "application/octet-stream") {
    return fallback;
  }

  switch (fileFormat) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls":
      return "application/vnd.ms-excel";
  }
}

export async function extractTextFromBuffer(input: {
  buffer: Buffer;
  fileName: string;
  contentType?: string | null;
  role?: ProjectDocumentRole;
  useDocling?: boolean;
}): Promise<ParsedUpload> {
  const fileName = input.fileName || "document.txt";
  const suffix = fileName.toLowerCase();
  const fileFormat = inferUploadFileFormat({
    fileName,
    contentType: input.contentType,
  });
  const contentType = contentTypeForUploadFormat(fileFormat, input.contentType);
  const buffer = input.buffer;
  const role = input.role;

  if (input.useDocling !== false && canUseDoclingForFormat(fileFormat)) {
    const docling = await tryExtractWithDocling({
      buffer,
      fileName,
      fileFormat,
      contentType,
      role,
    });
    if (docling) {
      return docling;
    }
  }

  if (fileFormat === "pdf") {
    return extractPdf(buffer, fileName, role);
  }

  if (fileFormat === "docx") {
    return extractDocx(buffer, fileName, role);
  }

  if (suffix.endsWith(".doc")) {
    throw new Error("`.doc` støttes ikke direkte. Lagre dokumentet som `.docx` og last opp på nytt.");
  }

  if (fileFormat === "txt") {
    return extractTxtLike(buffer, fileName, "txt", role);
  }

  if (fileFormat === "md") {
    return extractTxtLike(buffer, fileName, "md", role);
  }

  if (fileFormat === "xlsx") {
    return extractSpreadsheet(buffer, fileName, "xlsx", role);
  }

  if (fileFormat === "xls") {
    return extractSpreadsheet(buffer, fileName, "xls", role);
  }

  throw new Error("Kun PDF, DOCX, Excel, TXT og Markdown støttes.");
}

export async function extractTextFromUpload(
  file: File,
  role?: ProjectDocumentRole,
  options?: { useDocling?: boolean },
): Promise<ParsedUpload> {
  return extractTextFromBuffer({
    buffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name || "document.txt",
    contentType: file.type || "application/octet-stream",
    role,
    useDocling: options?.useDocling,
  });
}
