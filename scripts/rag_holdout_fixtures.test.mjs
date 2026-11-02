import test from "node:test";
import assert from "node:assert/strict";
import { loadFrozenRagHoldout } from "./rag_holdout_fixtures.mjs";

test("independent large-document holdouts preserve their frozen bytes, evidence pages and distinct denominators", () => {
  const { manifest, fixtures } = loadFrozenRagHoldout();
  assert.equal(fixtures.length, 2);
  assert.equal(manifest.factual_cases, 60);
  assert.equal(manifest.negative_cases, 20);
  assert.ok(fixtures.every(fixture => fixture.characters > 90_000));
});
