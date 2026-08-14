import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
} from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MigrationError,
  configurationFromEnvironment,
  createSupabaseLinkedCliSource,
  migrateAndVerify,
  parseDatabaseReferences,
  validateObjectPath,
  validateSupabaseS3Endpoint,
} from "./azure_blob_migrate_verify.mjs";

const BUCKET = "anbud-documents";
const SECRET = "migration-test-app-encryption-key";
const SMOKE_PATH = "projects/project-1/document-1/source.pdf";
const PROJECT_REF = "abcdefghijklmnopqrst";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function appEncryptedFile(value, secret = SECRET) {
  const plainBase64 = Buffer.from(value).toString("base64");
  const key = createHash("sha256").update(secret).digest();
  const iv = Buffer.from("0102030405060708090a0b0c", "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([
    cipher.update(plainBase64, "utf8"),
    cipher.final(),
  ]);
  return Buffer.from(
    [
      "enc:v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(":"),
  );
}

function sourceObject(body, overrides = {}) {
  const bytes = Buffer.from(body);
  return {
    body: bytes,
    contentType: "application/octet-stream",
    cacheControl: "max-age=31536000",
    contentDisposition: undefined,
    contentEncoding: undefined,
    contentLanguage: "nb",
    metadata: { origin: "supabase", revision: "7" },
    etag: `"${sha256(bytes).slice(0, 32)}"`,
    ...overrides,
  };
}

class FakeS3 {
  constructor(objects, options = {}) {
    this.objects = new Map(Object.entries(objects));
    this.pageSize = options.pageSize ?? 2;
    this.listError = options.listError;
    this.repeatedToken = options.repeatedToken ?? false;
    this.mutateAfterListCalls = options.mutateAfterListCalls ?? 0;
    this.listCalls = 0;
    this.getCalls = [];
  }

