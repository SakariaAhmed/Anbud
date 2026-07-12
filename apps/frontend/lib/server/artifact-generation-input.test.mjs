import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jiti = createJiti(path.join(frontendRoot, "artifact-input-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const { normalizeSourceDocumentIds } = await jiti.import(
  path.join(frontendRoot, "lib/server/artifact-generation-input.ts"),
);

test("source document IDs preserve all 13 authorized inputs without a silent cap", () => {
  const ids = Array.from({ length: 13 }, (_, index) => `document-${index + 1}`);
  assert.deepEqual(normalizeSourceDocumentIds(ids), ids);
});

test("invalid, duplicate, and oversized source document IDs fail closed", () => {
  for (const value of [
    "document-1",
    ["document-1", 7],
    ["document-1", "document-1"],
    [""],
    ["x".repeat(201)],
  ]) {
    assert.throws(() => normalizeSourceDocumentIds(value), /source_document_ids/u);
  }
});
