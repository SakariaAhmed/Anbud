import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const { requirementReviewRows, editRequirementReviewRow } = load("./requirement-review.ts");
const { projectFollowUpItems } = load("./project-follow-up.ts");
const content = `# Besvarelse

## Drift
| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |
| --- | --- | --- | --- | --- |
| K1 | Eksport A \\| B | Må avklares | Ikke dokumentert | Side 2 |
| K1 | Logger |  |  | - |

Uendret avslutning.
`;
const snapshot = { generation_metadata: { requirement_response: { immutable_row_manifest: { rows: [
  { ref: "K1", source_document_id: "a", source_locator: "Side 2", row_sha256: "a" },
  { ref: "K1", source_document_id: "b", source_locator: "Side 9", row_sha256: "b" },
] }, deterministic_control_repair_rows: [{ ref: "K1", order_index: 1, source_document_id: "b" }] } } };
test("review retains repeated row identity and flags unanswered or unsupported answers", () => {
  const rows = requirementReviewRows(content, snapshot);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].key, rows[1].key);
  assert.equal(rows[0].sourceDocumentId, "a"); assert.equal(rows[1].sourceDocumentId, "b");
  assert.equal(rows[0].requirement, "Eksport A | B");
  assert.equal(rows[0].needsReview, true); assert.equal(rows[1].unanswered, true); assert.equal(rows[1].missingSource, true);
});
test("editing one answer preserves immutable cells and all other lines byte for byte", () => {
  const rows = requirementReviewRows(content, snapshot);
  const edited = editRequirementReviewRow(content, rows[0], { answer: "Ja, A | B", evidence: "Original\\sti\nNeste linje" });
  const next = requirementReviewRows(edited, snapshot);
  assert.equal(next[0].answer, "Ja, A | B"); assert.equal(next[0].evidence, "Original\\sti<br>Neste linje");
  assert.equal(next[0].requirement, rows[0].requirement); assert.equal(next[0].source, rows[0].source);
  const oldLines = content.split("\n"), newLines = edited.split("\n");
  for (let index = 0; index < oldLines.length; index++) if (index !== rows[0].lineIndex) assert.equal(newLines[index], oldLines[index]);
  assert.throws(() => editRequirementReviewRow(edited, rows[0], { answer: "stale", evidence: "" }), /endret/u);
});
test("follow-up excludes historical or stale artifacts and retains missing coverage and clarifications", () => {
  const artifact = { id: "current", artifact_type: "forbedret_kravsvar", content_markdown: content, input_snapshot: snapshot, is_current: true, source_is_current: true };
  const items = projectFollowUpItems({ artifacts: [artifact, { ...artifact, id: "old", is_current: false }, { ...artifact, id: "stale", source_is_current: false }], analysis: { ambiguities: ["Hvem eier migreringen?"] }, evaluation: { missing_elements: ["Akseptanseplan"], requirement_coverage: { items: [ { reference: "K2", assessment: "Mangler", rationale: "Ingen plan", recommendation: "Beskriv planen" }, { reference: "K3", assessment: "Godt" } ] } } });
  assert.equal(items.filter(item => item.kind === "requirement").length, 2);
  assert.equal(items.filter(item => item.kind === "coverage").length, 2);
  assert.equal(items.filter(item => item.kind === "clarification").length, 1);
  assert.ok(items.every(item => item.nextAction));
});
