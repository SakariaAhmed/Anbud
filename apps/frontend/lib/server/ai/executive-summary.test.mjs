import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const frontend = new URL("../../..", import.meta.url).pathname;
test("a legacy evaluation summary verifies customer quotations against the scoped document snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "executive-evidence-"));
  try {
    const completion = path.join(directory, "completion.cjs");
    fs.writeFileSync(completion, `exports.createJsonCompletion=async()=>({source_solution_evaluation_present:true,executive_summary:'Kunden krever «data skal behandles i Norge».',fit_to_customer_needs:'Drift og databehandling må dokumenteres.',likely_score_assessment:{quality:'Middels',delivery_confidence:'Middels',risk:'Middels',competitiveness:'Middels'},strengths:[],weaknesses:[]});`);
    const { generateExecutiveSummary } = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/ai/completion": completion, "@": frontend, "server-only": "/dev/null" } })("./executive-summary.ts");
    const input = { projectName: "Fiktiv", customerAnalysis: null, solutionEvaluation: { executive_summary: "Tidligere vurdering uten kildekontrakt.", strengths: [], weaknesses: [], missing_elements: [], risks_to_customer: [], improvement_recommendations: [], likely_score_assessment: {}, requirement_coverage: { items: [] } }, sourceDocuments: [{ sourceType: "project_document", document: { id: "customer", project_id: "fictional", role: "primary_customer_document", title: "Krav", raw_text: "Kundens data skal behandles i Norge.", structure_map: [], chunk_source_revision: 7 } }] };
    const result = await generateExecutiveSummary(input);
    assert.equal(result.source_evidence.issues, undefined);
    assert.equal(result.source_evidence.references[0].source.source_revision, 7);
    assert.equal(result.source_evidence.references[0].source.original_quote, "data skal behandles i Norge");
    const missing = await generateExecutiveSummary({ ...input, sourceDocuments: [] });
    assert.match(missing.executive_summary, /Må avklares/u);
    assert.equal(missing.source_evidence.issues[0].path, "result.executive_summary");
    assert.equal(missing.source_evidence.references.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
