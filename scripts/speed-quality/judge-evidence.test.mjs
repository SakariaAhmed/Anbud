import test from "node:test";
import assert from "node:assert/strict";
import { judgeEvidence } from "./judge-evidence.mjs";

test("judges cannot demand facts outside the actual generation owner's source boundary", () => {
  const input = { customerDocument: { title: "Customer", raw_text: "Customer requirements" }, supportingDocuments: [], solutionDocument: { title: "Supplier", raw_text: "Supplier-only deviations" }, solutionEvaluation: { architecture_comparison: "Derived architecture" } };
  const summaries = { customerAnalysis: "Derived customer facts", solutionEvaluation: "Frozen evaluation" };
  for (const kind of ["customer_analysis", "customer_analysis_v3", "section_strategy", "high_level_design"]) {
    const evidence = judgeEvidence(kind, input, summaries);
    assert.equal(evidence.sourceDocuments.length, 1);
    assert.doesNotMatch(JSON.stringify(evidence), /Supplier-only|Frozen evaluation/);
  }
  const executive = judgeEvidence("executive_summary", input, summaries);
  assert.deepEqual(executive.sourceDocuments, []);
  assert.equal(executive.derivedContext.solutionEvaluation, "Frozen evaluation");
  assert.equal(executive.derivedContext.architectureComparison, "Derived architecture");
  assert.equal(judgeEvidence("forbedret_kravsvar", input, summaries).sourceDocuments.length, 2);
});
