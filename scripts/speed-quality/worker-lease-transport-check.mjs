import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "v1";
assert.match(label, /^[a-z0-9-]+$/);
const output = path.join(dir, `verification/worker-lease-transport-${label}`);
assert.equal(existsSync(output), false); mkdirSync(output);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const protectedFiles = ["api-budget.json", "generation-inputs.json"];
const originalHashes = protectedFiles.map((file) => sha(readFileSync(path.join(dir, file))));
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json")));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
const providerOrigin = "http://127.0.0.1:4329";
Object.assign(process.env, env, { OPENAI_API_KEY: "local-stalled-transport-only", OPENAI_BASE_URL: `${providerOrigin}/v1` });
const nativeFetch = globalThis.fetch;
const databaseRequests = [];
globalThis.fetch = async (...args) => {
  const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  assert.ok([env.DATA_API_URL, providerOrigin].includes(url.origin), "All external network requests are prohibited.");
  if (url.origin !== env.DATA_API_URL) return nativeFetch(...args);
  const atMs = performance.now();
  const response = await nativeFetch(...args);
  const result = await response.clone().json().catch(() => null);
  const payload = typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : null;
  databaseRequests.push({ atMs, completedAtMs: performance.now(), path: url.pathname,
    method: args[1]?.method ?? "GET", status: response.status,
    hasLeaseFilter: url.searchParams.has("lease_token"),
    payloadFields: payload && typeof payload === "object" ? Object.keys(payload) : [],
    statusValue: payload?.status, returnedRows: Array.isArray(result) ? result.length : null,
    errorCode: typeof result?.code === "string" ? result.code : undefined,
    zeroRowsDetail: result?.code === "PGRST116" && typeof result.details === "string" && /\b0 rows\b/u.test(result.details),
  });
  return response;
};
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  "@": frontend, "server-only": "/dev/null",
  "next/cache": path.join(frontend, "lib/server/repositories/data-store.persistence.test-support.ts"),
} });
const { encryptJson } = jiti(path.join(frontend, "lib/server/crypto.ts"));
const { queueExecutiveSummaryJob, runQueuedProjectJob } = jiti(path.join(frontend, "lib/server/project-jobs.ts"));
const { assertExecutiveSummaryEvaluationReady } = jiti(path.join(frontend, "lib/server/executive-summary-readiness.ts"));
const projectId = randomUUID(), jobId = randomUUID();
const report = { at: new Date().toISOString(), completed: false, scope: "Actual persisted queue/claim, executive-summary workflow, normal 30-second heartbeat, OpenAI SDK and local HTTP transport. Service-role takeover changes only this new test job's lease. Provider response is deliberately withheld; no OpenAI/Azure network or AI generation quality is tested. Next cache is bypassed/invalidation stubbed; route authentication and user cancellation are not exercised. DB instrumentation clones responses and records only method, timing, field names, row counts and status; not request secrets or content.", projectId, jobId, providerRequests: [], events: [], databaseRequests };
const persist = () => writeFileSync(path.join(output, "checks.json"), `${JSON.stringify(report, null, 2)}\n`);
const originalWarn = console.warn;
console.warn = (...args) => { try { const e = JSON.parse(args[0]); if (e.job_id === jobId) report.events.push({ ...e, atMs: performance.now() }); } catch {} originalWarn(...args); };
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const arrived = deferred(), closed = deferred();
const connections = new Set();
const server = createServer(async (request, response) => {
  connections.add(response);
  response.on("close", () => { report.transportClosedAtMs = performance.now(); connections.delete(response); closed.resolve(); });
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.url, "/v1/chat/completions");
    const body = Buffer.concat(chunks);
    const payload = JSON.parse(body);
    report.providerRequests.push({ route: request.url, model: payload.model, bodySha256: sha(body), atMs: performance.now() });
    arrived.resolve(); persist();
    // No headers or body are sent. Only the worker's real abort can close it.
  } catch (error) {
    report.providerHandlerError = error instanceof Error ? error.message : String(error);
    response.destroy(); arrived.resolve(); persist();
  }
});
async function db(route, method = "GET", body) {
  const response = await fetch(`${env.DATA_API_URL}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Disposable fixture operation failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}
async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
let created = false, worker;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(4329, "127.0.0.1", resolve); });
  const evaluation = JSON.parse(readFileSync(path.join(dir, "matrix-baseline16k-fjord-drift-development-solution_evaluation.json"))).result;
  assertExecutiveSummaryEvaluationReady(evaluation);
  await db("projects", "POST", { id: projectId, owner_id: env.APP_ADMIN_PRINCIPAL_ID, title: "Fiktiv lease-transportkontroll", client_name: "Disponibel test" }); created = true;
  await db("solution_evaluations", "POST", { project_id: projectId, evaluation_provenance_mode: "document_only", result_json: encryptJson(evaluation) });
  const sourceBefore = (await db(`projects?id=eq.${projectId}&select=source_revision`))[0].source_revision;
  const queued = await queueExecutiveSummaryJob({ projectId }, { autoRun: false, jobId });
  assert.equal(queued.id, jobId); assert.equal(queued.status, "queued");
  let workerDone = false;
  worker = runQueuedProjectJob(jobId).finally(() => { workerDone = true; report.workerReturnedAtMs = performance.now(); });
  await within(Promise.race([arrived.promise, worker.then(() => { throw new Error("Worker finished before reaching the controlled provider."); })]), 15000, "Worker did not reach the local provider.");
  assert.equal(workerDone, false);
  assert.equal(report.providerHandlerError, undefined);
  const running = (await db(`project_jobs?id=eq.${jobId}&select=status,lease_token,result_checkpoint,result_json`))[0];
  assert.equal(running.status, "running"); assert.ok(running.lease_token);
  assert.equal(connections.size, 1); assert.equal(report.transportClosedAtMs, undefined);
  report.transportOpenBeforeTakeover = true;
  assert.equal(running.result_checkpoint, null); assert.equal(running.result_json, null);
  const replacementLease = randomUUID();
  report.takeoverAtMs = performance.now();
  await db(`project_jobs?id=eq.${jobId}&lease_token=eq.${running.lease_token}`, "PATCH", { lease_token: replacementLease });
  report.takeoverCompletedAtMs = performance.now();
  await within(Promise.all([closed.promise, worker]), 45000, "Lease loss did not stop the worker and HTTP transport.");
  const final = (await db(`project_jobs?id=eq.${jobId}&select=status,lease_token,result_checkpoint,result_json`))[0];
  assert.equal(final.status, "running"); assert.equal(final.lease_token, replacementLease);
  assert.equal(final.result_checkpoint, null); assert.equal(final.result_json, null);
  assert.deepEqual(await db(`executive_summaries?project_id=eq.${projectId}&select=id`), []);
  assert.deepEqual(await db(`generated_artifacts?project_id=eq.${projectId}&select=id`), []);
  assert.equal((await db(`projects?id=eq.${projectId}&select=source_revision`))[0].source_revision, sourceBefore);
  assert.equal(report.providerRequests.length, 1);
  assert.ok(report.events.some((e) => e.event === "project_job_heartbeat_lease_lost"));
  assert.ok(report.events.some((e) => e.event === "project_job_execution_cancelled"));
  const staleWrites = databaseRequests.filter((r) => r.atMs >= report.takeoverCompletedAtMs && r.path === "/project_jobs" && r.method === "PATCH");
  assert.ok(staleWrites.length > 0, "The real heartbeat must attempt renewal after takeover.");
  assert.ok(staleWrites.every((r) => r.hasLeaseFilter &&
    (r.status === 200 && r.returnedRows === 0 || r.status === 406 && r.errorCode === "PGRST116" && r.zeroRowsDetail)));
  assert.ok(staleWrites.every((r) => !["completed", "failed"].includes(r.statusValue)));
  report.postTakeoverWritesWereFenced = true;
  const leaseLost = report.events.find((e) => e.event === "project_job_heartbeat_lease_lost");
  assert.ok(leaseLost.atMs <= report.workerReturnedAtMs && leaseLost.atMs <= report.transportClosedAtMs);
  report.leaseLossPrecededWorkerReturnAndTransportClose = true;
  report.takeoverToTransportCloseMs = report.transportClosedAtMs - report.takeoverAtMs;
  report.takeoverToWorkerReturnMs = report.workerReturnedAtMs - report.takeoverAtMs;
  report.replacementLeasePreserved = true; report.noGeneratedOutputs = true; report.sourceRevisionUnchanged = true; report.completed = true;
} catch (error) { report.failure = error instanceof Error ? error.message : String(error); throw error; }
finally {
  for (const response of connections) response.destroy();
  if (worker) await within(worker.catch(() => {}), 35000, "Worker cleanup timed out.").catch((error) => { report.cleanupFailure = error.message; });
  await new Promise((resolve) => server.close(resolve));
  if (created) { await db(`projects?id=eq.${projectId}`, "DELETE"); assert.deepEqual(await db(`projects?id=eq.${projectId}&select=id`), []); report.fixtureRemoved = true; }
  assert.deepEqual(protectedFiles.map((file) => sha(readFileSync(path.join(dir, file)))), originalHashes);
  report.protectedFilesUnchanged = true; persist();
  globalThis.fetch = nativeFetch; console.warn = originalWarn;
}
console.log(JSON.stringify(report, null, 2));
