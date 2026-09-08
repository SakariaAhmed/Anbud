import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { checkServiceHttp } from "./service-http-check.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const http = process.argv.includes("--http");
const output = path.join(dir, `verification/populated-service-${http ? "http" : "owner"}.json`);
if (existsSync(output)) throw new Error("Preserve existing service evidence.");
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json"), "utf8"));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
const ledgerHash = () => createHash("sha256").update(readFileSync(path.join(dir, "api-budget.json"))).digest("hex");
const beforeLedger = ledgerHash();
const database = "speed_quality_service_check";
const container = "anbud-speed-quality-service-check-rest";
const pg = "anbud-speed-quality-db";
const docker = (...args) => {
  try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error("Isolated Docker operation failed; command arguments can contain local credentials and are omitted."); }
};
const base = "http://127.0.0.1:55444";
const frontend = path.join(root, "apps/frontend");
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
Object.assign(process.env, env, { DATA_API_URL: base });
const load = (directory) => createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@": directory, "server-only": "/dev/null", "next/cache": path.join(import.meta.dirname, "next-cache-fixture.cjs") } });
const currentLoader = load(frontend);
const { encryptString } = currentLoader(path.join(frontend, "lib/server/crypto.ts"));
const owners = {
  before: load("/tmp/anbud-speed-quality-baseline-3779e6f2/apps/frontend")("/tmp/anbud-speed-quality-baseline-3779e6f2/apps/frontend/lib/server/repositories/data-store.ts"),
  after: currentLoader(path.join(frontend, "lib/server/repositories/data-store.ts")),
};
async function db(route, method = "GET", body) {
  const response = await fetch(`${base}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Isolated service DB status ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const report = { at: new Date().toISOString(), scope: "30 alternating actual repository-owner reads of a populated fictional service catalog. Identical isolated database using current schema, baseline 3779e6f2 versus current code. Next cache bypassed in both owners; no route/auth/browser, generation, Azure upload, or production latency claim. Selection persistence exercises the actual SQL RPC directly, not Next cache invalidation.", rows: [], checks: {} };
let databaseCreated = false;
let containerStarted = false;
try {
  docker("exec", pg, "createdb", "-U", "postgres", database);
  databaseCreated = true;
  docker("exec", pg, "pg_dump", "-U", "postgres", "-d", "speed_quality", "--schema-only", "-Fc", "-f", "/tmp/anbud-service-schema.dump");
  docker("exec", pg, "pg_restore", "-U", "postgres", "-d", database, "--exit-on-error", "/tmp/anbud-service-schema.dump");
  const source = JSON.parse(docker("inspect", "anbud-speed-quality-rest"))[0];
  const sourceUri = source.Config.Env.find((s) => s.startsWith("PGRST_DB_URI="));
  assert.ok(sourceUri, "Local REST database URI is required.");
  const targetUri = new URL(sourceUri.slice("PGRST_DB_URI=".length));
  assert.equal(targetUri.pathname, "/speed_quality", "Only the known local source database is supported.");
  targetUri.pathname = `/${database}`;
  const args = ["run", "--detach", "--name", container, "--publish", "127.0.0.1:55444:3000"];
  for (const value of source.Config.Env.filter((s) => s.startsWith("PGRST_"))) {
    args.push("--env", value.startsWith("PGRST_DB_URI=") ? `PGRST_DB_URI=${targetUri}` : value);
  }
  args.push(source.Config.Image);
  docker(...args); containerStarted = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await db("service_descriptions?select=id"); ready = true; break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.equal(ready, true);
  assert.deepEqual(await db("service_descriptions?select=id"), []);
  const projectId = randomUUID();
  await db("projects", "POST", { id: projectId, owner_id: env.APP_ADMIN_PRINCIPAL_ID, title: "Azure backup overvåking", client_name: "Fiktiv katalogkontroll", context_keywords: ["azure", "backup", "overvåking", "beredskap"] });
  const fixedTime = "2026-09-08T00:00:00.000Z";
  const definitions = [
    { name: "Azure backup", description: "Backup overvåking beredskap", keywords: ["azure", "backup", "overvåking", "beredskap"] },
    { name: "Nettverksdrift", description: "Brannmur segmentering nettverk", keywords: ["brannmur", "segmentering", "nettverk"] },
    { name: "Lønnssystem", description: "Lønn personal regnskap", keywords: ["personal", "regnskap", "lønn"] },
  ].map((s) => ({ id: randomUUID(), ...s, created_at: fixedTime, updated_at: fixedTime }));
  await db("service_descriptions", "POST", definitions);
  await db("service_documents", "POST", definitions.map((s, i) => ({ id: randomUUID(), service_id: s.id, title: s.name, file_name: `tjeneste-${i}.md`, file_format: "md", file_size_bytes: 120, raw_text: encryptString(`${s.description}. Fiktiv kilde.`), ai_summary: encryptString(`Fiktivt sammendrag: ${s.description}`), ai_summary_updated_at: fixedTime, created_at: fixedTime, updated_at: fixedTime })));
  await db("rpc/replace_project_service_selections", "POST", { p_project_id: projectId, p_service_ids: [definitions[0].id] });
  for (const withSummaries of [false, true]) {
    const row = { withSummaries, before: [], after: [] };
    for (let sample = -2; sample < 30; sample++) {
      const values = {};
      for (const version of sample % 2 ? ["before", "after"] : ["after", "before"]) {
        const start = performance.now();
        values[version] = await owners[version].listProjectServiceDescriptions(projectId, { includeDocumentAiSummaries: withSummaries });
        if (sample >= 0) row[version].push(performance.now() - start);
      }
      assert.deepEqual(values.before, values.after);
      assert.equal(values.after.length, 3);
      const backup = values.after.find((s) => s.id === definitions[0].id);
      assert.equal(backup.selected, true); assert.equal(backup.recommended, true); assert.ok(backup.recommendation_score >= 75);
      assert.equal(values.after.find((s) => s.id === definitions[2].id).recommended, false);
      assert.ok(values.after.every((s) => s.documents.length === 1));
      if (withSummaries) assert.ok(backup.documents[0].ai_summary.startsWith("Fiktivt sammendrag:"));
      else assert.equal(backup.documents[0].ai_summary, "");
      row.responseSha256 = createHash("sha256").update(JSON.stringify(values.after)).digest("hex");
    }
    for (const version of ["before", "after"]) {
      const sorted = [...row[version]].sort((a, b) => a - b);
      row[`${version}Summary`] = { p50Ms: sorted[14], p95Ms: sorted[28] };
    }
    report.rows.push(row);
  }
  await db("rpc/replace_project_service_selections", "POST", { p_project_id: projectId, p_service_ids: [definitions[1].id, definitions[1].id] });
  const changed = await owners.after.listProjectServiceDescriptions(projectId);
  assert.deepEqual(changed.filter((s) => s.selected).map((s) => s.id), [definitions[1].id]);
  await db("rpc/replace_project_service_selections", "POST", { p_project_id: projectId, p_service_ids: [] });
  assert.equal((await owners.after.listProjectServiceDescriptions(projectId)).some((s) => s.selected), false);
  if (http) report.http = await checkServiceHttp({ root, env, projectId, services: definitions });
  report.checks = { threeServicesAndDocumentsRead: true, matchingAndNonmatchingServices: true, decryptedSummaryOptIn: true, baselineCandidateIdentical: true, selectionReplaceDeduplicatedAndCleared: true, ledgerUnchanged: beforeLedger === ledgerHash() };
  assert.equal(report.checks.ledgerUnchanged, true);
} finally {
  if (containerStarted) docker("rm", "--force", container);
  if (databaseCreated) docker("exec", pg, "dropdb", "-U", "postgres", "--force", database);
}
report.checks.isolatedDatabaseRemoved = true;
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ checks: report.checks, rows: report.rows.map((r) => ({ withSummaries: r.withSummaries, before: r.beforeSummary, after: r.afterSummary })) }, null, 2));
