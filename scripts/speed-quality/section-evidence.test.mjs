import test from "node:test";
import assert from "node:assert/strict";
import { sectionEvidence } from "./section-evidence.mjs";

test("section evidence excludes unchanged context but rejects unrelated changes", () => {
  const original = { summary: "Before", risks: ["Risk"], revision: 3 };
  const result = { ...original, summary: "After", section_histories: { summary: [] } };
  assert.deepEqual(sectionEvidence(original, result, ["summary"]), { summary: "After" });
  assert.throws(() => sectionEvidence(original, { ...result, risks: [] }, ["summary"]), /unrelated/);
  assert.throws(() => sectionEvidence(original, { ...result, revision: 4 }, ["summary"]), /unrelated/);
  assert.throws(() => sectionEvidence(original, { ...result, invented: true }, ["summary"]), /unrelated/);
  const missing = { ...result }; delete missing.summary;
  assert.throws(() => sectionEvidence(original, missing, ["summary"]), /Missing regenerated/);
});
