import "server-only";

import pdfParse from "pdf-parse/lib/pdf-parse.js";

export async function extractTextFromUpload(file: File): Promise<{ rawText: string; contentType: string; fileName: string }> {
  const fileName = file.name || "document.txt";
  const suffix = fileName.toLowerCase();
  const contentType = file.type || "application/octet-stream";

  if (contentType === "application/pdf" || suffix.endsWith(".pdf")) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buffer);
    return {
      rawText: parsed.text.trim(),
      contentType: "application/pdf",
      fileName
    };
  }

  if (contentType === "text/plain" || suffix.endsWith(".txt")) {
    const buffer = Buffer.from(await file.arrayBuffer());
    return {
      rawText: buffer.toString("utf-8").trim(),
      contentType: "text/plain",
      fileName
    };
  }

  throw new Error("Only PDF and TXT files are supported");
}
