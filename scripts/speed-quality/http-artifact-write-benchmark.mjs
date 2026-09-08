import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const fixtureLabel = process.argv.find((arg) => arg.startsWith("--fixtures-label="))?.slice(17) ?? "";
assert.match(fixtureLabel, /^[a-z0-9-]*$/);
const pairedDatabases = process.argv.includes("--paired-databases");
const fixtures = JSON.parse(readFileSync(path.join(dir, `write-fixtures${fixtureLabel ? `-${fixtureLabel}` : ""}.json`), "utf8"));
const verificationOnly = process.argv.includes("--verify-source-current");
const sampleCount = verificationOnly ? 1 : 30;
const output = path.join(dir, `${verificationOnly ? "http-artifact-write-source-verification" : "http-artifact-write-comparison"}${fixtureLabel ? `-${fixtureLabel}` : ""}.json`);
if (existsSync(output)) throw new Error("Write comparison already exists.");
const db = "postgresql://postgres:speed-quality-local-only@127.0.0.1:55439/speed_quality";
const baseline = path.join(root, "apps/frontend/lib/server/repositories/fixtures/snapshot-dependencies-before.sql");
const candidate = path.join(root, "database/migrations/20260908100000_materialize_snapshot_dependencies.sql");
const install = (file) => execFileSync("psql", [db, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file]);
const report = { at: new Date().toISOString(), sampleCount, verificationOnly, measurement: "Authenticated PATCH and DELETE through separate local production builds, identical isolated synthetic fixture restored after each sample by the real delete route. Includes full response body; validation reads excluded from timed requests. Baseline phase then candidate phase; not an Azure measurement.", rows: [] };
try {
  for (const [version, port, sql] of [["before", 4317, baseline], ["after", 4318, candidate]]) {
    if (!pairedDatabases) install(sql);
    const base = `http://localhost:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
    async function request(route, method = "GET", input) {
      const start = performance.now();
      const response = await fetch(`${base}${route}`, { method, headers: { cookie, "content-type": "application/json" }, body: input ? JSON.stringify(input) : undefined });
      const text = await response.text();
      assert.equal(response.status, 200, `Local ${method} failed (${response.status}).`);
      return { ms: performance.now() - start, bytes: Buffer.byteLength(text), data: JSON.parse(text) };
    }
    for (const fixture of fixtures) {
      const route = `/api/projects/${fixture.id}/generate`;
      const initial = (await request(route)).data.artifacts;
      assert.equal(initial.length, 7, "Do not reuse a partially modified fixture.");
      if (fixtureLabel) assert.ok(initial.every((a) => !a.content_markdown.startsWith("enc:v1:")), "Seed plaintext artifact content according to its persistence contract.");
      const parent = initial.find((a) => a.artifact_type === "tilbudsstrategi");
      assert.equal(parent.source_is_current, true, "Manual editing requires a fully current parent.");
      const input = { artifact_id: parent.id, title: "Fiktiv manuelt revidert tilbudsstrategi", content_markdown: `${parent.content_markdown}\n\nFiktivt tillegg: Kunde og leverandør godkjenner planen før gjennomføring.` };
      const row = { version, size: fixture.size, projectId: fixture.id, inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"), samples: [], verifiedRoundTrips: 0 };
      report.rows.push(row);
      // First warmup is verified but excluded from the 30 steady-state samples.
      for (let i = -1; i < sampleCount; i++) {
        const saved = await request(route, "PATCH", input);
        const artifact = saved.data.artifact;
        assert.equal(artifact.content_markdown, input.content_markdown);
        assert.equal(artifact.artifact_version, 2);
        assert.equal(artifact.parent_artifact_id, parent.id);
        assert.equal(artifact.origin, "manual_edit");
        const persisted = (await request(route)).data.artifacts.find((a) => a.id === artifact.id);
        assert.equal(persisted.content_markdown, input.content_markdown);
        assert.equal(persisted.is_current, true);
        assert.equal(persisted.source_is_current, true);
        const deleted = await request(route, "DELETE", { artifact_id: artifact.id });
        const restored = (await request(route)).data.artifacts;
        assert.equal(restored.length, 7);
        assert.equal(restored.find((a) => a.id === parent.id).is_current, true);
        row.verifiedRoundTrips++;
        if (i >= 0) row.samples.push({ patchMs: saved.ms, deleteMs: deleted.ms, patchBytes: saved.bytes, deleteBytes: deleted.bytes });
        writeFileSync(output, JSON.stringify(report, null, 2));
      }
      for (const operation of ["patch", "delete"]) {
        const sorted = row.samples.map((s) => s[`${operation}Ms`]).sort((a, b) => a - b);
        row[operation] = { p50Ms: sorted[Math.ceil(sampleCount * 0.5) - 1], p95Ms: sampleCount >= 30 ? sorted[Math.ceil(sampleCount * 0.95) - 1] : undefined };
      }
      writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ...row, samples: undefined }));
    }
  }
} finally { if (!pairedDatabases) install(candidate); }
