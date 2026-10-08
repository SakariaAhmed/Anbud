#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json"), "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440") throw new Error("Only local benchmark traffic is allowed.");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null", "next/headers": require.resolve("next/headers"), "next/server": require.resolve("next/server") }, fsCache: false, moduleCache: false });
const relative = "apps/frontend/lib/server/authorization.ts";
const directory = mkdtempSync(path.join(tmpdir(), "anbud-auth-benchmark-"));
const nativeFetch = globalThis.fetch;
let reads = 0;
globalThis.fetch = (...args) => { reads++; return nativeFetch(...args); };
try {
  const oldFile = path.join(directory, "authorization.ts");
  writeFileSync(oldFile, execFileSync("git", ["show", `3779e6f2:${relative}`], { cwd: root }));
  const before = jiti(oldFile).getEffectiveProjectRole;
  const after = jiti(path.join(root, relative)).getEffectiveProjectRole;
  const projectId = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/read-fixtures.json"), "utf8"))[0].id;
  const rows = [];
  for (const [principalId, expectedRole] of [[env.APP_ADMIN_PRINCIPAL_ID, "owner"], ["u_nonexistent_synthetic_reader_2026", null]]) {
    for (let warm = 0; warm < 3; warm++) { await before(principalId, projectId); await after(principalId, projectId); }
    const runs = { before: [], after: [] };
    for (let sample = 0; sample < 30; sample++) {
      for (const version of sample % 2 ? ["before", "after"] : ["after", "before"]) {
        reads = 0;
        const start = performance.now();
        const role = await (version === "before" ? before : after)(principalId, projectId);
        const ms = performance.now() - start;
        assert.equal(role, expectedRole);
        runs[version].push({ ms, reads });
      }
    }
    const summarize = (values) => { const sorted = values.map((v) => v.ms).sort((a, b) => a - b); return { p50Ms: sorted[14], p95Ms: sorted[28], samples: values }; };
    rows.push({ case: expectedRole === "owner" ? "owner" : "ungranted", outputIdentical: true, before: summarize(runs.before), after: summarize(runs.after) });
  }
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const result = { at: new Date().toISOString(), node: process.version, baselineFileSha256: hash(oldFile), candidateFileSha256: hash(path.join(root, relative)), measurement: "Real getEffectiveProjectRole and disposable local PostgREST/PostgreSQL; paired alternating warm reads; excludes middleware and session validation", rows };
  writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(rows.map(({ case: name, before, after }) => ({ case: name, beforeP50Ms: before.p50Ms, afterP50Ms: after.p50Ms, beforeReads: before.samples[0].reads, afterReads: after.samples[0].reads })), null, 2));
} finally { globalThis.fetch = nativeFetch; rmSync(directory, { recursive: true, force: true }); }
