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

function criterionFixture() {
  const { result, input } = fixture();
  result.requirement_coverage.items[0].evidence = "Rammen er 1 500 kr.";
  const customer = { id: "criterion-source", project_id: "project", title: "Kriterier", role: "primary_customer_document", chunk_source_revision: 1, raw_text: "[[SIDE:2]]\nTildelingskriterium: Kvalitet på overgangsplan", structure_map: [{ reference: "Tildeling · side 2", text: "Tildelingskriterium: Kvalitet på overgangsplan", page: 2 }] };
  const solution = { ...customer, id: "criterion-answer", role: "primary_solution_document", raw_text: "Overgangen har tre milepæler med godkjenning fra kunden.", structure_map: [] };
  input.documents.push({ document: customer, sourceType: "project_document" }, { document: solution, sourceType: "project_document" });
  const { normalizeCriterionCoverage } = load("./criterion-coverage.ts");
  result.criterion_coverage = normalizeCriterionCoverage([{ criterion_index: 0, criterion: "Kvalitet på overgangsplan", assessment: "Godt", rationale: "Planen er konkret.", evidence: solution.raw_text, requirement_references: ["A · K-1"] }], { criteria: ["Kvalitet på overgangsplan"], coverage: result.requirement_coverage, customerDocuments: [customer], solutionDocument: solution });
  return { result, input, customer, solution };
}

test("an unlinked proposed criterion does not erase verified requirement narratives", () => {
  const {result,input}=criterionFixture();
  const narrative={strengths:["Tydelige milepæler."],weaknesses:["Avklar prisen."],value_assessment:[{title:"Forutsigbarhet"}],executive_summary:"Kravene har dokumenterte svar."};
  Object.assign(result,narrative);
  result.criterion_coverage=[{...result.criterion_coverage[0],criterion:"Pris",origin:"suggested",assessment:"Uklart",review_required:true,requirement_references:[]}];
  const reviewed=reviewSolutionEvaluationEvidence(result,input);
  assert.ok(reviewed.requirement_coverage.items.every(row=>row.assessment==="Godt"));
  assert.equal(reviewed.criterion_coverage[0].assessment,"Uklart");
  assert.equal(reviewed.evidence_review,undefined);
  for(const [key,value] of Object.entries(narrative))assert.deepEqual(reviewed[key],value,key);
});

test("criterion source/answer metadata is immutable evidence while rejected answer/rationale and linked downgrades withhold positive conclusions", () => {
  const initial = criterionFixture();
  const checked = reviewSolutionEvaluationEvidence(initial.result, initial.input);
  assert.equal(checked.criterion_coverage[0].assessment, "Godt");
  assert.equal(checked.criterion_coverage[0].origin, "observed");
  assert.deepEqual(checked.criterion_coverage[0].criterion_source, initial.result.criterion_coverage[0].criterion_source);
  assert.deepEqual(checked.criterion_coverage[0].answer_source, initial.result.criterion_coverage[0].answer_source);
  assert.deepEqual(checked.criterion_coverage[0].criterion_scope, initial.result.criterion_coverage[0].criterion_scope);
  for (const target of ["evidence", "rationale", "linked_requirement", "source_changed", "label_changed"]) {
    const { result, input, customer } = criterionFixture();
    if (target === "linked_requirement") result.requirement_coverage.items[0].evidence = "«Dette finnes ikke i originalen.»";
    else if (target === "source_changed") customer.chunk_source_revision = 2;
    else if (target === "label_changed") { result.criterion_coverage[0].criterion = "«Oppdiktet kriterium»"; result.criterion_coverage[0].assessment = "Mangler"; }
    else result.criterion_coverage[0][target] = "«Dette finnes ikke i originalen.»";
    const reviewed = reviewSolutionEvaluationEvidence(result, input);
    assert.equal(reviewed.criterion_coverage[0].assessment, "Uklart", target);
    assert.equal(reviewed.criterion_coverage[0].review_required, true, target);
    assert.doesNotMatch(reviewed.criterion_coverage[0].rationale, /Planen er konkret/u);
    if (target !== "label_changed") {
      assert.equal(reviewed.evidence_review.status, "coverage_downgraded");
      assert.deepEqual(reviewed.strengths, []);
      assert.match(reviewed.executive_summary, /holdt tilbake/u);
    } else assert.equal(reviewed.evidence_review, undefined);
    assert.equal(result.criterion_coverage[0].assessment, target === "label_changed" ? "Mangler" : "Godt", "The captured input is not mutated.");
  }
});

test("criterion normalization cannot hide a lost model-positive rating from narrative review", () => {
  const { result, input, customer, solution } = criterionFixture();
  const raw = [{ criterion_index: 0, criterion: "Kvalitet på overgangsplan", assessment: "Godt", rationale: "Planen er konkret.", evidence: "Oppdiktet svargrunnlag", requirement_references: ["A · K-1"] }];
  const { normalizeCriterionCoverage } = load("./criterion-coverage.ts");
  result.criterion_coverage = normalizeCriterionCoverage(raw, { criteria: [raw[0].criterion], coverage: result.requirement_coverage, customerDocuments: [customer], solutionDocument: solution });
  assert.equal(result.criterion_coverage[0].assessment, "Uklart");
  result.strengths = ["Overgangsplanen er løsningens sterkeste side"];
  result.executive_summary = result.strengths[0];
  const reviewed = reviewSolutionEvaluationEvidence(result, input, raw);
  assert.equal(reviewed.evidence_review.status, "coverage_downgraded");
  assert.deepEqual(reviewed.evidence_review.affected_requirement_references, []);
  assert.deepEqual(reviewed.strengths, []);
  assert.match(reviewed.executive_summary, /kriterievurderingen.*holdt tilbake/u);
  assert.ok(reviewed.requirement_coverage.items.every(row => row.assessment === "Godt"));
  assert.equal(raw[0].assessment, "Godt");
});