  async send(command) {
    if (command.constructor.name === "ListObjectsV2Command") {
      if (this.listError) throw this.listError;
      const offset = Number(command.input.ContinuationToken ?? 0);
      const entries = [...this.objects.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const page = entries.slice(offset, offset + this.pageSize);
      const nextOffset = offset + page.length;
      this.listCalls += 1;
      const result = {
        Contents: page.map(([Key, value]) => ({
          Key,
          Size: value.body.byteLength,
          ETag: value.etag,
        })),
        IsTruncated: nextOffset < entries.length,
        NextContinuationToken:
          nextOffset < entries.length
            ? String(this.repeatedToken ? offset || nextOffset : nextOffset)
            : undefined,
      };
      if (
        this.mutateAfterListCalls > 0 &&
        this.listCalls === this.mutateAfterListCalls
      ) {
        const current = this.objects.get(SMOKE_PATH);
        this.objects.set(SMOKE_PATH, sourceObject(Buffer.concat([current.body, Buffer.from("x")])));
      }
      return result;
    }
    if (command.constructor.name === "HeadObjectCommand") {
      const object = this.objects.get(command.input.Key);
      if (!object) {
        const error = new Error("missing from private source endpoint");
        error.name = "NoSuchKey";
        throw error;
      }
      if (command.input.IfMatch && command.input.IfMatch !== object.etag) {
        const error = new Error("precondition failed");
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      return {
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        CacheControl: object.cacheControl,
        ContentDisposition: object.contentDisposition,
        ContentEncoding: object.contentEncoding,
        ContentLanguage: object.contentLanguage,
        Metadata: object.metadata,
        Expires: object.expires,
      };
    }
    if (command.constructor.name === "GetObjectCommand") {
      const object = this.objects.get(command.input.Key);
      this.getCalls.push(command.input.Key);
      if (!object) {
        const error = new Error("provider URL and credentials must remain private");
        error.name = "NoSuchKey";
        throw error;
      }
      if (command.input.IfMatch && command.input.IfMatch !== object.etag) {
        const error = new Error("precondition failed at a sensitive endpoint");
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const midpoint = Math.max(1, Math.floor(object.body.byteLength / 2));
      return {
        Body: Readable.from([
          object.body.subarray(0, midpoint),
          object.body.subarray(midpoint),
        ]),
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        CacheControl: object.cacheControl,
        ContentDisposition: object.contentDisposition,
        ContentEncoding: object.contentEncoding,
        ContentLanguage: object.contentLanguage,
        Metadata: object.metadata,
        Expires: object.expires,
      };
    }
    throw new Error("unexpected fake S3 command");
  }
}

function azureObject(body, overrides = {}) {
  return {
    body: Buffer.from(body),
    contentType: "application/octet-stream",
    cacheControl: "max-age=31536000",
    contentDisposition: undefined,
    contentEncoding: undefined,
    contentLanguage: "nb",
    metadata: { origin: "supabase", revision: "7" },
    ...overrides,
  };
}

class FakeContainer {
  constructor(objects = {}, options = {}) {
    this.objects = new Map(Object.entries(objects));
    this.uploads = [];
    this.corruptUploads = options.corruptUploads ?? false;
    this.accessError = options.accessError;
  }

  async getProperties() {
    if (this.accessError) throw this.accessError;
    return {};
  }

  async *listBlobsFlat() {
    for (const name of [...this.objects.keys()].sort()) yield { name };
  }

  getBlockBlobClient(path) {
    return {
      getProperties: async () => {
        const object = this.objects.get(path);
        if (!object) {
          const error = new Error("missing at https://secret.blob.core.windows.net");
          error.statusCode = 404;
          throw error;
        }
        return {
          contentLength: object.body.byteLength,
          contentType: object.contentType,
          cacheControl: object.cacheControl,
          contentDisposition: object.contentDisposition,
          contentEncoding: object.contentEncoding,
          contentLanguage: object.contentLanguage,
          metadata: object.metadata,
        };
      },
      download: async () => {
        const object = this.objects.get(path);
        if (!object) {
          const error = new Error("missing");
          error.statusCode = 404;
          throw error;
        }
        return {
          readableStreamBody: Readable.from([
            object.body.subarray(0, 3),
            object.body.subarray(3),
          ]),
        };
      },
      uploadStream: async (stream, bufferBytes, maxConcurrency, options) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        let body = Buffer.concat(chunks);
        if (this.corruptUploads) body = Buffer.concat([body.subarray(0, -1), Buffer.from("!")]);
        this.objects.set(
          path,
          azureObject(body, {
            contentType: options.blobHTTPHeaders.blobContentType,
            cacheControl: options.blobHTTPHeaders.blobCacheControl,
            contentDisposition: options.blobHTTPHeaders.blobContentDisposition,
            contentEncoding: options.blobHTTPHeaders.blobContentEncoding,
            contentLanguage: options.blobHTTPHeaders.blobContentLanguage,
            metadata: { ...options.metadata },
          }),
        );
        this.uploads.push({ path, bufferBytes, maxConcurrency });
      },
    };
  }
}

function baseSourceObjects() {
  return {
    [SMOKE_PATH]: sourceObject(appEncryptedFile("real document bytes")),
    "projects/project-1/document-2/appendix.pdf": sourceObject(
      Buffer.from("second encrypted-ish body"),
      {
        contentType: "application/pdf",
        contentDisposition: "attachment; filename=appendix.pdf",
        metadata: { classification: "confidential" },
      },
    ),
    "orphans/not-in-database.bin": sourceObject(Buffer.from("orphan bytes"), {
      contentEncoding: "identity",
    }),
  };
}

function migrationInput(overrides = {}) {
  const input = {
    sourceBucket: BUCKET,
    targetContainer: BUCKET,
    allowedBuckets: new Set([BUCKET]),
    dbReferences: [
      SMOKE_PATH,
      "projects/project-1/document-2/appendix.pdf",
    ],
    mode: "pre-copy",
    decryptionSmokePath: SMOKE_PATH,
    encryptionSecret: SECRET,
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
    ...overrides,
  };
  input.dbReferenceFile ??= {
    status: "sha256-verified",
    size: 128,
    sha256: "4".repeat(64),
    modifiedAt: "2026-08-14T11:55:00.000Z",
  };
  input.sourceProjectRef ??= PROJECT_REF;
  input.sourceFrozenAttested ??= input.mode === "final";
  input.sourceFrozenAt ??=
    input.mode === "final" ? "2026-08-14T11:50:00.000Z" : null;
  return input;
}

test("pre-copy paginates all source objects, preserves bytes and metadata, and reports orphans/extras", async () => {
  const sources = baseSourceObjects();
  const alreadyCopiedPath = "projects/project-1/document-2/appendix.pdf";
  const existing = sources[alreadyCopiedPath];
  const s3 = new FakeS3(sources, { pageSize: 1 });
  const target = new FakeContainer({
    [alreadyCopiedPath]: azureObject(existing.body, {
      contentType: existing.contentType,
      cacheControl: existing.cacheControl,
      contentDisposition: existing.contentDisposition,
      contentLanguage: existing.contentLanguage,
      metadata: existing.metadata,
    }),
    "stale/allowed-during-pre-copy.bin": azureObject("stale"),
  });
  const directory = await mkdtemp(join(tmpdir(), "azure-blob-test-"));
  const manifestFile = join(directory, "manifest.json");
  try {
    const manifest = await migrateAndVerify(
      migrationInput({ s3, container: target, manifestFile }),
    );
    assert.equal(manifest.status, "verified");
    assert.equal(manifest.sourceObjectCount, 3);
    assert.equal(manifest.uploadedObjectCount, 2);
    assert.equal(manifest.resumedObjectCount, 1);
    assert.deepEqual(manifest.databaseReferenceReport.orphanPaths, [
      "orphans/not-in-database.bin",
    ]);
    assert.deepEqual(manifest.targetInventoryReport.extraPaths, [
      "stale/allowed-during-pre-copy.bin",
    ]);
    assert.deepEqual(target.objects.get(SMOKE_PATH).body, sources[SMOKE_PATH].body);
    assert.deepEqual(
      target.objects.get("orphans/not-in-database.bin").metadata,
      sources["orphans/not-in-database.bin"].metadata,
    );
    assert.deepEqual(
      manifest.objects.map(({ path, size, sha256: digest }) => ({ path, size, digest })),
      Object.entries(sources)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, object]) => ({
          path,
          size: object.body.byteLength,
          digest: sha256(object.body),
        })),
    );
    const persisted = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.deepEqual(persisted, manifest);
    assert.equal((await stat(manifestFile)).mode & 0o777, 0o600);
    assert.ok(s3.listCalls >= 6, "three single-object pages must be read twice");

    target.uploads.length = 0;
    const resumed = await migrateAndVerify(
      migrationInput({ s3, container: target }),
    );
    assert.equal(resumed.uploadedObjectCount, 0);
    assert.equal(resumed.resumedObjectCount, 3);
    assert.equal(target.uploads.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("final mode rejects target extras before writing", async () => {
  const s3 = new FakeS3(baseSourceObjects());
  const target = new FakeContainer({ "stale/object": azureObject("stale") });
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target, mode: "final" })),
    (error) => error instanceof MigrationError && error.code === "EXTRA_TARGET_OBJECTS",
  );
  assert.equal(target.uploads.length, 0);
  assert.equal(s3.getCalls.length, 0);
});

