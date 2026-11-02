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

test("a nonbinding coverage cap preserves the comparison reasoning and its proof", () => {
  const { result, input } = fixture();
  result.architecture_comparison.architect_solution_score = 60;
  result.architecture_comparison.winner = "Systemløsning";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.equal(reviewed.requirement_coverage.unclear, 1);
  assert.equal(reviewed.architecture_comparison.architect_solution_score, 60);
  assert.equal(reviewed.architecture_comparison.winner, "Systemløsning");
  assert.equal(reviewed.architecture_comparison.verdict, result.architecture_comparison.verdict);
  assert.ok(reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"));
});

test("a rewritten comparison drops both the replaced quotation proof and its old validation issue", () => {
  const { result, input } = fixture();
  result.architecture_comparison.verdict = "«Dette finnes ikke i dokumentet.»";
  const reviewed = reviewSolutionEvaluationEvidence(result, input);
  assert.match(reviewed.architecture_comparison.verdict, /Poengene er oppdatert/u);
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
