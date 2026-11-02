import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" }, fsCache: false });
const { compactText, documentContext, summarizeSolutionEvaluation, solutionEvaluationRetrievalTerms } = jiti("./context.ts");
function original(value, limit = 16000) {
  const normalized = (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

test("bounded normalization preserves exact excerpts, whitespace and truncation semantics", () => {
  const sources = [undefined, null, 42, "", "  ", " ÆØÅ\t ansvar\r\n og\u00a0kontroll ", "x".repeat(50000), " ".repeat(50000), `A${" \n".repeat(30000)}B`, `${" ".repeat(50000)}Kontroll`, `😀${"kilde\n".repeat(12000)}`];
  for (const source of sources) {
    for (const limit of [-3, 0, 1, 2, 2.8, 220, 4000, 16000, Infinity, NaN]) {
      assert.equal(compactText(source, limit), original(source, limit));
    }
  }
  // Seeded fuzz checks mixed whitespace around exactly truncated boundaries.
  let seed = 20260908;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const alphabet = ["a", "ø", "🙂", "\t", "\n", " ", "\r\n", "\u2028", "\ufeff"];
  for (let iteration = 0; iteration < 600; iteration++) {
    const source = Array.from({ length: Math.floor(random() * 4000) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const limit = Math.floor(random() * 1000);
    assert.equal(compactText(source, limit), original(source, limit));
  }
});

test("document prompt preserves metadata, exact source references and original text", () => {
  const document = { title: "Kundekrav", file_name: "krav.txt", file_format: "txt", role: "primary_customer_document", raw_text: " \nK-17 Leverandøren dokumenterer kontroll.\n".repeat(10000), structure_map: [{ reference: "Side 12 / K-17", text: "Verifisert kilde" }] };
  const source = document.raw_text;
  const result = documentContext("Kilde", document, { textLimit: 220 });
  assert.ok(result.includes(original(source, 220)));
  assert.ok(result.includes("Side 12 / K-17"));
  assert.ok(result.includes("primary_customer_document"));
  assert.equal(document.raw_text, source);
});


test("evaluation prompt keeps criterion meaning without repeated persistence snapshots", () => {
  const evaluation = { strengths: [], weaknesses: [], missing_elements: [], risks_to_customer: [], improvement_recommendations: [],
    evidence_review: { status: "coverage_downgraded", message: "Kontroller vurderingen" },
    criterion_coverage: [{ criterion_id: "price", criterion_index: 0, criterion: "Pris", origin: "observed", assessment: "Uklart", review_required: true,
      rationale: "Usikker begrunnelse. ".repeat(100), evidence: "Dokumentert tekst. ".repeat(100), requirement_references: ["K-42"],
      criterion_scope: { analysis_criteria: Array(1000).fill("Repeated criterion"), documents: Array(1000).fill({id: "doc", fingerprint: "fingerprint"}) },
      criterion_source: { original_quote: "Stored locator metadata" }, answer_source: { original_quote: "Stored answer metadata" } }],
  };
  const before = structuredClone(evaluation);
  const text = summarizeSolutionEvaluation(evaluation), prompt = JSON.parse(text), row = prompt.criterion_coverage[0];
  assert.deepEqual({ ...row, rationale: undefined, evidence: undefined }, {
    criterion_id: "price", criterion_index: 0, criterion: "Pris", origin: "observed", assessment: "Uklart", review_required: true,
    requirement_references: ["K-42"], rationale: undefined, evidence: undefined,
  });
  assert.equal(row.rationale, compactText(before.criterion_coverage[0].rationale, 300));
  assert.equal(row.evidence, compactText(before.criterion_coverage[0].evidence, 300));
  assert.deepEqual(prompt.evidence_review, evaluation.evidence_review);
  assert.deepEqual(evaluation, before);
  evaluation.criterion_coverage[0].criterion_scope = {};
  assert.equal(summarizeSolutionEvaluation(evaluation), text, "Snapshot cardinality cannot inflate the generation prompt.");
  const many = { ...evaluation, criterion_coverage: Array.from({length: 20}, (_, i) => ({ ...evaluation.criterion_coverage[0], criterion_id: `criterion-${i}` })) };
  assert.equal(JSON.parse(summarizeSolutionEvaluation(many)).criterion_coverage.length, 20, "No criterion is silently dropped.");
  assert.deepEqual(JSON.parse(summarizeSolutionEvaluation({ ...evaluation, criterion_coverage: [] })).criterion_coverage, []);
  assert.equal(Object.hasOwn(JSON.parse(summarizeSolutionEvaluation({ ...evaluation, criterion_coverage: undefined })), "criterion_coverage"), false);
});


test("evaluation retrieval terms stay bounded while generation retains all criteria", () => {
  const evaluation = { fit_to_customer_needs: "Behov ".repeat(1000), executive_summary: "Sammendrag ".repeat(1000), strengths: [], weaknesses: [], missing_elements: [], risks_to_customer: [], improvement_recommendations: [],
    criterion_coverage: Array.from({length: 2000}, (_, index) => ({ criterion: `Kriterium ${index} ` + "Lang tekst ".repeat(1000), assessment: "Uklart", rationale: "RATIONALE_NOT_FOR_SEARCH", evidence: "EVIDENCE_NOT_FOR_SEARCH" })) };
  const terms = solutionEvaluationRetrievalTerms(evaluation);
  assert.ok(terms.length < 2000);
  assert.match(terms, /Kriterium 7/u);
  assert.doesNotMatch(terms, /Kriterium 8|RATIONALE_NOT_FOR_SEARCH|EVIDENCE_NOT_FOR_SEARCH/u);
  assert.equal(JSON.parse(summarizeSolutionEvaluation(evaluation)).criterion_coverage.length, 2000);
});
