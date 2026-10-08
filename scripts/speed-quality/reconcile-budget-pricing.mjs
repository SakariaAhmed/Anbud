import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNTING_POLICY, ACCOUNTING_POLICY_V3, ACCOUNTING_POLICY_V4, accountedCostUpperBound, accountedCostUpperBoundV4, accountedCostUpperBoundV3, accountedCostUpperBoundV2 } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "";
const version = process.argv.find((arg) => arg.startsWith("--policy="))?.slice(9) ?? "v3";
assert.ok(["v3", "v5"].includes(version));
const previousPolicy = version === "v3" ? "verified-usage-or-full-reservation-v2" : ACCOUNTING_POLICY_V4;
const nextPolicy = version === "v3" ? ACCOUNTING_POLICY_V3 : ACCOUNTING_POLICY;
const previousCost = version === "v3" ? accountedCostUpperBoundV2 : accountedCostUpperBoundV4;
const nextCost = version === "v3" ? accountedCostUpperBoundV3 : accountedCostUpperBound;
assert.match(label, /^[a-z0-9_-]*$/);
const output = path.join(dir, `budget-pricing-reconciliation-${version}${label ? `-${label}` : ""}.json`);
const archive = path.join(dir, `api-budget-before-${version}.json`);
assert.equal(existsSync(output), false);
const bytes = readFileSync(path.join(dir, "api-budget.json"));
const ledger = JSON.parse(bytes);
assert.equal(ledger.limitUsd, 14);
assert.equal(ledger.accountingPolicy, previousPolicy);
assert.equal(ledger.requests.some((r) => r.status === "reserved"), false);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const rows = ledger.requests.map((row) => {
  const before = previousCost(row), after = nextCost(row);
  assert.ok(after <= before);
  if (after < before) {
    assert.ok((version === "v3" ? ["gpt-5.6-terra", "gpt-5.6-luna"] : ["gpt-5.4", "gpt-5.6-terra", "gpt-5.6-luna"]).includes(row.model));
    assert.equal(row.status, 200); assert.ok(row.usage);
    if (version === "v3") assert.ok(row.inputTokensUpperBound + row.outputTokensLimit < 256000);
  }
  if (!row.usage || row.status !== 200) assert.equal(after, row.reservedUsd);
  return { id: row.id, model: row.model, originalPriceTier: row.priceTier, reservedUsd: row.reservedUsd, before, after, fullTokenUpperBound: row.inputTokensUpperBound + row.outputTokensLimit };
});
const before = rows.reduce((n, r) => n + r.before, 0), after = rows.reduce((n, r) => n + r.after, 0);
assert.ok(after <= 14);
const report = {
  at: new Date().toISOString(), policy: nextPolicy, marginPercent: 10, limitUsd: 14,
  sources: ["https://developers.openai.com/api/docs/pricing", "https://developers.openai.com/api/docs/models/gpt-5.6-terra", "https://developers.openai.com/api/docs/models/gpt-5.6-luna", ...(version === "v5" ? ["https://developers.openai.com/api/docs/guides/prompt-caching", "https://developers.openai.com/api/docs/models/gpt-5.4"] : [])],
  verifiedPricing: { checkedDate: "2026-09-08", longContextAboveInputTokens: 272000, conservativeInputPlusOutputGuard: 256000, standardUsdPerMillion: { terra: { maximumShortInputIncludingCacheWrites: 2.5, shortOutput: 12 }, luna: { maximumShortInputIncludingCacheWrites: 0.25, shortOutput: 1.2 } } },
  scope: "Pure recalculation from validated usage, preserving all original reservation/usage/priceTier rows. No margin reduction, unknown-outcome refund, new budget, new ledger or API call. The original complete ledger bytes are archived; starting the same locked proxy updates only its top-level policy before appending new calls.",
  originalLedgerSha256: sha(bytes), originalRequestsSha256: sha(JSON.stringify(ledger.requests)), originalRequestCount: rows.length,
  previousUpperBoundUsd: before, revisedUpperBoundUsd: after, remainingUsd: 14 - after,
  changedRows: rows.filter((r) => r.after < r.before), unchangedRows: rows.filter((r) => r.after === r.before).length,
};
if (version === "v5") report.verifiedCachePricing = { checkedDate: "2026-09-08", readUsdPerMillionShortLong: { "gpt-5.4": [0.25, 0.5], "gpt-5.6-terra": [0.2, 0.4], "gpt-5.6-luna": [0.02, 0.04] }, fastMultiplier: 2, rule: "Only validated returned cached_tokens reduce the input cost. All remaining input uses maximum cache-write rate. Unknown/invalid cache details receive no discount. New preflight reservations assume zero cache hits." };
if (existsSync(archive)) assert.equal(sha(readFileSync(archive)), sha(bytes), "Preserve the original ledger archive.");
else writeFileSync(archive, bytes, { flag: "wx" });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
assert.equal(sha(readFileSync(path.join(dir, "api-budget.json"))), report.originalLedgerSha256);
console.log(JSON.stringify({ changedRows: report.changedRows.length, before, after, remainingUsd: report.remainingUsd, ledgerUnchanged: true }));
