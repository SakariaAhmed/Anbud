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
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" }, fsCache: false, moduleCache: false });
const baseline = "3779e6f2";
const relative = "apps/frontend/lib/server/ai/context.ts";
const dir = mkdtempSync(path.join(tmpdir(), "anbud-context-benchmark-"));
try {
  const oldFile = path.join(dir, "context.ts");
  writeFileSync(oldFile, execFileSync("git", ["show", `${baseline}:${relative}`], { cwd: root }));
  const before = jiti(oldFile);
  const after = jiti(path.join(root, relative));
  const unit = "  Krav K-17: Leverandøren skal dokumentere kontroll, ansvar og avhengigheter.\n\tReferanse: side 12.  ";
  const rows = [];
  const cases = [5000, 80000, 800000, 5000000].map((size) => ({ size, pattern: "norwegian-text" }));
  cases.push({ size: 5000000, pattern: "whitespace-only" }, { size: 5000000, pattern: "leading-whitespace" });
  for (const { size, pattern } of cases) {
    const source = pattern === "whitespace-only" ? " ".repeat(size)
      : pattern === "leading-whitespace" ? `${" ".repeat(size - 8)}Kort ord`
      : unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    for (const limit of pattern === "norwegian-text" ? [220, 4000, 22000] : [220]) {
      assert.equal(after.compactText(source, limit), before.compactText(source, limit));
      const timings = { before: [], after: [] };
      for (let warm = 0; warm < 3; warm++) { before.compactText(source, limit); after.compactText(source, limit); }
      for (let sample = 0; sample < 30; sample++) {
        for (const name of sample % 2 ? ["before", "after"] : ["after", "before"]) {
          const fn = name === "before" ? before.compactText : after.compactText;
          const start = performance.now();
          for (let repeat = 0; repeat < 5; repeat++) fn(source, limit);
          timings[name].push((performance.now() - start) / 5);
        }
      }
      const stats = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return { p50Ms: sorted[14], p95Ms: sorted[28], samples: values.length, rawMs: values };
      };
      rows.push({ sourceChars: size, pattern, limit, inputSha256: createHash("sha256").update(source).digest("hex"), outputIdentical: true, before: stats(timings.before), after: stats(timings.after) });
    }
  }
  const hashFile = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const result = { at: new Date().toISOString(), node: process.version, baseline, baselineFileSha256: hashFile(oldFile), candidateFileSha256: hashFile(path.join(root, relative)), candidateHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), measurement: "Warm in-process CPU, real compactText, synthetic Norwegian text, alternating paired runs; no model/network/database latency", rows };
  const output = process.argv[2];
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.rows.map(({ sourceChars, limit, before, after }) => ({ sourceChars, limit, beforeP50Ms: before.p50Ms, afterP50Ms: after.p50Ms, speedup: before.p50Ms / after.p50Ms })), null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
