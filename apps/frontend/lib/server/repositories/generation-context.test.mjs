import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const frontend = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

test("generation context retries a changed snapshot and keeps the evaluation dependency paired with its content", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-generation-context-"));
  const state = { revisions: [1, 2, 2, 2], version: 1, rows: 0, evaluationReads: 0, missing: false, failed: false };
  globalThis.__generationContextTest = state;
  try {
    const dataApi = path.join(directory, "data-api.cjs");
    writeFileSync(dataApi, `exports.createServiceClient = () => ({
      from(table) {
        if (table !== "projects") throw new Error("Generation loaded unused UI data");
        let select;
        const query = {
          select(value) { select=value; return query; }, eq() { return query; },
          async single() {
            const state=globalThis.__generationContextTest;
            if (select === "snapshot_revision") {
              state.version=state.revisions.shift() ?? 2;
              return { data: { snapshot_revision: state.version }, error: null };
            }
            state.rows++;
            return { data: { id: "project", name: "Project " + state.version }, error: null };
          }
        }; return query;
      },
      async rpc(name) {
        if (name !== "get_current_project_derived_snapshot") throw new Error("Unexpected UI RPC");
        const state=globalThis.__generationContextTest; state.evaluationReads++;
        if (state.failed) return { data: null, error: { message: "Snapshot unavailable" } };
        if (state.missing) return { data: null, error: null };
        const id="00000000-0000-4000-8000-00000000000"+state.version;
        const updated_at="2026-09-08T10:00:00.000Z";
        return { data: { evaluation_row: { id, project_id: "project", updated_at, result_json: { executive_summary: "Evaluation " + state.version } }, dependency: { id, updated_at, content_hash: "hash"+state.version, evaluated_generated_artifact_id: null, provenance_mode: "document_only" }, executive_summary_row: null }, error: null };
      }
    });`);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/data-api": dataApi, "@": frontend, "server-only": "/dev/null" } });
    const { getProjectGenerationContext } = jiti(path.join(frontend, "lib/server/repositories/data-store.ts"));
    const result = await getProjectGenerationContext("project");
    assert.equal(result.name, "Project 2");
    assert.equal(result.snapshot_revision, 2);
    assert.equal(result.solutionEvaluationSnapshot.evaluation.executive_summary, "Evaluation 2");
    assert.equal(result.solutionEvaluationSnapshot.dependency.content_hash, "hash2");
    assert.equal(state.rows, 2);
    assert.equal(state.evaluationReads, 2);
    state.missing = true;
    assert.equal((await getProjectGenerationContext("project")).solutionEvaluationSnapshot, null);
    state.failed = true;
    await assert.rejects(getProjectGenerationContext("project"), /Snapshot unavailable/);
  } finally {
    delete globalThis.__generationContextTest;
    rmSync(directory, { recursive: true, force: true });
  }
});
