import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountedCostUpperBound, openBudgetLedger, prepareRequest } from "./budget.mjs";

test("budget reserves concurrent calls durably and never refunds failures or retries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "anbud-budget-test-"));
  const file = path.join(dir, "ledger.json");
  let ledger;
  try {
    ledger = openBudgetLedger(file, 1);
    assert.throws(() => openBudgetLedger(file, 1), /EEXIST/);
    const a = ledger.reserve({ reservedUsd: 0.6, model: "gpt-5.4" });
    ledger.finish(a, { status: "uncertain" });
    assert.throws(() => ledger.reserve({ reservedUsd: 0.5 }), /exhausted/);
    ledger.close();
    ledger = openBudgetLedger(file, 1);
    assert.equal(ledger.snapshot().reservedUsd, 0.6);
    ledger.reserve({ reservedUsd: 0.4 });
    assert.throws(() => ledger.reserve({ reservedUsd: 0.000001 }), /exhausted/);
    for (const value of [NaN, Infinity, -1, 0]) assert.throws(() => ledger.reserve({ reservedUsd: value }));
  } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("text calls have conservative input bounds and capped reasoning-inclusive output", () => {
  const input = { model: "gpt-5.4", messages: [{ role: "user", content: "Ærlig svar" }], max_completion_tokens: 20000, service_tier: "priority" };
  const prepared = prepareRequest("/v1/chat/completions", input);
  assert.equal(prepared.request.max_completion_tokens, 8000);
  assert.equal(prepared.request.service_tier, "default");
  assert.ok(prepared.inputTokens > Buffer.byteLength(JSON.stringify(input)));
  assert.equal(prepared.priceTier, "bounded-short");
  assert.ok(prepared.reservedUsd > (prepared.inputTokens * 2.5 + 8000 * 15) / 1e6);
  const long = prepareRequest("/v1/chat/completions", { ...input, messages: [{ role: "user", content: "x".repeat(256000) }] });
  assert.equal(long.priceTier, "maximum");
  assert.ok(long.reservedUsd > (long.inputTokens * 5 + 8000 * 22.5) / 1e6);
  assert.equal(input.max_completion_tokens, 20000);
  const embedding = prepareRequest("/v1/embeddings", { model: "text-embedding-3-small", input: ["Krav", "Svar"] });
  assert.equal(embedding.outputTokens, 0);
  assert.ok(embedding.reservedUsd > 0);
});

test("unpriced requests and unbounded context are refused before a reservation", () => {
  const basic = { model: "gpt-5.4", input: "Hei" };
  for (const patch of [{ model: "gpt-unknown" }, { input: [{ type: "input_file", file_id: "test" }] }, { tools: [{}] }, { previous_response_id: "test" }, { conversation: "test" }, { background: true }, { n: 2 }, { max_output_tokens: Infinity }]) {
    assert.throws(() => prepareRequest("/v1/responses", { ...basic, ...patch }));
  }
  assert.throws(() => prepareRequest("/v1/files", basic));
  assert.throws(() => prepareRequest("/v1/embeddings", { model: "text-embedding-3-small", input: [[123, 45]] }));
});

test("only complete bounded usage reconciles cost; uncertain calls and reasoning retain budget", () => {
  const row = { model: "gpt-5.4", status: 200, reservedUsd: 1, inputTokensUpperBound: 20000, outputTokensLimit: 8000, usage: { prompt_tokens: 10000, completion_tokens: 8000, total_tokens: 18000, completion_tokens_details: { reasoning_tokens: 8000 } } };
  assert.ok(accountedCostUpperBound(row) >= 0.253 && accountedCostUpperBound(row) <= 0.253001);
  for (const patch of [{ status: "uncertain" }, { status: 500 }, { usage: {} }, { usage: { prompt_tokens: 20001, completion_tokens: 1 } }, { usage: { prompt_tokens: 1, completion_tokens: 8001 } }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 } }]) assert.equal(accountedCostUpperBound({ ...row, ...patch }), 1);
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-budget-reconcile-"));
  let ledger;
  try {
    const file = path.join(directory, "ledger.json");
    ledger = openBudgetLedger(file, 1);
    const id = ledger.reserve({ ...row, inputTokens: 20000, outputTokens: 8000 });
    assert.throws(() => ledger.reserve({ reservedUsd: 0.01 }), /exhausted/);
    ledger.finish(id, { status: 200, usage: row.usage });
    assert.equal(ledger.snapshot().reservedUsd, 1, "historical reservation stays intact");
    assert.equal(ledger.snapshot().accountedUpperBoundUsd, accountedCostUpperBound(row));
    ledger.close(); ledger = openBudgetLedger(file, 1);
    ledger.reserve({ reservedUsd: 0.7 });
    assert.throws(() => ledger.reserve({ reservedUsd: 0.05 }), /exhausted/);
  } finally { ledger?.close(); rmSync(directory, { recursive: true, force: true }); }
});
