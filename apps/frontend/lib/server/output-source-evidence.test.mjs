import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const app = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { bindOutputSourceEvidence, reviewRequirementRowOutputEvidence, reviewOutputSourceEvidence, reviewStructuredOutputEvidence, outputEvidenceFields } = app("./output-source-evidence.ts");
const source = { sourceType: "project_document", document: { id: "customer", project_id: "fictional", role: "primary_customer_document", title: "Bilag 1", chunk_source_revision: 4, raw_text: "[[SIDE:3]]\nK-1.3 Leverandøren skal levere eksport innen 30 dager.", structure_map: [] } };
const service = { sourceType: "service_document", document: { id: "service", title: "Drift", chunk_source_revision: 2, raw_text: "Vi overvåker plattformen hele døgnet.", structure_map: [] } };
test("generated output binds actual quote characters and source revisions across project and authorized service documents", () => {
  const result = bindOutputSourceEvidence({ documents: [source, service], fields: [{ path: "rows.0.answer", text: 'K-1.3 har fristen «eksport innen **30 dager**». Vi tilbyr “Vi overvåker plattformen hele døgnet.”' }] });
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].source.page_start, 3); assert.equal(result.references[0].source.source_revision, 4);
  assert.equal(result.references[0].source.original_quote, "eksport innen 30 dager");
  assert.equal(result.references[1].source.source_type, "service_document"); assert.equal(result.references[1].source.source_revision, 2);
  assert.ok(result.references.every(reference => reference.source.evidence_id && reference.source.source_fingerprint));
});
test("invented IDs and quotations fail before publication while authoritative local row references remain explicit", () => {
  assert.throws(() => bindOutputSourceEvidence({ documents: [source], fields: [{ path: "answer", text: "K-99 er oppfylt." }] }), /krav-ID/iu);
  for (const text of ['«eksport innen 60 dager»', '“eksport innen 60 dager”', '"eksport innen 60 dager"']) assert.throws(() => bindOutputSourceEvidence({ documents: [source], fields: [{ path: "answer", text }] }), /kildesitat/iu);
  assert.deepEqual(bindOutputSourceEvidence({ documents: [source], authoritativeRequirementRefs: ["REQ-42"], fields: [{ path: "answer", text: "REQ-42: Forslag til leveranse." }] }).references, []);
});
test("structured result traversal ignores provenance metadata and does not reinterpret JSON punctuation as source quotations", () => {
  const fields = outputEvidenceFields({ executive_summary: "K-1.3 krever eksport.", strengths: ["Dokumentert frist"], source_evidence: { token: "ignore" }, source_references: [{ quote: "ignore" }], score: 5 });
  assert.deepEqual(fields.map(field => field.path), ["result.executive_summary", "result.strengths.0"]);
});

test("generated interpretation stays distinct from original documents and transitive quotes keep source identity", () => {
  const artifact = { id: "draft", title: "Forslag", artifact_version: 3, content_markdown: "Vi foreslår en overgang med to beslutningsporter." };
  const interpreted = bindOutputSourceEvidence({ documents: [source], artifacts: [artifact], fields: [{ path: "comparison", text: "Systemutkastet sier «Vi foreslår en overgang med to beslutningsporter.»" }] });
  const ref = interpreted.references[0].source;
  assert.equal(ref.source_type, "generated_artifact"); assert.equal(ref.classification, "interpretation"); assert.equal(ref.source_revision, 3); assert.equal(ref.page_start, null);
  const summary = bindOutputSourceEvidence({ documents: [], verifiedReferences: [ref], fields: [{ path: "summary", text: "Utkastet foreslår «to beslutningsporter»." }] });
  assert.equal(summary.references[0].source.source_id, artifact.id);
  assert.equal(summary.references[0].source.classification, "interpretation");
  assert.notEqual(summary.references[0].source.evidence_id, ref.evidence_id);
  assert.throws(() => bindOutputSourceEvidence({ documents: [], verifiedReferences: [{ ...ref, evidence_id: undefined }], fields: [{ path: "summary", text: "«to beslutningsporter»" }] }), /kildesitat/iu);
});
test("unquoted coverage fields bind only literal source excerpts", () => {
  const result = bindOutputSourceEvidence({ documents: [source], fields: [{ path: "coverage.0.requirement", text: "K-1.3 Leverandøren skal levere eksport innen 30 dager." }, { path: "coverage.0.evidence", text: "Ikke dokumentert" }] });
  assert.equal(result.references.length, 1); assert.equal(result.references[0].path, "coverage.0.requirement");
});

