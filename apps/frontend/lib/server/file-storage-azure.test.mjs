import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const testSupportPath = path.join(
  frontendRoot,
  "lib/server/storage-observability.test-support.ts",
);
const jiti = createJiti(path.join(frontendRoot, "file-storage-azure-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@/lib/server/azure-blob-storage": testSupportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const { setAzureBlobStorageTestBackend } = jiti(testSupportPath);
const {
  buildStoredFilePath,
  downloadEncryptedBase64File,
  removeStoredFilePrefixes,
  uploadEncryptedBase64File,
} = jiti(path.join(frontendRoot, "lib/server/file-storage-azure.ts"));

test("stored file paths remain normalized and deterministic", () => {
  assert.equal(
    buildStoredFilePath({
      scope: "projects",
      ownerId: "kunde/ prosjekt",
      fileId: "doc:1",
      fileName: "Vedlegg Økonomi.pdf",
    }),
    "projects/kunde-prosjekt/doc-1/Vedlegg-konomi.pdf",
  );
});

test("file operations always delegate to Azure Blob Storage", async () => {
  const calls = [];
  setAzureBlobStorageTestBackend({
    async uploadEncryptedBase64File(input) {
      calls.push(["upload", input]);
      return { bucket: "anbud-documents", path: input.path };
    },
    async downloadEncryptedBase64File(input) {
      calls.push(["download", input]);
      return "encrypted";
    },
  });

  assert.deepEqual(
    await uploadEncryptedBase64File({ path: "projects/p/a", encryptedBase64: "cipher" }),
    { bucket: "anbud-documents", path: "projects/p/a" },
  );
  assert.equal(
    await downloadEncryptedBase64File({
      bucket: "anbud-documents",
      path: "projects/p/a",
    }),
    "encrypted",
  );
  assert.deepEqual(calls, [
    ["upload", { path: "projects/p/a", encryptedBase64: "cipher" }],
    ["download", { bucket: "anbud-documents", path: "projects/p/a" }],
  ]);
});

test("prefix removal deletes every Azure object and verifies emptiness", async () => {
  const files = new Set(["projects/p/a", "projects/p/b"]);
  const removals = [];
  setAzureBlobStorageTestBackend({
    async listStoredFilesUnderPrefix() {
      return [...files].sort();
    },
    async removeStoredFiles(entries) {
      removals.push(entries.map((entry) => entry.path));
      for (const entry of entries) files.delete(entry.path);
    },
  });

  await removeStoredFilePrefixes([
    { bucket: "anbud-documents", prefix: "projects/p" },
    { bucket: "anbud-documents", prefix: "projects/p" },
  ]);

  assert.equal(files.size, 0);
  assert.deepEqual(removals, [["projects/p/a", "projects/p/b"]]);
});
