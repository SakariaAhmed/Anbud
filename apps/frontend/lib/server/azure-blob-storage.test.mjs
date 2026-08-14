import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "azure-blob-storage-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { createAzureBlobStorageBackend } = jiti(
  path.join(frontendRoot, "lib/server/azure-blob-storage.ts"),
);

function mockContainer() {
  const blobs = new Map();
  const uploads = [];
  let createCalls = 0;
  const container = {
    async getProperties() {
      return { etag: "mock" };
    },
    async createIfNotExists() {
      createCalls += 1;
      return {};
    },
    getBlockBlobClient(name) {
      return {
        async uploadData(body, options) {
          uploads.push({ name, body: Buffer.from(body), options });
          blobs.set(name, Buffer.from(body));
        },
        async downloadToBuffer() {
          const body = blobs.get(name);
          if (!body) throw Object.assign(new Error("missing blob"), { statusCode: 404 });
          return Buffer.from(body);
        },
        async deleteIfExists() {
          return { succeeded: blobs.delete(name) };
        },
      };
    },
    listBlobsFlat({ prefix }) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const name of [...blobs.keys()].sort()) {
            if (name.startsWith(prefix)) yield { name };
          }
        },
      };
    },
  };
  return { blobs, container, uploads, createCalls: () => createCalls };
}

test("Azure Blob adapter preserves encrypted UTF-8 bytes and overwrites the exact path", async () => {
  const mock = mockContainer();
  const backend = createAzureBlobStorageBackend({
    getContainerClient: () => mock.container,
  });
  const encryptedBase64 = "enc:v1:å-safe-base64-payload";

  const stored = await backend.uploadEncryptedBase64File({
    path: "projects/p-1/file.txt",
    encryptedBase64,
  });
  await backend.uploadEncryptedBase64File({
    path: stored.path,
    encryptedBase64: `${encryptedBase64}-new`,
  });

  assert.deepEqual(stored, {
    bucket: "anbud-documents",
    path: "projects/p-1/file.txt",
  });
  assert.equal(mock.createCalls(), 1);
  assert.equal(mock.uploads.length, 2);
  assert.equal(
    await backend.downloadEncryptedBase64File(stored),
    `${encryptedBase64}-new`,
  );
  assert.equal(
    mock.uploads[0].options.blobHTTPHeaders.blobContentType,
    "application/octet-stream",
  );
});

test("Azure Blob adapter readiness probe performs a non-mutating container read", async () => {
  const mock = mockContainer();
  let propertyReads = 0;
  mock.container.getProperties = async () => {
    propertyReads += 1;
    return { etag: "mock" };
  };
  const backend = createAzureBlobStorageBackend({
    getContainerClient: () => mock.container,
  });

  await backend.probeAccess();
  assert.equal(propertyReads, 1);
  assert.equal(mock.createCalls(), 0);
});

test("Azure Blob adapter lists only the slash-bounded prefix", async () => {
  const mock = mockContainer();
  mock.blobs.set("projects/abc/one", Buffer.from("one"));
  mock.blobs.set("projects/abc/nested/two", Buffer.from("two"));
  mock.blobs.set("projects/abcd/not-a-match", Buffer.from("other"));
  const backend = createAzureBlobStorageBackend({
    getContainerClient: () => mock.container,
  });

  assert.deepEqual(
    await backend.listStoredFilesUnderPrefix({ prefix: "projects/abc" }),
    ["projects/abc/nested/two", "projects/abc/one"],
  );
});

test("Azure Blob adapter deduplicates idempotent deletes and rejects other containers", async () => {
  const mock = mockContainer();
  mock.blobs.set("projects/p/file", Buffer.from("payload"));
  const backend = createAzureBlobStorageBackend({
    getContainerClient: () => mock.container,
  });

  await backend.removeStoredFiles([
    { path: "projects/p/file" },
    { path: "projects/p/file" },
    { path: null },
  ]);
  await backend.removeStoredFiles([{ path: "projects/p/file" }]);
  assert.equal(mock.blobs.size, 0);
  await assert.rejects(
    backend.downloadEncryptedBase64File({ bucket: "other", path: "x" }),
    /ikke tillatt/u,
  );
});
