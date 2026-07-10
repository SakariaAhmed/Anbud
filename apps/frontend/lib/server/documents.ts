import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { assertProjectWorkflowActive } from "@/lib/server/project-workflow-cancellation";
import type { ProjectDocumentRole } from "@/lib/types";
import type { WorkBook, WorkSheet } from "@e965/xlsx";

export interface SourceMapEntry {
  reference: string;
  text: string;
  kind?:
    | "text"
    | "table"
    | "docling_text"
    | "docling_table_row"
    | "docling_markdown";
  parser?: string;
  page?: number | null;
  table_index?: number;
  row_index?: number;
  columns?: string[];
  cells?: Record<string, string>;
  docling_ref?: string;
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
let pdfLibPromise: Promise<typeof import("pdf-lib")> | null = null;

const MAX_SPREADSHEET_SHEETS = 12;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 2000;
const MAX_SPREADSHEET_COLUMNS_PER_SHEET = 80;
const MAX_SPREADSHEET_CELLS = 80_000;
const DEFAULT_DOCLING_TIMEOUT_MS = 600_000;
const DOCLING_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DOCLING_DEFAULT_PDF_CHUNK_PAGES = 40;
const DOCLING_DEFAULT_PDF_CHUNK_THRESHOLD_PAGES = 120;
const DOCLING_MAX_PDF_CHUNK_PAGES = 80;
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

async function getPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import("pdf-lib");
  }
  return pdfLibPromise;
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

function optionalPositiveIntegerEnv(
  name: string,
  fallback: number,
  max: number,
) {
  const rawValue = normalizedOptionalEnv(name);
  const parsed = rawValue ? Number(rawValue) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function doclingPdfChunkPages() {
  return optionalPositiveIntegerEnv(
    "DOCLING_PDF_CHUNK_PAGES",
    DOCLING_DEFAULT_PDF_CHUNK_PAGES,
    DOCLING_MAX_PDF_CHUNK_PAGES,
  );
}

function doclingPdfChunkThresholdPages() {
  return optionalPositiveIntegerEnv(
    "DOCLING_PDF_CHUNK_THRESHOLD_PAGES",
    DOCLING_DEFAULT_PDF_CHUNK_THRESHOLD_PAGES,
    1000,
  );
}

function doclingPdfChunkingMode() {
  return normalizedOptionalEnv("DOCLING_PDF_CHUNKING")?.toLowerCase() ?? "auto";
}

function doclingLargePdfTableMode() {
  const mode =
    normalizedOptionalEnv("DOCLING_LARGE_PDF_TABLE_MODE")?.toLowerCase() ??
    "fast";
  return mode === "accurate" || mode === "fast" ? mode : "fast";
}

function sourceFileExtensionForFormat(fileFormat: ParsedUpload["fileFormat"]) {
  switch (fileFormat) {
    case "pdf":
      return ".pdf";
    case "docx":
      return ".docx";
    case "xlsx":
      return ".xlsx";
    case "xls":
      return ".xls";
    case "md":
      return ".md";
    case "txt":
      return ".txt";
  }
}

function doclingCliArgs(
  inputPath: string,
  outputDir: string,
  options: { useOcr?: boolean; tableMode?: string | null } = {},
) {
  const args = [
    "--to",
    "md",
    "--to",
    "json",
    "--output",
    outputDir,
    "--image-export-mode",
    doclingImageExportMode(),
    "--document-timeout",
    String(Math.ceil(doclingTimeoutMs() / 1000)),
  ];
  const artifactsPath = normalizedOptionalEnv("DOCLING_ARTIFACTS_PATH");
  const numThreads = doclingNumThreads();
  const tableMode = (
    options.tableMode ?? normalizedOptionalEnv("DOCLING_TABLE_MODE")
  )?.toLowerCase();
  const configuredOcrMode = normalizedOptionalEnv("DOCLING_OCR")?.toLowerCase();
  const ocrMode =
    typeof options.useOcr === "boolean"
      ? options.useOcr
        ? "on"
        : "off"
      : configuredOcrMode;

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

async function findJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonFiles(fullPath)));
    } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
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

function sortDoclingOutputFiles(files: string[], preferredSuffix: string) {
  return files.sort((left, right) => {
    const leftSource = new RegExp(`(^|/)source\\.${preferredSuffix}$`, "i").test(left) ? 0 : 1;
    const rightSource = new RegExp(`(^|/)source\\.${preferredSuffix}$`, "i").test(right) ? 0 : 1;
    return leftSource - rightSource || left.localeCompare(right);
  });
}

