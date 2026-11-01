import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { bindDocumentSourceEvidence } = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname, "server-only": "/dev/null" } })("./document-source-evidence.ts");
const document = { id: "document", title: "Fiktive krav", chunk_source_revision: 7, role: "primary_customer_document", raw_text: "[[SIDE:2]]\nK-1 Leverandøren skal lagre data i Norge.\n[[SIDE:3]]\nK-2 Logger skal bevares i ett år.", structure_map: [] };
test("source drawers bind original quote, source revision and explicit page markers", () => {
  const source = bindDocumentSourceEvidence(document, "K-1 Leverandøren skal lagre data i Norge.");
  assert.equal(source.page_start, 2); assert.equal(source.source_revision, 7); assert.equal(source.classification, "documented");
  assert.equal(source.original_quote, "K-1 Leverandøren skal lagre data i Norge.");
  assert.ok(source.evidence_id); assert.equal(source.source_fingerprint.length, 64);
  assert.equal(bindDocumentSourceEvidence(document, "K-1 Leverandøren skal lagre data i Sverige."), null);
});
test("repeated quotes or absent page markers never manufacture a page or heading", () => {
  const repeated = { ...document, raw_text: `${document.raw_text}\n[[SIDE:9]]\nK-1 Leverandøren skal lagre data i Norge.` };
  const source = bindDocumentSourceEvidence(repeated, "K-1 Leverandøren skal lagre data i Norge.");
  assert.equal(source.page_start, null); assert.deepEqual(source.heading_path, []);
  assert.equal(bindDocumentSourceEvidence({ ...document, raw_text: "K-1 Leverandøren skal lagre data i Norge." }, "K-1 Leverandøren skal lagre data i Norge.").page_start, null);
});