test("final mode copies the delta and requires an exact target inventory", async () => {
  const sources = baseSourceObjects();
  const s3 = new FakeS3(sources);
  const target = new FakeContainer();
  const manifest = await migrateAndVerify(
    migrationInput({ s3, container: target, mode: "final" }),
  );
  assert.equal(manifest.targetInventoryReport.exactMatchRequired, true);
  assert.equal(manifest.targetInventoryReport.extraObjectCount, 0);
  assert.deepEqual([...target.objects.keys()].sort(), Object.keys(sources).sort());
});

test("DB references missing from S3 stop before any copy", async () => {
  const sources = baseSourceObjects();
  delete sources[SMOKE_PATH];
  const s3 = new FakeS3(sources);
  const target = new FakeContainer();
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target })),
    (error) =>
      error instanceof MigrationError && error.code === "MISSING_REFERENCED_SOURCE",
  );
  assert.equal(target.uploads.length, 0);
});

test("unsafe traversal, encoded separators and control characters are rejected", () => {
  for (const path of [
    "../secret",
    "safe/../secret",
    "/absolute",
    "safe\\secret",
    "safe/%2e%2e/secret",
    "safe/%2fsecret",
    "safe/line\nfeed",
    "safe/zero\0byte",
  ]) {
    assert.throws(
      () => validateObjectPath(path),
      (error) => error instanceof MigrationError && error.code === "UNSAFE_OBJECT_PATH",
    );
  }
});

