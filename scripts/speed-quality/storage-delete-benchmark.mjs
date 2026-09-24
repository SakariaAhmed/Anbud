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
const output = path.join(dir, `storage-delete-${beforeOnly ? "before" : "paired"}.json`);
assert.equal(existsSync(output), false);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ledger = sha(readFileSync(path.join(dir, "api-budget.json")));
const ownerPath = "apps/frontend/lib/server/azure-blob-storage.ts";
const baseline = execFileSync("git", ["show", `07d40e7f:${ownerPath}`], { cwd: root });
const baselinePath = path.join(dir, "storage-delete-before-owner.ts");
if (!existsSync(baselinePath)) writeFileSync(baselinePath, baseline, { flag: "wx" });
assert.equal(sha(readFileSync(baselinePath)), sha(baseline));
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
function load(file) {
  return createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "server-only": "/dev/null", "@azure/identity": require.resolve("@azure/identity"), "@azure/storage-blob": require.resolve("@azure/storage-blob"),
  } })(file).createAzureBlobStorageBackend;
}
const owners = { before: load(baselinePath), after: load(path.join(root, ownerPath)) };
const report = { at: new Date().toISOString(), completed: false, baselineCommit: "07d40e7f", baselineOwnerSha256: sha(baseline), candidateOwnerSha256: sha(readFileSync(path.join(root, ownerPath))), scope: "Actual Azure storage adapter with injected in-memory SDK clients and a fixed 10 ms delay per deletion. No Azure network, credentials, file storage, API/DB writes or paid AI. Thirty warm pairs show scheduling behavior under simulated latency, NOT measured Azure or complete project-deletion performance.", simulatedPerDeleteMs: 10, rows: [] };
for (const fileCount of [1, 24]) {
  const row = { fileCount, before: [], after: [] }; report.rows.push(row);
  for (let sample = -2; sample < 30; sample++) {
    for (const version of beforeOnly ? ["before"] : sample % 2 ? ["before", "after"] : ["after", "before"]) {
      const deleted = []; let active = 0; let maxActive = 0;
      const backend = owners[version]({ getContainerClient: () => ({ getBlockBlobClient: (name) => ({ async deleteIfExists(options) {
        assert.deepEqual(options, { deleteSnapshots: "include" });
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, report.simulatedPerDeleteMs));
        deleted.push(name); active--; return { succeeded: true };
      } }) }) });
      const files = Array.from({ length: fileCount }, (_, n) => ({ path: `projects/synthetic/${n}` }));
      const started = performance.now(); await backend.removeStoredFiles([...files, files[0]]); const ms = performance.now() - started;
      assert.deepEqual(deleted.sort(), files.map((f) => f.path).sort()); assert.equal(active, 0);
      if (sample >= 0) row[version].push({ ms, maxActive, deleted: deleted.length });
    }
  }
  for (const version of beforeOnly ? ["before"] : ["before", "after"]) {
    const sorted = row[version].map((s) => s.ms).sort((a, b) => a - b);
    row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28], maxActive: [...new Set(row[version].map((s) => s.maxActive))] };
  }
  console.log(JSON.stringify({ fileCount, before: row.beforeSummary, after: row.afterSummary }));
}
assert.equal(sha(readFileSync(path.join(dir, "api-budget.json"))), ledger);
report.completed = true; report.ledgerUnchanged = true;
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
