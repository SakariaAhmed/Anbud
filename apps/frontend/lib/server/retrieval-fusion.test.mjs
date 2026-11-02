import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { reciprocalRankFusion } = createJiti(import.meta.url)("./retrieval-fusion.ts");
test("fusion rewards agreement, prevents duplicate votes, and keeps stable tie order", () => {
  const key = value => value;
  assert.deepEqual(reciprocalRankFusion([["a", "b", "c"], ["c", "b", "d"]], key), ["c", "b", "a", "d"]);
  assert.deepEqual(reciprocalRankFusion([["a", "a", "a", "b"], ["b"]], key), ["b", "a"]);
  assert.deepEqual(reciprocalRankFusion([["a", "b"]], key), ["a", "b"]);
});
