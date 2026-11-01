import "server-only";
import { isRecord } from "@/lib/unknown-values";
import { editRequirementReviewRow, requirementReviewRows } from "@/lib/requirement-review";
import { buildImmutableRequirementRowManifest } from "@/lib/server/artifact-validation";
import { requirementDisplayRef, requirementDisplaySource, requirementGroupHeading, sortRequirementLedgerInDocumentOrder } from "@/lib/server/requirements/presentation";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { GeneratedArtifact, GeneratedArtifactType } from "@/lib/types";
import type { RequirementRegenerationSelection } from "@/lib/requirement-regeneration";
import type { GeneratedArtifactDraft } from "@/lib/server/ai/artifact-generation-types";
const record = (value: unknown) => isRecord(value) ? value : {};
const responseMetadata = (value: unknown) => record(record(value).requirement_response);

export function selectRequirementRegenerationLedger(ledger: RequirementLedgerEntry[], parent: GeneratedArtifact, selection: RequirementRegenerationSelection) {
  if (parent.artifact_type !== ("forbedret_kravsvar" satisfies GeneratedArtifactType) || parent.id !== selection.artifactId || parent.artifact_version !== selection.artifactVersion || !parent.is_current || !parent.source_is_current) throw new Error("Kravbesvarelsen er endret eller bygger på eldre kilder. Last inn på nytt.");
  const sorted = sortRequirementLedgerInDocumentOrder(ledger);
  const fresh = buildImmutableRequirementRowManifest(sorted.map(entry => ({ ref: requirementDisplayRef(entry, requirementGroupHeading(entry)), requirementText: entry.text, sourceLocator: requirementDisplaySource(entry, requirementGroupHeading(entry)), sourceDocumentId: entry.documentId ?? null })));
  const prior = record(responseMetadata(record(parent.input_snapshot).generation_metadata).immutable_row_manifest);
  if (fresh.manifest_sha256 !== prior.manifest_sha256) throw new Error("Kravgrunnlaget er endret. Generer en ny fullstendig kravbesvarelse først.");
  for (const row of selection.rows) if (fresh.rows[row.index]?.row_sha256 !== row.rowHash) throw new Error("Et valgt krav er endret. Last inn kravbesvarelsen på nytt.");
  return selection.rows.map(row => sorted[row.index]);
}

/** Merge editable cells only. Untouched answers and the complete immutable
 * manifest survive, including duplicate IDs and manually written answers. */
export function mergeRegeneratedRequirementRows(parent: GeneratedArtifact, selection: RequirementRegenerationSelection, generated: GeneratedArtifactDraft): GeneratedArtifactDraft {
  const before = requirementReviewRows(parent.content_markdown, parent.input_snapshot);
  const freshMetadata = responseMetadata(generated.generation_metadata);
  const freshSnapshot = { generation_metadata: generated.generation_metadata };
  const replacements = requirementReviewRows(generated.content_markdown, freshSnapshot);
  if (replacements.length !== selection.rows.length || before.length < selection.rows.length) throw new Error("Generatoren returnerte et annet antall krav enn utvalget.");
  const selected = new Set(selection.rows.map(row => row.index));
  const originalIndexes = new Map<number, number>();
  let content = parent.content_markdown;
  replacements.forEach((row, subsetIndex) => {
    // The subset manifest is reindexed; row_sha256 includes the index, so
    // compare literal immutable cells and source identity against the parent.
    const originalIndex = selection.rows[subsetIndex].index;
    const target = before[originalIndex];
    if (!target || target.rowHash !== selection.rows[subsetIndex].rowHash || row.ref !== target.ref || row.requirement !== target.requirement || row.source !== target.source || row.sourceDocumentId !== target.sourceDocumentId) throw new Error("Generatoren endret kravets identitet eller kilde. Ingen svar ble lagret.");
    content = editRequirementReviewRow(content, target, { answer: row.answer, evidence: row.evidence });
    originalIndexes.set(subsetIndex, originalIndex);
  });
  const old = responseMetadata(record(parent.input_snapshot).generation_metadata);
  const merged: Record<string, unknown> = { ...old };
  for (const [rowsKey, refsKey, countKey] of [
    ["deterministic_template_repair_rows", "deterministic_template_repair_refs", "deterministic_template_repair_answers"],
    ["deterministic_control_repair_rows", "deterministic_control_repair_refs", "deterministic_control_repair_answers"],
    ["proposal_input_required_rows", "proposal_input_required_refs", "proposal_input_required_count"],
  ]) {
    const priorRows = Array.isArray(old[rowsKey]) ? old[rowsKey].filter(isRecord) : [];
    // Legacy ref-only warnings cannot be safely assigned to repeated IDs.
    // Keep them conservatively rather than clearing another row's warning.
    const legacyRefs = !priorRows.length && Array.isArray(old[refsKey]) ? old[refsKey].filter((value): value is string => typeof value === "string") : [];
    const freshRows = Array.isArray(freshMetadata[rowsKey]) ? freshMetadata[rowsKey].filter(isRecord) : [];
    const rows: Record<string, unknown>[] = [...priorRows.filter(row => !selected.has(Number(row.order_index))), ...freshRows.map(row => {
      const index = originalIndexes.get(Number(row.order_index));
      if (index === undefined) throw new Error("Kontrollmarkeringen mangler en kjent kravrad.");
      return { ...row, order_index: index };
    })];
    merged[rowsKey] = rows; merged[refsKey] = [...legacyRefs, ...rows.map(row => row.ref)]; merged[countKey] = legacyRefs.length + rows.length;
  }
  const oldFallback = Array.isArray(old.unresolved_fallback_answers) ? old.unresolved_fallback_answers.filter(isRecord) : [];
  const newFallback = Array.isArray(freshMetadata.unresolved_fallback_answers) ? freshMetadata.unresolved_fallback_answers.filter(isRecord) : [];
  const fallback = [...oldFallback.filter(row => !selected.has(Number(row.nr) - 1)), ...newFallback.map(row => {
    const index = originalIndexes.get(Number(row.nr) - 1);
    if (index === undefined) throw new Error("Et ubesvart krav mangler en kjent radidentitet.");
    return { ...row, nr: index + 1 };
  })];
  merged.unresolved_fallback_answers = fallback;
  merged.deterministic_fallback_answers_after_handoff = fallback.length;
  const unexplainedPriorReview = old.manual_review_required === true && !["deterministic_template_repair_answers", "deterministic_control_repair_answers", "proposal_input_required_count", "deterministic_fallback_answers_after_handoff"].some(key => Number(old[key]) > 0);
  merged.manual_review_required = unexplainedPriorReview || fallback.length > 0 || ["deterministic_template_repair_answers", "deterministic_control_repair_answers", "proposal_input_required_count"].some(key => Number(merged[key]) > 0);
  merged.manual_review_note = merged.manual_review_required ? "Kontroller markerte krav mot originalkildene og fyll inn manglende tilbudsinput før innlevering." : undefined;
  merged.selected_regeneration = { parent_artifact_id: parent.id, parent_artifact_version: parent.artifact_version, rows: selection.rows };
  return { title: parent.title, content_markdown: content, generation_metadata: { ...record(record(parent.input_snapshot).generation_metadata), requirement_response: merged } };
}
