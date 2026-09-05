import type { ProjectDocumentDetail } from "@/lib/types";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

const normalizeId = (value: string) => value.replace(/\s+/g, "").toUpperCase();

/** Bind trailing, explicit references in prose to unique source requirements.
 * Repeated IDs across source sections remain ambiguous and are not guessed.
 * Excerpts retain the original supplier wording, including qualifications.
 */
export function narrativeAnswerEvidence(
  document: ProjectDocumentDetail,
  requirements: RequirementLedgerEntry[],
): RequirementLedgerEntry[] {
  if (!["txt", "md", "docx"].includes(document.file_format)) return [];
  const byId = new Map<string, RequirementLedgerEntry[]>();
  for (const entry of requirements) {
    const id = normalizeId(entry.id);
    byId.set(id, [...(byId.get(id) ?? []), entry]);
  }
  const result: RequirementLedgerEntry[] = [];
  let previousEnd = 0;
  const text = document.raw_text;
  for (const marker of text.matchAll(/\([^()\n]{1,100}\)/gu)) {
    const ids = [...marker[0].matchAll(/\b[A-ZÆØÅ]{1,8}\s*-\s*\d{1,5}\b/giu)]
      .map((match) => normalizeId(match[0]));
    if (ids.length !== 1) continue;
    const sources = byId.get(ids[0]);
    const end = marker.index! + marker[0].length;
    const excerpt = text.slice(previousEnd, end).replace(/^[\s.]+/, "").trim();
    previousEnd = end;
    if (sources?.length !== 1 || excerpt.length < 30 || excerpt.length > 2400) continue;
    result.push({
      ...sources[0],
      answerExcerpt: excerpt,
      sourceExcerpt: excerpt,
      documentId: document.id,
      documentTitle: document.title,
      answerReference: `${document.title}, ${sources[0].id}`,
    });
  }
  // Multiple prose references to the same ID are not a single unambiguous answer.
  return result.filter((entry) => result.filter((other) =>
    normalizeId(other.id) === normalizeId(entry.id)).length === 1);
}
