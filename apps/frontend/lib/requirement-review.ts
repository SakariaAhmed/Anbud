import { isMarkdownTableDivider, splitMarkdownTableRow } from "@/lib/markdown-table-row";
import { requirementResponseTableColumns } from "@/lib/requirement-response-table";
import { requirementResponseArtifactMetadata } from "@/lib/requirement-response-metadata";
import { isRecord } from "@/lib/unknown-values";

export type RequirementReviewRow = {
  key: string; index: number; lineIndex: number; rawLine: string; ref: string; group: string;
  requirement: string; answer: string; evidence: string; source: string;
  sourceDocumentId?: string; sourceLocator?: string; rowHash?: string;
  needsReview: boolean; unanswered: boolean; missingSource: boolean;
  columns: ReturnType<typeof requirementResponseTableColumns>;
};

const normalized = (value: string) => value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("nb");
export function requirementReviewRows(content: string, inputSnapshot?: unknown): RequirementReviewRow[] {
  const metadata = requirementResponseArtifactMetadata(inputSnapshot);
  const snapshot = isRecord(inputSnapshot) ? inputSnapshot : {};
  const generation = isRecord(snapshot.generation_metadata) ? snapshot.generation_metadata : {};
  const response = isRecord(generation.requirement_response) ? generation.requirement_response : {};
  const manifest = isRecord(response.immutable_row_manifest) ? response.immutable_row_manifest : {};
  const manifestRows = Array.isArray(manifest.rows) ? manifest.rows.filter(isRecord) : [];
  const lines = content.split("\n");
  const result: RequirementReviewRow[] = [];
  let group = "Kravliste";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const heading = lines[lineIndex].match(/^#{2,6}\s+(.+)$/u);
    if (heading) group = heading[1].trim();
    const columns = requirementResponseTableColumns(splitMarkdownTableRow(lines[lineIndex]));
    if ([columns.refIndex, columns.requirementIndex, columns.answerIndex, columns.sourceIndex].some(index => index < 0) || !isMarkdownTableDivider(lines[lineIndex + 1] ?? "")) continue;
    lineIndex += 2;
    while (lineIndex < lines.length && /^\s*\|/u.test(lines[lineIndex])) {
      const rawLine = lines[lineIndex], cells = splitMarkdownTableRow(rawLine);
      if (cells[columns.requirementIndex]?.trim()) {
        const index = result.length;
        const ref = cells[columns.refIndex] ?? "";
        const answer = cells[columns.answerIndex] ?? "";
        const source = cells[columns.sourceIndex] ?? "";
        const entry = manifestRows[index];
        // Only attach identity from the same immutable row, never another row
        // with a repeated local reference in a different document.
        const identity = entry && normalized(String(entry.ref ?? "")) === normalized(ref) ? entry : undefined;
        const matches = (row: { ref: string; orderIndex?: number; sourceLocator?: string }) => row.orderIndex !== undefined
          ? row.orderIndex === index : normalized(row.ref) === normalized(ref) && (!row.sourceLocator || normalized(source).includes(normalized(row.sourceLocator)));
        const flagged = (entries: Array<{ ref: string; orderIndex?: number; sourceLocator?: string }>, refs: string[]) => entries.some(matches) || refs.some(reference => normalized(reference) === normalized(ref));
        const unanswered = !answer.trim() || /^(?:-|—|ikke besvart|mangler svar)$/iu.test(answer.trim());
        const missingSource = !source.trim() || /^(?:-|—|ukjent|mangler|ikke oppgitt)$/iu.test(source.trim());
        const needsReview = unanswered || missingSource || flagged(metadata.templateRepairRows, metadata.templateRepairLegacyRefs) || flagged(metadata.controlRepairRows, metadata.controlRepairLegacyRefs) || flagged(metadata.proposalInputRequiredRows, metadata.proposalInputRequiredLegacyRefs) || metadata.unresolvedFallbackAnswers.some(row => row.nr === index + 1) ||
          /\b(?:må avklares|trenger tilbudsinput|ikke dokumentert|kan ikke bekreftes)\b/iu.test(answer);
        result.push({ key: `${index}:${ref}`, index, lineIndex, rawLine, ref, group, requirement: cells[columns.requirementIndex] ?? "", answer,
          evidence: columns.evidenceIndex >= 0 ? cells[columns.evidenceIndex] ?? "" : "", source, columns,
          sourceDocumentId: typeof identity?.source_document_id === "string" ? identity.source_document_id : undefined,
          sourceLocator: typeof identity?.source_locator === "string" ? identity.source_locator : undefined,
          rowHash: typeof identity?.row_sha256 === "string" ? identity.row_sha256 : undefined,
          needsReview, unanswered, missingSource });
      }
      lineIndex++;
    }
    lineIndex--;
  }
  return result;
}

/** Update only the editable cells of one exact row. Preserve all other lines,
 * row identities, requirements, locators and escaped pipe characters. The server
 * still validates the immutable manifest and authoritative parent version. */
export function editRequirementReviewRow(content: string, row: RequirementReviewRow, value: { answer: string; evidence: string }): string {
  const lines = content.split("\n");
  if (lines[row.lineIndex] !== row.rawLine) throw new Error("Kravbesvarelsen er endret. Last inn på nytt før du lagrer.");
  const cells = splitMarkdownTableRow(row.rawLine);
  cells[row.columns.answerIndex] = value.answer.replace(/\r?\n/gu, "<br>");
  if (row.columns.evidenceIndex >= 0) cells[row.columns.evidenceIndex] = value.evidence.replace(/\r?\n/gu, "<br>");
  lines[row.lineIndex] = `| ${cells.map(cell => cell.replace(/\|/gu, "\\|")).join(" | ")} |`;
  return lines.join("\n");
}
