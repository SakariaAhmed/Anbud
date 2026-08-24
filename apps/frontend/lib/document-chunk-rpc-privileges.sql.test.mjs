import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migration = fs.readFileSync(
  path.join(
    repositoryRoot,
    "database/migrations/20260813014812_restrict_document_chunk_search_rpc.sql",
  ),
  "utf8",
);

test("document chunk search-vector RPC is service-role only", () => {
  assert.match(
    migration,
    /revoke execute[\s\S]*from public, anon, authenticated/iu,
  );
  assert.match(migration, /grant execute[\s\S]*to service_role/iu);
});
