import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const dataApiStoreSource = fs.readFileSync(
  path.join(frontendRoot, "lib/server/repositories/data-store.ts"),
  "utf8",
);

const jiti = createJiti(path.join(frontendRoot, "postgrest-compat-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  isMissingRelationColumn,
  isMissingSchemaColumn,
  missingColumnNameFromError,
  removeMissingStorageColumns,
} = jiti(
  path.join(frontendRoot, "lib/server/repositories/postgrest-compat.ts"),
);

test("schema compatibility helpers identify missing columns without hiding constraint errors", () => {
  const missing = {
    message: "Could not find the 'ai_summary' column of 'service_documents' in the schema cache",
  };

  assert.equal(isMissingSchemaColumn(missing), true);
  assert.equal(isMissingRelationColumn(missing, "ai_summary"), true);
  assert.equal(
    missingColumnNameFromError(missing, ["ai_summary", "raw_text"]),
    "ai_summary",
  );
  assert.equal(
    isMissingSchemaColumn({
      message: "null value in column raw_text violates not-null constraint",
    }),
    false,
  );
});

test("storage column removal drops only storage references", () => {
  const payload = {
    file_storage_bucket: "documents",
    file_storage_path: "projects/a/file.pdf",
    file_base64: "encrypted",
  };

  removeMissingStorageColumns(payload);

  assert.deepEqual(payload, { file_base64: "encrypted" });
});

test("legacy project creation preserves the authenticated owner", () => {
  assert.match(
    dataApiStoreSource,
    /if \(insertResult\.error && isMissingLegacyProjectColumn\(insertResult\.error\)\)[\s\S]*?\.insert\(\{\s*owner_id: input\.owner_id,/u,
  );
});
