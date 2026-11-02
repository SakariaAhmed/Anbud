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

test("uncited conversation labels and service terminology do not consume citation repair", () => {
  assert.deepEqual(validateChatEvidence('Svar "Ja" eller “Nei”. Forslag: P1-hendelser i Q3, L2-støtte med M365 E5 og AZ-104.', []), []);
  assert.throws(() => validateChatEvidence('Kilden sier «oppdiktet påstand».', []), /sitat/iu);
  assert.throws(() => validateChatEvidence('Kilden sier "oppdiktet påstand". [Kilde 1]', sources), /sitat/iu);
});

test("terms in a generated draft do not acquire requirement authority, while registered ambiguous IDs remain checked", () => {
  const draft = { source_type: "generated_artifact", evidence_id: "draft", original_quote: "Forslag til P1-hendelser og L2-støtte i Q3 med M365 E5." };
  assert.deepEqual(validateChatEvidence("Forslag: P1-hendelser og L2-støtte i Q3 med M365 E5.", [draft]), []);
  const registered = { source_type: "project_document", requirement_id: "P1", evidence_id: "row", original_quote: "P1 Leverandøren skal tilby døgnåpen beredskap." };
  assert.equal(validateChatEvidence("P1 krever beredskap. [Kilde 1]", [registered]).length, 1);
  assert.throws(() => validateChatEvidence("P2 krever beredskap. [Kilde 1]", [registered]), /krav-ID/iu);
});

test("planning bullets do not become invented compound requirement IDs across line breaks", () => {
  assert.deepEqual(validateChatEvidence("Forslag til bemanning:\n- 1 incident manager / P1-leder\n- 1–2 L2-teknikere med M365-kompetanse", []), []);
  assert.deepEqual(validateChatEvidence("Leveranser som bør inngå i planen\n- P1-runbook\n- Kontaktliste for L2", []), []);
  assert.throws(() => validateChatEvidence("Se P001-REQ-03 og ID2-14.", []), /krav-ID/u);
});

test("user-supplied conversation wording is not promoted into document evidence", () => {
  const userText = 'Skriv bare setningen: Svar "Ja" eller "Nei".';
  assert.deepEqual(validateChatEvidence('Svar «Ja» eller «Nei».', [], { userText }), []);
  assert.throws(() => validateChatEvidence('Svar «Kanskje».', [], { userText }), /sitat/iu);
  assert.throws(() => validateChatEvidence('«Ja» [Kilde 1]', [{ evidence_id: 'doc', original_quote: 'Kravet er lagring i Norge.' }], { userText }), /sitat/iu);
  assert.throws(() => validateChatEvidence('K-99 er et krav.', [], { userText: 'Gjenta K-99.' }), /krav-ID/iu);
});

test("register authority survives a lookup miss and whole-document citations", () => {
  const source = { source_type: "project_document", evidence_id: "whole", original_quote: "Leverandøren skal lagre data i Norge." };
  assert.throws(() => validateChatEvidence("P2 krever lagring i Norge. [Kilde 1]", [source], { authoritativeRequirementIds: ["P1"] }), /krav-ID/iu);
  assert.deepEqual(validateChatEvidence("Forslag til P2-hendelser og L2-støtte.", [source]), []);
});

test("short quoted numeric values must match whole tokens in the cited passage", () => {
  const available = [{ evidence_id: "numeric", original_quote: "Den gamle fristen var 130 dager." }];
  assert.throws(() => validateChatEvidence("Fristen er «30 dager». [Kilde 1]", available), /sitat/iu);
  const source = "Den gamle fristen var 130 dager.\nDen nye fristen er 30 dager.";
  const match = new SourceQuoteIndex(source).locate("30 dager", { tokenBoundaries: true });
  assert.equal(match.start, source.lastIndexOf("30 dager")); assert.equal(match.text, "30 dager");
});

test("quoted numbers require the complete decimal or thousands-grouped value, including tiny values", () => {
  for (const [quote, text] of [["500 kr", "Rammen er 1 500 kr."], ["500 000 kr", "Rammen er 1 500 000 kr."], ["500 kr", "Rammen er 1\u00a0500 kr."], ["99 %", "Målet er 99,99 %."], ["30 dager", "Fristen er 1,30 dager."], ["5 %", "Målet er 25 %."], ["5", "Antallet er 25."], ["1 500", "Rammen er 1 500 000 kr."]]) {
    assert.throws(() => validateChatEvidence(`Kilden sier «${quote}». [Kilde 1]`, [{ evidence_id: "number", original_quote: text }]), /sitat/iu, `${quote} is not ${text}`);
  }
  for (const quote of ["5 %", "48t"]) assert.throws(() => validateChatEvidence(`Kilden sier «${quote}». [Kilde 1]`, [{ evidence_id: "absent", original_quote: "Kilden oppgir ingen slik frist eller prosent." }]), /sitat/iu);
  assert.equal(validateChatEvidence("Målet er «5 %». [Kilde 1]", [{ evidence_id: "exact", original_quote: "Det avtalte målet er 5 %." }]).length, 1);
});
test("saved excerpts retain the exact validated short number and requirement occurrence in long sources", () => {
  const raw = "Tidligere frist var 130 dager.\nK-4.20 Gammelt krav.\n" + "Generell bakgrunn. ".repeat(400) + "\nGjeldende frist er 30 dager.\nK-4.2 Gjeldende krav.";
  const source = { source_type: "project_document", evidence_id: "long", original_quote: raw };
  const saved = validateChatEvidence("Fristen er «30 dager». K-4.2 gjelder. [Kilde 1]", [source]);
  const excerpts = [saved[0].original_quote, ...(saved[0].quotation_excerpts ?? [])].join("\n");
  assert.match(excerpts, /Gjeldende frist er 30 dager/u); assert.match(excerpts, /K-4\.2 Gjeldende/u);
  assert.doesNotMatch(excerpts, /130 dager|K-4\.20/u);
});

test("all Unicode numeric space separators keep a grouped value intact while tabs may separate columns", () => {
  for (const separator of ["\u2007", "\u2008", "\u2009", "\u202f", "\u00a0"]) {
    const original_quote = `Rammen er 1${separator}500 kr.`;
    for (const quote of ["500 kr", "1"]) assert.throws(() => validateChatEvidence(`Rammen er «${quote}». [Kilde 1]`, [{ evidence_id: "unicode", original_quote }]), /sitat/iu);
  }
  assert.doesNotThrow(() => validateChatEvidence("Beløpet er «500 kr». [Kilde 1]", [{ evidence_id: "columns", original_quote: "Rad 1\t500 kr" }]));
});
