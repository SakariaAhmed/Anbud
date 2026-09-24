import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const frontend = path.resolve(import.meta.dirname, "../../..");

test("requirement batch policy changes only the default workload and preserves explicit models and mini protection", async () => {
  const names = ["OPENAI_MODEL", "OPENAI_ANALYSIS_MODEL", "OPENAI_DOCUMENT_ANALYSIS_MODEL", "OPENAI_REQUIREMENT_RESPONSE_MODEL"];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const load = () => createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@": frontend, "server-only": "/dev/null" } })(path.join(import.meta.dirname, "model-config.ts"));
  try {
    for (const name of names) delete process.env[name];
    let config = load();
    assert.equal(config.requirementResponseBatchModel(), "gpt-5.6-luna");
    assert.equal(config.requirementResponseBatchModel("  "), "gpt-5.6-luna");
    assert.equal(config.requirementResponseBatchModel(undefined, true), "gpt-5.4", "multi-batch generation retains the proven model");
    assert.equal(config.requirementResponseBatchModel("gpt-5.6-luna", true), "gpt-5.6-luna");
    assert.equal(config.requirementResponseBatchModel(" gpt-5.4 "), "gpt-5.4");
    assert.equal(config.requirementResponseBatchModel("gpt-5.4-mini"), "gpt-5.4");
    assert.equal(config.requirementResponseBatchModel("gpt-5.4-nano"), "gpt-5.4");
    assert.equal(config.requirementResponseRepairModel(), "gpt-5.4");
    assert.equal(config.requirementResponseRepairModel(" "), "gpt-5.4");
    assert.equal(config.requirementResponseRepairModel("gpt-5.4-mini"), "gpt-5.4");
    assert.equal(config.requirementResponseRepairModel("gpt-5.6-luna"), "gpt-5.6-luna");
    assert.equal(config.ANALYSIS_MODEL, "gpt-5.4");
    assert.equal(config.FAST_MODEL, "gpt-5.4-mini");
    assert.equal(config.DOCUMENT_ANALYSIS_MODEL, "gpt-5.6-terra");
    assert.equal(config.solutionEvaluationReasoningEffort("gpt-5.4"), "low");
    for (const model of ["gpt-5.6-terra", "gpt-5.4-mini", "gpt-5.4-2026-03-05"]) {
      assert.equal(config.solutionEvaluationReasoningEffort(model), "medium", "Untested models retain their reasoning policy.");
    }
    assert.equal(config.EVALUATION_REASONING_EFFORT, "medium");
    process.env.OPENAI_REQUIREMENT_RESPONSE_MODEL = " gpt-5.4 ";
    config = load();
    assert.equal(config.requirementResponseBatchModel(), "gpt-5.4", "operators can restore the prior batch model without changing other generation policies");
    assert.equal(config.requirementResponseBatchModel("gpt-5.6-luna"), "gpt-5.6-luna");
    assert.equal(await config.resolveOpenAIModelOverride("gpt-5.4"), "gpt-5.4");
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
