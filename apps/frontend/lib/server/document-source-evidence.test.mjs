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

test("short numeric quotations retain original context while ordinary labels never become proof", () => {
  const input = { ...document, raw_text: "[[SIDE:4]]\nLeverandøren skal levere eksport innen 30 dager.\nSvarfelt: Ja.", structure_map: [] };
  const source = bindDocumentSourceEvidence(input, "30 dager");
  assert.equal(source.original_quote, "Leverandøren skal levere eksport innen 30 dager.");
  assert.equal(source.page_start, 4);
  assert.equal(bindDocumentSourceEvidence(input, "Ja"), null);
  assert.equal(bindDocumentSourceEvidence({ ...input, raw_text: "30 dager" }, "30 dager"), null);
  assert.equal(bindDocumentSourceEvidence({ ...input, raw_text: "Fristen er 130 dager." }, "30 dager"), null);
  const later = { ...input, raw_text: "Den gamle fristen var 130 dager.\nDen nye fristen er 30 dager." };
  assert.equal(bindDocumentSourceEvidence(later, "30 dager").original_quote, "Den nye fristen er 30 dager.");
});

test("a quoted numeric value cannot be the fractional tail of a decimal", () => {
  assert.equal(bindDocumentSourceEvidence({ ...document, raw_text: "Tilgjengeligheten skal være 99,99 %." }, "99 %"), null);
  assert.equal(bindDocumentSourceEvidence({ ...document, raw_text: "Fristen er 1,30 dager." }, "30 dager"), null);
  assert.ok(bindDocumentSourceEvidence({ ...document, raw_text: "Tilgjengeligheten skal være 99,99 %." }, "99,99 %"));
});
