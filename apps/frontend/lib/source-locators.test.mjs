import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { unsupportedSourceLocators } = load("./source-locators.ts");
const { bindDocumentSourceEvidence } = load("./server/document-source-evidence.ts");
const { validateChatEvidence } = load("./server/source-evidence.ts");
const { reviewStructuredOutputEvidence } = load("./server/output-source-evidence.ts");
const document = { id: "doc", title: "Krav", chunk_source_revision: 1, raw_text: "[[SIDE:2]]\nData skal lagres i Norge.", structure_map: [] };
const source = bindDocumentSourceEvidence(document, "Data skal lagres i Norge.");
test("recognized page and heading precision must match actual source-derived locations", () => {
  assert.deepEqual(unsupportedSourceLocators("på den ene side er dette vanskelig", []), []);
  assert.deepEqual(unsupportedSourceLocators("på side 2", [source]), []);
  for (const text of ["på side 3", "se s. 19", "side 2–3", "side 0", "kapittel 4", "avsnitt «Drift»"]) assert.ok(unsupportedSourceLocators(text, [source]).length, text);
  assert.deepEqual(unsupportedSourceLocators("kapittel 4", [{ ...source, heading_path: ["4 Drift"] }]), []);
  assert.ok(unsupportedSourceLocators("side 2", [{ ...source, page_start: null, page_end: null }]).length);
});
test("correct quotation does not excuse a wrong prose page in chat or structured output", () => {
  assert.throws(() => validateChatEvidence("På side 3 står «Data skal lagres i Norge.» [Kilde 1]", [source]), /side-/u);
  assert.equal(validateChatEvidence("På side 2 står «Data skal lagres i Norge.» [Kilde 1]", [source]).length, 1);
  const reviewed = reviewStructuredOutputEvidence({ rows: [{ reference: "Side 3", evidence: "Data skal lagres i Norge.", answer: "Data skal lagres i Norge." }] }, { documents: [{ document, sourceType: "project_document" }] });
  assert.match(reviewed.result.rows[0].reference, /ikke bekreftet/u);
  assert.equal(reviewed.result.rows[0].answer, "Data skal lagres i Norge.");
  assert.equal(reviewed.evidence.issues[0].code, "unverified_locator");
  assert.ok(reviewed.evidence.references.some(ref => ref.path === "result.rows.0.evidence"));
});