test("bucket allowlist and one-bucket DB input fail closed", () => {
  assert.throws(
    () =>
      parseDatabaseReferences(
        JSON.stringify([{ bucket: "other-documents", path: SMOKE_PATH }]),
        BUCKET,
        new Set([BUCKET]),
      ),
    (error) => error instanceof MigrationError && error.code === "BUCKET_NOT_ALLOWED",
  );
  assert.deepEqual(
    parseDatabaseReferences(
      `${JSON.stringify({ bucket: BUCKET, path: SMOKE_PATH })}\n${JSON.stringify({
        bucket: BUCKET,
        path: "projects/project-1/document-2/appendix.pdf",
      })}`,
      BUCKET,
      new Set([BUCKET]),
    ),
    [SMOKE_PATH, "projects/project-1/document-2/appendix.pdf"].sort(),
  );
  assert.throws(
    () =>
      parseDatabaseReferences(
        JSON.stringify([{ bucket: "other-documents", path: SMOKE_PATH }]),
        BUCKET,
        new Set([BUCKET, "other-documents"]),
      ),
    (error) => error instanceof MigrationError && error.code === "MULTI_BUCKET_REFERENCE",
  );
});

test("DB references accept the Supabase linked CLI JSON envelope", () => {
  assert.deepEqual(
    parseDatabaseReferences(
      JSON.stringify({
        boundary: "synthetic-boundary",
        rows: [
          { bucket: BUCKET, path: "folder/referenced.enc" },
          { bucket: BUCKET, path: "folder/referenced.enc" },
        ],
        warning: "untrusted database rows",
      }),
      BUCKET,
      new Set([BUCKET]),
    ),
    ["folder/referenced.enc"],
  );
});

test("corrupt Azure upload fails byte verification", async () => {
  const s3 = new FakeS3(baseSourceObjects());
  const target = new FakeContainer({}, { corruptUploads: true });
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target })),
    (error) => error instanceof MigrationError && error.code === "TARGET_VERIFY_FAILED",
  );
});

test("source metadata unsupported by Azure is rejected instead of silently lost", async () => {
  const sources = baseSourceObjects();
  sources[SMOKE_PATH] = sourceObject(appEncryptedFile("document"), {
    metadata: { "not-supported-key": "value" },
  });
  const s3 = new FakeS3(sources);
  const target = new FakeContainer();
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target })),
    (error) =>
      error instanceof MigrationError && error.code === "UNSUPPORTED_SOURCE_METADATA",
  );
  assert.equal(target.uploads.length, 0);
});

test("source inventory changes invalidate the run", async () => {
  const s3 = new FakeS3(baseSourceObjects(), {
    pageSize: 10,
    mutateAfterListCalls: 1,
  });
  const target = new FakeContainer();
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target })),
    (error) =>
      error instanceof MigrationError &&
      ["SOURCE_DOWNLOAD_FAILED", "SOURCE_CHANGED"].includes(error.code),
  );
});

