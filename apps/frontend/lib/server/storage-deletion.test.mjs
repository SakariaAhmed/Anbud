import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "storage-deletion-tests.cjs"), {
  interopDefault: true,
  alias: {
    "server-only": "/dev/null",
  },
});

const {
  fetchStoredFileReferencesPaginated,
  runStorageFirstDeletion,
} = jiti(path.join(frontendRoot, "lib/server/storage-deletion.ts"));

test("storage reference reads paginate until the first short page", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    file_storage_bucket: "documents",
    file_storage_path: `projects/p/${index}.pdf`,
  }));
  const ranges = [];
  const result = await fetchStoredFileReferencesPaginated(
    async (from, to) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    },
    2,
  );

  assert.deepEqual(ranges, [
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
  assert.deepEqual(result, rows);
});

test("storage reference read errors fail closed instead of returning partial rows", async () => {
  await assert.rejects(
    fetchStoredFileReferencesPaginated(
      async (from) =>
        from === 0
          ? {
              data: [{ file_storage_path: "projects/p/first.pdf" }],
              error: null,
            }
          : { data: null, error: { message: "forced page failure" } },
      1,
    ),
    /forced page failure/u,
  );
});

test("database deletion never runs when storage deletion fails", async () => {
  const calls = [];
  await assert.rejects(
    runStorageFirstDeletion({
      removeStorage: async () => {
        calls.push("storage");
        throw new Error("forced storage failure");
      },
      deleteDatabaseRows: async () => {
        calls.push("database");
      },
    }),
    /forced storage failure/u,
  );
  assert.deepEqual(calls, ["storage"]);
});

test("successful deletion is ordered storage before database", async () => {
  const calls = [];
  await runStorageFirstDeletion({
    removeStorage: async () => calls.push("storage"),
    deleteDatabaseRows: async () => calls.push("database"),
  });
  assert.deepEqual(calls, ["storage", "database"]);
});
