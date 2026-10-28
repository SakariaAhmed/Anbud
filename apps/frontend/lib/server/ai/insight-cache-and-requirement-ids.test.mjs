import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "insight-cache-and-requirement-ids.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});

const { isImmediateNextRequirementId, rememberDocumentInsight } = await jiti.import(
  path.join(frontendRoot, "lib/server/ai.ts"),
);

test("a rejected document insight is evicted so the next attempt runs again", async () => {
  const key = "Kundedokument:synthetic-document:2026-10-28:100:12";
  const failed = Promise.reject(new Error("transient provider failure"));
  rememberDocumentInsight(key, failed);
  assert.equal(globalThis.__anbudDocumentInsightCache.get(key), failed);
  await assert.rejects(failed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__anbudDocumentInsightCache.has(key), false);
});

test("a rejected insight does not evict a newer entry under the same key", async () => {
  const key = "Kundedokument:synthetic-document:2026-10-28:100:24";
  let rejectOld;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  rememberDocumentInsight(key, old);
  const fresh = Promise.resolve("innsikt");
  rememberDocumentInsight(key, fresh);
  rejectOld(new Error("late failure"));
  await assert.rejects(old);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.__anbudDocumentInsightCache.get(key), fresh);
});

test("requirement ID letter suffixes take part in immediate-successor checks", () => {
  assert.equal(isImmediateNextRequirementId("1-2", "1-3"), true);
  assert.equal(isImmediateNextRequirementId("1-2A", "1-3A"), true);
  assert.equal(isImmediateNextRequirementId("1-2A", "1-3"), false);
  assert.equal(isImmediateNextRequirementId("1-2", "1-3B"), false);
});
