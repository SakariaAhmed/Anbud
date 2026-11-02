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
test("unverified criterion identity stays unknown even when the model claims missing coverage", () => {
  for(const row of [{...proposed,assessment:"Mangler",source_quote:"Oppdiktet kriterium"},{...proposed,assessment:"Mangler",requirement_references:[]},{...proposed,assessment:"Mangler",requirement_references:["Ukjent krav"]}]) {
    const item=normalize([row])[0];
    assert.equal(item.assessment,"Uklart");
    assert.equal(item.review_required,true);
  }
  const known=normalize([{...proposed,assessment:"Mangler"}]);
  assert.equal(known[0].assessment,"Mangler","A verified criterion's negative assessment is preserved.");
  assert.equal(reconcileCriterionCoverage(known,{items:[]})[0].assessment,"Uklart","Removed links no longer establish missing coverage.");
});

const documentedText = "Tildelingskriterium: Kvalitet på overgangsplan";
const documented = { ...customer, raw_text: `[[SIDE:2]]\n${documentedText}`, structure_map: [{ reference: "Tildeling · side 2", text: documentedText, page: 2 }] };
function explicit(rows = [proposed], document = documented, options = {}) {
  return normalizeCriterionCoverage(rows, { criteria: [criterion], coverage, customerDocuments: [document], solutionDocument: solution, analysisRevision: "analysis-v1", sourceRevision: 7, ...options });
}

test("existing structured evidence establishes explicit criteria independently of model origin and quote", () => {
  const [item] = explicit([{ ...proposed, origin: "suggested", source_quote: "Oppdiktet" }]);
  assert.equal(item.origin, "observed");
  assert.equal(item.assessment, "Godt");
  assert.equal(item.criterion_source.original_quote, documentedText);
  assert.equal(item.criterion_source.source_revision, 1);
  assert.equal(item.answer_source.original_quote, solution.raw_text);
  assert.equal(item.criterion_scope.analysis_revision, "analysis-v1");
  assert.equal(item.criterion_scope.project_source_revision, 7);
  assert.equal(explicit()[0].criterion_id, item.criterion_id);
  assert.deepEqual(projectFollowUpItems({ artifacts: [], analysis: { revision: "analysis-v1", likely_evaluation_criteria: [criterion] }, evaluation: { criterion_coverage: [item] } }), []);
});

test("supplier statements, proposals, qualification rules and ambiguous duplicates never become explicit award criteria", () => {
  for (const text of [
    "Leverandøren foreslår tildelingskriterium: Kvalitet på overgangsplan",
    "Tildelingskriterium: Eksempel på kvalitet på overgangsplan",
    "Tildelingskriterium: Hvis kunden ønsker kvalitet på overgangsplan",
    "Tildelingskriterium: Kvalifikasjonskrav til kvalitet på overgangsplan",
    "Tildelingskriterium: Leverandøren har kvalitet på overgangsplan",
    "Kvaliteten på overgangsplanen vil bli vurdert.",
  ]) {
    const document = { ...documented, raw_text: text, structure_map: [{ reference: "Side 2", text, page: 2 }] };
    const [item] = explicit([{ ...proposed, criterion: text, origin: "observed", source_quote: text }], document, { criteria: [text] });
    assert.equal(item.origin, "suggested", text);
  }
  const repeated = { ...documented, raw_text: `${documented.raw_text}\n[[SIDE:3]]\n${documentedText}` };
  assert.notEqual(explicit(undefined, repeated)[0].origin, "observed");
  const other = { ...documented, id: "other" };
  const [ambiguous] = explicit(undefined, documented, { customerDocuments: [documented, other] });
  assert.equal(ambiguous.assessment, "Uklart");
  assert.notEqual(ambiguous.origin, "observed");
  const duplicate = explicit([{ ...proposed, assessment: "Mangler" }], documented, { criteria: [criterion, criterion] });
  assert.ok(duplicate.every(item => item.assessment === "Uklart"));
  assert.notEqual(explicit(undefined, { ...documented, chunk_source_revision: 0 })[0].origin, "observed");
});

test("captured scope survives changed sources, analysis and manual edits without reusing a positive assessment", () => {
  const saved = explicit();
  const changed = { ...documented, raw_text: `${documented.raw_text}\nEndret tekst`, chunk_source_revision: 2 };
  const reviewed = reconcileCriterionCoverage(saved, coverage, [changed, solution]);
  assert.equal(reviewed[0].assessment, "Uklart");
  assert.equal(reviewed[0].origin, "unknown");
  assert.deepEqual(saved[0].criterion_scope.documents[0].revision, 1);
  assert.notEqual(explicit(undefined, changed)[0].criterion_id, saved[0].criterion_id);
  assert.notEqual(explicit(undefined, documented, { analysisRevision: "analysis-v2" })[0].criterion_id, saved[0].criterion_id);
  for (const analysis of [
    { revision: "analysis-v2", likely_evaluation_criteria: [criterion] },
    { revision: "analysis-v1", likely_evaluation_criteria: [criterion, "Pris"] },
  ]) {
    const items = projectFollowUpItems({ artifacts: [], analysis, evaluation: { criterion_coverage: saved } });
    assert.match(items[0].description, /dekningen er ukjent/u);
  }
  const manual = { ...saved[0], criterion: "Manuelt endret kriterium", assessment: "Mangler" };
  assert.equal(reconcileCriterionCoverage([manual], coverage)[0].assessment, "Uklart");
  const legacy = { ...saved[0], criterion_scope: undefined };
  assert.equal(reconcileCriterionCoverage([legacy], coverage)[0].assessment, "Uklart");
  assert.equal(reconcileCriterionCoverage([{ ...saved[0], assessment: "Mangler" }], coverage, [changed, solution])[0].assessment, "Uklart");
});

test("an exact documented award weighting stays distinct from a model's inferred label", () => {
  const text = "Tildelingen vekter kvalitet 60 prosent og pris 40 prosent.";
  const document = { ...documented, raw_text: `[[SIDE:2]]\n${text}`, structure_map: [{ reference: "Tildeling · side 2", text, page: 2 }] };
  const [observed] = explicit([{ ...proposed, criterion: text }], document, { criteria: [text] });
  assert.equal(observed.origin, "observed");
  assert.equal(observed.criterion_source.original_quote, text);
  const [inferred] = explicit([{ ...proposed, criterion: "Kvalitet", origin: "observed", source_quote: text }], document, { criteria: ["Kvalitet"] });
  assert.equal(inferred.origin, "suggested", "A quote cannot certify a model's paraphrase as an explicit criterion.");
  const [legacyLink] = explicit([{ ...proposed, requirement_references: ["K-1"] }], document, { coverage: { items: [{ reference: "K-1", assessment: "Godt" }] } });
  assert.equal(legacyLink.assessment, "Uklart", "Links require full source-qualified identities.");
});
