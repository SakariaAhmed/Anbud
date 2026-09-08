import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { responseFingerprint } from "./response-fingerprint.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const extended = process.argv.includes("--access-downloads");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "";
const fixtureLabel = process.argv.find((arg) => arg.startsWith("--fixtures-label="))?.slice(17) ?? "";
if (!/^[a-z0-9-]*$/.test(fixtureLabel)) throw new Error("Invalid fixture label.");
if (label && !/^[a-z0-9_-]+$/.test(label)) throw new Error("Invalid quiet-run label.");
const output = path.join(dir, `http-quiet-${label ? `${label}-` : ""}${extended ? "access-download" : "control"}-pairs.json`);
if (existsSync(output)) throw new Error("Quiet control already exists.");
const fixtures = JSON.parse(readFileSync(path.join(dir, `read-fixtures${fixtureLabel ? `-${fixtureLabel}` : ""}.json`), "utf8"));
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
    return { ms: performance.now() - start, bytes: body.length, body, contentType: response.headers.get("content-type") ?? "" };
  };
}
const report = { at: new Date().toISOString(), completed: false, measurement: "30 alternating sequential warm baseline/candidate pairs per route. Separate local DBs with matched fixture contents, baseline/candidate SQL and standalone production builds; no concurrent AI, writes, builds or SQL benchmarks. Not Azure latency.", rows: [] };
const routes = (extended ? [["small", "access"], ["large", "access"]] : [["small", "customer-analysis"], ["small", "executive-summary"], ["small", "service-descriptions"], ["large", "service-descriptions"], ["large", "executive-summary"], ["large", "generate"]]).map(([size, endpoint]) => ({size, endpoint, url: `/api/projects/${fixtures.find((p) => p.size === size).id}/${endpoint}`}));
report.fixtureLabel = fixtureLabel;
if (process.argv.includes("--all-workspaces")) {
  assert.equal(extended, false);
  routes.length = 0;
  for (const size of ["small", "large"]) {
    const id = fixtures.find((p) => p.size === size).id;
    for (const endpoint of ["", "customer-analysis", "solution-evaluation", "executive-summary", "service-descriptions", "generate", "chat", "access", "artifact-authority", "jobs"]) routes.push({ size, endpoint: endpoint || "detail", url: `/api/projects/${id}${endpoint ? `/${endpoint}` : ""}` });
    for (const endpoint of ["detail", "artifact-authority", "jobs"]) routes.push({ size, endpoint: `${endpoint}-three-projects`, urls: fixtures.filter((p) => p.size === size).map((p) => `/api/projects/${p.id}${endpoint === "detail" ? "" : `/${endpoint}`}`) });
  }
}
if (extended) {
  const live = JSON.parse(readFileSync(path.join(dir, "live-fixtures.json"), "utf8")).projects;
  for (const caseId of ["fjord-drift-development", "sundvik-32-explicit-ids"]) {
    const project = live.find((p) => p.caseId === caseId);
    const doc = project.documents.find((d) => d.role === "primary_customer_document");
    routes.push({size: caseId, endpoint: "download", url: `/api/projects/${project.id}/documents/${doc.id}`, expectedSha256: doc.sourceSha256});
  }
}
async function readTarget(version, { url, urls }) {
    if (!urls) {
      const result = await clients[version](url);
      return { ms: result.ms, bytes: result.bytes, ...responseFingerprint(result.body, result.contentType) };
    }
    assert.equal(urls.length, 3);
    const started = performance.now();
    const results = await Promise.all(urls.map(clients[version]));
    const ms = performance.now() - started;
    // Fingerprint validation happens after all downloads complete, outside both
    // individual and concurrent-group timings. Preserve raw hashes separately.
    const fingerprints = results.map((r) => responseFingerprint(r.body, r.contentType));
    return { ms, bytes: results.reduce((sum, r) => sum + r.bytes, 0), sha256: createHash("sha256").update(JSON.stringify(fingerprints.map((r) => r.sha256))).digest("hex"), jsonSha256: createHash("sha256").update(JSON.stringify(fingerprints.map((r) => r.jsonSha256 ?? r.sha256))).digest("hex") };
}
function requireIdentical(pair, location) {
  if ((pair.before.jsonSha256 ?? pair.before.sha256) !== (pair.after.jsonSha256 ?? pair.after.sha256)) {
    report.failure = { ...location, beforeSha256: pair.before.sha256, afterSha256: pair.after.sha256 };
    writeFileSync(output, JSON.stringify(report, null, 2));
    throw new Error("Control outputs differ; see preserved failure location.");
  }
}
report.preflight = { completed: false, checkedRoutes: 0 };
for (const route of routes) {
  const pair = {};
  for (const version of ["before", "after"]) pair[version] = await readTarget(version, route);
  requireIdentical(pair, { phase: "preflight", size: route.size, endpoint: route.endpoint });
  report.preflight.checkedRoutes++;
}
report.preflight.completed = true;
for (const route of routes) {
  const {size, endpoint, urls, expectedSha256} = route;
  const row = { size, endpoint, concurrentProjects: urls?.length ?? 1, before: [], after: [] };
  for (let i = -3; i < 30; i++) {
    const pair = {};
    for (const version of i % 2 ? ["before", "after"] : ["after", "before"]) pair[version] = await readTarget(version, route);
    requireIdentical(pair, { phase: "measurement", size, endpoint, sample: i });
    if (expectedSha256) assert.equal(pair.after.sha256, expectedSha256, "Original bytes changed.");
    if (i >= 0) for (const version of ["before", "after"]) row[version].push(pair[version]);
  }
  for (const version of ["before", "after"]) {
    const sorted = row[version].map((s) => s.ms).sort((a, b) => a - b);
    row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28] };
  }
  row.completeJsonValuesIdentical = true;
  row.rawResponseHashesIdentical = row.before.every((before, index) => before.sha256 === row.after[index].sha256);
  report.rows.push(row);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ size, endpoint, before: row.beforeSummary, after: row.afterSummary }));
}
const finalBudget = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
assert.equal(finalBudget.requests.length, initialBudget.requests.length, "Paid work overlapped the control run.");
report.noConcurrentPaidRequests = true;
report.completed = true;
writeFileSync(output, JSON.stringify(report, null, 2));
