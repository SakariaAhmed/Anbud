import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const modulePath = fileURLToPath(new URL("./value-opportunities.ts", import.meta.url));
const jiti = createJiti(import.meta.url);
const { getDisplayProfitShares, isValidManualValueOpportunities } = jiti(modulePath);
const entries = (values) => values.map((profit_share_percent) => ({
  title: "Verdi", description: "Bevart kildetekst", value_categories: [], profit_share_percent,
}));

test("manual values reject oversized and nonfinite weights, preserve editor defaults", () => {
  assert.equal(isValidManualValueOpportunities(entries(Array(101).fill(1))), false);
  assert.equal(isValidManualValueOpportunities(entries(Array(100).fill(1))), true);
  for (const value of [-1, 101, Infinity, -Infinity, NaN, Number.MAX_VALUE, "1"]) {
    assert.equal(isValidManualValueOpportunities(entries([value])), false);
  }
  assert.equal(isValidManualValueOpportunities(entries([0, 0.5, 100])), true);
  assert.equal(isValidManualValueOpportunities([]), true);
});

test("legacy adversarial shares finish within a bounded worker and preserve every row", async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { createJiti } = require(workerData.jitiPath);
    const { getDisplayProfitShares } = createJiti(workerData.modulePath)(workerData.modulePath);
    const cases = [Array(101).fill(1), Array(10000).fill(1), Array(101).fill(0),
      [Number.MAX_VALUE, Number.MAX_VALUE], [NaN, Infinity, -Infinity], [1, Number.MIN_VALUE]];
    parentPort.postMessage(cases.map(values => getDisplayProfitShares(values.map(profit_share_percent => ({ profit_share_percent })))));
  `, { eval: true, workerData: { modulePath, jitiPath: require.resolve("jiti") } });
  const timer = setTimeout(() => worker.terminate(), 5000);
  try {
    const results = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("allocation worker exited before completing")));
    });
    assert.deepEqual(results.map((result) => result.length), [101, 10000, 101, 2, 3, 2]);
    for (const result of results) {
      assert.equal(result.reduce((sum, share) => sum + share, 0), 100);
      assert.ok(result.every((share) => Number.isInteger(share) && share >= 0 && share <= 100));
    }
    assert.equal(results[0][100], 0);
    assert.deepEqual(results[3], [50, 50]);
  } finally { clearTimeout(timer); await worker.terminate(); }
});

test("ordinary four-category allocation and ties are deterministic without source mutation", () => {
  const source = entries([40, 30, 20, 10]);
  const before = structuredClone(source);
  assert.deepEqual(getDisplayProfitShares(source), [40, 30, 20, 10]);
  assert.deepEqual(source, before);
  assert.deepEqual(getDisplayProfitShares(entries([1, 1, 1])), [34, 33, 33]);
  assert.deepEqual(getDisplayProfitShares(entries([0, 0, 0, 0])), [25, 25, 25, 25]);
  assert.deepEqual(getDisplayProfitShares(entries([0, 1, 0, 3])), [0, 25, 0, 75]);
  assert.deepEqual(getDisplayProfitShares([]), []);
});
