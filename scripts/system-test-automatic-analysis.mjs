#!/usr/bin/env node
// Explicit paid test of the persisted upload intent and normal job drain.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { systemTestStatusPath } from "./system-test-runtime.mjs";
if (!process.argv.includes("--ai")) throw new Error("Explicit --ai required for automatic-analysis generation.");
const status = JSON.parse(fs.readFileSync(systemTestStatusPath(), "utf8"));
assert.equal(status.running, true); assert.equal(status.baseUrl, "http://127.0.0.1:4338");
const runtime = JSON.parse(fs.readFileSync(path.join(status.directory, "environment.json"), "utf8"));
const webAutorun = process.argv.includes("--web-autorun");
assert.equal(runtime.env.PROJECT_JOB_WORKER_PROCESS, webAutorun ? "0" : "1", "Restart the owned app with the matching worker/web mode before testing automatic analysis.");
assert.equal(runtime.env.OPENAI_BASE_URL, "http://127.0.0.1:4340/v1");
assert.ok((await (await fetch("http://127.0.0.1:4340/budget")).json()).remainingUsd > 0);
async function request(route, options = {}, expected = 200) {
  const r = await fetch(status.baseUrl + route, { ...options, signal: AbortSignal.timeout(600_000), headers: { cookie: runtime.sessions.adminCookie, origin: status.baseUrl, ...options.headers } });
  assert.equal(r.status, expected, `${options.method ?? "GET"} ${route}: ${r.status}`); return r.json();
}
const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const project = await request("/api/projects", json({ name: "Fiktiv automatisk analysetest", customer_name: "Fiktiv kommune" }), 201);
const route = `/api/projects/${project.id}`;
async function upload(role, name, content, choice) {
  const form = new FormData(); form.set("file", new File([content], name, { type: "text/plain" })); form.set("role", role); form.set("role_source", "explicit"); form.set("request_auto_analysis", String(choice));
  if (role === "supporting_document") form.set("supporting_subtype", "kravdokument");
  return request(route + "/documents", { method: "POST", body: form }, 201);
}
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 300)); }
  throw new Error(`Timed out: ${label}`);
}
async function waitForJob(id) {
  const value = await waitFor(() => request(`${route}/jobs/${id}`), ({ job }) => ["completed", "failed"].includes(job.status), "document publication");
  assert.equal(value.job.status, "completed", value.job.error ?? "Document failed"); return value.job;
}
const customer = await upload("primary_customer_document", "konkurransegrunnlag.txt", "Fiktiv kommune har 120 ansatte på tre lokasjoner og skal anskaffe sikker plattformdrift. Tilbudsfrist er 10. november 2026. Avtalen gjelder tre år med ett års opsjon. Kravspesifikasjonen følger i Bilag 1. Kunden vektlegger trygg overgang og dokumentert ansvar.", false);
await waitForJob(customer.job.id);
let activity = await request(route + "/jobs"); assert.equal(activity.jobs.filter(job => job.kind === "customer_analysis").length, 0, "Opt-out must not generate analysis.");
const started = performance.now();
const requirements = await upload("supporting_document", "bilag1-krav.txt", "1 Drift\nK-1.1 Leverandøren skal drifte plattformen hele døgnet og dokumentere ansvar for kritiske hendelser.\n2 Sikkerhet\nK-1.2 Kundedata og sikkerhetskopier skal lagres og behandles i Norge.\n3 Exit\nK-1.3 Leverandøren skal tilby eksport i åpne formater innen 30 dager.", true);
await waitForJob(requirements.job.id);
const register = await request(route + "/requirement-register");
assert.ok(register.documents.some(document => document.rows?.some(row => row.id === "K-1.3")), "Persisted requirement register must be available before waiting for analysis.");
const registerReadyMs = performance.now() - started;
activity = await waitFor(() => request(route + "/jobs"), value => value.automatic_analysis?.status !== "pending", "automatic scheduling");
assert.ok(["scheduled", "completed"].includes(activity.automatic_analysis?.status));
// This owned app intentionally runs in worker-process mode: its web drain is
// disabled because a real scheduled worker exits after the HTTP response.
// Exercise that normal worker path after the follow-up becomes durable.
if (!webAutorun && activity.automatic_analysis.status === "scheduled") await request("/api/project-jobs/worker", { ...json({ limit: 10 }), headers: { "content-type": "application/json", "x-worker-token": runtime.env.PROJECT_JOB_WORKER_TOKEN } });
activity = await waitFor(() => request(route + "/jobs"), value => ["completed", "failed"].includes(value.automatic_analysis?.status), "automatic analysis completion");
assert.equal(activity.automatic_analysis.status, "completed");
assert.equal(activity.jobs.filter(job => job.kind === "customer_analysis").length, 1);
const completedMs = performance.now() - started;
const analysis = await request(route + "/customer-analysis");
assert.ok(analysis.analysis?.revision, "Automatic analysis must be persisted with a revision.");
const solution = await upload("primary_solution_document", "losningsnotat.txt", "Leverandøren foreslår døgnkontinuerlig drift med navngitt vaktleder. Kundedata og sikkerhetskopier behandles i Norge. Eksport i åpne formater tilbys innen 30 dager.", true);
await waitForJob(solution.job.id);
activity = await request(route + "/jobs");
assert.equal(activity.automatic_analysis.status, "completed");
assert.equal(activity.automatic_analysis.reason_code, "existing_analysis_preserved");
assert.equal(activity.jobs.filter(job => job.kind === "customer_analysis").length, 1);
assert.equal((await request(route + "/customer-analysis")).analysis.revision, analysis.analysis.revision, "Existing analysis must not be regenerated or overwritten.");
const report = { project_id: project.id, execution_mode: webAutorun ? "web_autorun_without_worker_dispatch" : "scheduled_worker", register_ready_ms: Math.round(registerReadyMs), automatic_analysis_completed_ms: Math.round(completedMs), automatic_jobs: 1, existing_analysis_preserved: true, limitation: "One owned synthetic TXT scenario; no p50/p95 or production latency inference." };
fs.writeFileSync(path.join(status.directory, "automatic-analysis-system-result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
