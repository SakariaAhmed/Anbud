import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "model-output-boundary-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));

const { normalizeValueOpportunities } = await load(
  "lib/server/document-intelligence/value-normalization.ts",
);
const { normalizeCustomerAnalysisResult } = await load(
  "lib/server/document-intelligence/customer-analysis-postprocess.ts",
);
const { normalizeSolutionEvaluationResult } = await load("lib/server/ai.ts");
const { runJsonCompletion } = await load("lib/server/ai/json-completion.ts");

test("value opportunities with non-text fields from the model are dropped, not crashed on", () => {
  const items = normalizeValueOpportunities([
    { title: 7, description: "Tallet er ikke en tittel." },
    null,
    { title: "Raskere saksbehandling", description: "Kortere ventetid for innbyggere." },
  ]);
  assert.deepEqual(items.map((item) => item.title), ["Raskere saksbehandling"]);
});

test("a customer analysis missing its summary fields normalizes instead of throwing", () => {
  const result = normalizeCustomerAnalysisResult({
    customer_profile: ["Kommune med 40 000 innbyggere."],
    implicit_requirements: [{ title: "Drift", description: "Døgnkontinuerlig drift.", importance: 3 }],
  });
  assert.equal(typeof result.customer_profile_summary, "string");
  assert.equal(result.implicit_requirements.length, 1);
  assert.equal(result.implicit_requirements[0].importance, "Viktig");
});

test("model output cannot set evaluation provenance fields", () => {
  const result = normalizeSolutionEvaluationResult(
    {
      fit_to_customer_needs: "Løsningen dekker behovene.",
      evaluated_generated_artifact_id: "invented-by-model",
      evaluation_provenance_mode: "generated_artifact",
      customer_document_id: "invented-by-model",
    },
    { provenance: { customer_document_id: "customer-doc", solution_document_id: "solution-doc" } },
  );
  assert.equal(result.customer_document_id, "customer-doc");
  assert.equal(result.solution_document_id, "solution-doc");
  assert.equal("evaluated_generated_artifact_id" in result, false);
  assert.equal("evaluation_provenance_mode" in result, false);
});

test("JSON completions reject output that is valid JSON but not an object", async () => {
  const runWith = (content) =>
    runJsonCompletion({
      system: "system",
      user: "user",
      maxRetries: 0,
      getClient: async () => ({
        chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
        responses: { create: async () => ({}) },
      }),
      defaultModel: "gpt-test",
      defaultReasoningEffort: "low",
      supportsCustomTemperature: () => true,
    });
  assert.deepEqual(await runWith('{"rows":[]}'), { rows: [] });
  await assert.rejects(runWith("[1, 2]"), /ugyldig JSON/);
  await assert.rejects(runWith('"text"'), /ugyldig JSON/);
});
