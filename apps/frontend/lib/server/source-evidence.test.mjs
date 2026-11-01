import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";
const { evidenceIdentity, SourceQuoteIndex, validateChatEvidence } = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../.."), "server-only": "/dev/null" } })("./source-evidence.ts");
const sources = [{ citation_number: 1, evidence_id: "e1", original_quote: "K-4.2 Leverandøren skal lagre data i Norge.", source_revision: 2 }, { citation_number: 2, evidence_id: "e2", original_quote: "K-4.20 Loggene skal lagres i ett år." }];
const { parseChatSourceReferences } = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../..") } })("../chat-source-references.ts");
test("canonical matching returns original quotation characters and rejects invented words", () => {
  const original = "K‐4.2\nLeverandøren  skal lagre data i Norge.";
  const index = new SourceQuoteIndex(original);
  assert.equal(index.find(sources[0].original_quote), original);
  assert.equal(index.find("Data skal lagres i Sverige."), null);
});
test("only actually cited sources persist; unknown references, quotes and prefix-colliding IDs are rejected", () => {
  assert.deepEqual(validateChatEvidence("K-4.2 krever lagring i Norge. [Kilde 1]", sources), [sources[0]]);
  assert.deepEqual(validateChatEvidence("Dette er et forslag til videre arbeid.", sources), []);
  assert.deepEqual(validateChatEvidence("Som et forslag kan dere vurdere AES-256 og SHA-256 etter ISO-27001.", sources), []);
  for (const answer of ["Fakta. [Kilde 0]", "Fakta. [Kilde 3]", "«Data lagres i Sverige.» [Kilde 1]", "K-4.2 gjelder. [Kilde 2]", "K-99 gjelder. [Kilde 1]", "K42 gjelder. [Kilde 1]", "«Leverandøren skal lagre data i Norge.»"]) {
    assert.throws(() => validateChatEvidence(answer, sources), /kilde|sitat|krav-ID/iu);
  }
  assert.throws(() => validateChatEvidence("Fakta. [Kilde 1]", [{ evidence_id: "e1" }]), /kilde/iu);
});
test("evidence identity is stable for one snapshot and changes with source revision or content", () => {
  const input = { sourceType: "project_document", sourceId: "one", revision: 1, fingerprint: "hash", reference: "Side 2", text: "K-1 Data i Norge." };
  assert.equal(evidenceIdentity(input), evidenceIdentity({ ...input }));
  assert.notEqual(evidenceIdentity(input), evidenceIdentity({ ...input, revision: 2 }));
  assert.notEqual(evidenceIdentity(input), evidenceIdentity({ ...input, text: "Endret." }));
});

test("sparse, out-of-order citation numbers and attachment evidence survive save/reload parsing", () => {
  const source = (number, text) => ({ citation_number: number, evidence_id: `e${number}`, original_quote: text, source_revision: 0, source_fingerprint: "fingerprint", chunk_id: null,
    document_title: `Kilde ${number}`, reference: "Vedlegg", heading_path: [], page_start: null, page_end: null, source_type: "chat_attachment", source_id: `attachment-${number}`, classification: "documented" });
  const available = [source(1, "K-1 Data skal eksporteres."), source(2, "K-2 Logger skal bevares."), source(3, "K-3 Tjenesten skal være tilgjengelig.")];
  const used = validateChatEvidence("K-3 krever tilgjengelighet. [Kilde 3]\n\nK-1 krever eksport. [Kilde 1]", available);
  assert.deepEqual(used.map(source => source.citation_number), [3, 1]);
  assert.deepEqual(parseChatSourceReferences(JSON.parse(JSON.stringify(used))), used);
  assert.equal(parseChatSourceReferences([{ document_title: "Bad", source_type: "unexpected" }]).length, 0);
});

test("whole-source and attachment quotes outside the retrieval shortlist remain verifiable and bounded in persistence", () => {
  const original = `${"Bakgrunn. ".repeat(5000)}K42 Leverandøren skal tilby eksport i åpne formater.${" Mer bakgrunn.".repeat(5000)}`;
  const source = { evidence_id: "whole", source_type: "chat_attachment", original_quote: original };
  const used = validateChatEvidence("K42 krever «Leverandøren skal tilby eksport i åpne formater.» [Kilde 1]", [source]);
  assert.equal(used[0].citation_number, 1);
  assert.ok(used[0].original_quote.length < 1000);
  assert.ok(original.includes(used[0].original_quote));
  assert.match(used[0].original_quote, /K42/u);
  assert.throws(() => validateChatEvidence("K43 krever eksport. [Kilde 1]", [source]), /krav-ID/iu);
});

test("bold emphasis inside a quotation preserves exact wording without accepting changed content", () => {
  const source = { citation_number: 1, evidence_id: "one", original_quote: "Leverandøren skal levere en exitplan innen 30 dager." };
  const valid = validateChatEvidence("Fristen er «Leverandøren skal levere en exitplan **innen 30 dager**.» [Kilde 1]", [source]);
  assert.equal(valid[0].original_quote, source.original_quote);
  assert.throws(() => validateChatEvidence("Fristen er «Leverandøren skal levere en exitplan **innen 60 dager**.» [Kilde 1]", [source]), /sitat/iu);
  assert.throws(() => validateChatEvidence("Fristen er «Leverandøren skal levere en exitplan **innen 30 dager.» [Kilde 1]", [source]), /sitat/iu);
});

test("literal source Markdown remains valid and long-source excerpts retain original characters", () => {
  const literal = "**Frist:** 30 dager";
  for (const original_quote of [literal, "Innledning. ".repeat(600) + literal + " Avslutning."]) {
    const used = validateChatEvidence(`Fristen er «${literal}» [Kilde 1]`, [{ evidence_id: "markdown", original_quote }]);
    assert.ok(used[0].original_quote.includes(literal));
    assert.ok(original_quote.includes(used[0].original_quote));
    assert.throws(() => validateChatEvidence("Fristen er «**Frist:** 60 dager» [Kilde 1]", [{ evidence_id: "markdown", original_quote }]), /sitat/iu);
  }
});
test("protocol recommendations remain ordinary terms rather than unsupported requirement IDs", () => {
  assert.deepEqual(validateChatEvidence("Vurder SAML2, OIDC1 og CIS2 for videre arbeid.", []), []);
});
