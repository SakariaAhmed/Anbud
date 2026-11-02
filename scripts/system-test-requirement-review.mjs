// Selected-row regeneration through the actual authorized HTTP/job/SQL path.
// Explicit --ai uses only the owned stack's already configured budget proxy.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { systemTestStatusPath } from "./system-test-runtime.mjs";
if (!process.argv.includes("--ai")) throw new Error("Explicit --ai is required for selected answer generation.");
const status = JSON.parse(fs.readFileSync(systemTestStatusPath(), "utf8"));
assert.equal(status.running, true); assert.equal(status.baseUrl, "http://127.0.0.1:4338");
const runtime = JSON.parse(fs.readFileSync(path.join(status.directory, "environment.json"), "utf8"));
assert.equal(runtime.env.OPENAI_BASE_URL, "http://127.0.0.1:4340/v1");
assert.ok(runtime.sessions?.adminCookie && status.projectId, "Run the complete HTTP scenario first.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "apps/frontend");
const { createJiti } = createRequire(path.join(frontend, "package.json"))("jiti");
const app = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { requirementReviewRows, editRequirementReviewRow } = app(path.join(frontend, "lib/requirement-review.ts"));
async function request(route, options = {}) {
  const response = await fetch(status.baseUrl + route, { ...options, signal: AbortSignal.timeout(600_000), headers: { cookie: runtime.sessions.adminCookie, origin: status.baseUrl, ...options.headers } });
  assert.equal(response.status, options.method === "POST" ? 202 : 200, `${options.method ?? "GET"} ${route}: ${response.status}`);
  return response.json();
}
const route = `/api/projects/${status.projectId}`;
async function queueAndRun(body) {
  const accepted = await request(`${route}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const worker = await fetch(`${status.baseUrl}/api/project-jobs/worker`, { method: "POST", signal: AbortSignal.timeout(600_000), headers: { cookie: runtime.sessions.adminCookie, origin: status.baseUrl, "content-type": "application/json", "x-worker-token": runtime.env.PROJECT_JOB_WORKER_TOKEN }, body: JSON.stringify({ limit: 10 }) });
  assert.equal(worker.status, 200);
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const { job } = await request(`${route}/jobs/${accepted.job.id}`);
    if (job.status === "failed") throw new Error(`Requirement generation failed: ${job.error ?? "no safe detail"}`);
    if (job.status === "completed") return job;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Requirement generation did not reach its terminal deadline.");
}
async function currentParent() {
  return (await request(`${route}/generate?artifact_type=forbedret_kravsvar`)).artifacts.find(artifact => artifact.is_current && artifact.source_is_current);
}
let parent = await currentParent();
if (!parent) { await queueAndRun({ kind: "artifact_generation", artifact_type: "forbedret_kravsvar" }); parent = await currentParent(); }
assert.ok(parent);
if (process.argv.includes("--manual-proposal")) {
  const row = requirementReviewRows(parent.content_markdown, parent.input_snapshot)[0];
  const content = editRequirementReviewRow(parent.content_markdown, row, { answer: row.answer + ' Foreslått tjenestenavn: «Beredskapsvakt Pluss».', evidence: row.evidence });
  const saved = await request(`${route}/generate`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ artifact_id: parent.id, title: parent.title, content_markdown: content }) });
  parent = saved.artifact;
  assert.ok(parent?.is_current && parent.source_is_current);
  assert.ok(!parent.input_snapshot.source_evidence.references.some(entry => entry.path === "rows.0.answer"), "A manual proposal cannot inherit proof from its previous answer.");
}
const before = requirementReviewRows(parent.content_markdown, parent.input_snapshot);
assert.equal(before.length, 3);
const selected = before[1]; assert.ok(selected.rowHash);
await queueAndRun({ kind: "artifact_generation", artifact_type: "forbedret_kravsvar", regenerate_requirements: { artifactId: parent.id, artifactVersion: parent.artifact_version, rows: [{ index: selected.index, rowHash: selected.rowHash }] } });
const refreshed = await request(`${route}/generate?artifact_type=forbedret_kravsvar`);
const next = refreshed.artifacts.find(artifact => artifact.is_current && artifact.source_is_current);
assert.ok(next); assert.equal(next.parent_artifact_id, parent.id); assert.equal(next.artifact_version, parent.artifact_version + 1);
const after = requirementReviewRows(next.content_markdown, next.input_snapshot);
assert.equal(after.length, before.length);
for (const row of before) {
  assert.equal(after[row.index].rowHash, row.rowHash);
  if (row.index !== selected.index) assert.equal(after[row.index].rawLine, row.rawLine, "Untouched answer rows must survive byte for byte.");
}
assert.equal(next.input_snapshot.generation_metadata.requirement_response.selected_regeneration.parent_artifact_id, parent.id);
if (process.argv.includes("--manual-proposal")) {
  assert.match(after[0].answer, /«Beredskapsvakt Pluss»/u);
  assert.ok(!next.input_snapshot.source_evidence.references.some(entry => entry.path === "rows.0.answer"));
  const unselectedProof = manifest => manifest.references.filter(entry => !entry.path.startsWith(`rows.${selected.index}.`));
  assert.deepEqual(unselectedProof(next.input_snapshot.source_evidence), unselectedProof(parent.input_snapshot.source_evidence), "Unchanged manual cells retain their exact existing evidence state.");
}
const result = { manualProposalPreserved: process.argv.includes("--manual-proposal"), projectId: status.projectId, parentId: parent.id, artifactId: next.id, selectedRows: 1, preservedRows: before.length - 1, checks: ["authorized selected job accepted", "existing requirement generation owner ran selected ledger only", "immutable manifest preserved", "unselected answer lines preserved", "new version linked to authoritative parent", "current source authority retained"] };
fs.writeFileSync(path.join(status.directory, "requirement-review-result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