test("provider messages cannot leak credentials or endpoint URLs", async () => {
  const providerMessage =
    "access=top-secret https://project.storage.supabase.co/storage/v1/s3";
  const s3 = new FakeS3({}, { listError: new Error(providerMessage) });
  const target = new FakeContainer();
  await assert.rejects(
    migrateAndVerify(migrationInput({ s3, container: target })),
    (error) => {
      assert.equal(error.code, "SOURCE_LIST_FAILED");
      assert.doesNotMatch(error.message, /top-secret|https?:\/\//u);
      return true;
    },
  );
});

test("decryption smoke uses the app AES-GCM format and exposes no plaintext on failure", async () => {
  const s3 = new FakeS3(baseSourceObjects());
  const target = new FakeContainer();
  await assert.rejects(
    migrateAndVerify(
      migrationInput({
        s3,
        container: target,
        encryptionSecret: "wrong-key-never-log-this",
      }),
    ),
    (error) => {
      assert.equal(error.code, "DECRYPTION_SMOKE_FAILED");
      assert.doesNotMatch(error.message, /wrong-key|real document|sha|hash/iu);
      return true;
    },
  );
});

test("managed Supabase endpoint and env-only Azure alternatives validate without leaking URLs", () => {
  assert.equal(
    validateSupabaseS3Endpoint(
      "https://project-ref.storage.supabase.co/storage/v1/s3",
    ),
    "https://project-ref.storage.supabase.co/storage/v1/s3",
  );
  assert.throws(
    () =>
      validateSupabaseS3Endpoint(
        "https://access:secret@example.com/storage/v1/s3?token=private",
      ),
    (error) => {
      assert.equal(error.code, "INVALID_ENDPOINT");
      assert.doesNotMatch(error.message, /access|secret|example|token/iu);
      return true;
    },
  );

  const common = {
    SOURCE_STORAGE_MODE: "supabase-s3",
    MIGRATION_EXPECTED_SUPABASE_PROJECT_REF: PROJECT_REF,
    MIGRATION_EXPECTED_AZURE_STORAGE_ACCOUNT: "safeaccount",
    MIGRATION_MODE: "pre-copy",
    SUPABASE_S3_ENDPOINT:
      `https://${PROJECT_REF}.storage.supabase.co/storage/v1/s3`,
    SUPABASE_S3_REGION: "eu-west-1",
    SUPABASE_S3_ACCESS_KEY_ID: "server-only-id",
    SUPABASE_S3_SECRET_ACCESS_KEY: "server-only-secret",
    SUPABASE_S3_BUCKET: BUCKET,
    MIGRATION_ALLOWED_SOURCE_BUCKETS: BUCKET,
    MIGRATION_DB_REFERENCES_FILE: "/secure/references.json",
    MIGRATION_MANIFEST_FILE: "/secure/manifest.json",
    MIGRATION_DECRYPTION_SMOKE_PATH: SMOKE_PATH,
    APP_ENCRYPTION_KEY: SECRET,
  };
  const accountConfiguration = configurationFromEnvironment({
    ...common,
    AZURE_STORAGE_ACCOUNT_URL: "https://safeaccount.blob.core.windows.net",
    AZURE_STORAGE_CONTAINER: BUCKET,
  });
  assert.equal(accountConfiguration.azure.containerName, BUCKET);
  const containerConfiguration = configurationFromEnvironment({
    ...common,
    AZURE_STORAGE_CONTAINER_URL: `https://safeaccount.blob.core.windows.net/${BUCKET}`,
  });
  assert.equal(containerConfiguration.azure.containerName, BUCKET);
  assert.throws(
    () =>
      configurationFromEnvironment({
        ...common,
        SUPABASE_S3_ENDPOINT:
          "https://wrongprojectref1234.storage.supabase.co/storage/v1/s3",
        AZURE_STORAGE_ACCOUNT_URL: "https://safeaccount.blob.core.windows.net",
        AZURE_STORAGE_CONTAINER: BUCKET,
      }),
    (error) => error.code === "SOURCE_PROJECT_MISMATCH",
  );
  assert.throws(
    () =>
      configurationFromEnvironment({
        ...common,
        AZURE_STORAGE_ACCOUNT_URL: "https://wrongaccount.blob.core.windows.net",
        AZURE_STORAGE_CONTAINER: BUCKET,
      }),
    (error) => error.code === "TARGET_ACCOUNT_MISMATCH",
  );
});

test("preferred linked CLI adapter lists and downloads without S3 credentials and rechecks final bytes", async () => {
  const linkedPath = "projects/project 1/dokument-æ.pdf";
  const objects = new Map([
    [SMOKE_PATH, appEncryptedFile("linked CLI document")],
    [linkedPath, Buffer.from("orphan from linked CLI")],
  ]);
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd });
    if (args[0] === "--version") {
      return { status: 0, stdout: "2.105.0\n", stderr: "", overflow: false };
    }
    if (args[0] === "storage" && args[1] === "ls") {
      return {
        status: 0,
        stdout: JSON.stringify({
          // Supabase CLI 2.114 emits linked Storage paths with a leading slash.
          paths: [...objects.keys()].sort().map((path) => `/${BUCKET}/${path}`),
        }),
        stderr: "",
        overflow: false,
      };
    }
    if (args[0] === "storage" && args[1] === "cp") {
      const remote = new URL(args[2]);
      const remotePath = decodeURIComponent(remote.pathname)
        .replace(/^\//u, "")
        .slice(`${BUCKET}/`.length);
      const body = objects.get(remotePath);
      assert.ok(body, "fake linked CLI source path must resolve exactly");
      await writeFile(args[3], body, { flag: "wx", mode: 0o600 });
      return {
        status: 0,
        stdout: JSON.stringify({ downloaded: [{ from: args[2], to: args[3] }] }),
        stderr: "",
        overflow: false,
      };
    }
    throw new Error("unexpected fake linked CLI invocation");
  };
  const source = createSupabaseLinkedCliSource({
    bucket: BUCKET,
    workdir: "/secure/linked-project",
    expectedProjectRef: PROJECT_REF,
    projectRefReader: async () => PROJECT_REF,
    runner,
  });
  const target = new FakeContainer();
  const manifest = await migrateAndVerify(
    migrationInput({
      source,
      s3: undefined,
      container: target,
      dbReferences: [SMOKE_PATH],
      mode: "final",
    }),
  );
  assert.equal(manifest.sourceMode, "supabase-linked-cli");
  assert.equal(manifest.finalSourceBodyRecheck, true);
  assert.deepEqual(manifest.databaseReferenceReport.orphanPaths, [linkedPath]);
  assert.equal(
    calls.filter(({ args }) => args[0] === "storage" && args[1] === "cp").length,
    4,
    "final mode downloads every linked source once for copy and once for freeze verification",
  );
  for (const call of calls) {
    assert.equal(call.cwd, "/secure/linked-project");
    assert.doesNotMatch(call.args.join(" "), /access.key|secret|storage\.supabase\.co/iu);
  }
  const encodedCall = calls.find(({ args }) => args[2]?.includes("project%201"));
  assert.ok(encodedCall, "linked CLI URLs must encode unsafe URL characters without changing keys");
  assert.deepEqual(target.objects.get(linkedPath).body, objects.get(linkedPath));
});

