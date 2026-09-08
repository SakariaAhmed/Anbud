import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const output = path.join(dir, "generation-context-comparison.json");
if (existsSync(output)) throw new Error("Context benchmark already exists.");
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json"), "utf8"));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
function load(directory) {
  return createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@": directory, "server-only": "/dev/null" } })(path.join(directory, "lib/server/repositories/data-store.ts"));
}
const before = load("/tmp/anbud-speed-quality-baseline-3779e6f2/apps/frontend");
const after = load(frontend);
const fixtures = JSON.parse(readFileSync(path.join(dir, "read-fixtures.json"), "utf8"));
const nativeFetch = globalThis.fetch;
let reads = 0;
globalThis.fetch = (...args) => { reads++; return nativeFetch(...args); };
const report = { at: new Date().toISOString(), measurement: "Real repository owners on identical independent local DB snapshots, original versus candidate SQL. Same name, evaluation, dependency and snapshot revision; alternating warm pairs. Excludes route authentication, generation, writes and browser. Fetch count measures database HTTP requests.", rows: [] };
try {
  for (const size of ["small", "large"]) for (const useCase of ["chat", "executive-summary"]) {
    const fixture = fixtures.find((p) => p.size === size);
    const row = { size, useCase, before: [], after: [] };
    for (let sample = -2; sample < 30; sample++) {
      const values = {};
      for (const version of sample % 2 ? ["before", "after"] : ["after", "before"]) {
        process.env.DATA_API_URL = version === "before" ? "http://127.0.0.1:55443" : "http://127.0.0.1:55440";
        reads = 0;
        const started = performance.now();
        if (version === "after") {
          const context = await after.getProjectGenerationContext(fixture.id);
          values[version] = { name: context.name, snapshot_revision: context.snapshot_revision, evaluation: context.solutionEvaluationSnapshot?.evaluation ?? null, ...(useCase === "executive-summary" ? { dependency: context.solutionEvaluationSnapshot?.dependency ?? null } : {}) };
        } else if (useCase === "chat") {
          const detail = await before.getProjectDetail(fixture.id);
          values[version] = { name: detail.name, snapshot_revision: detail.snapshot_revision, evaluation: detail.solution_evaluation };
        } else {
          const [detail, snapshot] = await Promise.all([before.getProjectDetail(fixture.id), before.getFreshSolutionEvaluationSnapshot(fixture.id)]);
          values[version] = { name: detail.name, snapshot_revision: detail.snapshot_revision, evaluation: snapshot?.evaluation ?? null, dependency: snapshot?.dependency ?? null };
        }
        const ms = performance.now() - started;
        if (sample >= 0) row[version].push({ ms, reads });
      }
      assert.deepEqual(values.before, values.after, "Actual generation inputs changed.");
      row.inputSha256 = createHash("sha256").update(JSON.stringify(values.after)).digest("hex");
    }
    for (const version of ["before", "after"]) {
      const sorted = row[version].map((s) => s.ms).sort((a, b) => a - b);
      row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28], databaseRequests: [...new Set(row[version].map((s) => s.reads))] };
    }
    row.inputsIdentical = true;
    report.rows.push(row);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ size, useCase, before: row.beforeSummary, after: row.afterSummary }));
  }
} finally { globalThis.fetch = nativeFetch; }
