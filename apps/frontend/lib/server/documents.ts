import "server-only";

import type { ProjectDocumentRole } from "@/lib/types";

export interface SourceMapEntry {
  reference: string;
  text: string;
}

export interface ParsedUpload {
  rawText: string;
  contentType: string;
  fileName: string;
  fileFormat: "pdf" | "docx" | "txt" | "md";
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

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
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

async function extractPdf(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  let pageNumber = 0;
  const pageEntries: SourceMapEntry[] = [];
  const label = documentLabel(role);

  const pdfParse = await getPdfParse();
  const parsed = await pdfParse(buffer, {
      pagerender: (pageData: {
        getTextContent: (options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{
          items: Array<{ str: string; transform: number[] }>;
        }>;
      }) => {
        pageNumber += 1;
        return pageData
          .getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false,
          })
          .then((textContent) => {
            let lastY: number | undefined;
            let text = "";

            for (const item of textContent.items as Array<{ str: string; transform: number[] }>) {
              if (!lastY || lastY === item.transform[5]) {
                text += item.str;
              } else {
                text += `\n${item.str}`;
              }
              lastY = item.transform[5];
            }

            const normalized = normalizeText(text);
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

  return {
    rawText: normalizeText(parsed.text),
    contentType: "application/pdf",
    fileName,
    fileFormat: "pdf",
    fileBase64: buffer.toString("base64"),
    sourceMap: pageEntries.filter((entry) => entry.text),
  };
}

async function extractDocx(buffer: Buffer, fileName: string, role?: ProjectDocumentRole): Promise<ParsedUpload> {
  const mammoth = await getMammoth();
  const result = await mammoth.extractRawText({ buffer });
  const rawText = normalizeText(result.value);

  return {
    rawText,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName,
    fileFormat: "docx",
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText, role),
  };
}

async function extractTxtLike(buffer: Buffer, fileName: string, fileFormat: "txt" | "md", role?: ProjectDocumentRole): Promise<ParsedUpload> {
  const rawText = normalizeText(buffer.toString("utf-8"));

  return {
    rawText,
    contentType: fileFormat === "md" ? "text/markdown" : "text/plain",
    fileName,
    fileFormat,
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText, role),
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

  throw new Error("Kun PDF, DOCX, TXT og Markdown støttes.");
}
