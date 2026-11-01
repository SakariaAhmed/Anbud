import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const app = createJiti(import.meta.url, { alias: { "@": new URL("../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { bindOutputSourceEvidence, outputEvidenceFields } = app("./output-source-evidence.ts");
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