test("evaluation provenance titles and locators never become generated claims", () => {
  const result = { executive_summary: "K-1.3 krever eksport.", evaluation_context: { customer_document_title: 'K-99 «Oppdiktet tittel»' }, requirement_coverage: { items: [{ source_document_title: 'K-99 «Oppdiktet filnavn»', source_reference: "K-99 side 888", reference: "K-1.3", requirement: "K-1.3 Leverandøren skal levere eksport innen 30 dager." }] } };
  const fields = outputEvidenceFields(result);
  assert.ok(fields.every(field => !field.text.includes("K-99")));
  assert.doesNotThrow(() => bindOutputSourceEvidence({ documents: [source], fields }));
  assert.throws(() => bindOutputSourceEvidence({ documents: [source], fields: outputEvidenceFields({ ...result, executive_summary: "K-99 krever eksport." }) }), /krav-ID/iu, "A generated claim still needs source membership.");
});

test("ordinary short labels carry no proof or issue while short numeric quotes retain verifiable context", () => {
  const labels = reviewOutputSourceEvidence({ documents: [{ ...source, document: { ...source.document, raw_text: "Kravet er besvart med Ja i tabellen." } }], fields: [{ path: "answer", text: 'Leverandøren svarer "Ja".' }] });
  assert.deepEqual(labels.evidence.references, []); assert.equal(labels.evidence.issues, undefined);
  const numeric = bindOutputSourceEvidence({ documents: [source], fields: [{ path: "answer", text: 'Fristen er «30 dager».' }] });
  assert.equal(numeric.references[0].source.original_quote, "K-1.3 Leverandøren skal levere eksport innen 30 dager.");
  assert.throws(() => bindOutputSourceEvidence({ documents: [source], fields: outputEvidenceFields({ document_findings: [{ reference: 'K-99 i «Bilag 2»' }] }) }), /krav-ID/iu);
  assert.doesNotThrow(() => bindOutputSourceEvidence({ documents: [source], fields: outputEvidenceFields({ document_findings: [{ reference: 'K-1.3 i «Bilag 2»' }] }) }));
});

