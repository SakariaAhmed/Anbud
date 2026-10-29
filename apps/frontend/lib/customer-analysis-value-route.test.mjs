import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const root = fileURLToPath(new URL("../", import.meta.url));
const support = `${root}app/api/projects/[id]/customer-analysis/route.test-support.ts`;
const aliases = Object.fromEntries([
  "next/server", "@/lib/server/authorization", "@/lib/server/ai",
  "@/lib/server/repositories/analyses", "@/lib/server/repositories/data-store",
  "@/lib/server/document-intelligence/repository", "@/lib/server/domain/project-documents",
  "@/lib/server/project-ai-route", "@/lib/server/use-cases/solution-evaluation-readiness",
  "@/lib/server/use-cases/solution-evaluation-source-snapshot", "@/lib/service-description",
].map((name) => [name, support]));
const jiti = createJiti(import.meta.url, { alias: { ...aliases, "@": root } });
const { PUT } = jiti(`${root}app/api/projects/[id]/customer-analysis/route.ts`);
const { state, revision } = jiti(support);
const opportunity = { title: "Verdi", description: "Kildetekst", value_categories: [], profit_share_percent: 1 };
async function put(values) {
  return PUT(new Request("http://localhost/api/projects/project/customer-analysis", {
    method: "PUT", body: JSON.stringify({ section: "value", section_snapshot: { value_opportunities: values }, expected_analysis_revision: revision }),
  }), { params: Promise.resolve({ id: "project" }) });
}

test("manual PUT rejects the original101-row payload before snapshot reads or persistence", async () => {
  const response = await put(Array(101).fill(opportunity));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /maksimalt 100/);
  assert.equal(state.reads, 0);
  assert.equal(state.saved.length, 0);
  for (const weight of [-1, 101, Number.MAX_VALUE]) {
    assert.equal((await put([{ ...opportunity, profit_share_percent: weight }])).status, 400);
  }
  assert.equal(state.saved.length, 0);
});

test("manual PUT persists ordinary four entries unchanged with current revision", async () => {
  const values = [40, 30, 20, 10].map((profit_share_percent) => ({ ...opportunity, profit_share_percent }));
  const response = await put(values);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).analysis.value_opportunities, values);
  assert.deepEqual(state.saved.at(-1).value_opportunities, values);
});
