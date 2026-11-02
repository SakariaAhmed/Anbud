import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("../../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { reviewSolutionEvaluationEvidence } = load("../ai.ts");

function fixture() {
  const documents = [{ sourceType: "project_document", document: { id: "source", role: "primary_customer_document", title: "Krav", chunk_source_revision: 1, structure_map: [], raw_text: "K-1 Leverandøren skal oppgi kontraktsrammen. K-2 Leverandøren skal oppgi fristen. Rammen er 1 500 kr. Alt er godt." } }];
  const item = (reference, full_reference, evidence) => ({ reference, full_reference, source_reference: full_reference, requirement: "Leverandøren skal oppgi kontraktsrammen.", assessment: "Godt", rationale: "Svaret er dokumentert.", evidence, recommendation: "Kontroller avtalen." });
  const result = {
    requirement_coverage: { total_requirements: 2, assessed_requirements: 2, good: 2, weak: 0, missing: 0, unclear: 0, coverage_summary: "Alle krav er gode.", items: [item("K-1", "A · K-1", "«500 kr»"), item("K-2", "B · K-2", "Rammen er 1 500 kr.")] },
    architecture_comparison: { architect_solution_score: 100, system_solution_score: 75, winner: "Arkitektløsning", verdict: "«Alt er godt.»" },
    document_findings: [
      { reference: "A · K-1", matched_requirement_reference: "K-1", reference_match: "coverage", assessment: "Godt", evidence: "Rammen er 1 500 kr.", finding: "Svaret er vurdert.", recommendation: "Kontroller." },
      { reference: "B · K-2", matched_requirement_reference: "K-2", reference_match: "coverage", assessment: "Godt", evidence: "", finding: "Svaret er vurdert.", recommendation: "Kontroller." },
      { reference: "Seksjonsfunn: drift", reference_match: "section", assessment: "Godt", evidence: "", finding: "Drift er vurdert.", recommendation: "Kontroller." },
    ],
  };
  return { result, input: { documents, authoritativeRequirementRefs: ["K-1", "K-2"] } };
}

test("a source downgrade updates coverage text, scores, winner and source-qualified findings together", () => {
  const { result, input } = fixture();
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.deepEqual(reviewed.requirement_coverage.items.map(row => row.assessment), ["Uklart", "Godt"]);
  assert.equal(reviewed.requirement_coverage.good, 1); assert.equal(reviewed.requirement_coverage.unclear, 1);
  assert.match(reviewed.requirement_coverage.coverage_summary, /1 er vurdert som gode.*1 er uklare/u);
  assert.equal(reviewed.architecture_comparison.architect_solution_score, 68);
  assert.equal(reviewed.architecture_comparison.winner, "Systemløsning");
  assert.deepEqual(reviewed.document_findings.map(f => f.assessment), ["Uklart", "Godt", "Godt"]);
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"), "Rewritten comparison text cannot inherit the original field's quotation proof.");
  assert.equal(result.requirement_coverage.good, 2, "The input snapshot is not mutated.");
});

test("a nonbinding cap reconciles stale coverage claims without claiming the scores changed", () => {
  const { result, input } = fixture();
  result.architecture_comparison.architect_solution_score = 60;
  result.architecture_comparison.winner = "Systemløsning";
  result.architecture_comparison.verdict = "Alle krav er godt dekket. «Alt er godt.»";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.equal(reviewed.requirement_coverage.unclear, 1);
  assert.equal(reviewed.architecture_comparison.architect_solution_score, 60);
  assert.equal(reviewed.architecture_comparison.winner, "Systemløsning");
  assert.match(reviewed.architecture_comparison.verdict, /1 er vurdert som gode.*1 er uklare/u);
  assert.match(reviewed.architecture_comparison.verdict, /Poengene og vinneren er uendret/u);
  assert.doesNotMatch(reviewed.architecture_comparison.verdict, /Alle krav er godt dekket|Poengene er oppdatert/u);
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"));
});

test("a rewritten comparison drops both the replaced quotation proof and its old validation issue", () => {
  const { result, input } = fixture();
  result.architecture_comparison.verdict = "«Dette finnes ikke i dokumentet.»";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.match(reviewed.architecture_comparison.verdict, /Sammenligningen er oppdatert/u);
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"));
  assert.ok(!reviewed.source_evidence.issues.some(issue => issue.path === "result.architecture_comparison.verdict"));
  assert.ok(reviewed.source_evidence.issues.some(issue => issue.path === "result.requirement_coverage.items.0.evidence"));
});
test("unsupported evidence cannot upgrade missing or weak requirements to unclear", () => {
  for (const assessment of ["Mangler", "Dårlig"]) {
    const { result, input } = fixture();
    result.requirement_coverage.items[0].assessment = assessment;
    result.requirement_coverage.good = 1;
    result.requirement_coverage[assessment === "Mangler" ? "missing" : "weak"] = 1;
    const reviewed = reviewSolutionEvaluationEvidence(result, input);
    assert.equal(reviewed.requirement_coverage.items[0].assessment, assessment);
    assert.equal(reviewed.requirement_coverage[assessment === "Mangler" ? "missing" : "weak"], 1);
    assert.ok(reviewed.source_evidence.issues.some(issue => issue.path === "result.requirement_coverage.items.0.evidence"));
  }
});
test("unchanged verified coverage preserves the original comparison and its quotation proof", () => {
  const { result, input } = fixture();
  result.requirement_coverage.items[0].evidence = "Rammen er 1 500 kr.";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.equal(reviewed.requirement_coverage.unclear, 0);
  assert.deepEqual(reviewed.architecture_comparison, result.architecture_comparison);
  assert.ok(reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"));
});
test("downgraded rows replace stale positive guidance and discard its old quotation proof", () => {
  const { result, input } = fixture();
  result.requirement_coverage.items[0].rationale = "Kravet er fullt dokumentert og godt dekket. «Alt er godt.»";
  result.requirement_coverage.items[0].recommendation = "Ingen tiltak. «Alt er godt.»";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  const row = reviewed.requirement_coverage.items[0];
  assert.equal(row.assessment, "Uklart");
  assert.match(row.rationale, /Må avklares.*kunne ikke bekreftes/u);
  assert.match(row.recommendation, /Kontroller originalkilden/u);
  assert.ok(!reviewed.source_evidence.references.some(ref => /^result\.requirement_coverage\.items\.0\.(?:rationale|recommendation)$/u.test(ref.path)));
  assert.equal(reviewed.requirement_coverage.items[1].rationale, result.requirement_coverage.items[1].rationale);
  assert.equal(reviewed.requirement_coverage.items[1].recommendation, result.requirement_coverage.items[1].recommendation);
});
test("linked downgraded findings withhold inferred prose while original evidence retains its proof", () => {
  const { result, input } = fixture();
  result.document_findings[0].finding = "Observasjonen er «Rammen er 1 500 kr.»";
  result.document_findings[0].recommendation = "Ingen tiltak. «Alt er godt.»";
  result.requirement_coverage.items[1].assessment = "Mangler";
  result.requirement_coverage.good = 1;
  result.requirement_coverage.missing = 1;
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  const finding = reviewed.document_findings[0];
  assert.equal(finding.assessment, "Uklart");
  assert.equal(finding.recommendation, reviewed.requirement_coverage.items[0].recommendation);
  assert.equal(finding.finding, reviewed.requirement_coverage.items[0].rationale);
  assert.equal(finding.evidence, result.document_findings[0].evidence);
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.document_findings.0.recommendation"));
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.document_findings.0.finding"));
  assert.ok(reviewed.source_evidence.references.some(ref => ref.path === "result.document_findings.0.evidence"));
  assert.equal(reviewed.document_findings[1].assessment, "Mangler");
  assert.equal(reviewed.document_findings[1].recommendation, result.document_findings[1].recommendation);
  assert.deepEqual(reviewed.document_findings[2], result.document_findings[2]);
  assert.equal(result.document_findings[0].recommendation, "Ingen tiltak. «Alt er godt.»", "The input snapshot is unchanged.");
});
test("a rationale-only rejection keeps valid requirement evidence while reconciling the row and linked guidance", () => {
  const { result, input } = fixture();
  result.requirement_coverage.items[0].requirement = "«Leverandøren skal oppgi kontraktsrammen.»";
  result.requirement_coverage.items[0].evidence = "«Rammen er 1 500 kr.»";
  result.requirement_coverage.items[0].rationale = "«Dette er ikke dokumentert i kilden.»";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.equal(reviewed.requirement_coverage.items[0].assessment, "Uklart");
  assert.equal(reviewed.requirement_coverage.good, 1);
  assert.equal(reviewed.requirement_coverage.unclear, 1);
  assert.deepEqual(reviewed.source_evidence.issues, []);
  for (const field of ["requirement", "evidence"]) assert.ok(reviewed.source_evidence.references.some(ref => ref.path === `result.requirement_coverage.items.0.${field}`));
  assert.equal(reviewed.document_findings[0].recommendation, reviewed.requirement_coverage.items[0].recommendation);
  assert.equal(result.requirement_coverage.items[0].rationale, "«Dette er ikke dokumentert i kilden.»");
});

test("a downgrade withholds global conclusions and sends corrected coverage to summary consumers", () => {
  const { result, input } = fixture();
  result.fit_to_customer_needs = "Alt er godt dekket. «Alt er godt.»";
  result.executive_summary = "Alle krav er fullt dokumentert.";
  result.strengths = ["Ingen mangler. «Alt er godt.»"];
  result.weaknesses = []; result.missing_elements = []; result.risks_to_customer = [];
  result.improvement_recommendations = ["Ingen tiltak"];
  result.likely_score_assessment = { quality: "Perfekt", risk: "Ingen", delivery_confidence: "Høy", competitiveness: "Best" };
  result.architecture_comparison.strong_critique = ["Ingen svakheter"];
  const snapshot = structuredClone(result);
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  const { summarizeSolutionEvaluation } = load("./context.ts");
  const downstream = JSON.parse(summarizeSolutionEvaluation(reviewed));
  assert.equal(reviewed.evidence_review.status, "coverage_downgraded");
  assert.deepEqual(reviewed.evidence_review.affected_requirement_references, ["A · K-1"]);
  assert.match(downstream.executive_summary, /holdt tilbake/u);
  assert.doesNotMatch(JSON.stringify(downstream), /Ingen tiltak|Perfekt|Alle krav er fullt dokumentert/u);
  assert.deepEqual(reviewed.strengths, []);
  assert.deepEqual(reviewed.architecture_comparison.strong_critique, []);
  assert.ok(!reviewed.source_evidence.references.some(r => r.path.startsWith("result.strengths.")));
  assert.deepEqual(result, snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(reviewed)).evidence_review, reviewed.evidence_review);
});

test("ambiguous and unmatched findings lose stale advice even without a coverage downgrade", () => {
  for (const ambiguous of [false, true]) {
    const { result, input } = fixture();
    result.requirement_coverage.items[0].evidence = "Rammen er 1 500 kr.";
    result.document_findings[0] = { reference: "K-1", reference_match: "coverage", assessment: "Godt", finding: "Alt er dokumentert.", evidence: "", recommendation: "Ingen tiltak." };
    if (ambiguous) result.requirement_coverage.items.push({ ...result.requirement_coverage.items[0], full_reference: "C · K-1" });
    else result.document_findings[0].reference = "K-ikke-registrert";
    const reviewed = reviewSolutionEvaluationEvidence(result, input);
    assert.equal(reviewed.document_findings[0].assessment, "Uklart");
    assert.match(reviewed.document_findings[0].recommendation, /avklar hvilket krav/u);
    assert.match(reviewed.document_findings[0].finding, /ikke knyttes entydig/u);
    assert.equal(reviewed.evidence_review, undefined);
  }
});