test("missing short numeric quotations are withheld and partial numbers cannot become source evidence", () => {
  for (const quote of ["45 dager", "99,99 %", "ISO 9999"]) {
    const result = reviewOutputSourceEvidence({ documents: [source], fields: [{ path: "answer", text: `Kilden sier «${quote}».` }] });
    assert.equal(result.evidence.issues?.[0].code, "unverified_quote");
    assert.doesNotMatch(result.fields[0].text, new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  const wrongNumber = { ...source, document: { ...source.document, raw_text: "Leverandøren skal levere eksport innen 130 dager." } };
  assert.throws(() => bindOutputSourceEvidence({ documents: [wrongNumber], fields: [{ path: "answer", text: "Fristen er «30 dager»." }] }), /kildesitat/iu);
  const repeated = { ...source, document: { ...source.document, raw_text: "Leverandøren har 30 dager til eksport.\nKunden har 30 dager til kontroll." } };
  const result = reviewOutputSourceEvidence({ documents: [repeated], fields: [{ path: "answer", text: "Fristen er «30 dager»." }] });
  assert.deepEqual(result.evidence.references, []); assert.equal(result.evidence.issues, undefined, "An existing repeated quote cannot be given a manufactured unique locator.");
});

test("selected regeneration retains untouched manual text and only unchanged prior proof", () => {
  const parentRows = [
    { index: 0, ref: "K-1.3", answer: 'Foreslått tjenestenavn: «Beredskapsvakt Pluss»', evidence: "Manuelt forslag, må avklares." },
    { index: 1, ref: "K-1.3", answer: "Tidligere svar", evidence: "Tidligere grunnlag" },
  ];
  const previous = bindOutputSourceEvidence({ documents: [source], fields: [{ path: "rows.0.evidence", text: "«eksport innen 30 dager»" }] });
  const before = [{ ...parentRows[0], evidence: "«eksport innen 30 dager»" }, parentRows[1]];
  const after = [{ ...before[0] }, { ...before[1], answer: "K-1.3 krever eksport.", evidence: "«eksport innen 30 dager»" }];
  const result = reviewRequirementRowOutputEvidence({ documents: [source], rows: after, parentRows: before, parentEvidence: previous, regeneratedIndexes: new Set([1]) });
  assert.deepEqual(result.evidence.references.map(entry => entry.path), ["rows.0.evidence", "rows.1.evidence"]);
  assert.equal(after[0].answer, parentRows[0].answer);
  const changed = [{ ...after[0], evidence: "Egen ny tekst" }, after[1]];
  assert.deepEqual(reviewRequirementRowOutputEvidence({ documents: [source], rows: changed, parentRows: before, parentEvidence: previous, regeneratedIndexes: new Set([1]) }).evidence.references.map(entry => entry.path), ["rows.1.evidence"]);
  const held = reviewRequirementRowOutputEvidence({ documents: [source], rows: after, regeneratedIndexes: new Set([0]) });
  assert.match(held.fields[0].text, /Må avklares/u);
  assert.doesNotMatch(held.fields[0].text, /Beredskapsvakt Pluss/u);
  assert.equal(held.evidence.issues[0].code, "unverified_quote");
});

test("ordinary SLA, calendar, support, certificate and product labels are not invented requirements", () => {
  assert.doesNotThrow(() => bindOutputSourceEvidence({ documents: [], fields: [{ path: "proposal", text: "Forslag: P1-hendelser, Q3 2027, L2-støtte, AZ-104/AZ-305 og M365 E5." }] }));
  const reviewed = reviewOutputSourceEvidence({ documents: [], authoritativeRequirementRefs: ["P1"], fields: [{ path: "answer", text: "P2 krever døgnåpen drift." }] });
  assert.equal(reviewed.evidence.issues[0].code, "unknown_requirement", "An explicit register can give an ambiguous shape requirement authority.");
});
test("unsupported generated fields are withheld independently while verified fields retain proof", () => {
  const reviewed = reviewStructuredOutputEvidence({ strengths: ['K-1.3 har «eksport innen 30 dager».', 'K-99 har «eksport innen 60 dager».'], evaluation_context: { customer_document_title: 'K-99 «Tittel»' } }, { documents: [source] });
  assert.equal(reviewed.result.strengths[0], 'K-1.3 har «eksport innen 30 dager».');
  assert.match(reviewed.result.strengths[1], /Må avklares/u);
  assert.doesNotMatch(reviewed.result.strengths[1], /K-99|60 dager/u);
  assert.equal(reviewed.result.evaluation_context.customer_document_title, 'K-99 «Tittel»');
  assert.deepEqual(reviewed.evidence.references.map(entry => entry.path), ["result.strengths.0"]);
  assert.deepEqual(reviewed.evidence.issues.map(entry => entry.path), ["result.strengths.1"]);
});
test("authored strategy wording remains interpretation without false primary proof", () => {
  const reviewed = reviewOutputSourceEvidence({ documents: [source], interpretationOnly: true, fields: [{ path: "strategy", text: 'Forslag til budskap: «Trygg drift, kontrollert overgang».' }] });
  assert.equal(reviewed.fields[0].text, 'Forslag til budskap: «Trygg drift, kontrollert overgang».');
  assert.equal(reviewed.evidence.references.length, 0);
  assert.equal(reviewed.evidence.issues, undefined);
});

test("output quotations reject shortened numeric groups and missing tiny values", () => {
  for (const [quote, raw_text] of [["500 kr", "Rammen er 1 500 kr."], ["500 000 kr", "Rammen er 1 500 000 kr."], ["500 kr", "Rammen er 1\u00a0500 kr."], ["99 %", "Målet er 99,99 %."], ["30 dager", "Fristen er 1,30 dager."], ["5 %", "Målet er 25 %."], ["5", "Antallet er 25."], ["1 500", "Rammen er 1 500 000 kr."], ["5 %", "Prosent er ikke oppgitt."], ["48t", "Fristen er ikke oppgitt."]]) {
    const reviewed = reviewOutputSourceEvidence({ documents: [{ ...source, document: { ...source.document, raw_text } }], fields: [{ path: "answer", text: `Kilden sier «${quote}».` }] });
    assert.equal(reviewed.evidence.issues?.[0].code, "unverified_quote", `${quote} is not ${raw_text}`);
    assert.equal(reviewed.evidence.references.length, 0);
  }
});
test("short draft and prior-reference quotations retain their visible evidence classification", () => {
  const artifact = { id: "short-draft", title: "Utkast", artifact_version: 2, content_markdown: "Forslaget legger opp til en overgang innen 45 dager." };
  const bound = bindOutputSourceEvidence({ documents: [], artifacts: [artifact], fields: [{ path: "summary", text: "Utkastet foreslår «45 dager»." }] });
  const proof = bound.references[0].source;
  assert.equal(proof.classification, "interpretation"); assert.equal(proof.source_type, "generated_artifact");
  assert.equal(proof.original_quote, artifact.content_markdown);
  for (const source_type of ["generated_artifact", "project_document"]) {
    const prior = { ...proof, source_type, classification: source_type === "generated_artifact" ? "interpretation" : "documented" };
    const retained = bindOutputSourceEvidence({ documents: [], verifiedReferences: [prior], fields: [{ path: "summary", text: "Fristen er «45 dager»." }] });
    assert.equal(retained.references[0].source.classification, prior.classification);
    assert.equal(retained.references[0].source.original_quote, prior.original_quote);
  }
});
