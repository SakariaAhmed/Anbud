import type { ProjectDocumentDetail } from "@/lib/types";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

const normalizeId = (value: string) => value.replace(/\s+/g, "").toUpperCase();
// Permit only the separator variant of a simple letter/number ID, retaining
// leading zeroes. Both spellings in the source make the alias ambiguous.
const referenceKey = (value: string) => normalizeId(value).replace(/^([A-ZÆØÅ]{1,8})-(\d{1,5})$/u, "$1$2");
const explicitIds = (value: string) =>
  [...value.matchAll(/\b[A-ZÆØÅ]{1,8}[ \t]*-[ \t]*\d{1,5}\b/giu)]
    .map((match) => normalizeId(match[0]));
const answerHeadingIds = (value: string) => {
  const target = /\bsvar\s+på\s+(.+)$/iu.exec(value)?.[1];
  // "S01 – svar på L01" supplies an answer-section label and a distinct
  // requirement reference. Only the explicit target supplies the binding.
  return target
    ? [...target.matchAll(/\b[A-ZÆØÅ]{1,8}[ \t]*-?[ \t]*\d{1,5}\b/giu)].map((match) => normalizeId(match[0]))
    : explicitIds(value);
};

/** Bind explicit answer sections or trailing prose references to source requirements.
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
    const id = referenceKey(entry.id);
    byId.set(id, [...(byId.get(id) ?? []), entry]);
  }
  const result: RequirementLedgerEntry[] = [];
  const counts = new Map<string, number>();
  const text = document.raw_text;
  const addAnswer = (ids: string[], rawExcerpt: string) => {
    for (const id of ids) {
      const key = referenceKey(id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (ids.length !== 1) return;
    const sources = byId.get(referenceKey(ids[0]));
    const excerpt = rawExcerpt.trim();
    if (sources?.length !== 1 || excerpt.length < 30 || excerpt.length > 2400) return;
    result.push({
      ...sources[0],
      answerExcerpt: excerpt,
      sourceExcerpt: excerpt,
      documentId: document.id,
      documentTitle: document.title,
      answerReference: `${document.title}, ${ids[0]}`,
    });
  };

  // Every explicit heading/answer line is a boundary, including unknown IDs.
  // An unknown or ambiguous section must never leak into its known neighbour.
  const boundaries = [...text.matchAll(
    /^[ \t]*(?:#{1,6}[ \t]+[^\n]*|[A-ZÆØÅ]{1,8}[ \t]*-[ \t]*\d{1,5}[ \t]*[:.)–—-][^\n]*)$/gimu,
  )].map((match) => match.index!);
  const starts = [...new Set([0, ...boundaries])];
  const boundarySet = new Set(boundaries);
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const section = text.slice(start, starts[index + 1] ?? text.length);
    const heading = section.split("\n", 1)[0];
    const headingIds = boundarySet.has(start) ? answerHeadingIds(heading) : [];
    if (headingIds.length) {
      const headingLevel = heading.trimStart().match(/^#+/u)?.[0].length;
      if (headingLevel === undefined) {
        // A labelled answer paragraph ends at a blank line. Subsequent
        // unlabelled project context is not evidence exclusively for this ID.
        addAnswer(headingIds, section.split(/\n[ \t]*\n/u, 1)[0]);
        continue;
      }
      const level = headingLevel;
      let next = index + 1;
      for (; next < starts.length; next += 1) {
        const lineEnd = text.indexOf("\n", starts[next]);
        const nextHeading = text.slice(starts[next], lineEnd < 0 ? text.length : lineEnd);
        const nextLevel = nextHeading.trimStart().match(/^#+/u)?.[0].length ?? 7;
        // Nested notes without a new ID are still part of this answer.
        if (answerHeadingIds(nextHeading).length || nextLevel <= level) break;
      }
      addAnswer(headingIds, text.slice(start, starts[next] ?? text.length));
      index = next - 1;
      continue;
    }
    for (const paragraph of section.split(/\n[ \t]*\n/u)) {
      const markers = [...paragraph.matchAll(/\([^()\n]{1,100}\)/gu)]
        .filter((marker) => explicitIds(marker[0]).length > 0);
      let previousEnd = 0;
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
        const marker = markers[markerIndex];
        const markerEnd = marker.index! + marker[0].length;
        const sentenceEnd = /[.!?](?=\s|$)/u.exec(paragraph.slice(markerEnd));
        const end = markers.length === 1 || !sentenceEnd
          ? paragraph.length
          : markerEnd + sentenceEnd.index + 1;
        // Keep a trailing qualification in the same sentence. References to
        // several requirements in that sentence remain ambiguous.
        const ids = explicitIds(marker[0]);
        while (markerIndex + 1 < markers.length && markers[markerIndex + 1].index! < end) {
          markerIndex += 1;
          ids.push(...explicitIds(markers[markerIndex][0]));
        }
        addAnswer(ids, paragraph.slice(previousEnd, end));
        previousEnd = end;
      }
    }
  }
  // Multiple prose references to the same ID are not a single unambiguous answer.
  return result.filter((entry) => counts.get(referenceKey(entry.id)) === 1);
}
