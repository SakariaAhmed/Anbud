import "server-only";

import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import { DocumentRole } from "@/lib/types";

export interface SourceMapEntry {
  reference: string;
  text: string;
}

export interface ParsedUpload {
  rawText: string;
  contentType: string;
  fileName: string;
  fileFormat: "pdf" | "docx" | "txt";
  fileBase64: string;
  sourceMap: SourceMapEntry[];
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildTextSourceMap(text: string) {
  const lines = normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: SourceMapEntry[] = [];
  let currentReference = "Tekstblokk 1";
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
    if (/^(kapittel|section|del|vedlegg)\b/i.test(line) || /^\d+(\.\d+)*\s+\S+/.test(line)) {
      flush();
      currentReference = line;
      continue;
    }

    currentLines.push(line);
    if (currentLines.length >= 12) {
      flush();
      counter += 1;
      currentReference = `Tekstblokk ${counter}`;
    }
  }

  flush();
  return sections.length ? sections : [{ reference: "Tekstblokk 1", text: normalizeText(text) }];
}

function bilagLabel(documentRole?: DocumentRole) {
  return documentRole === "bilag2" ? "Bilag 2" : "Bilag 1";
}

async function extractPdf(buffer: Buffer, fileName: string, documentRole?: DocumentRole): Promise<ParsedUpload> {
  let pageNumber = 0;
  const pageEntries: SourceMapEntry[] = [];
  const sourceLabel = bilagLabel(documentRole);

  const parsed = await (pdfParse as unknown as (buffer: Buffer, options: Record<string, unknown>) => Promise<{ text: string }>)(
    buffer,
    {
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
          pageEntries.push({
            reference: `${sourceLabel} – side ${pageNumber}`,
            text: normalized,
          });

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

async function extractDocx(buffer: Buffer, fileName: string): Promise<ParsedUpload> {
  const result = await mammoth.extractRawText({ buffer });
  const rawText = normalizeText(result.value);

  return {
    rawText,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileName,
    fileFormat: "docx",
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText),
  };
}

async function extractTxt(buffer: Buffer, fileName: string): Promise<ParsedUpload> {
  const rawText = normalizeText(buffer.toString("utf-8"));

  return {
    rawText,
    contentType: "text/plain",
    fileName,
    fileFormat: "txt",
    fileBase64: buffer.toString("base64"),
    sourceMap: buildTextSourceMap(rawText),
  };
}

export async function extractTextFromUpload(file: File, documentRole?: DocumentRole): Promise<ParsedUpload> {
  const fileName = file.name || "document.txt";
  const suffix = fileName.toLowerCase();
  const contentType = file.type || "application/octet-stream";
  const buffer = Buffer.from(await file.arrayBuffer());

  if (contentType === "application/pdf" || suffix.endsWith(".pdf")) {
    return extractPdf(buffer, fileName, documentRole);
  }

  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    suffix.endsWith(".docx")
  ) {
    return extractDocx(buffer, fileName);
  }

  if (contentType === "application/msword" || suffix.endsWith(".doc")) {
    throw new Error("`.doc` støttes ikke direkte. Lagre dokumentet som `.docx` og last opp på nytt.");
  }

  if (contentType === "text/plain" || suffix.endsWith(".txt")) {
    return extractTxt(buffer, fileName);
  }

  throw new Error("Kun PDF, DOCX og TXT støttes.");
}