async function readDoclingJson(tempDir: string) {
  const jsonFiles = sortDoclingOutputFiles(await findJsonFiles(tempDir), "json");

  for (const filePath of jsonFiles) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed side outputs and keep looking for Docling's main JSON.
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCellText(value: unknown) {
  return normalizeText(String(value ?? "").replace(/\s+/g, " "));
}

function doclingRef(value: unknown) {
  if (isRecord(value)) {
    const ref = value.$ref;
    return typeof ref === "string" ? ref : "";
  }

  return typeof value === "string" ? value : "";
}

function doclingSelfRef(item: Record<string, unknown>) {
  const selfRef = item.self_ref;
  if (typeof selfRef === "string") {
    return selfRef;
  }

  const ref = item.$ref;
  return typeof ref === "string" ? ref : "";
}

function doclingProvenancePage(item: Record<string, unknown>) {
  const prov = item.prov;
  if (!Array.isArray(prov)) {
    return null;
  }

  for (const provenance of prov) {
    if (!isRecord(provenance)) {
      continue;
    }

    const page = provenance.page_no;
    if (typeof page === "number" && Number.isFinite(page)) {
      return page;
    }
  }

  return null;
}

function doclingText(item: Record<string, unknown>) {
  const text = item.text ?? item.orig;
  return typeof text === "string" ? normalizeText(text) : "";
}

function doclingLabel(item: Record<string, unknown>) {
  const label = item.label;
  return typeof label === "string" ? label : "text";
}

function doclingChildren(item: Record<string, unknown>) {
  const children = item.children;
  return Array.isArray(children) ? children.map(doclingRef).filter(Boolean) : [];
}

type DoclingItem = {
  item: Record<string, unknown>;
  kind: "text" | "table" | "group";
  index: number;
};

function collectDoclingItems(doclingJson: Record<string, unknown>) {
  const items = new Map<string, DoclingItem>();
  const specs: Array<{
    key: string;
    kind: DoclingItem["kind"];
  }> = [
    { key: "texts", kind: "text" },
    { key: "tables", kind: "table" },
    { key: "groups", kind: "group" },
  ];

  for (const spec of specs) {
    const values = doclingJson[spec.key];
    if (!Array.isArray(values)) {
      continue;
    }

    values.forEach((value, index) => {
      if (!isRecord(value)) {
        return;
      }

      const ref = doclingSelfRef(value) || `#/${spec.key}/${index}`;
      items.set(ref, {
        item: value,
        kind: spec.kind,
        index,
      });
    });
  }

  return items;
}

function orderedDoclingItems(doclingJson: Record<string, unknown>) {
  const items = collectDoclingItems(doclingJson);
  const ordered: DoclingItem[] = [];
  const seen = new Set<string>();

  function visitRef(ref: string) {
    if (seen.has(ref)) {
      return;
    }
    seen.add(ref);

    const match = items.get(ref);
    if (!match) {
      return;
    }

    if (match.kind === "text" || match.kind === "table") {
      ordered.push(match);
    }

    for (const childRef of doclingChildren(match.item)) {
      visitRef(childRef);
    }
  }

  const body = doclingJson.body;
  if (isRecord(body)) {
    for (const ref of doclingChildren(body)) {
      visitRef(ref);
    }
  }

  if (!ordered.length) {
    return Array.from(items.values())
      .filter((item) => item.kind === "text" || item.kind === "table")
      .sort((left, right) => {
        const leftPage = doclingProvenancePage(left.item) ?? Number.MAX_SAFE_INTEGER;
        const rightPage = doclingProvenancePage(right.item) ?? Number.MAX_SAFE_INTEGER;
        return leftPage - rightPage || left.index - right.index;
      });
  }

  return ordered;
}

type DoclingTableCell = {
  text: string;
  row: number;
  col: number;
  columnHeader: boolean;
};

function doclingTableCells(table: Record<string, unknown>) {
  const data = table.data;
  if (!isRecord(data) || !Array.isArray(data.table_cells)) {
    return [];
  }

  return data.table_cells
    .map((value): DoclingTableCell | null => {
      if (!isRecord(value)) {
        return null;
      }

      const row = value.start_row_offset_idx;
      const col = value.start_col_offset_idx;
      if (
        typeof row !== "number" ||
        typeof col !== "number" ||
        !Number.isFinite(row) ||
        !Number.isFinite(col)
      ) {
        return null;
      }

      return {
        text: normalizeCellText(value.text),
        row,
        col,
        columnHeader: value.column_header === true,
      };
    })
    .filter((value): value is DoclingTableCell => Boolean(value));
}

function dedupeColumnNames(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((name, index) => {
    const fallback = `Kolonne ${index + 1}`;
    const base = normalizeCellText(name) || fallback;
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

function buildDoclingTableRows(input: {
  table: Record<string, unknown>;
  tableIndex: number;
  label: string;
  pageOffset?: number;
}): SourceMapEntry[] {
  const cells = doclingTableCells(input.table);
  if (!cells.length) {
    return [];
  }

  const page = doclingProvenancePage(input.table);
  const sourcePage = page ? page + (input.pageOffset ?? 0) : null;
  const rowIndexes = Array.from(new Set(cells.map((cell) => cell.row))).sort(
    (left, right) => left - right,
  );
  const colIndexes = Array.from(new Set(cells.map((cell) => cell.col))).sort(
    (left, right) => left - right,
  );
  const explicitHeaderRows = new Set(
    cells.filter((cell) => cell.columnHeader).map((cell) => cell.row),
  );
  const headerRows = explicitHeaderRows.size
    ? explicitHeaderRows
    : new Set(rowIndexes.length > 1 ? [rowIndexes[0] as number] : []);
  const columns = dedupeColumnNames(
    colIndexes.map((colIndex) => {
      const headerText = cells
        .filter((cell) => cell.col === colIndex && headerRows.has(cell.row))
        .map((cell) => cell.text)
        .filter(Boolean)
        .join(" ");

      return headerText || `Kolonne ${colIndex + 1}`;
    }),
  );
  const columnByIndex = new Map(
    colIndexes.map((colIndex, index) => [colIndex, columns[index] ?? `Kolonne ${index + 1}`]),
  );
  const rows: SourceMapEntry[] = [];

  for (const rowIndex of rowIndexes.filter((index) => !headerRows.has(index))) {
    const rowCells = cells.filter((cell) => cell.row === rowIndex);
    const cellMap: Record<string, string> = {};

    for (const cell of rowCells) {
      const column = columnByIndex.get(cell.col) ?? `Kolonne ${cell.col + 1}`;
      if (cell.text) {
        cellMap[column] = [cellMap[column], cell.text].filter(Boolean).join(" ");
      }
    }

    const rowText = columns
      .map((column) => {
        const value = normalizeCellText(cellMap[column]);
        return value ? `${column}: ${value}` : "";
      })
      .filter(Boolean)
      .join(" | ");

    if (!rowText) {
      continue;
    }

    const pageSuffix = sourcePage ? `, side ${sourcePage}` : "";
    rows.push({
      reference: `${input.label} – Docling tabell ${input.tableIndex + 1}, rad ${rowIndex + 1}${pageSuffix}`,
      text: rowText,
      kind: "docling_table_row",
      parser: "docling",
      page: sourcePage,
      table_index: input.tableIndex + 1,
      row_index: rowIndex + 1,
      columns,
      cells: cellMap,
      docling_ref: doclingSelfRef(input.table),
    });
  }

  return rows;
}

function buildDoclingSourceMap(input: {
  doclingJson: Record<string, unknown> | null;
  markdown: string;
  role?: ProjectDocumentRole;
  pageOffset?: number;
}) {
  const label = documentLabel(input.role);
  const entries: SourceMapEntry[] = [];

  if (input.doclingJson) {
    for (const ordered of orderedDoclingItems(input.doclingJson)) {
      if (ordered.kind === "table") {
        entries.push(
          ...buildDoclingTableRows({
            table: ordered.item,
            tableIndex: ordered.index,
            label,
            pageOffset: input.pageOffset,
          }),
        );
        continue;
      }

      const text = doclingText(ordered.item);
      if (!text) {
        continue;
      }

      const page = doclingProvenancePage(ordered.item);
      const sourcePage = page ? page + (input.pageOffset ?? 0) : null;
      const pageSuffix = sourcePage ? `, side ${sourcePage}` : "";
      entries.push({
        reference: `${label} – Docling ${doclingLabel(ordered.item)} ${ordered.index + 1}${pageSuffix}`,
        text,
        kind: "docling_text",
        parser: "docling",
        page: sourcePage,
        docling_ref: doclingSelfRef(ordered.item),
      });
    }
  }

  if (entries.length) {
    return entries;
  }

  if (input.markdown) {
    return buildTextSourceMap(input.markdown, input.role).map((entry) => ({
      ...entry,
      kind: "docling_markdown" as const,
      parser: "docling",
    }));
  }

  return [];
}

async function runDoclingConversion(input: {
  inputPath: string;
  outputDir: string;
  fileName: string;
  useOcr?: boolean;
  tableMode?: string | null;
}) {
  const primaryArgs = doclingCliArgs(input.inputPath, input.outputDir, {
    useOcr: input.useOcr,
    tableMode: input.tableMode,
  });
  const fallbackArgs = [
    "--to",
    "md",
    "--to",
    "json",
    "--output",
    input.outputDir,
    input.inputPath,
  ];
  let markdown = "";
  let doclingJson: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  try {
    const result = await execDocling(primaryArgs);
    markdown = await readDoclingMarkdown(input.outputDir, result.stdout);
    doclingJson = await readDoclingJson(input.outputDir);
  } catch (error) {
    assertProjectWorkflowActive();
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
        markdown = await readDoclingMarkdown(input.outputDir, result.stdout);
        doclingJson = await readDoclingJson(input.outputDir);
      } catch (fallbackError) {
        assertProjectWorkflowActive();
        lastError = fallbackError;
      }
    }
  }

  return { markdown, doclingJson, lastError };
}

async function pdfPageCount(buffer: Buffer) {
  const { PDFDocument } = await getPdfLib();
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return pdf.getPageCount();
}

async function pdfPageRangeBuffer(input: {
  buffer: Buffer;
  startPage: number;
  endPage: number;
}) {
  const { PDFDocument } = await getPdfLib();
  const source = await PDFDocument.load(input.buffer, { ignoreEncryption: true });
  const target = await PDFDocument.create();
  const pageIndexes = Array.from(
    { length: input.endPage - input.startPage + 1 },
    (_, index) => input.startPage - 1 + index,
  );
  const pages = await target.copyPages(source, pageIndexes);
  for (const page of pages) {
    target.addPage(page);
  }

  return Buffer.from(await target.save());
}

async function shouldUseChunkedPdfDocling(input: {
  buffer: Buffer;
  fileFormat: ParsedUpload["fileFormat"];
}) {
  if (input.fileFormat !== "pdf") {
    return false;
  }

  const mode = doclingPdfChunkingMode();
  if (mode === "off" || mode === "false" || mode === "0") {
    return false;
  }
  if (mode === "on" || mode === "true" || mode === "1") {
    return true;
  }

  try {
    return (await pdfPageCount(input.buffer)) >= doclingPdfChunkThresholdPages();
  } catch {
    return false;
  }
}

async function tryExtractChunkedPdfWithDocling(input: {
  buffer: Buffer;
  fileName: string;
  fileFormat: ParsedUpload["fileFormat"];
  contentType: string;
  role?: ProjectDocumentRole;
  useOcr?: boolean;
  tempDir: string;
}) {
  if (!(await shouldUseChunkedPdfDocling(input))) {
    return null;
  }

  const pageCount = await pdfPageCount(input.buffer);
  const chunkPages = doclingPdfChunkPages();
  const rawParts: string[] = [];
  const sourceMap: SourceMapEntry[] = [];
  let chunkIndex = 0;

  for (let startPage = 1; startPage <= pageCount; startPage += chunkPages) {
    const endPage = Math.min(pageCount, startPage + chunkPages - 1);
    const chunkDir = await mkdtemp(
      path.join(input.tempDir, `chunk-${String(chunkIndex + 1).padStart(3, "0")}-`),
    );
    const chunkPath = path.join(chunkDir, `source-${startPage}-${endPage}.pdf`);
    await writeFile(
      chunkPath,
      await pdfPageRangeBuffer({
        buffer: input.buffer,
        startPage,
        endPage,
      }),
    );

    const converted = await runDoclingConversion({
      inputPath: chunkPath,
      outputDir: chunkDir,
      fileName: `${input.fileName} side ${startPage}-${endPage}`,
      useOcr: input.useOcr,
      tableMode: doclingLargePdfTableMode(),
    });
    const chunkSourceMap = buildDoclingSourceMap({
      doclingJson: converted.doclingJson,
      markdown: converted.markdown,
      role: input.role,
      pageOffset: startPage - 1,
    });
    const chunkText =
      converted.markdown ||
      normalizeText(chunkSourceMap.map((entry) => entry.text).join("\n\n"));

    if (chunkText) {
      rawParts.push(`[[SIDE:${startPage}-${endPage}]]\n${chunkText}`);
    } else {
      console.info(
        JSON.stringify({
          event: "docling_ingestion_chunk_fallback",
          file_name: input.fileName,
          pages: `${startPage}-${endPage}`,
          reason:
            converted.lastError instanceof Error
              ? converted.lastError.message
              : "empty_chunk_output",
        }),
      );
      return null;
    }
    sourceMap.push(...chunkSourceMap);
    chunkIndex += 1;
  }

  const rawText = normalizeText(rawParts.join("\n\n"));
  if (!rawText || !sourceMap.length) {
    return null;
  }

  console.info(
    JSON.stringify({
      event: "docling_ingestion_success",
      file_name: input.fileName,
      file_format: input.fileFormat,
      chars: rawText.length,
      structure_entries: sourceMap.length,
      json: true,
      chunks: chunkIndex,
    }),
  );

  return {
    rawText,
    contentType: input.contentType,
    fileName: input.fileName,
    fileFormat: input.fileFormat,
    fileBase64: input.buffer.toString("base64"),
    sourceMap,
    parserUsed: "docling",
  } satisfies ParsedUpload;
}

async function tryExtractWithDocling(input: {
  buffer: Buffer;
  fileName: string;
  fileFormat: ParsedUpload["fileFormat"];
  contentType: string;
  role?: ProjectDocumentRole;
  useOcr?: boolean;
}): Promise<ParsedUpload | null> {
  if (!isDoclingEnabled()) {
    return null;
  }

  if (!canUseDoclingForFormat(input.fileFormat)) {
    return null;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "anbud-docling-"));
  const suffix = sourceFileExtensionForFormat(input.fileFormat);
  const inputPath = path.join(tempDir, `source${suffix}`);

  try {
    await writeFile(inputPath, input.buffer);
    const chunkedPdf = await tryExtractChunkedPdfWithDocling({
      buffer: input.buffer,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      contentType: input.contentType,
      role: input.role,
      useOcr: input.useOcr,
      tempDir,
    });
    if (chunkedPdf) {
      return chunkedPdf;
    }

    const converted = await runDoclingConversion({
      inputPath,
      outputDir: tempDir,
      fileName: input.fileName,
      useOcr: input.useOcr,
    });
    const { markdown, doclingJson, lastError } = converted;

    const sourceMap = buildDoclingSourceMap({
      doclingJson,
      markdown,
      role: input.role,
    });
    const rawText = markdown || normalizeText(sourceMap.map((entry) => entry.text).join("\n\n"));

    if (!rawText) {
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

    ensureReadableText(rawText, input.fileName);
    console.info(
      JSON.stringify({
        event: "docling_ingestion_success",
        file_name: input.fileName,
        file_format: input.fileFormat,
        chars: rawText.length,
        structure_entries: sourceMap.length,
        json: Boolean(doclingJson),
      }),
    );

    return {
      rawText,
      contentType: input.contentType,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      fileBase64: input.buffer.toString("base64"),
      sourceMap,
      parserUsed: "docling",
    };
  } catch (error) {
    assertProjectWorkflowActive();
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

type DocxTableRow = {
  rowIndex: number;
  cells: string[];
};

function wordAttributeValue(element: Element, localName: string) {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) continue;
    const attributeLocalName =
      attribute.localName || attribute.name.replace(/^.*:/, "");
    if (attributeLocalName === localName) {
      return attribute.value;
    }
  }

  return "";
}

function docxCellGridSpan(cell: Element) {
  const gridSpan = findFirstDescendant(cell, "gridSpan");
  const value = gridSpan ? Number(wordAttributeValue(gridSpan, "val")) : 1;
  return Number.isInteger(value) && value > 1 ? Math.min(value, 20) : 1;
}

function docxCellVerticalMerge(cell: Element): "none" | "restart" | "continue" {
  const verticalMerge = findFirstDescendant(cell, "vMerge");
  if (!verticalMerge) {
    return "none";
  }

  return wordAttributeValue(verticalMerge, "val") === "restart"
    ? "restart"
    : "continue";
}

function extractTableRows(table: Element): DocxTableRow[] {
  const verticalMergeText = new Map<number, string>();

  return childElements(table)
    .filter((child) => elementLocalName(child) === "tr")
    .map((row, rowIndex) => {
      const cells: string[] = [];
      let columnIndex = 0;

      for (const cell of childElements(row)
        .filter((child) => elementLocalName(child) === "tc")
      ) {
        const paragraphText = findDescendants(cell, "p")
          .map(extractParagraphText)
          .filter(Boolean)
          .join(" / ");
        const text =
          paragraphText || normalizeDocxInlineText(readWordText(cell));
        const verticalMerge = docxCellVerticalMerge(cell);
        const gridSpan = docxCellGridSpan(cell);
        const effectiveText =
          verticalMerge === "continue" && !text
            ? verticalMergeText.get(columnIndex) ?? ""
            : text;

        for (let offset = 0; offset < gridSpan; offset += 1) {
          const targetColumn = columnIndex + offset;
          cells[targetColumn] = offset === 0 ? effectiveText.trim() : "";
          if (verticalMerge === "restart") {
            verticalMergeText.set(targetColumn, effectiveText.trim());
          } else if (verticalMerge === "none") {
            verticalMergeText.delete(targetColumn);
          }
        }

        columnIndex += gridSpan;
      }

      return {
        rowIndex: rowIndex + 1,
        cells: cells.map((cell) => cell.trim()),
      };
    })
    .filter((row) => row.cells.some(Boolean));
}

function docxColumnLabel(value: string, index: number) {
  return value.replace(/\s+/g, " ").trim() || `Kolonne ${index + 1}`;
}

function uniqueDocxColumnLabels(values: string[], width: number) {
  const seen = new Map<string, number>();
  const labels: string[] = [];

  for (let index = 0; index < width; index += 1) {
    const baseLabel = docxColumnLabel(values[index] ?? "", index);
    const duplicateCount = seen.get(baseLabel.toLowerCase()) ?? 0;
    seen.set(baseLabel.toLowerCase(), duplicateCount + 1);
    labels.push(
      duplicateCount > 0 ? `${baseLabel} ${duplicateCount + 1}` : baseLabel,
    );
  }

  return labels;
}

function docxTableColumns(rows: DocxTableRow[]) {
  const width = Math.max(0, ...rows.map((row) => row.cells.length));
  if (width <= 0) {
    return [];
  }

  return uniqueDocxColumnLabels(rows[0]?.cells ?? [], width);
}

function docxRowCellMap(columns: string[], cells: string[]) {
  const result: Record<string, string> = {};
  const width = Math.max(columns.length, cells.length);

  for (let index = 0; index < width; index += 1) {
    const value = (cells[index] ?? "").replace(/\s+/g, " ").trim();
    if (!value) {
      continue;
    }

    result[columns[index] ?? `Kolonne ${index + 1}`] = value;
  }

  return result;
}

function docxTableRowText(row: DocxTableRow) {
  return `Rad ${row.rowIndex}: ${row.cells
    .map((cell) => cell.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")}`;
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
        const columns = docxTableColumns(rows);
        const tableText = rows.map(docxTableRowText).join("\n");
        rawBlocks.push(`Tabell ${tableCounter}\n${tableText}`);
        sourceMap.push({
          reference: `${label} – tabell ${tableCounter}`,
          text: tableText,
          kind: "table",
          parser: "docx-xml",
          table_index: tableCounter,
          columns,
        });
        for (const row of rows) {
          sourceMap.push({
            reference: `${label} – tabell ${tableCounter}, rad ${row.rowIndex}`,
            text: docxTableRowText(row),
            kind: "table",
            parser: "docx-xml",
            table_index: tableCounter,
            row_index: row.rowIndex,
            columns,
            cells: docxRowCellMap(columns, row.cells),
          });
        }
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
    assertProjectWorkflowActive();
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
  useDoclingOcr?: boolean;
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
      useOcr: input.useDoclingOcr,
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
  options?: { useDocling?: boolean; useDoclingOcr?: boolean },
): Promise<ParsedUpload> {
  return extractTextFromBuffer({
    buffer: Buffer.from(await file.arrayBuffer()),
    fileName: file.name || "document.txt",
    contentType: file.type || "application/octet-stream",
    role,
    useDocling: options?.useDocling,
    useDoclingOcr: options?.useDoclingOcr,
  });
}