test("linked CLI mode is configurable without full-access S3 keys", () => {
  const environment = {
    SOURCE_STORAGE_MODE: "supabase-linked-cli",
    SOURCE_STORAGE_BUCKET: BUCKET,
    MIGRATION_EXPECTED_SUPABASE_PROJECT_REF: PROJECT_REF,
    MIGRATION_EXPECTED_AZURE_STORAGE_ACCOUNT: "safeaccount",
    MIGRATION_ALLOWED_SOURCE_BUCKETS: BUCKET,
    MIGRATION_SUPABASE_WORKDIR: "/secure/linked-project",
    MIGRATION_MODE: "pre-copy",
    AZURE_STORAGE_ACCOUNT_URL: "https://safeaccount.blob.core.windows.net",
    AZURE_STORAGE_CONTAINER: BUCKET,
    MIGRATION_DB_REFERENCES_FILE: "/secure/references.json",
    MIGRATION_MANIFEST_FILE: "/secure/manifest.json",
    MIGRATION_DECRYPTION_SMOKE_PATH: SMOKE_PATH,
    APP_ENCRYPTION_KEY: SECRET,
  };
  const configuration = configurationFromEnvironment(environment);
  assert.equal(configuration.source.mode, "supabase-linked-cli");
  assert.equal(configuration.source.accessKeyId, undefined);
  assert.equal(configuration.source.secretAccessKey, undefined);
  assert.throws(
    () =>
      configurationFromEnvironment({
        ...environment,
        MIGRATION_MODE: "final",
      }),
    (error) => error.code === "SOURCE_NOT_FROZEN",
  );
  const finalConfiguration = configurationFromEnvironment({
    ...environment,
    MIGRATION_MODE: "final",
    MIGRATION_SOURCE_FROZEN: "1",
    MIGRATION_SOURCE_FROZEN_AT: "2026-08-14T11:50:00.000Z",
  });
  assert.equal(finalConfiguration.sourceFrozenAttested, true);
  assert.equal(
    finalConfiguration.sourceFrozenAt,
    "2026-08-14T11:50:00.000Z",
  );
});

