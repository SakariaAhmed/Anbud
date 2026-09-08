#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const kind = option("kind", "customer_analysis");
const split = option("split", "all");
const label = option("label", "baseline");
const selectedCase = option("case", "");
const artifactType = option("artifact-type", "");
const requirementArtifact = kind === "artifact_generation" && artifactType === "forbedret_kravsvar" && Boolean(selectedCase);
if (!/^[a-z0-9_-]+$/.test(label) || (!requirementArtifact && !["customer_analysis", "high_level_design", "solution_evaluation", "executive_summary"].includes(kind))) throw new Error("Invalid live run configuration.");
const file = path.join(root, `output/speed-quality-2026-09-08/live-${label}-${kind}.json`);
if (existsSync(file)) throw new Error("Run output already exists; inspect it before explicitly starting a new paid run.");
const fixtures = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/live-fixtures.json"), "utf8"));
const sourceFile = path.join(import.meta.dirname, "fixtures/tender-cases.json");
if (fixtures.sourceSha256 !== createHash("sha256").update(readFileSync(sourceFile)).digest("hex")) throw new Error("Frozen fixture source changed.");
const projects = fixtures.projects.filter((p) => (!selectedCase || p.caseId === selectedCase) && (split === "all" || p.split === split || (split === "small" && p.split !== "large-regression")));
if (!projects.length) throw new Error("No projects selected.");
const base = "http://localhost:4318";
const budgetBefore = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
if (budgetBefore.limitUsd !== 14 || budgetBefore.remainingUsd < (requirementArtifact ? 0.075 : 6)) throw new Error("Insufficient budget headroom for generation and final evaluation.");
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
if (!login.ok) throw new Error(`Local login failed (${login.status}).`);
const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function request(route, body) {
  const response = await fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`Local workflow request failed (${response.status}).`);
  return response.json();
}
// Compile read routes before starting clocks; Next development compilation is
// still reported separately in server logs, never called production latency.
await Promise.all(projects.map((p) => request(`/api/projects/${p.id}/jobs`)));
const logFile = option("log-file", "/tmp/anbud-speed-quality-dev.log");
const serverMode = option("server-mode", "development");
const logStart = readFileSync(logFile, "utf8").length;
const start = performance.now();
const report = { at: new Date().toISOString(), label, kind, serverMode, logFile, sourceSha256: fixtures.sourceSha256, budgetBefore, jobs: [], events: [], measurement: "Real default-model API generation through budget proxy, real local DB/leases/persistence, authenticated local Next API with frozen fictional cases; polling adds up to approximately 1 second to observed completion." };
function save() { writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`); }
save();
await Promise.all(projects.map(async (project) => {
  const initialArtifactIds = requirementArtifact ? new Set((await request(`/api/projects/${project.id}/generate`)).artifacts.map((artifact) => artifact.id)) : undefined;
  const submissionStart = performance.now();
  const { job } = await request(`/api/projects/${project.id}/jobs`, requirementArtifact ? { kind, artifact_type: artifactType, use_solution_evaluation_context: false } : { kind });
  const row = { projectId: project.id, caseId: project.caseId, split: project.split, jobId: job.id, submitMs: performance.now() - submissionStart, accepted: job, final: null };
  report.jobs.push(row);
  save();
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const { job: current } = await request(`/api/projects/${project.id}/jobs/${job.id}`);
    if (["completed", "failed"].includes(current.status)) {
      row.final = current;
      row.observedCompletionMs = performance.now() - submissionStart;
      if (requirementArtifact && current.status === "completed") {
        row.persistedArtifacts = (await request(`/api/projects/${project.id}/generate`)).artifacts.filter((artifact) => !initialArtifactIds.has(artifact.id));
        if (row.persistedArtifacts.length !== 1 || row.persistedArtifacts[0].artifact_type !== artifactType) throw new Error("Expected exactly one new persisted requirement artifact.");
      }
      save();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  row.timedOut = true;
  save();
}));
report.totalMs = performance.now() - start;
report.budgetAfter = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
report.events = readFileSync(logFile, "utf8").slice(logStart).split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
  try { const event = JSON.parse(line); return /^(ai_|project_job_)/.test(event.event ?? "") ? [event] : []; } catch { return []; }
});
save();
console.log(JSON.stringify({ file, totalMs: report.totalMs, reservedUsdThisRun: report.budgetAfter.reservedUsd - report.budgetBefore.reservedUsd, jobs: report.jobs.map(({ caseId, submitMs, observedCompletionMs, final, timedOut }) => ({ caseId, submitMs, observedCompletionMs, status: final?.status, timedOut })) }, null, 2));
if (report.jobs.some((job) => job.final?.status !== "completed")) process.exitCode = 1;
