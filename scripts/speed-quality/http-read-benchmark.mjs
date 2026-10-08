#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const projects = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/read-fixtures.json"), "utf8"));
const base = "http://localhost:4318";
const mode = process.argv.includes("--production") ? "production build" : "development server";
const revision = process.argv.find((a) => a.startsWith("--revision="))?.slice(11);
const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
if (!login.ok) throw new Error(`Local login failed (${login.status}).`);
const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
async function read(route) {
  const started = performance.now();
  const response = await fetch(`${base}${route}`, { headers: { cookie } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Local read failed (${response.status}) for ${route}.`);
  return { ms: performance.now() - started, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}
const results = [];
for (const size of ["small", "large"]) {
  const selected = projects.filter((p) => p.size === size);
  for (const route of ["detail", "authority", "jobs"]) {
    const url = (p) => `/api/projects/${p.id}${route === "detail" ? "" : route === "authority" ? "/artifact-authority" : "/jobs"}`;
    const first = await read(url(selected[0]));
    for (let warm = 0; warm < 2; warm++) await Promise.all(selected.map((p) => read(url(p))));
    for (const concurrent of [1, 3]) {
      const samples = [];
      for (let sample = 0; sample < 30; sample++) {
        const batch = await Promise.all(selected.slice(0, concurrent).map((p) => read(url(p))));
        samples.push(...batch);
      }
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      results.push({ size, route, concurrentProjects: concurrent, firstRequestMs: first.ms, sampleCount: samples.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samples });
    }
  }
}
const output = process.argv[2];
if (!output) throw new Error("Pass an output JSON path.");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), node: process.version, revision, environment: `Authenticated localhost Next ${mode} and real disposable PostgreSQL/PostgREST. First requests are separate; steady-state samples are warm. This is not Azure latency or an AI measurement.`, results }, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ samples, ...row }) => row), null, 2));
