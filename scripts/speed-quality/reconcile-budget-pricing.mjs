import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACCOUNTING_POLICY_V3 as ACCOUNTING_POLICY, accountedCostUpperBoundV3 as accountedCostUpperBound, accountedCostUpperBoundV2 } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8) ?? "";
assert.match(label, /^[a-z0-9_-]*$/);
const output = path.join(dir, `budget-pricing-reconciliation-v3${label ? `-${label}` : ""}.json`);
const archive = path.join(dir, "api-budget-before-v3.json");
assert.equal(existsSync(output), false);
const bytes = readFileSync(path.join(dir, "api-budget.json"));
const ledger = JSON.parse(bytes);
assert.equal(ledger.limitUsd, 14);
assert.equal(ledger.accountingPolicy, "verified-usage-or-full-reservation-v2");
assert.equal(ledger.requests.some((r) => r.status === "reserved"), false);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const rows = ledger.requests.map((row) => {
  const before = accountedCostUpperBoundV2(row), after = accountedCostUpperBound(row);
  assert.ok(after <= before);
  if (after < before) {
    assert.ok(["gpt-5.6-terra", "gpt-5.6-luna"].includes(row.model));
    assert.equal(row.status, 200); assert.ok(row.usage);
    assert.ok(row.inputTokensUpperBound + row.outputTokensLimit < 256000);
  }
  if (!row.usage || row.status !== 200) assert.equal(after, row.reservedUsd);
  return { id: row.id, model: row.model, originalPriceTier: row.priceTier, reservedUsd: row.reservedUsd, before, after, fullTokenUpperBound: row.inputTokensUpperBound + row.outputTokensLimit };
});
const before = rows.reduce((n, r) => n + r.before, 0), after = rows.reduce((n, r) => n + r.after, 0);
assert.ok(after <= 14);
const report = {
  at: new Date().toISOString(), policy: ACCOUNTING_POLICY, marginPercent: 10, limitUsd: 14,
  sources: ["https://developers.openai.com/api/docs/pricing", "https://developers.openai.com/api/docs/models/gpt-5.6-terra", "https://developers.openai.com/api/docs/models/gpt-5.6-luna"],
  verifiedPricing: { checkedDate: "2026-09-08", longContextAboveInputTokens: 272000, conservativeInputPlusOutputGuard: 256000, standardUsdPerMillion: { terra: { maximumShortInputIncludingCacheWrites: 2.5, shortOutput: 12 }, luna: { maximumShortInputIncludingCacheWrites: 0.25, shortOutput: 1.2 } } },
  scope: "Pure recalculation from validated usage, preserving all original reservation/usage/priceTier rows. No margin reduction, unknown-outcome refund, new budget, new ledger or API call. The original complete ledger bytes are archived; starting the same locked proxy updates only its top-level policy before appending new calls.",
  originalLedgerSha256: sha(bytes), originalRequestsSha256: sha(JSON.stringify(ledger.requests)), originalRequestCount: rows.length,
  previousUpperBoundUsd: before, revisedUpperBoundUsd: after, remainingUsd: 14 - after,
  changedRows: rows.filter((r) => r.after < r.before), unchangedRows: rows.filter((r) => r.after === r.before).length,
};
if (existsSync(archive)) assert.equal(sha(readFileSync(archive)), sha(bytes), "Preserve the original ledger archive.");
else writeFileSync(archive, bytes, { flag: "wx" });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
assert.equal(sha(readFileSync(path.join(dir, "api-budget.json"))), report.originalLedgerSha256);
console.log(JSON.stringify({ changedRows: report.changedRows.length, before, after, remainingUsd: report.remainingUsd, ledgerUnchanged: true }));
