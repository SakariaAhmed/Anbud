import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, "output/speed-quality-2026-09-08/verification/final-sse.json");
if (existsSync(output)) throw new Error("Preserve the existing SSE evidence.");
const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json"), "utf8"));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
const base = "http://localhost:4318";
const ledger = path.join(root, "output/speed-quality-2026-09-08/api-budget.json");
const digest = () => createHash("sha256").update(readFileSync(ledger)).digest("hex");
const ledgerBefore = digest();
const projectId = randomUUID();
const jobId = randomUUID();
const controllers = [];
const report = { at: new Date().toISOString(), scope: "Actual authenticated local Next SSE, isolated manually seeded running status, two clients, disconnect, heartbeat and manually persisted terminal transition. No worker execution or job cancellation, no model calls, no before/after latency claim.", checks: {} };
async function db(route, method = "GET", body) {
  const response = await fetch(`${env.DATA_API_URL}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Local DB status ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function connect(cookie) {
  const controller = new AbortController();
  controllers.push(controller);
  const started = performance.now();
  const response = await fetch(`${base}/api/projects/${projectId}/jobs/${jobId}/events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return { controller, started, async next() {
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          if (!event) continue;
          return { event, data: JSON.parse(/^data: (.+)$/m.exec(raw)[1]) };
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timer); }
  } };
}
try {
  await db("projects", "POST", { id: projectId, owner_id: env.APP_ADMIN_PRINCIPAL_ID, title: "Isolert SSE-kontroll", client_name: "Fiktiv SSE-kontroll" });
  await db("project_jobs", "POST", { id: jobId, project_id: projectId, kind: "customer_analysis", status: "running", message: "Syntetisk status; ingen worker", locked_at: new Date().toISOString(), lease_token: randomUUID() });
  const anonymous = await fetch(`${base}/api/projects/${projectId}/jobs/${jobId}/events`);
  assert.equal(anonymous.status, 401);
  report.checks.anonymousDenied = true;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  const first = await connect(cookie);
  const second = await connect(cookie);
  for (const stream of [first, second]) {
    const event = await stream.next();
    assert.equal(event.event, "job"); assert.equal(event.data.job.id, jobId); assert.equal(event.data.job.status, "running");
  }
  report.checks.twoSubscribersReceivedRunning = true;
  first.controller.abort();
  assert.equal((await second.next()).event, "heartbeat");
  const stillRunning = await db(`project_jobs?id=eq.${jobId}&select=status`);
  assert.equal(stillRunning[0].status, "running");
  report.checks.disconnectPreservesOtherSubscriberAndJob = true;
  await db(`project_jobs?id=eq.${jobId}`, "PATCH", { status: "failed", message: "Kontroll fullført", error: "Syntetisk terminalstatus", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  let terminal;
  do { terminal = await second.next(); } while (terminal?.event === "heartbeat");
  assert.equal(terminal.event, "job"); assert.equal(terminal.data.job.status, "failed");
  assert.equal(await second.next(), null);
  report.checks.persistedTerminalDeliveredAndStreamClosed = true;
  report.ledgerUnchanged = ledgerBefore === digest();
  assert.equal(report.ledgerUnchanged, true);
} finally {
  for (const controller of controllers) controller.abort();
  await db(`projects?id=eq.${projectId}`, "DELETE");
  assert.deepEqual(await db(`projects?id=eq.${projectId}&select=id`), []);
  assert.deepEqual(await db(`project_jobs?id=eq.${jobId}&select=id`), []);
}
report.checks.isolatedFixtureRemoved = true;
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