test("linked CLI final mode rejects source bytes that change during the second download", async () => {
  const initial = appEncryptedFile("initial linked bytes");
  const changed = appEncryptedFile("changed linked bytes");
  let copyCount = 0;
  const runner = async (args) => {
    if (args[0] === "--version") {
      return { status: 0, stdout: "2.105.0", stderr: "", overflow: false };
    }
    if (args[1] === "ls") {
      return {
        status: 0,
        stdout: JSON.stringify({ paths: [`${BUCKET}/${SMOKE_PATH}`] }),
        stderr: "",
        overflow: false,
      };
    }
    if (args[1] === "cp") {
      copyCount += 1;
      await writeFile(args[3], copyCount === 1 ? initial : changed, {
        flag: "wx",
        mode: 0o600,
      });
      return { status: 0, stdout: "{}", stderr: "", overflow: false };
    }
    throw new Error("unexpected command");
  };
  const source = createSupabaseLinkedCliSource({
    bucket: BUCKET,
    workdir: "/secure/linked-project",
    expectedProjectRef: PROJECT_REF,
    projectRefReader: async () => PROJECT_REF,
    runner,
  });
  await assert.rejects(
    migrateAndVerify(
      migrationInput({
        source,
        s3: undefined,
        container: new FakeContainer(),
        dbReferences: [SMOKE_PATH],
        mode: "final",
      }),
    ),
    (error) => error instanceof MigrationError && error.code === "SOURCE_CHANGED",
  );
});

test("linked CLI runner failures cannot expose Management API credentials or URLs", async () => {
  const source = createSupabaseLinkedCliSource({
    bucket: BUCKET,
    workdir: "/secure/linked-project",
    expectedProjectRef: PROJECT_REF,
    projectRefReader: async () => PROJECT_REF,
    runner: async (args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "2.105.0", stderr: "", overflow: false }
        : {
            status: 1,
            stdout: "",
            stderr: "token=management-secret https://api.supabase.com/private",
            overflow: false,
          },
  });
  await assert.rejects(
    migrateAndVerify(
      migrationInput({
        source,
        s3: undefined,
        container: new FakeContainer(),
      }),
    ),
    (error) => {
      assert.equal(error.code, "SOURCE_LIST_FAILED");
      assert.doesNotMatch(error.message, /management-secret|https?:\/\//u);
      return true;
    },
  );
});

test("linked CLI verifies the expected project before listing storage", async () => {
  const calls = [];
  const source = createSupabaseLinkedCliSource({
    bucket: BUCKET,
    workdir: "/secure/linked-project",
    expectedProjectRef: PROJECT_REF,
    projectRefReader: async () => "wrongprojectref1234",
    runner: async (args) => {
      calls.push(args);
      return { status: 0, stdout: "2.105.0", stderr: "", overflow: false };
    },
  });
  await assert.rejects(
    migrateAndVerify(
      migrationInput({ source, s3: undefined, container: new FakeContainer() }),
    ),
    (error) => error.code === "SOURCE_PROJECT_MISMATCH",
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["--version"]);
});
