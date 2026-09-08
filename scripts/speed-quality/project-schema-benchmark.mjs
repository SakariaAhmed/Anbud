import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const beforeOnly = process.argv.includes("--before-only");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? (beforeOnly ? "before" : "paired");
assert.match(label, /^[a-z0-9-]+$/);
const output = path.join(dir, `project-schema-${label}.json`);
assert.equal(existsSync(output), false);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ledgerHash = sha(readFileSync(path.join(dir, "api-budget.json")));
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json"), "utf8"));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
Object.assign(process.env, env);
const sourcePath = "apps/frontend/lib/server/repositories/data-store.ts";
const baselineSource = execFileSync("git", ["show", `820bb84a:${sourcePath}`], { cwd: root });
const baselinePath = path.join(dir, "project-schema-before-owner.ts");
if (!existsSync(baselinePath)) writeFileSync(baselinePath, baselineSource, { flag: "wx" });
assert.equal(sha(readFileSync(baselinePath)), sha(baselineSource));
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
function load(file) {
  return createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@": frontend, "server-only": "/dev/null",
    "next/server": require.resolve("next/server"),
    "next/cache": path.join(frontend, "lib/server/repositories/data-store.persistence.test-support.ts"),
  } })(file);
}
const owners = { before: load(baselinePath), after: load(path.join(root, sourcePath)) };
const fixture = JSON.parse(readFileSync(path.join(dir, "read-fixtures-plaintext-v3.json"))).find((p) => p.size === "small");
const nativeFetch = globalThis.fetch;
let trace = [];
globalThis.fetch = async (...args) => {
  const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  assert.equal(url.origin, env.DATA_API_URL, "Only the disposable DB is allowed.");
  const response = await nativeFetch(...args);
  trace.push({ path: url.pathname, method: args[1]?.method ?? "GET", status: response.status });
  return response;
};
const report = { at: new Date().toISOString(), completed: false, baselineCommit: "820bb84a", baselineOwnerSha256: sha(baselineSource), candidateOwnerSha256: sha(readFileSync(path.join(root, sourcePath))), scope: "Actual repository owners against the same disposable current-schema DB. Next unstable_cache is bypassed and cache invalidation is stubbed on both sides. Thirty warm process/DB samples with uncached owner execution; paired mode alternates before/after. Excludes route authentication, audit writes, browser, Azure and AI. Created projects are removed directly through PostgREST outside timing; this is not a project-deletion benchmark.", rows: [] };
report.fixture = { id: fixture.id, size: fixture.size };
async function cleanup(id) {
  const response = await nativeFetch(`${env.DATA_API_URL}/projects?id=eq.${id}`, { method: "DELETE", headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}` } });
  assert.equal(response.status, 204);
  const verify = await nativeFetch(`${env.DATA_API_URL}/projects?id=eq.${id}&select=id`, { headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}` } });
  assert.deepEqual(await verify.json(), []);
}
try {
  for (const operation of ["getProjectShell", "listProjects", "getProjectGenerationContext", "createProject"]) {
    const row = { operation, before: [], after: [] }; report.rows.push(row);
    for (let sample = -2; sample < 30; sample++) {
      const values = {};
      for (const version of beforeOnly ? ["before"] : sample % 2 ? ["before", "after"] : ["after", "before"]) {
        trace = [];
        const started = performance.now();
        const result = operation === "createProject"
          ? await owners[version].createProject({ owner_id: env.APP_ADMIN_PRINCIPAL_ID, name: "Fiktiv opprettelseskontroll", customer_name: "Fiktiv kunde", description: "Kun disponibel lokal måling", selected_service_ids: [] })
          : operation === "listProjects"
            ? await owners[version].listProjects(env.APP_ADMIN_PRINCIPAL_ID, { admin: true })
            : await owners[version][operation](fixture.id);
        const ms = performance.now() - started;
        if (sample >= 0) row[version].push({ ms, requests: trace.length, trace });
        if (operation === "createProject") {
          try {
            assert.equal(result.name, "Fiktiv opprettelseskontroll");
            assert.equal(result.customer_name, "Fiktiv kunde");
            assert.equal(result.description, "Kun disponibel lokal måling");
            // Only server-generated identity/timestamps may differ on two creates.
            const { id, created_at, updated_at, last_activity_at, ...rest } = result;
            assert.ok(id && created_at && updated_at && last_activity_at);
            values[version] = rest;
          } finally { await cleanup(result.id); }
        } else values[version] = result;
      }
      if (!beforeOnly) assert.deepEqual(values.before, values.after);
    }
    for (const version of beforeOnly ? ["before"] : ["before", "after"]) {
      const sorted = row[version].map((s) => s.ms).sort((a, b) => a - b);
      row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28], requests: [...new Set(row[version].map((s) => s.requests))], failedRequests: [...new Set(row[version].map((s) => s.trace.filter((r) => r.status >= 400).length))] };
    }
    console.log(JSON.stringify({ operation, before: row.beforeSummary, after: row.afterSummary }));
  }
  assert.equal(sha(readFileSync(path.join(dir, "api-budget.json"))), ledgerHash);
  report.ledgerUnchanged = true; report.createdProjectsRemoved = true; report.completed = true;
} finally { globalThis.fetch = nativeFetch; writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
