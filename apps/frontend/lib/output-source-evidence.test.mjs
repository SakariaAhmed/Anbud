import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { parseOutputSourceEvidence } = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } })("./output-source-evidence.ts");
test("output evidence boundary requires stable original proof and retains generated interpretation", () => {
  const source = { source_type: "generated_artifact", source_id: "draft", document_title: "Forslag", reference: "Exit", heading_path: ["Exit"], evidence_id: "E-one", original_quote: "Et forslag", source_revision: 3, source_fingerprint: "hash", classification: "interpretation", page_start: null, page_end: null };
  const value = { version: 1, references: [{ path: "result.summary", source }] };
  assert.deepEqual(parseOutputSourceEvidence(value), value);
  for (const invalid of [null, { ...value, version: 2 }, { version: 1, references: [{ path: "x", source: { ...source, source_revision: undefined } }] }, { version: 1, references: [{ path: "x", source: { ...source, evidence_id: undefined } }] }]) assert.equal(parseOutputSourceEvidence(invalid).references.length, 0);
});
