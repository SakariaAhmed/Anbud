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
const { runStorageFirstDeletion } = jiti(
  path.join(frontendRoot, "lib/server/storage-deletion.ts"),
);

function mockContainer() {
  const blobs = new Map();
  const uploads = [];
  const container = {
    async getProperties() {
      return { etag: "mock" };
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
  return { blobs, container, uploads };
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Azure deletes overlap within a fixed bound and include snapshots exactly once", async () => {
  const gate = deferred();
  const started = [];
  let active = 0, maxActive = 0;
  const backend = createAzureBlobStorageBackend({ getContainerClient: () => ({
    getBlockBlobClient: (name) => ({ async deleteIfExists(options) {
      assert.deepEqual(options, { deleteSnapshots: "include" });
      started.push(name); active++; maxActive = Math.max(maxActive, active);
      await gate.promise; active--; return { succeeded: true };
    } }),
  }) });
  const files = Array.from({ length: 9 }, (_, i) => ({ path: `projects/p/${i}` }));
  let databaseDeletes = 0;
  const operation = runStorageFirstDeletion({
    removeStorage: () => backend.removeStoredFiles([...files, files[0], { path: null }]),
    deleteDatabaseRows: async () => { assert.equal(active, 0); assert.equal(started.length, 9); databaseDeletes++; },
  });
  try { assert.equal(started.length, 4); }
  finally { gate.resolve(); await operation; }
  assert.equal(maxActive, 4);
  assert.equal(active, 0);
  assert.equal(databaseDeletes, 1);
  assert.deepEqual([...started].sort(), files.map((f) => f.path).sort());
});

for (const reason of [new Error("delete failed"), undefined, null, false]) {
  test(`Azure deletion drains started work and stops queue after rejection: ${String(reason)}`, async () => {
    const first = deferred(), others = deferred();
    const started = [], finished = [];
    let outcome;
    let databaseDeletes = 0;
    const backend = createAzureBlobStorageBackend({ getContainerClient: () => ({
      getBlockBlobClient: (name) => ({ async deleteIfExists() {
        started.push(name);
        if (name === "projects/p/0") return first.promise;
        await others.promise; finished.push(name); return { succeeded: true };
      } }),
    }) });
    const operation = runStorageFirstDeletion({
      removeStorage: () => backend.removeStoredFiles(Array.from({ length: 9 }, (_, i) => ({ path: `projects/p/${i}` }))),
      deleteDatabaseRows: async () => { databaseDeletes++; },
    })
      .then(() => { outcome = { status: "resolved" }; }, (error) => { outcome = { status: "rejected", error }; });
    try {
      assert.equal(started.length, 4);
      assert.equal(databaseDeletes, 0);
      first.reject(reason);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(outcome, undefined, "Started deletes must drain before rejection reaches the caller.");
      assert.equal(started.length, 4, "No queued file starts after the observed failure.");
      others.resolve(); await operation;
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.error, reason);
      assert.equal(databaseDeletes, 0);
      assert.equal(finished.length, 3);
      assert.equal(started.length, 4);
    } finally { first.reject(reason); others.resolve(); await operation; }
  });
}

test("Azure deletion validates every path and bucket before mutating any file", async () => {
  const deleted = [];
  const backend = createAzureBlobStorageBackend({ getContainerClient: () => ({
    getBlockBlobClient: (name) => ({ async deleteIfExists() { deleted.push(name); } }),
  }) });
  for (const invalid of [{ path: "/absolute" }, { path: "nul\0path" }, { bucket: "other", path: "valid" }]) {
    await assert.rejects(backend.removeStoredFiles([{ path: "projects/p/valid" }, invalid]));
    assert.deepEqual(deleted, []);
  }
  await backend.removeStoredFiles([]);
  await backend.removeStoredFiles([{ path: null }, { path: "" }]);
  assert.deepEqual(deleted, []);
});
