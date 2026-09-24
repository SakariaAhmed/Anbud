import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const label = option("label", "");
const port = option("port", "4318");
if (!/^[a-z0-9-]+$/.test(label) || !["4317", "4318"].includes(port)) throw new Error("Explicit local benchmark label/port required.");
const output = path.join(dir, `http-workspace-${label}.json`);
if (existsSync(output)) throw new Error("Benchmark already exists.");
const base = `http://localhost:${port}`;
const readFixtures = JSON.parse(readFileSync(path.join(dir, "read-fixtures.json"), "utf8"));
const live = JSON.parse(readFileSync(path.join(dir, "live-fixtures.json"), "utf8")).projects;
const loginStart = performance.now();
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
if (!login.ok) throw new Error(`Local login failed: ${login.status}`);
const loginMs = performance.now() - loginStart;
const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
const routes = [
  { name: "project-list", url: "/api/projects", scope: "All fixed local projects" },
  { name: "service-library", url: "/api/service-descriptions", scope: "Empty local library; cache/control case only" },
];
for (const size of ["small", "large"]) {
  const project = readFixtures.find((p) => p.size === size);
  for (const endpoint of ["customer-analysis", "solution-evaluation", "executive-summary", "generate", "service-descriptions", "chat", "access"]) routes.push({ name: `${size}-${endpoint}`, url: `/api/projects/${project.id}/${endpoint}`, scope: "Fixed synthetic read fixture, including absent optional results" });
}
for (const caseId of ["fjord-drift-development", "sundvik-32-explicit-ids"]) {
  const project = live.find((p) => p.caseId === caseId);
  const doc = project.documents.find((d) => d.role === "primary_customer_document");
  routes.push({ name: `${caseId}-download`, url: `/api/projects/${project.id}/documents/${doc.id}`, expectedSha256: doc.sourceSha256, scope: "Real decrypted inline local original; excludes Azure Blob Storage" });
}
async function read(route) {
  const start = performance.now();
  const response = await fetch(`${base}${route.url}`, { headers: { cookie } });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${route.name} failed: ${response.status}`);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (route.expectedSha256 && route.expectedSha256 !== sha256) throw new Error("Original download bytes changed.");
  return { ms: performance.now() - start, bytes: body.length, sha256 };
}
const report = { at: new Date().toISOString(), label, port, loginMs, environment: "Authenticated local standalone production build, disposable DB and HTTPS gateway. Server response times; excludes browser and production infrastructure. Login is one observation, not a distribution.", results: [] };
for (const route of routes) {
  const first = await read(route);
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push(await read(route));
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const row = { ...route, firstMs: first.ms, p50Ms: sorted[14], p95Ms: sorted[28], samples };
  report.results.push(row);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...row, samples: undefined }));
}
