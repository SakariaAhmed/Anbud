import type { ProjectDocument } from "@/lib/types";

function normalizeReferenceText(value: string) {
  return value.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o").replace(/æ/g, "ae")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

export function findDocumentForReference<T extends Pick<ProjectDocument, "id" | "role" | "title" | "file_name">>(
  documents: T[],
  sourceReference: string,
): T | null {
  const reference = normalizeReferenceText(sourceReference);
  if (!reference) return null;

  const role = /\b(?:kundedokument|customer document)\b/.test(reference)
    ? "primary_customer_document"
    : /\b(?:losningsdokument|solution document)\b/.test(reference)
      ? "primary_solution_document"
      : null;
  const candidates = role ? documents.filter((document) => document.role === role) : documents;
  if (role && candidates.length === 1) return candidates[0];

  const tokens = reference.split(" ").filter((token) => token.length >= 3);
  let bestMatch: { document: T; score: number } | null = null;
  let tied = false;
  for (const document of candidates) {
    let score = 0;
    for (const candidate of [document.title, document.file_name].map(normalizeReferenceText).filter(Boolean)) {
      if (candidate === reference) score = Math.max(score, 100);
      else if (candidate.includes(reference) || reference.includes(candidate)) score = Math.max(score, 70);
      for (const token of tokens) {
        if (candidate.includes(token)) score += 12;
      }
    }
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { document, score };
      tied = false;
    } else if (score === bestMatch.score) {
      tied = true;
    }
  }
  return bestMatch && bestMatch.score >= 24 && !tied ? bestMatch.document : null;
}
