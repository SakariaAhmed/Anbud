import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("../../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { selectRequirementRegenerationLedger, mergeRegeneratedRequirementRows } = load("./requirement-response-regeneration.ts");
const { buildImmutableRequirementRowManifest } = load("../artifact-validation.ts");
const { requirementDisplayRef, requirementDisplaySource, requirementGroupHeading, sortRequirementLedgerInDocumentOrder } = load("../requirements/presentation.ts");
const { parseRequirementRegeneration } = load("../../requirement-regeneration.ts");
const { requirementReviewRows } = load("../../requirement-review.ts");
const ledger = sortRequirementLedgerInDocumentOrder([0, 1, 2].map(index => ({ id: "K1", text: `Leverandøren skal utføre oppgave ${index + 1}.`, documentId: `document-${index}`, documentTitle: `Dokument ${index}`, heading: "Drift", pages: [index + 1], source: "structured", orderIndex: index })));
function draft(entries, answers) {
  const manifest = buildImmutableRequirementRowManifest(entries.map(entry => ({ ref: requirementDisplayRef(entry, requirementGroupHeading(entry)), requirementText: entry.text, sourceLocator: requirementDisplaySource(entry, requirementGroupHeading(entry)), sourceDocumentId: entry.documentId })));
  const content = ["## Drift", "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |", "| --- | --- | --- | --- | --- |", ...entries.map((entry, index) => `| ${manifest.rows[index].ref} | ${entry.text} | ${answers[index]} | Bevis ${index} | ${requirementDisplaySource(entry, requirementGroupHeading(entry))} |`)].join("\n");
  return { title: "Kravbesvarelse", content_markdown: content, generation_metadata: { requirement_response: { immutable_row_manifest: manifest, total_requirements: entries.length, requirement_refs: manifest.rows.map(row => row.ref), coverage_enforced: true, source_evidence_enforced: true } } };
}
const original = draft(ledger, ["Manuelt svar A", "Gammelt svar B", "Manuelt svar C"]);
const parent = { ...original, id: "00000000-0000-4000-8000-000000000001", artifact_type: "forbedret_kravsvar", artifact_version: 3, is_current: true, source_is_current: true, input_snapshot: { generation_metadata: original.generation_metadata } };
const selected = { artifactId: parent.id, artifactVersion: 3, rows: [{ index: 1, rowHash: original.generation_metadata.requirement_response.immutable_row_manifest.rows[1].row_sha256 }] };
test("selected regeneration binds a full current manifest and rejects stale, changed or ambiguous identities", () => {
  assert.deepEqual(selectRequirementRegenerationLedger(ledger, parent, selected), [ledger[1]]);
  assert.throws(() => selectRequirementRegenerationLedger(ledger, { ...parent, is_current: false }, selected), /endret/u);
  assert.throws(() => selectRequirementRegenerationLedger(ledger, parent, { ...selected, rows: [{ index: 0, rowHash: selected.rows[0].rowHash }] }), /valgt krav/u);
  assert.throws(() => selectRequirementRegenerationLedger([{ ...ledger[0], text: "Endret krav" }, ...ledger.slice(1)], parent, selected), /Kravgrunnlaget/u);
  assert.throws(() => parseRequirementRegeneration({ ...selected, rows: [selected.rows[0], selected.rows[0]] }), /flere ganger/u);
});
test("only the selected answer changes and repair identities are remapped to the original row", () => {
  const generated = draft([ledger[1]], ["Nytt svar B"]);
  generated.generation_metadata.requirement_response.deterministic_control_repair_rows = [{ ref: "K1", order_index: 0, source_document_id: ledger[1].documentId, source_locator: "Drift" }];
  const merged = mergeRegeneratedRequirementRows(parent, selected, generated, ledger);
  const rows = requirementReviewRows(merged.content_markdown, { generation_metadata: merged.generation_metadata });
  assert.deepEqual(rows.map(row => row.answer), ["Manuelt svar A", "Nytt svar B", "Manuelt svar C"]);
  assert.deepEqual(merged.generation_metadata.requirement_response.immutable_row_manifest, original.generation_metadata.requirement_response.immutable_row_manifest);
  assert.equal(merged.generation_metadata.requirement_response.deterministic_control_repair_rows[0].order_index, 1);
  const before = parent.content_markdown.split("\n"), after = merged.content_markdown.split("\n");
  for (let index = 0; index < before.length; index++) if (index !== rows[1].lineIndex) assert.equal(after[index], before[index]);
  assert.throws(() => mergeRegeneratedRequirementRows(parent, selected, draft([ledger[2]], ["Feil dokument"]), ledger), /identitet/u);
});

test("mixed legacy and indexed warnings remain visible after selected regeneration", () => {
  const originalDraft = draft(ledger, ["Svar A", "Svar B", "Svar C"]);
  originalDraft.generation_metadata.requirement_response.deterministic_control_repair_refs = ["K1"];
  originalDraft.generation_metadata.requirement_response.manual_review_required = true;
  const legacyParent = { ...parent, content_markdown: originalDraft.content_markdown, input_snapshot: { generation_metadata: originalDraft.generation_metadata } };
  const generated = draft([ledger[1]], ["Nytt svar"]);
  generated.generation_metadata.requirement_response.deterministic_control_repair_rows = [{ ref: "K1", order_index: 0, source_document_id: ledger[1].documentId }];
  const merged = mergeRegeneratedRequirementRows(legacyParent, selected, generated, ledger);
  const rows = requirementReviewRows(merged.content_markdown, { generation_metadata: merged.generation_metadata });
  assert.equal(rows[0].needsReview, true, "an untouched repeated-ID legacy warning remains conservatively visible");
  assert.equal(rows[1].needsReview, true);
  assert.equal(merged.generation_metadata.requirement_response.deterministic_control_repair_refs.length, 2);
});

test("selected clarification duplicates are refreshed by original row identity, preserving unselected clarification text", () => {
  const clarificationLedger = ledger.map(entry => ({ ...entry, heading: "Avklaringspunkt" }));
  const originalDraft = draft(clarificationLedger, ["Gammel avklaring A", "Gammel avklaring B", "Gammel avklaring C"]);
  const manifest = originalDraft.generation_metadata.requirement_response.immutable_row_manifest;
  const text = `${originalDraft.content_markdown}\n\n## Avklaringspunkter\n\n${manifest.rows.map((row, index) => `- **${row.ref}:** Gammel avklaring ${String.fromCharCode(65 + index)}`).join("\n")}\n`;
  const prior = { ...parent, content_markdown: text, input_snapshot: { generation_metadata: originalDraft.generation_metadata } };
  const selection = { ...selected, rows: [{ index: 1, rowHash: manifest.rows[1].row_sha256 }] };
  const merged = mergeRegeneratedRequirementRows(prior, selection, draft([clarificationLedger[1]], ["Ny avklaring B"]), clarificationLedger);
  assert.doesNotMatch(merged.content_markdown, /Gammel avklaring B/u);
  assert.match(merged.content_markdown, /Ny avklaring B/u);
  assert.match(merged.content_markdown, /Gammel avklaring A/u);
  assert.match(merged.content_markdown, /Gammel avklaring C/u);
  assert.match(merged.content_markdown, /Se svar i kravtabellen, rad 2/u);
});
