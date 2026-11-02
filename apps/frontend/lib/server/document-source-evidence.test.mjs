import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const app = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { bindDocumentSourceEvidence } = app("./document-source-evidence.ts");
const { validateChatEvidence, sourceEvidenceExcerpt, SourceQuoteIndex } = app("./source-evidence.ts");
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

test("saved long-source citations round-trip through the strict drawer binder at every window offset", () => {
  for (let offset = 0; offset < 40; offset++) {
    const raw_text = "Innledning. " + "x".repeat(offset) + " " + "Driftsdokumentasjon og beredskapsplanlegging. ".repeat(160) + "Gjeldende responstid er 30 dager. " + "Kontraktsforvaltning og systemovervåking. ".repeat(80);
    const doc = { ...document, raw_text, structure_map: [] };
    for (const answer of ["Fristen er «30 dager». [Kilde 1]", "Driftsdokumentasjon er beskrevet. [Kilde 1]"]) {
      const saved = validateChatEvidence(answer, [{ source_type: "project_document", evidence_id: "long-doc", original_quote: raw_text }]);
      for (const quote of [saved[0].original_quote, ...(saved[0].quotation_excerpts ?? [])]) {
        const checked = bindDocumentSourceEvidence(doc, quote);
        assert.ok(checked, `offset ${offset} must remain verifiable`); assert.equal(checked.original_quote, quote);
      }
    }
  }
  const raw_text = "Rammen for avtalen er 1 500 000 kr og avtalen løper i tre år.";
  const quote = sourceEvidenceExcerpt(raw_text, 2, raw_text.indexOf("1 500") + 1);
  assert.match(quote, /1 500 000/u); assert.ok(bindDocumentSourceEvidence({ ...document, raw_text, structure_map: [] }, quote));
  assert.equal(sourceEvidenceExcerpt("x".repeat(20_000), 10_000, 11_000), null, "Unbroken source text cannot bypass the excerpt size bound.");
});
test("normalized repetitions never acquire a unique short-value locator in either order", () => {
  for (const raw_text of ["Leveransen tar 30\u00a0dager.\nKontrollen tar 30 dager.", "Leveransen tar 30 dager.\nKontrollen tar 30\u00a0dager."]) {
    assert.equal(bindDocumentSourceEvidence({ ...document, raw_text, structure_map: [] }, "30 dager"), null);
  }
});
test("whitespace-variant repeated passages never acquire a unique page or heading in either order", () => {
  const plain = "Leverandøren skal lagre data i Norge.";
  const wrapped = "Leverandøren skal\nlagre data i Norge.";
  for (const [first, second] of [[plain, wrapped], [wrapped, plain]]) {
    const input = { ...document, raw_text: `[[SIDE:1]]\n${first}\n[[SIDE:2]]\n${second}`, structure_map: [
      { text: first, page: 1, heading_path: ["Første"], reference: "Første · side 1" },
      { text: second, page: 2, heading_path: ["Andre"], reference: "Andre · side 2" },
    ] };
    for (const quote of [plain, wrapped]) {
      const source = bindDocumentSourceEvidence(input, quote);
      assert.equal(source.original_quote, quote, "Original source characters are retained.");
      assert.equal(source.page_start, null); assert.equal(source.page_end, null);
      assert.deepEqual(source.heading_path, []);
      assert.match(source.reference, /nøyaktig plassering ikke oppgitt/u);
    }
  }
});
test("reusing one document index preserves evidence identity and repeated-quote locators across fields", () => {
  const input = { ...document, raw_text: document.raw_text + "\n[[SIDE:9]]\nK-1 Leverandøren skal\nlagre data i Norge." };
  const index = new SourceQuoteIndex(input.raw_text);
  for (const quote of ["K-1 Leverandøren skal lagre data i Norge.", "K-2 Logger skal bevares i ett år.", "Ukjent kravtekst."]) {
    assert.deepEqual(bindDocumentSourceEvidence(input, quote, { index }), bindDocumentSourceEvidence(input, quote));
  }
});

test("plain and bold versions on different pages cannot acquire a unique locator", () => {
  const raw_text = "[[SIDE:1]]\nData skal lagres i Norge.\n[[SIDE:2]]\nData skal **lagres i Norge**.";
  assert.equal(bindDocumentSourceEvidence({ ...document, raw_text }, "Data skal lagres i Norge.").page_start, null);
});
