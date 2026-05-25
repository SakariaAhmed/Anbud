import "server-only";

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
  };
}

async function extractDocx(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  try {
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
    };
  } catch (error) {
    return extractDocxFromWordXml(buffer, fileName, role, error);
  }
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
  const sourceMap: SourceMapEntry[] = [];
  const sheetTexts: string[] = [];
  const label = documentLabel(role);

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }

    const range = getSheetRange(xlsx, sheet);
    if (!range) {
      continue;
    }

    const rows: string[] = [];
    let lastNonEmptyRow = 0;

    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const cells: string[] = [];

      for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
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
  };
}

export async function extractTextFromUpload(file: File, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  const fileName = file.name || "document.txt";
  const suffix = fileName.toLowerCase();
  const contentType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  if (contentType === "application/pdf" || suffix.endsWith(".pdf")) {
    return extractPdf(buffer, fileName, role);
  }

  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    suffix.endsWith(".docx")
  ) {
    return extractDocx(buffer, fileName, role);
  }

  if (contentType === "application/msword" || suffix.endsWith(".doc")) {
    throw new Error("`.doc` støttes ikke direkte. Lagre dokumentet som `.docx` og last opp på nytt.");
  }

  if (contentType === "text/plain" || suffix.endsWith(".txt")) {
    return extractTxtLike(buffer, fileName, "txt", role);
  }

  if (contentType === "text/markdown" || suffix.endsWith(".md")) {
    return extractTxtLike(buffer, fileName, "md", role);
  }

  if (
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    suffix.endsWith(".xlsx")
  ) {
    return extractSpreadsheet(buffer, fileName, "xlsx", role);
  }

  if (
    contentType === "application/vnd.ms-excel" ||
    contentType === "application/xls" ||
    suffix.endsWith(".xls")
  ) {
    return extractSpreadsheet(buffer, fileName, "xls", role);
  }

  throw new Error("Kun PDF, DOCX, Excel, TXT og Markdown støttes.");
}
