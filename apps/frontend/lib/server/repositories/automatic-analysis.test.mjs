import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
test("automatic scheduling preserves lease failures and fences its failure marker to the original pending intent", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "automatic-analysis-repository-"));
  const pending = { request_id: "old-request", status: "pending", job_id: null, source_revision: null, reason_code: null, updated_at: new Date().toISOString(), raw_text: "private field" };
  const state = { request: pending, calls: [], updates: [], error: null, markError: null };
  globalThis.__automaticAnalysisRepositoryTest = state;
  try {
    const io = path.join(directory, "data-api.cjs");
    writeFileSync(io, `exports.createServiceClient = () => ({
      rpc: async (name, input) => { const s=globalThis.__automaticAnalysisRepositoryTest; s.calls.push({name,input}); return {data:null,error:s.error}; },
      from: () => { const s=globalThis.__automaticAnalysisRepositoryTest; let update; const q={select(){return q},eq(k,v){if(update) update.filters[k]=v;return q},async maybeSingle(){return {data:s.request,error:null}},update(value){update={value,filters:{}};s.updates.push(update);return q},then(resolve,reject){return Promise.resolve({error:s.markError}).then(resolve,reject)}};return q; }
    });`);
    const frontend = path.resolve(import.meta.dirname, "../../..");
    const { getAutomaticAnalysisRequest, scheduleReadyCustomerAnalysis, dispatchReadyCustomerAnalyses } = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/data-api": io, "@": frontend, "server-only": "/dev/null" } })("./automatic-analysis.ts");
    const lease = { projectId: "project", jobId: "parent", leaseToken: "lease" };
    assert.equal("raw_text" in await getAutomaticAnalysisRequest("project"), false);
    await scheduleReadyCustomerAnalysis("project", lease);
    assert.deepEqual(state.calls[0], { name: "schedule_ready_customer_analysis", input: { p_project_id: "project", p_parent_job_id: "parent", p_parent_lease_token: "lease" } });
    assert.equal(state.updates.length, 0);
    state.error = { message: "PROJECT_JOB_LEASE_LOST: stale parent" };
    await assert.rejects(scheduleReadyCustomerAnalysis("project", lease), /lease|parent/iu);
    assert.equal(state.updates.length, 0, "A stale worker must never mark the current intent failed.");
    state.error = { message: "Scheduling transaction unavailable" };
    await assert.rejects(scheduleReadyCustomerAnalysis("project", null), /unavailable/u);
    assert.deepEqual(state.updates.at(-1).filters, { project_id: "project", request_id: "old-request", status: "pending" });
    assert.equal(state.updates.at(-1).value.status, "failed");
    state.request = { ...pending, status: "failed" }; const calls = state.calls.length;
    await scheduleReadyCustomerAnalysis("project", null); assert.equal(state.calls.length, calls, "Failed attempts do not retry automatically.");
    state.error = null; await dispatchReadyCustomerAnalyses();
    assert.deepEqual(state.calls.at(-1), { name: "dispatch_ready_customer_analyses", input: { p_limit: 20 } });
    const errors = []; t.mock.method(console, "error", message => errors.push(message));
    state.request = pending; state.error = { message: "Scheduling failed" }; state.markError = { message: "Failure status unavailable" };
    await assert.rejects(scheduleReadyCustomerAnalysis("project", null), /Scheduling failed/u);
    assert.ok(errors.some(message => message.includes("automatic_analysis_failure_state_not_saved")));
    assert.ok(errors.every(message => !message.includes("private field")));
  } finally { delete globalThis.__automaticAnalysisRepositoryTest; rmSync(directory, { recursive: true, force: true }); }
});
