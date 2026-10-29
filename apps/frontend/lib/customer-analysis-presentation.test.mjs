import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { customerAnalysisPositioningGroups } = jiti("./customer-analysis-presentation.ts");

test("merging evidence into trust preserves every saved recommendation and its order", () => {
  const recommendations = [
    "Budskap 1", "Trygghet 1", "Bevis 1", "Leveranse 1",
    "Budskap 2", "Trygghet 2", "Bevis 2", "Leveranse 2", "Budskap 3",
  ];
  const original = [...recommendations];
  assert.deepEqual(customerAnalysisPositioningGroups(recommendations), [
    { title: "Budskap", items: ["Budskap 1", "Budskap 2", "Budskap 3"] },
    { title: "Trygghet", items: ["Trygghet 1", "Bevis 1", "Trygghet 2", "Bevis 2"] },
    { title: "Leveranse", items: ["Leveranse 1", "Leveranse 2"] },
  ]);
  assert.deepEqual(recommendations, original);
});

test("empty or partial saved strategy keeps three groups without inventing content", () => {
  assert.deepEqual(customerAnalysisPositioningGroups([]), [
    { title: "Budskap", items: [] },
    { title: "Trygghet", items: [] },
    { title: "Leveranse", items: [] },
  ]);
  assert.deepEqual(customerAnalysisPositioningGroups(["En anbefaling"])[0].items, ["En anbefaling"]);
});
