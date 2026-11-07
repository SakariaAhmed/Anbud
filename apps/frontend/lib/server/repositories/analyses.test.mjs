import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");

test("analysis persistence roundtrips without document/parser/blob services and keeps revision/history fences", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-analysis-owner-"));
  const savedKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "isolated-analysis-repository-test-key";
  try {
    const support = path.join(directory, "runtime.cjs");
    writeFileSync(support, `
      const calls = [], state = { rows: {}, rpcResult: null, rpcError: null, fenced: true };
      exports.calls = calls; exports.state = state;
      exports.unstable_cache = fn => fn;
      exports.revalidateTag = tag => calls.push({ tag });
      exports.revalidatePath = route => calls.push({ route });
      exports.createServiceClient = () => ({
        from(table) {
          const filters = [], orders = []; let limit = Infinity;
          const query = {
            select() { return query; }, eq(key,value) { filters.push([key,value]); return query; },
            order(key,options) { orders.push([key,options.ascending]); return query; },
            limit(value) { limit=value; return query; },
            then(resolve,reject) {
              calls.push({ table, filters, orders, limit });
              const data = (state.rows[table] ?? []).filter(row => filters.every(([key,value]) => row[key] === value)).slice(0,limit);
              return Promise.resolve({ data, error: null }).then(resolve,reject);
            }
          }; return query;
        },
        async rpc(name,args) { calls.push({ name,args }); return { data: state.rpcResult, error: state.rpcError }; }
      });
      for (const [name,kind] of [['runLeaseFencedCustomerAnalysisMutation','analysis'],['runLeaseFencedSolutionEvaluationMutation','evaluation'],['runLeaseFencedExecutiveSummaryMutation','summary']]) {
        exports[name] = async (projectId,payload) => {
          calls.push({kind,projectId,payload});
          return state.fenced ? { fenced:true,data:{ id:kind,project_id:projectId,result_json:payload.result_json,revision:'saved-revision',customer_document_id:payload.customer_document_id,solution_document_id:payload.solution_document_id } } : {fenced:false,data:null};
        };
      }
    `);
    const forbidden = path.join(directory, "unrelated-service.cjs");
    writeFileSync(forbidden, "throw new Error('Analysis operation loaded an unrelated document/blob repository.');");
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: true, alias: {
      "next/cache": support,
      "@/lib/server/data-api": support,
      "@/lib/server/repositories/lease-fenced-persistence": support,
      "@/lib/server/repositories/data-store": forbidden,
      "@/lib/server/file-storage-azure": forbidden,
      "@/lib/server/documents": forbidden,
      "@/lib/server/document-chunks": forbidden,
      "@": frontend, "server-only": "/dev/null",
    } });
    const { calls, state } = load(support);
    const repository = load("./analyses.ts");
    const { encryptJson, decryptJson } = load(path.join(frontend, "lib/server/crypto.ts"));
    const analysis = {
      customer_profile_summary: "En kommune", customer_goals_summary: "Trygg drift",
      high_level_solution_design: "Kontrollert innføring", executive_summary: "Sikre tjenester",
      signal_words: ["Sikkerhet"], positioning_recommendations: ["Vis ansvar"], section_histories: {},
    };
    const saved = await repository.saveCustomerAnalysis("project", ["customer"], analysis, {
      expectedSourceRevision: 7, expectedAnalysisRevision: "current-revision",
      previousAnalysis: { ...analysis, revision: "current-revision", executive_summary: "Tidligere strategi" },
      updatedSections: ["strategy"], historySource: "manual_edit",
    });
    assert.equal(saved.revision, "saved-revision");
    assert.equal(saved.executive_summary, analysis.executive_summary);
    const analysisWrite = calls.find(call => call.kind === "analysis");
    assert.equal(analysisWrite.payload.expected_source_revision, 7);
    assert.equal(analysisWrite.payload.expected_analysis_revision, "current-revision");
    assert.deepEqual(analysisWrite.payload.source_document_ids, ["customer"]);
    assert.equal(analysisWrite.payload.result_json.encrypted, true);
    assert.ok(decryptJson(analysisWrite.payload.result_json, {}).section_histories.strategy.length > 0);
    assert.ok(calls.some(call => call.tag === "project:project"));
    assert.ok(calls.some(call => call.route === "/projects/project"));

    await repository.saveSolutionEvaluation("project", {
      customerDocumentId: "customer", solutionDocumentId: "solution", sourceDocumentIds: ["customer", "support", "solution", "support"],
      expectedSourceRevision: 8, result: { strengths: null, architecture_comparison: { architect_solution_score: 150, system_solution_score: -1 } },
    });
    const evaluationWrite = calls.find(call => call.kind === "evaluation");
    assert.equal(evaluationWrite.payload.expected_source_revision, 8);
    assert.deepEqual(evaluationWrite.payload.source_document_ids, ["customer", "support", "solution"]);
    const evaluated = decryptJson(evaluationWrite.payload.result_json, {});
    assert.deepEqual(evaluated.strengths, []);
    assert.equal(evaluated.architecture_comparison.architect_solution_score, 100);
    assert.equal(evaluated.architecture_comparison.system_solution_score, 0);

    const dependency = { id: "evaluation", updated_at: "2026-11-07T00:00:00.000Z", content_hash: "hash", evaluated_generated_artifact_id: null, provenance_mode: "document_only" };
    await repository.saveExecutiveSummary("project", { executive_summary: "Oppsummering" }, { source: "snapshot" }, dependency);
    const summaryWrite = calls.find(call => call.kind === "summary");
    assert.deepEqual(summaryWrite.payload.solution_evaluation_dependency, dependency);
    assert.deepEqual(decryptJson(summaryWrite.payload.input_snapshot, {}), { source: "snapshot" });
    state.fenced = false;
    await assert.rejects(repository.saveExecutiveSummary("project", {}, {}, dependency), /aktiv.*evalueringsfencet/u);
    await assert.rejects(repository.saveSolutionEvaluation("project", { expectedSourceRevision: 8, result: {} }), /aktiv.*lease-fenced/u);
    await assert.rejects(repository.saveCustomerAnalysis("project", [], analysis, { expectedSourceRevision: -1 }), /source_revision/u);

    state.rows.customer_analyses = [{ project_id: "project", provenance_verified: true, result_json: encryptJson(analysis), revision: "current" }];
    assert.equal((await repository.getFreshCustomerAnalysis("project")).revision, "current");
    assert.ok(calls.some(call => call.table === "customer_analyses" && call.filters.some(([key,value]) => key === "provenance_verified" && value === true)));
    state.rows.project_result_history = [{ id: "history", project_id: "project", kind: "customer_analyses", result_json: encryptJson(analysis) }];
    assert.equal((await repository.getProjectResultHistory("project", true))[0].result_json.executive_summary, analysis.executive_summary);
    const historyRead = calls.findLast(call => call.table === "project_result_history");
    assert.equal(historyRead.limit, 1);
    assert.deepEqual(historyRead.orders, [["archived_at", false], ["id", false]]);

    state.rpcResult = {
      evaluation_row: { id: "evaluation", updated_at: dependency.updated_at, result_json: encryptJson({ strengths: ["Dokumentert"] }) },
      dependency,
      executive_summary_row: { result_json: encryptJson({ executive_summary: "Oppsummering" }) },
    };
    const snapshot = await repository.getFreshProjectDerivedSnapshot("project");
    assert.deepEqual(snapshot.dependency, dependency);
    assert.deepEqual(snapshot.evaluation.strengths, ["Dokumentert"]);
    assert.equal(snapshot.executiveSummary.executive_summary, "Oppsummering");
    state.rpcResult.evaluation_row.id = "another-evaluation";
    await assert.rejects(repository.getFreshProjectDerivedSnapshot("project"), /samme snapshot/u);
    state.rpcError = { message: "Synthetic backend failure" };
    await assert.rejects(repository.getFreshProjectDerivedSnapshot("project"), /Synthetic backend failure/u);
  } finally {
    if (savedKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedKey;
    rmSync(directory, { recursive: true, force: true });
  }
});
