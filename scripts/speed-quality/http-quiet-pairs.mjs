import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const extended = process.argv.includes("--access-downloads");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "";
if (label && !/^[a-z0-9_-]+$/.test(label)) throw new Error("Invalid quiet-run label.");
const output = path.join(dir, `http-quiet-${label ? `${label}-` : ""}${extended ? "access-download" : "control"}-pairs.json`);
if (existsSync(output)) throw new Error("Quiet control already exists.");
const fixtures = JSON.parse(readFileSync(path.join(dir, "read-fixtures.json"), "utf8"));
const initialBudget = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
assert.equal(initialBudget.requests.some((r) => r.status === "reserved"), false, "Wait for all paid work to finish.");
const clients = {};
for (const [version, port] of [["before", 4317], ["after", 4318]]) {
  const base = `http://localhost:${port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  clients[version] = async (url) => {
    const start = performance.now();
    const response = await fetch(`${base}${url}`, { headers: { cookie } });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    return { ms: performance.now() - start, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  };
}
const report = { at: new Date().toISOString(), measurement: "30 alternating sequential warm baseline/candidate pairs per route. Separate identical local DB snapshots, baseline/candidate SQL and standalone production builds; no concurrent AI, writes, builds or SQL benchmarks. Not Azure latency.", rows: [] };
const routes = (extended ? [["small", "access"], ["large", "access"]] : [["small", "customer-analysis"], ["small", "executive-summary"], ["small", "service-descriptions"], ["large", "service-descriptions"], ["large", "executive-summary"], ["large", "generate"]]).map(([size, endpoint]) => ({size, endpoint, url: `/api/projects/${fixtures.find((p) => p.size === size).id}/${endpoint}`}));
if (extended) {
  const live = JSON.parse(readFileSync(path.join(dir, "live-fixtures.json"), "utf8")).projects;
  for (const caseId of ["fjord-drift-development", "sundvik-32-explicit-ids"]) {
    const project = live.find((p) => p.caseId === caseId);
    const doc = project.documents.find((d) => d.role === "primary_customer_document");
    routes.push({size: caseId, endpoint: "download", url: `/api/projects/${project.id}/documents/${doc.id}`, expectedSha256: doc.sourceSha256});
  }
}
for (const {size, endpoint, url, expectedSha256} of routes) {
  const row = { size, endpoint, before: [], after: [] };
  for (let i = -3; i < 30; i++) {
    const pair = {};
    for (const version of i % 2 ? ["before", "after"] : ["after", "before"]) pair[version] = await clients[version](url);
    assert.equal(pair.before.sha256, pair.after.sha256, "Control outputs differ.");
    if (expectedSha256) assert.equal(pair.after.sha256, expectedSha256, "Original bytes changed.");
    if (i >= 0) for (const version of ["before", "after"]) row[version].push(pair[version]);
  }
  for (const version of ["before", "after"]) {
    const sorted = row[version].map((s) => s.ms).sort((a, b) => a - b);
    row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28] };
  }
  row.responseHashesIdentical = true;
  report.rows.push(row);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ size, endpoint, before: row.beforeSummary, after: row.afterSummary }));
}
const finalBudget = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
assert.equal(finalBudget.requests.length, initialBudget.requests.length, "Paid work overlapped the control run.");
report.noConcurrentPaidRequests = true;
writeFileSync(output, JSON.stringify(report, null, 2));
