import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("../../..", import.meta.url).pathname, "server-only": "/dev/null" } });
const { normalizeCriterionCoverage, reconcileCriterionCoverage } = load("./criterion-coverage.ts");
const { projectFollowUpItems } = load("../../project-follow-up.ts");
const customer = { id: "customer", role: "primary_customer_document", title: "Krav", raw_text: "[[SIDE:2]]\nKvaliteten på overgangsplanen vil bli vurdert.", structure_map: [], chunk_source_revision: 1 };
const solution = { ...customer, id: "solution", raw_text: "Overgangen har tre milepæler med godkjenning fra kunden." };
const criterion = "Kvalitet på overgangsplan";
const coverage = { items: [{ reference: "K-1", full_reference: "Krav · K-1", assessment: "Godt" }] };
const proposed = { criterion_index: 0, criterion, assessment: "Godt", rationale: "Planen er konkret.", source_quote: "Kvaliteten på overgangsplanen vil bli vurdert.", evidence: solution.raw_text, requirement_references: ["Krav · K-1"] };
const normalize = (rows = [proposed], requirements = coverage) => normalizeCriterionCoverage(rows, { criteria: [criterion], coverage: requirements, customerDocuments: [customer, customer], solutionDocument: solution });

test("criterion assessments round-trip with source identity and remain suggestions", () => {
  const rows = normalize();
  assert.equal(rows[0].assessment, "Godt");
  assert.equal(rows[0].origin, "suggested");
  assert.equal(rows[0].criterion_source.source_id, "customer");
  assert.equal(rows[0].criterion_source.page_start, 2);
  const reloaded = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(reloaded, rows);
  assert.deepEqual(projectFollowUpItems({ artifacts: [], analysis: { likely_evaluation_criteria: [criterion] }, evaluation: { criterion_coverage: reloaded } }), []);
  assert.equal(projectFollowUpItems({ artifacts: [], analysis: { likely_evaluation_criteria: [criterion] }, evaluation: {} }).length, 1, "Legacy results stay unknown.");
});
test("foreign, invented or ambiguous links and absent answer evidence cannot establish coverage", () => {
  for (const row of [{ ...proposed, requirement_references: ["K-99"] }, { ...proposed, evidence: "Ikke dokumentert" }, { ...proposed, source_quote: "Dette finnes ikke" }, { ...proposed, criterion: "Foreign" }]) {
    const item = normalize([row])[0];
    assert.equal(item.assessment, "Uklart");
    assert.equal(item.review_required, true);
  }
  const repeated = normalize([proposed], { items: [coverage.items[0], { ...coverage.items[0] }] });
  assert.equal(repeated[0].assessment, "Uklart");
});
test("later requirement evidence downgrades cap linked criteria without raising missing ratings", () => {
  const original = normalize();
  const reviewed = reconcileCriterionCoverage(original, { items: [{ ...coverage.items[0], assessment: "Uklart" }] });
  assert.equal(reviewed[0].assessment, "Uklart");
  assert.equal(reviewed[0].review_required, true);
  assert.equal(original[0].assessment, "Godt");
  assert.equal(reconcileCriterionCoverage([{ ...original[0], assessment: "Mangler" }], coverage)[0].assessment, "Mangler");
  const items = projectFollowUpItems({ artifacts: [], analysis: { likely_evaluation_criteria: [criterion] }, evaluation: { criterion_coverage: reviewed } });
  assert.match(items[0].description, /^Uklart:/u);
});
