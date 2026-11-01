import "server-only";

import type { ProjectDocumentDetail } from "@/lib/types";

type DocumentTextChunk = {
  label: string;
  text: string;
  references: string[];
};
const CHUNK_TEXT_LIMIT = 6500;
export const MAX_DOCUMENT_CHUNKS = 8;

export function buildDocumentTextChunks(
  document: ProjectDocumentDetail,
  options?: { maxChunks?: number; chunkLimit?: number },
): DocumentTextChunk[] {
  const chunkLimit = options?.chunkLimit ?? CHUNK_TEXT_LIMIT;
  const maxChunks = options?.maxChunks ?? MAX_DOCUMENT_CHUNKS;
  if (!Number.isInteger(chunkLimit) || chunkLimit < 2 || !Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new RangeError("Document chunk limits must be positive integers (text limit at least two).");
  }
  const entries = document.structure_map.length
    ? document.structure_map
    : [{ reference: document.title, text: document.raw_text }];
  const chunks: DocumentTextChunk[] = [];
  let currentText = "";
  let currentReferences: string[] = [];

  function flush() {
    if (!currentText.trim()) {
      return;
    }
    chunks.push({
      label: `${document.title} – del ${chunks.length + 1}`,
      text: currentText,
      references: currentReferences,
    });
    currentText = "";
    currentReferences = [];
  }

  for (const entry of entries) {
    const entryText = entry.text.replace(/\s+/gu, " ").trim();
    if (!entryText) continue;
    // References remain intact in metadata; leave room for source text even
    // when a source has an unusually long reference label.
    const prefix = `${entry.reference.slice(0, Math.min(Math.floor(chunkLimit / 2), chunkLimit - 2))}\n`;
    let offset = 0;
    while (offset < entryText.length && chunks.length < maxChunks) {
      const separator = currentText ? "\n\n" : "";
      const available = chunkLimit - currentText.length - separator.length - prefix.length;
      if (available <= 0) { flush(); continue; }
      const fragment = entryText.slice(offset, offset + available);
      currentText += `${separator}${prefix}${fragment}`;
      if (!currentReferences.includes(entry.reference)) currentReferences.push(entry.reference);
      offset += fragment.length;
      if (offset < entryText.length || currentText.length >= chunkLimit) flush();
    }
    if (chunks.length >= maxChunks) break;
  }

  flush();
  return chunks.slice(0, maxChunks);
}
