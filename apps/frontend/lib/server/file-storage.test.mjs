import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const testSupportPath = path.join(
  frontendRoot,
  "lib/server/storage-observability.test-support.ts",
);
const jiti = createJiti(path.join(frontendRoot, "file-storage-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@/lib/server/supabase": testSupportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const { setStorageObservabilityTestClient } = jiti(testSupportPath);
const { removeStoredFilePrefixes, removeStoredFiles } = jiti(
  path.join(frontendRoot, "lib/server/file-storage.ts"),
);

function storageClient({ errorAtCall = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      storage: {
        from(bucket) {
          return {
            async remove(paths) {
              calls.push({ bucket, paths: [...paths] });
              const callNumber = calls.length;
              return {
                data: [],
                error:
                  callNumber === errorAtCall
                    ? { message: "forced storage removal failure" }
                    : null,
              };
            },
          };
        },
      },
    },
  };
}

test("stored file removal deduplicates and respects Supabase's 1000-object limit", async () => {
  const storage = storageClient();
  setStorageObservabilityTestClient(storage.client);
  const files = Array.from({ length: 1_501 }, (_, index) => ({
    bucket: "documents",
    path: `projects/p/document-${String(index).padStart(4, "0")}.pdf`,
  }));
  files.push(files[0], { bucket: "documents", path: null });

  await removeStoredFiles(files);

  assert.deepEqual(
    storage.calls.map((call) => call.paths.length),
    [1_000, 501],
  );
  assert.ok(storage.calls.every((call) => call.bucket === "documents"));
  assert.equal(
    new Set(storage.calls.flatMap((call) => call.paths)).size,
    1_501,
  );
});

test("stored file removal propagates Storage API errors and stops later batches", async () => {
  const storage = storageClient({ errorAtCall: 1 });
  setStorageObservabilityTestClient(storage.client);

  await assert.rejects(
    removeStoredFiles(
      Array.from({ length: 1_001 }, (_, index) => ({
        path: `projects/p/${index}.pdf`,
      })),
    ),
    /forced storage removal failure/u,
  );
  assert.equal(storage.calls.length, 1);
});

test("prefix removal paginates, deletes orphaned objects and verifies the prefix", async () => {
  const prefix = "projects/project-1";
  const files = new Set(
    Array.from({ length: 1_001 }, (_, index) =>
      `${prefix}/orphan-${String(index).padStart(4, "0")}.pdf`,
    ),
  );
  const listCalls = [];
  const removeCalls = [];
  setStorageObservabilityTestClient({
    storage: {
      from(bucket) {
        assert.equal(bucket, "anbud-documents");
        return {
          async list(currentPrefix, options) {
            listCalls.push({ currentPrefix, ...options });
            const entries = [...files]
              .filter((filePath) => filePath.startsWith(`${currentPrefix}/`))
              .map((filePath) => ({
                name: filePath.slice(currentPrefix.length + 1),
                id: filePath,
                metadata: {},
              }))
              .sort((left, right) => left.name.localeCompare(right.name));
            return {
              data: entries.slice(options.offset, options.offset + options.limit),
              error: null,
            };
          },
          async remove(paths) {
            removeCalls.push([...paths]);
            for (const filePath of paths) files.delete(filePath);
            return { data: [], error: null };
          },
        };
      },
    },
  });

  await removeStoredFilePrefixes([{ prefix }]);

  assert.equal(files.size, 0);
  assert.deepEqual(
    removeCalls.map((paths) => paths.length),
    [1_000, 1],
  );
  assert.ok(listCalls.some((call) => call.offset === 1_000));
  assert.equal(listCalls.at(-1).offset, 0);
});
