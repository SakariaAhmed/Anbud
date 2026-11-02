import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("../../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { reviewSolutionEvaluationEvidence } = load("../ai.ts");

test("a source downgrade updates coverage text, scores, winner and source-qualified findings together", () => {
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
  const reviewed = reviewSolutionEvaluationEvidence(result, { documents, authoritativeRequirementRefs: ["K-1", "K-2"] });
  assert.deepEqual(reviewed.requirement_coverage.items.map(row => row.assessment), ["Uklart", "Godt"]);
  assert.equal(reviewed.requirement_coverage.good, 1); assert.equal(reviewed.requirement_coverage.unclear, 1);
  assert.match(reviewed.requirement_coverage.coverage_summary, /1 er vurdert som gode.*1 er uklare/u);
  assert.equal(reviewed.architecture_comparison.architect_solution_score, 68);
  assert.equal(reviewed.architecture_comparison.winner, "Systemløsning");
  assert.deepEqual(reviewed.document_findings.map(f => f.assessment), ["Uklart", "Godt", "Godt"]);
  assert.ok(!reviewed.source_evidence.references.some(ref => ref.path === "result.architecture_comparison.verdict"), "Rewritten comparison text cannot inherit the original field's quotation proof.");
  assert.equal(result.requirement_coverage.good, 2, "The input snapshot is not mutated.");
});
