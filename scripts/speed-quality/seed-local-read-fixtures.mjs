#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const forWrites = process.argv.includes("--for-writes");
const output = path.join(root, `output/speed-quality-2026-09-08/${forWrites ? "write" : "read"}-fixtures.json`);
if (existsSync(output)) throw new Error("Fixtures already exist; preserve their IDs and source state.");
const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json"), "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440") throw new Error("Only the disposable local database is allowed.");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { encryptJson, encryptString } = jiti(path.join(frontend, "lib/server/crypto.ts"));
async function db(route, method = "GET", body) {
  const response = await fetch(`${env.DATA_API_URL}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local fixture operation failed: ${response.status} ${await response.text()}`);
  return response.json();
}
const states = await db("artifact_source_state?singleton=eq.true");
const projects = [];
for (const [size, count] of [["small", 8], ["large", 400]]) {
  for (let index = 0; index < (forWrites ? 1 : 3); index++) {
    const id = randomUUID();
    await db("projects", "POST", { id, owner_id: env.APP_ADMIN_PRINCIPAL_ID, client_name: "Fiktiv målekunde", title: `Måleprosjekt ${size} ${index + 1}` });
    const text = "Kunden ber om dokumentert kontroll av tilgang, navngitt ansvar, testprotokoll og avklaring av avhengigheter. ";
    const items = Array.from({ length: count }, (_, row) => ({ requirement_id: `K-${row + 1}`, requirement: `${text.repeat(6)}Kravrad ${row + 1}.`, source_reference: `Side ${Math.floor(row / 10) + 1} / K-${row + 1}`, status: "Godt", answer_excerpt: text.repeat(5), rationale: text.repeat(3), recommendation: "Verifiser dokumentasjon ved overtakelse." }));
    const result = { executive_summary: "Fiktiv vurdering til lokal ytelsesmåling.", strengths: ["Kontroll og ansvar er beskrevet."], weaknesses: [], requirement_coverage: { total_requirements: count, assessed_requirements: count, good: count, weak: 0, missing: 0, unclear: 0, coverage_summary: "Fiktive rader.", items } };
    const evaluation = (await db("solution_evaluations", "POST", { project_id: id, evaluation_provenance_mode: "document_only", result_json: encryptJson(result) }))[0];
    const dependency = await db("rpc/raw_artifact_solution_evaluation_dependency", "POST", { p_project_id: id });
    await db("generated_artifacts", "POST", ["losningsutkast", "bilag1_rekonstruksjon", "forbedret_kravsvar", "tilbudsstrategi", "verdiargumentasjon", "anbefalt_arkitektur", "gjennomforing_og_risiko"].map((type) => ({ project_id: id, artifact_type: type, title: "Syntetisk artefakt", content_markdown: encryptString(text.repeat(count)), artifact_version: 1, input_artifact_source_revision: 0, input_service_library_revision: states[0].service_library_revision, used_solution_evaluation: true, input_solution_evaluation_id: evaluation.id, input_solution_evaluation_updated_at: evaluation.updated_at, input_solution_evaluation_hash: dependency.content_hash })));
    if (forWrites) {
      // A manually editable parent must carry the current knowledge manifest.
      // The read stress fixtures intentionally retain absent legacy manifests.
      const manifest = await db("rpc/artifact_base_knowledge_manifest", "POST", { p_project_id: id, p_artifact_type: "tilbudsstrategi" });
      await db(`generated_artifacts?project_id=eq.${id}&artifact_type=eq.tilbudsstrategi`, "PATCH", { knowledge_base_manifest: manifest });
    }
    projects.push({ id, size, requirementCount: count, evaluationPlaintextBytes: Buffer.byteLength(JSON.stringify(result)) });
  }
}
writeFileSync(output, JSON.stringify(projects, null, 2));
console.log(JSON.stringify(projects, null, 2));
