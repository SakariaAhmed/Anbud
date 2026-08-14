#!/usr/bin/env node

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  ContainerClient,
} from "@azure/storage-blob";
import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODE_PRE_COPY = "pre-copy";
const MODE_FINAL = "final";
const SOURCE_LINKED_CLI = "supabase-linked-cli";
const SOURCE_S3 = "supabase-s3";
const MINIMUM_LINKED_CLI_VERSION = [2, 105, 0];
const MAX_CLI_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES = 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_SMOKE_MAX_BYTES = 64 * 1024 * 1024;
const APP_ENCRYPTION_PREFIX = "enc:v1";
const APP_AUTH_TAG_LENGTH = 16;
const APP_SUPPORTED_AUTH_TAG_LENGTHS = new Set([12, 13, 14, 15, 16]);
const AZURE_METADATA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_HTTP_HEADER_VALUE = /^[\x20-\x7e]*$/u;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const ENCODED_PATH_SPECIAL = /%(?:00|2e|2f|5c)/iu;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

let awsS3ModulePromise;

function awsS3Module() {
  awsS3ModulePromise ??= import("@aws-sdk/client-s3");
  return awsS3ModulePromise;
}

export class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

function stop(code, message) {
  throw new MigrationError(code, message);
}

function required(value, code, message) {
  const normalized = String(value ?? "").trim();
  if (!normalized) stop(code, message);
  return normalized;
}

function isNotFound(error) {
  return (
    Number(error?.statusCode ?? error?.$metadata?.httpStatusCode ?? 0) === 404 ||
    error?.code === "BlobNotFound" ||
    error?.name === "NoSuchKey"
  );
}

function isPreconditionFailed(error) {
  return Number(error?.statusCode ?? error?.$metadata?.httpStatusCode ?? 0) === 412;
}

async function externalOperation(code, message, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    stop(code, message);
  }
}

export function validateObjectPath(value) {
  const path = required(
    value,
    "UNSAFE_OBJECT_PATH",
    "Storage inventory contains an unsafe object path.",
  );
  if (
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    CONTROL_CHARACTERS.test(path) ||
    ENCODED_PATH_SPECIAL.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    stop("UNSAFE_OBJECT_PATH", "Storage inventory contains an unsafe object path.");
  }
  return path;
}

function validateBucketName(value) {
  const bucket = required(
    value,
    "INVALID_BUCKET",
    "A source bucket name is required.",
  );
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/u.test(bucket)) {
    stop("INVALID_BUCKET", "The source bucket name is invalid.");
  }
  return bucket;
}

function validateContainerName(value) {
  const container = required(
    value,
    "INVALID_CONTAINER",
    "An Azure container name is required.",
  );
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(container)) {
    stop("INVALID_CONTAINER", "The Azure container name is invalid.");
  }
  return container;
}

function safeUrl(value, type) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    stop("INVALID_ENDPOINT", `${type} endpoint configuration is invalid.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    stop("INVALID_ENDPOINT", `${type} endpoint configuration is invalid.`);
  }
  return parsed;
}

function validateProjectRef(value) {
  const projectRef = required(
    value,
    "INVALID_CONFIGURATION",
    "MIGRATION_EXPECTED_SUPABASE_PROJECT_REF is required.",
  );
  if (!/^[a-z0-9]{8,64}$/u.test(projectRef)) {
    stop("INVALID_CONFIGURATION", "The expected Supabase project ref is invalid.");
  }
  return projectRef;
}

export function validateSupabaseS3Endpoint(value, expectedProjectRef) {
  const parsed = safeUrl(
    required(
      value,
      "INVALID_ENDPOINT",
      "Supabase S3 endpoint configuration is required.",
    ),
    "Supabase S3",
  );
  if (
    !/^[a-z0-9-]+\.storage\.supabase\.co$/u.test(parsed.hostname) ||
    parsed.pathname.replace(/\/+$/u, "") !== "/storage/v1/s3"
  ) {
    stop(
      "INVALID_ENDPOINT",
      "Supabase S3 must use the direct managed-storage endpoint.",
    );
  }
  if (
    expectedProjectRef &&
    parsed.hostname !== `${validateProjectRef(expectedProjectRef)}.storage.supabase.co`
  ) {
    stop("SOURCE_PROJECT_MISMATCH", "The Supabase S3 endpoint does not match the expected project.");
  }
  return parsed.href.replace(/\/+$/u, "");
}

function validateAzureAccountUrl(value) {
  const parsed = safeUrl(value, "Azure Storage");
  if (
    !/^[a-z0-9-]+\.blob\.core\.windows\.net$/u.test(parsed.hostname) ||
    parsed.pathname !== "/"
  ) {
    stop("INVALID_ENDPOINT", "Azure Storage endpoint configuration is invalid.");
  }
  return parsed.href.replace(/\/+$/u, "");
}

function validateAzureContainerUrl(value) {
  const parsed = safeUrl(value, "Azure Storage container");
  if (!/^[a-z0-9-]+\.blob\.core\.windows\.net$/u.test(parsed.hostname)) {
    stop("INVALID_ENDPOINT", "Azure Storage container configuration is invalid.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) {
    stop("INVALID_ENDPOINT", "Azure Storage container configuration is invalid.");
  }
  return {
    containerName: validateContainerName(parts[0]),
    containerUrl: parsed.href.replace(/\/+$/u, ""),
  };
}

function parseMode(value) {
  const mode = required(
    value,
    "INVALID_MODE",
    "MIGRATION_MODE must be pre-copy or final.",
  );
  if (mode !== MODE_PRE_COPY && mode !== MODE_FINAL) {
    stop("INVALID_MODE", "MIGRATION_MODE must be pre-copy or final.");
  }
  return mode;
}

function parseSourceMode(value) {
  const mode = required(
    value,
    "INVALID_SOURCE_MODE",
    "SOURCE_STORAGE_MODE must be supabase-linked-cli or supabase-s3.",
  );
  if (mode !== SOURCE_LINKED_CLI && mode !== SOURCE_S3) {
    stop(
      "INVALID_SOURCE_MODE",
      "SOURCE_STORAGE_MODE must be supabase-linked-cli or supabase-s3.",
    );
  }
  return mode;
}

function parseAllowedBuckets(value) {
  const raw = required(
    value,
    "BUCKET_NOT_ALLOWED",
    "MIGRATION_ALLOWED_SOURCE_BUCKETS must be explicitly configured.",
  );
  const buckets = new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(validateBucketName),
  );
  if (!buckets.size) {
    stop(
      "BUCKET_NOT_ALLOWED",
      "MIGRATION_ALLOWED_SOURCE_BUCKETS must be explicitly configured.",
    );
  }
  return buckets;
}

function parsePositiveInteger(value, fallback, name) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    stop("INVALID_CONFIGURATION", `${name} must be a positive integer.`);
  }
  return parsed;
}

export function configurationFromEnvironment(environment = process.env, argv = []) {
  let cliMode = "";
  for (const argument of argv) {
    if (argument === "--help") return { help: true };
    if (argument.startsWith("--mode=")) {
      cliMode = argument.slice("--mode=".length);
      continue;
    }
    stop("INVALID_ARGUMENT", "Only --mode=pre-copy, --mode=final and --help are accepted.");
  }

  const sourceBucket = validateBucketName(
    environment.SOURCE_STORAGE_BUCKET || environment.SUPABASE_S3_BUCKET,
  );
  const allowedBuckets = parseAllowedBuckets(
    environment.MIGRATION_ALLOWED_SOURCE_BUCKETS,
  );
  if (!allowedBuckets.has(sourceBucket)) {
    stop("BUCKET_NOT_ALLOWED", "The configured source bucket is not allowlisted.");
  }

  const containerUrlValue = String(
    environment.AZURE_STORAGE_CONTAINER_URL ?? "",
  ).trim();
  const accountUrlValue = String(
    environment.AZURE_STORAGE_ACCOUNT_URL ?? "",
  ).trim();
  const containerValue = String(
    environment.AZURE_STORAGE_CONTAINER ?? "",
  ).trim();
  if (containerUrlValue && (accountUrlValue || containerValue)) {
    stop(
      "INVALID_CONFIGURATION",
      "Configure either an Azure container URL or an account URL plus container.",
    );
  }

  let azure;
  if (containerUrlValue) {
    azure = validateAzureContainerUrl(containerUrlValue);
  } else {
    if (!accountUrlValue || !containerValue) {
      stop(
        "INVALID_CONFIGURATION",
        "Azure account URL and container must be configured together.",
      );
    }
    azure = {
      accountUrl: validateAzureAccountUrl(accountUrlValue),
      containerName: validateContainerName(containerValue),
    };
  }
  if (azure.containerName !== sourceBucket) {
    stop(
      "BUCKET_CONTAINER_MISMATCH",
      "The Azure container must preserve the source bucket name.",
    );
  }
  const expectedAzureAccount = required(
    environment.MIGRATION_EXPECTED_AZURE_STORAGE_ACCOUNT,
    "INVALID_CONFIGURATION",
    "MIGRATION_EXPECTED_AZURE_STORAGE_ACCOUNT is required.",
  );
  if (!/^[a-z0-9]{3,24}$/u.test(expectedAzureAccount)) {
    stop("INVALID_CONFIGURATION", "The expected Azure Storage account name is invalid.");
  }
  const configuredAzureUrl = azure.containerUrl || azure.accountUrl;
  const configuredAzureAccount = new URL(configuredAzureUrl).hostname.split(".")[0];
  if (configuredAzureAccount !== expectedAzureAccount) {
    stop(
      "TARGET_ACCOUNT_MISMATCH",
      "The Azure Storage endpoint does not match the expected account.",
    );
  }
  azure.accountName = configuredAzureAccount;

  const sourceMode = parseSourceMode(environment.SOURCE_STORAGE_MODE);
  const expectedProjectRef = validateProjectRef(
    environment.MIGRATION_EXPECTED_SUPABASE_PROJECT_REF,
  );
  let source;
  if (sourceMode === SOURCE_LINKED_CLI) {
    source = {
      mode: sourceMode,
      bucket: sourceBucket,
      expectedProjectRef,
      workdir: resolve(
        required(
          environment.MIGRATION_SUPABASE_WORKDIR,
          "INVALID_CONFIGURATION",
          "MIGRATION_SUPABASE_WORKDIR is required for linked CLI mode.",
        ),
      ),
    };
  } else {
    const region = required(
      environment.SUPABASE_S3_REGION,
      "INVALID_CONFIGURATION",
      "Supabase S3 region is required.",
    );
    if (!/^[a-z0-9-]+$/u.test(region)) {
      stop("INVALID_CONFIGURATION", "Supabase S3 region is invalid.");
    }
    source = {
      mode: sourceMode,
      endpoint: validateSupabaseS3Endpoint(
        environment.SUPABASE_S3_ENDPOINT,
        expectedProjectRef,
      ),
      region,
      bucket: sourceBucket,
      expectedProjectRef,
      accessKeyId: required(
        environment.SUPABASE_S3_ACCESS_KEY_ID,
        "INVALID_CONFIGURATION",
        "Supabase S3 access ID is required.",
      ),
      secretAccessKey: required(
        environment.SUPABASE_S3_SECRET_ACCESS_KEY,
        "INVALID_CONFIGURATION",
        "Supabase S3 secret is required.",
      ),
    };
  }

  return {
    help: false,
    mode: parseMode(cliMode || environment.MIGRATION_MODE),
    source,
    azure,
    allowedBuckets,
    referencesFile: required(
      environment.MIGRATION_DB_REFERENCES_FILE,
      "INVALID_CONFIGURATION",
      "MIGRATION_DB_REFERENCES_FILE is required.",
    ),
    manifestFile: required(
      environment.MIGRATION_MANIFEST_FILE,
      "INVALID_CONFIGURATION",
      "MIGRATION_MANIFEST_FILE is required.",
    ),
    decryptionSmokePath: validateObjectPath(
      environment.MIGRATION_DECRYPTION_SMOKE_PATH,
    ),
    encryptionSecret: required(
      environment.APP_ENCRYPTION_KEY,
      "INVALID_CONFIGURATION",
      "APP_ENCRYPTION_KEY is required for the decryption smoke test.",
    ),
    bufferBytes: parsePositiveInteger(
      environment.MIGRATION_STREAM_BUFFER_BYTES,
      DEFAULT_BUFFER_BYTES,
      "MIGRATION_STREAM_BUFFER_BYTES",
    ),
    maxConcurrency: parsePositiveInteger(
      environment.MIGRATION_STREAM_CONCURRENCY,
      DEFAULT_MAX_CONCURRENCY,
      "MIGRATION_STREAM_CONCURRENCY",
    ),
    smokeMaxBytes: parsePositiveInteger(
      environment.MIGRATION_DECRYPTION_SMOKE_MAX_BYTES,
      DEFAULT_SMOKE_MAX_BYTES,
      "MIGRATION_DECRYPTION_SMOKE_MAX_BYTES",
    ),
  };
}

function referenceEntries(document) {
  if (Array.isArray(document)) return document;
  if (document && typeof document === "object" && Array.isArray(document.references)) {
    return document.references;
  }
  if (
    document &&
    typeof document === "object" &&
    (typeof document.path === "string" || typeof document.bucket === "string")
  ) {
    return [document];
  }
  stop(
    "INVALID_REFERENCE_FILE",
    "The DB reference input must be an array or an object with a references array.",
  );
}

export function parseDatabaseReferences(raw, sourceBucket, allowedBuckets) {
  let entries;
  try {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) entries = [];
    else {
      try {
        entries = referenceEntries(JSON.parse(trimmed));
      } catch {
        entries = trimmed
          .split(/\r?\n/u)
          .filter(Boolean)
          .flatMap((line) => referenceEntries(JSON.parse(line)));
      }
    }
  } catch {
    stop("INVALID_REFERENCE_FILE", "The DB reference input is not valid JSON or JSONL.");
  }

  const paths = new Set();
  for (const entry of entries) {
    const bucket = validateBucketName(
      typeof entry === "string" ? sourceBucket : entry?.bucket ?? sourceBucket,
    );
    if (!allowedBuckets.has(bucket)) {
      stop("BUCKET_NOT_ALLOWED", "A DB reference uses a bucket outside the allowlist.");
    }
    if (bucket !== sourceBucket) {
      stop(
        "MULTI_BUCKET_REFERENCE",
        "Run one migration per allowlisted bucket; the reference input mixes buckets.",
      );
    }
    const path = validateObjectPath(typeof entry === "string" ? entry : entry?.path);
    paths.add(path);
  }
  return [...paths].sort();
}

async function readDatabaseReferences(file, sourceBucket, allowedBuckets) {
  const raw = await externalOperation(
    "REFERENCE_FILE_READ_FAILED",
    "Could not read the DB reference input.",
    () => readFile(file, "utf8"),
  );
  return parseDatabaseReferences(raw, sourceBucket, allowedBuckets);
}

function sourceEntryFromList(entry) {
  const path = validateObjectPath(entry?.Key);
  const size = Number(entry?.Size);
  if (!Number.isSafeInteger(size) || size < 0) {
    stop("INVALID_SOURCE_INVENTORY", "Source inventory contains an invalid object size.");
  }
  return {
    path,
    size,
    etag: typeof entry?.ETag === "string" ? entry.ETag : "",
  };
}

export async function listSourceInventory(s3, bucket) {
  const { ListObjectsV2Command } = await awsS3Module();
  const objects = new Map();
  const seenTokens = new Set();
  let continuationToken;
  do {
    const page = await externalOperation(
      "SOURCE_LIST_FAILED",
      "Could not list the complete source bucket.",
      () =>
        s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            MaxKeys: 1_000,
          }),
        ),
    );
    for (const rawEntry of page?.Contents ?? []) {
      const entry = sourceEntryFromList(rawEntry);
      if (objects.has(entry.path)) {
        stop("DUPLICATE_SOURCE_OBJECT", "Source inventory contains a duplicate object path.");
      }
      objects.set(entry.path, entry);
    }
    if (!page?.IsTruncated) break;
    const next = String(page?.NextContinuationToken ?? "");
    if (!next || seenTokens.has(next)) {
      stop("SOURCE_PAGINATION_FAILED", "Source pagination did not make progress.");
    }
    seenTokens.add(next);
    continuationToken = next;
  } while (true);
  return [...objects.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function commandRunner(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn("supabase", args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CLI_STDOUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_CLI_STDERR_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stderr.push(Buffer.from(chunk));
      }
    });
    child.on("error", () => {
      resolvePromise({ status: -1, stdout: "", stderr: "", overflow: false });
    });
    child.on("close", (status) => {
      resolvePromise({
        status: status ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        overflow,
      });
    });
  });
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) > minimum[index]) return true;
    if ((actual[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

function linkedCliProperties() {
  return {
    contentType: "application/octet-stream",
    cacheControl: "max-age=31536000",
    contentDisposition: undefined,
    contentEncoding: undefined,
    contentLanguage: undefined,
    metadata: {},
    unsupportedProperties: ["source-http-metadata-unavailable-via-linked-cli"],
  };
}

function linkedCliStorageUrl(bucket, path = "") {
  const encodedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `ss:///${bucket}/${encodedPath}`;
}

function linkedCliPaths(stdout, bucket) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    stop("SOURCE_CLI_OUTPUT_INVALID", "Supabase CLI returned invalid JSON inventory output.");
  }
  const paths = parsed?.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    stop("SOURCE_CLI_OUTPUT_INVALID", "Supabase CLI returned an invalid path inventory.");
  }
  const prefixes = [`/${bucket}/`, `${bucket}/`];
  const result = new Set();
  for (const remotePath of paths) {
    const prefix = prefixes.find((candidate) => remotePath.startsWith(candidate));
    if (!prefix) {
      stop("SOURCE_CLI_OUTPUT_INVALID", "Supabase CLI returned a path outside the selected bucket.");
    }
    const path = validateObjectPath(remotePath.slice(prefix.length));
    if (result.has(path)) {
      stop("DUPLICATE_SOURCE_OBJECT", "Supabase CLI returned a duplicate object path.");
    }
    result.add(path);
  }
  return [...result].sort().map((path) => ({
    path,
    size: null,
    etag: "",
    properties: linkedCliProperties(),
  }));
}

async function hashLocalFile(file) {
  const state = { size: 0, hash: createHash("sha256") };
  try {
    for await (const chunk of createReadStream(file)) {
      state.size += chunk.byteLength;
      state.hash.update(chunk);
    }
  } catch {
    stop("SOURCE_STREAM_FAILED", "Could not hash a linked CLI source object.");
  }
  return { size: state.size, sha256: state.hash.digest("hex") };
}

export function createSupabaseLinkedCliSource({
  bucket,
  workdir,
  expectedProjectRef,
  runner = commandRunner,
  projectRefReader = (directory) =>
    readFile(join(directory, "supabase", ".temp", "project-ref"), "utf8"),
}) {
  const checkedBucket = validateBucketName(bucket);
  const checkedProjectRef = validateProjectRef(expectedProjectRef);
  const checkedWorkdir = resolve(
    required(
      workdir,
      "INVALID_CONFIGURATION",
      "A Supabase linked-project workdir is required.",
    ),
  );
  let readyPromise;

  async function run(args, code, message) {
    const result = await runner(args, { cwd: checkedWorkdir });
    if (result?.status !== 0 || result?.overflow) stop(code, message);
    return result;
  }

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const result = await run(
          ["--version"],
          "SOURCE_CLI_UNAVAILABLE",
          "Supabase CLI is unavailable or incompatible.",
        );
        const match = String(result.stdout).match(/(\d+)\.(\d+)\.(\d+)/u);
        const version = match?.slice(1).map(Number) ?? [];
        if (!versionAtLeast(version, MINIMUM_LINKED_CLI_VERSION)) {
          stop(
            "SOURCE_CLI_UNAVAILABLE",
            "Supabase CLI 2.105.0 or newer is required for linked Storage migration.",
          );
        }
        const linkedProjectRef = await externalOperation(
          "SOURCE_PROJECT_MISMATCH",
          "Could not verify the linked Supabase project identity.",
          () => projectRefReader(checkedWorkdir),
        );
        if (String(linkedProjectRef).trim() !== checkedProjectRef) {
          stop(
            "SOURCE_PROJECT_MISMATCH",
            "The linked Supabase project does not match the expected project ref.",
          );
        }
      })();
    }
    return readyPromise;
  }

  return {
    mode: SOURCE_LINKED_CLI,
    requiresFinalBodyVerification: true,
    async listInventory() {
      await ensureReady();
      const result = await run(
        [
          "storage",
          "ls",
          linkedCliStorageUrl(checkedBucket),
          "--recursive",
          "--linked",
          "--experimental",
          "--output-format",
          "json",
          "--workdir",
          checkedWorkdir,
        ],
        "SOURCE_LIST_FAILED",
        "Could not list the complete source bucket through linked Supabase CLI.",
      );
      return linkedCliPaths(result.stdout, checkedBucket);
    },
    async preflight() {
      await ensureReady();
    },
    async spool(entry, file) {
      await ensureReady();
      await run(
        [
          "storage",
          "cp",
          linkedCliStorageUrl(checkedBucket, entry.path),
          file,
          "--linked",
          "--experimental",
          "--output-format",
          "json",
          "--workdir",
          checkedWorkdir,
        ],
        "SOURCE_DOWNLOAD_FAILED",
        "Could not download a source object through linked Supabase CLI.",
      );
      const fileInfo = await externalOperation(
        "SOURCE_DOWNLOAD_FAILED",
        "Linked Supabase CLI did not produce the expected source object.",
        () => stat(file),
      );
      if (!fileInfo.isFile()) {
        stop("SOURCE_DOWNLOAD_FAILED", "Linked Supabase CLI produced an invalid source object.");
      }
      return {
        ...(await hashLocalFile(file)),
        properties: linkedCliProperties(),
      };
    },
  };
}

export async function listTargetPaths(container) {
  const paths = new Set();
  const iterator = container.listBlobsFlat();
  try {
    for await (const blob of iterator) {
      const path = validateObjectPath(blob?.name);
      if (paths.has(path)) {
        stop("DUPLICATE_TARGET_OBJECT", "Target inventory contains a duplicate object path.");
      }
      paths.add(path);
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    stop("TARGET_LIST_FAILED", "Could not list the complete Azure target container.");
  }
  return [...paths].sort();
}

function nodeReadable(body) {
  if (body instanceof Readable) return body;
  if (body && typeof body.pipe === "function") return body;
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  if (body && typeof body[Symbol.asyncIterator] === "function") return Readable.from(body);
  if (body instanceof Uint8Array || Buffer.isBuffer(body) || typeof body === "string") {
    return Readable.from([body]);
  }
  stop("INVALID_OBJECT_BODY", "Storage returned an unsupported object stream.");
}

function hashingTransform(state) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.size += bytes.byteLength;
      state.hash.update(bytes);
      callback(null, bytes);
    },
  });
}

function validateHeaderValue(value) {
  if (value == null) return undefined;
  const text = String(value);
  if (!SAFE_HTTP_HEADER_VALUE.test(text)) {
    stop("UNSUPPORTED_SOURCE_METADATA", "Source object contains unsupported HTTP metadata.");
  }
  return text;
}

export function normalizeMetadata(metadata) {
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(metadata ?? {})) {
    const key = String(rawKey).toLowerCase();
    if (!AZURE_METADATA_KEY.test(key) || Object.hasOwn(normalized, key)) {
      stop("UNSUPPORTED_SOURCE_METADATA", "Source object contains unsupported user metadata.");
    }
    normalized[key] = validateHeaderValue(rawValue) ?? "";
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function sourceProperties(response) {
  return {
    contentType: validateHeaderValue(response?.ContentType) || "application/octet-stream",
    cacheControl: validateHeaderValue(response?.CacheControl),
    contentDisposition: validateHeaderValue(response?.ContentDisposition),
    contentEncoding: validateHeaderValue(response?.ContentEncoding),
    contentLanguage: validateHeaderValue(response?.ContentLanguage),
    metadata: normalizeMetadata(response?.Metadata),
    unsupportedProperties: response?.Expires ? ["expires"] : [],
  };
}

function targetProperties(response) {
  return {
    contentType: response?.contentType || "application/octet-stream",
    cacheControl: response?.cacheControl || undefined,
    contentDisposition: response?.contentDisposition || undefined,
    contentEncoding: response?.contentEncoding || undefined,
    contentLanguage: response?.contentLanguage || undefined,
    metadata: normalizeMetadata(response?.metadata),
  };
}

function comparableProperties(properties) {
  return JSON.stringify({
    contentType: properties.contentType,
    cacheControl: properties.cacheControl ?? null,
    contentDisposition: properties.contentDisposition ?? null,
    contentEncoding: properties.contentEncoding ?? null,
    contentLanguage: properties.contentLanguage ?? null,
    metadata: properties.metadata,
  });
}

function azureUploadOptions(properties) {
  return {
    blobHTTPHeaders: {
      blobContentType: properties.contentType,
      blobCacheControl: properties.cacheControl,
      blobContentDisposition: properties.contentDisposition,
      blobContentEncoding: properties.contentEncoding,
      blobContentLanguage: properties.contentLanguage,
    },
    metadata: properties.metadata,
  };
}

async function spoolSourceObject({ s3, bucket, entry, file }) {
  const { GetObjectCommand } = await awsS3Module();
  let response;
  try {
    response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: entry.path,
        ...(entry.etag ? { IfMatch: entry.etag } : {}),
      }),
    );
  } catch (error) {
    if (isPreconditionFailed(error)) {
      stop("SOURCE_CHANGED", "A source object changed during migration.");
    }
    stop("SOURCE_DOWNLOAD_FAILED", "Could not download a source object.");
  }
  const state = { size: 0, hash: createHash("sha256") };
  await externalOperation(
    "SOURCE_STREAM_FAILED",
    "Could not stream a source object to bounded local storage.",
    () =>
      pipeline(
        nodeReadable(response?.Body),
        hashingTransform(state),
        createWriteStream(file, { flags: "wx", mode: 0o600 }),
      ),
  );
  if (state.size !== entry.size || (response?.ContentLength != null && state.size !== Number(response.ContentLength))) {
    stop("SOURCE_CHANGED", "A source object changed or was truncated during migration.");
  }
  const properties = sourceProperties(response);
  if (
    entry.properties &&
    (comparableProperties(properties) !== comparableProperties(entry.properties) ||
      JSON.stringify(properties.unsupportedProperties) !==
        JSON.stringify(entry.properties.unsupportedProperties))
  ) {
    stop("SOURCE_CHANGED", "Source object metadata changed during migration.");
  }
  return {
    size: state.size,
    sha256: state.hash.digest("hex"),
    properties,
  };
}

async function preflightSourceObjects(s3, bucket, inventory) {
  const { HeadObjectCommand } = await awsS3Module();
  for (const entry of inventory) {
    let response;
    try {
      response = await s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: entry.path,
          ...(entry.etag ? { IfMatch: entry.etag } : {}),
        }),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) {
        stop("SOURCE_CHANGED", "A source object changed before migration could start.");
      }
      stop(
        "SOURCE_PREFLIGHT_FAILED",
        "Could not inspect source object metadata before copying.",
      );
    }
    if (Number(response?.ContentLength) !== entry.size) {
      stop("SOURCE_CHANGED", "A source object changed before migration could start.");
    }
    entry.properties = sourceProperties(response);
  }
}

function createS3Source(s3, bucket) {
  if (!s3 || typeof s3.send !== "function") {
    stop("INVALID_CONFIGURATION", "A source adapter is required.");
  }
  return {
    mode: SOURCE_S3,
    requiresFinalBodyVerification: false,
    listInventory: () => listSourceInventory(s3, bucket),
    preflight: (inventory) => preflightSourceObjects(s3, bucket, inventory),
    spool: (entry, file) => spoolSourceObject({ s3, bucket, entry, file }),
  };
}

async function hashReadableBody(body, code, message, maxBytes = Infinity) {
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of nodeReadable(body)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) stop(code, message);
      hash.update(bytes);
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    stop(code, message);
  }
  return { size, sha256: hash.digest("hex") };
}

async function inspectTarget(blockBlob, expectedSize) {
  let properties;
  try {
    properties = await blockBlob.getProperties();
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    stop("TARGET_PROPERTIES_FAILED", "Could not inspect an Azure target object.");
  }
  const contentLength = Number(properties?.contentLength);
  if (contentLength !== expectedSize) {
    return {
      exists: true,
      size: contentLength,
      properties: targetProperties(properties),
    };
  }
  const download = await externalOperation(
    "TARGET_DOWNLOAD_FAILED",
    "Could not download an Azure target object for verification.",
    () => blockBlob.download(),
  );
  const digest = await hashReadableBody(
    download?.readableStreamBody,
    "TARGET_DOWNLOAD_FAILED",
    "Could not hash an Azure target object.",
  );
  return {
    exists: true,
    ...digest,
    properties: targetProperties(properties),
  };
}

async function uploadAndVerify({
  blockBlob,
  file,
  source,
  bufferBytes,
  maxConcurrency,
}) {
  await externalOperation(
    "TARGET_UPLOAD_FAILED",
    "Could not upload an object to Azure Blob Storage.",
    () =>
      blockBlob.uploadStream(
        createReadStream(file),
        bufferBytes,
        maxConcurrency,
        azureUploadOptions(source.properties),
      ),
  );
  const verified = await inspectTarget(blockBlob, source.size);
  if (
    !verified.exists ||
    verified.size !== source.size ||
    verified.sha256 !== source.sha256 ||
    comparableProperties(verified.properties) !== comparableProperties(source.properties)
  ) {
    stop("TARGET_VERIFY_FAILED", "Azure target verification failed after upload.");
  }
}

function inventoryMap(inventory) {
  return new Map(inventory.map((entry) => [entry.path, entry]));
}

function inventoryChanged(before, after) {
  if (before.length !== after.length) return true;
  const afterByPath = inventoryMap(after);
  return before.some((entry) => {
    const current = afterByPath.get(entry.path);
    return (
      !current ||
      current.size !== entry.size ||
      (entry.etag && current.etag && current.etag !== entry.etag)
    );
  });
}

function setDifference(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...left].filter((entry) => !rightSet.has(entry)).sort();
}

function deriveAppKey(secret) {
  return createHash("sha256").update(secret).digest();
}

export function decryptWithExactAppAlgorithm(value, secret) {
  if (!value || !value.startsWith(`${APP_ENCRYPTION_PREFIX}:`)) {
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke object is not app-encrypted.");
  }
  const parts = value.split(":");
  const [, , ivBase64, tagBase64, ...dataParts] = parts;
  const dataBase64 = dataParts.join(":");
  if (!ivBase64 || !tagBase64 || !dataBase64) {
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke test failed.");
  }
  const encrypted = Buffer.from(dataBase64, "base64");
  const variants = [
    { iv: Buffer.from(ivBase64, "base64"), tag: Buffer.from(tagBase64, "base64") },
    { iv: Buffer.from(tagBase64, "base64"), tag: Buffer.from(ivBase64, "base64") },
  ];
  for (const { iv, tag } of variants) {
    const authTagLength = APP_SUPPORTED_AUTH_TAG_LENGTHS.has(tag.length)
      ? tag.length
      : APP_AUTH_TAG_LENGTH;
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveAppKey(secret), iv, {
        authTagLength,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      // The second variant supports payloads emitted by the legacy tag/IV order.
    }
  }
  stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke test failed.");
}

async function boundedBuffer(body, maximumBytes) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of nodeReadable(body)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximumBytes) {
        stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke object exceeds its memory bound.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke test failed.");
  }
  return Buffer.concat(chunks, size);
}

async function runDecryptionSmoke(container, path, secret, maximumBytes) {
  const download = await externalOperation(
    "DECRYPTION_SMOKE_FAILED",
    "The decryption smoke test failed.",
    () => container.getBlockBlobClient(path).download(),
  );
  const encryptedBody = await boundedBuffer(download?.readableStreamBody, maximumBytes);
  const plainBase64 = decryptWithExactAppAlgorithm(encryptedBody.toString("utf8"), secret);
  if (!plainBase64 || plainBase64.length % 4 !== 0 || !BASE64.test(plainBase64)) {
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke payload is not valid file base64.");
  }
  if (!Buffer.from(plainBase64, "base64").byteLength) {
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke payload is empty.");
  }
}

async function writeManifestAtomic(file, manifest) {
  const destination = resolve(file);
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  await externalOperation(
    "MANIFEST_WRITE_FAILED",
    "Could not write the migration manifest.",
    async () => {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
    },
  );
}

export async function migrateAndVerify({
  s3,
  source,
  container,
  sourceBucket,
  targetContainer,
  allowedBuckets = new Set([sourceBucket]),
  dbReferences,
  mode,
  decryptionSmokePath,
  encryptionSecret,
  manifestFile,
  bufferBytes = DEFAULT_BUFFER_BYTES,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  smokeMaxBytes = DEFAULT_SMOKE_MAX_BYTES,
  clock = () => new Date(),
}) {
  const checkedMode = parseMode(mode);
  const checkedSourceBucket = validateBucketName(sourceBucket);
  const checkedTargetContainer = validateContainerName(targetContainer);
  const sourceAdapter = source ?? createS3Source(s3, checkedSourceBucket);
  if (!allowedBuckets.has(checkedSourceBucket)) {
    stop("BUCKET_NOT_ALLOWED", "The configured source bucket is not allowlisted.");
  }
  if (checkedSourceBucket !== checkedTargetContainer) {
    stop("BUCKET_CONTAINER_MISMATCH", "The target container must preserve the source bucket name.");
  }
  const references = [...new Set(dbReferences.map(validateObjectPath))].sort();
  const smokePath = validateObjectPath(decryptionSmokePath);
  if (!references.includes(smokePath)) {
    stop("DECRYPTION_SMOKE_FAILED", "The decryption smoke object must be DB-referenced.");
  }

  await externalOperation(
    "TARGET_ACCESS_FAILED",
    "The Azure target container is missing or inaccessible.",
    () => container.getProperties(),
  );

  const sourceBefore = await sourceAdapter.listInventory();
  const sourcePaths = sourceBefore.map((entry) => entry.path);
  const sourcePathSet = new Set(sourcePaths);
  const missingSourceReferences = references.filter((path) => !sourcePathSet.has(path));
  if (missingSourceReferences.length) {
    stop("MISSING_REFERENCED_SOURCE", "One or more DB-referenced objects are absent from the source bucket.");
  }
  const referenceSet = new Set(references);
  const orphanPaths = sourcePaths.filter((path) => !referenceSet.has(path));
  await sourceAdapter.preflight(sourceBefore);
  const targetBefore = await listTargetPaths(container);
  const targetExtrasBefore = setDifference(targetBefore, sourcePathSet);
  if (checkedMode === MODE_FINAL && targetExtrasBefore.length) {
    stop("EXTRA_TARGET_OBJECTS", "Final mode rejects Azure objects that are absent from the source inventory.");
  }

  const temporaryDirectory = await externalOperation(
    "TEMPORARY_STORAGE_FAILED",
    "Could not create bounded temporary storage for migration.",
    () => mkdtemp(join(tmpdir(), "anbud-blob-migration-")),
  );
  const objects = [];
  const sourcePropertiesByPath = new Map();
  let uploaded = 0;
  let skipped = 0;
  try {
    for (let index = 0; index < sourceBefore.length; index += 1) {
      const entry = sourceBefore[index];
      const temporaryFile = join(temporaryDirectory, `object-${String(index).padStart(8, "0")}`);
      const sourceObject = await sourceAdapter.spool(entry, temporaryFile);
      sourcePropertiesByPath.set(entry.path, sourceObject.properties);
      const blockBlob = container.getBlockBlobClient(entry.path);
      const target = await inspectTarget(blockBlob, sourceObject.size);
      const isIdentical =
        target.exists &&
        target.size === sourceObject.size &&
        target.sha256 === sourceObject.sha256 &&
        comparableProperties(target.properties) === comparableProperties(sourceObject.properties);
      if (isIdentical) {
        skipped += 1;
      } else {
        await uploadAndVerify({
          blockBlob,
          file: temporaryFile,
          source: sourceObject,
          bufferBytes,
          maxConcurrency,
        });
        uploaded += 1;
      }
      objects.push({
        path: entry.path,
        size: sourceObject.size,
        sha256: sourceObject.sha256,
        contentType: sourceObject.properties.contentType,
        cacheControl: sourceObject.properties.cacheControl ?? null,
        contentDisposition: sourceObject.properties.contentDisposition ?? null,
        contentEncoding: sourceObject.properties.contentEncoding ?? null,
        contentLanguage: sourceObject.properties.contentLanguage ?? null,
        metadata: sourceObject.properties.metadata,
        unsupportedSourceProperties: sourceObject.properties.unsupportedProperties,
      });
      await externalOperation(
        "TEMPORARY_STORAGE_FAILED",
        "Could not remove a completed temporary object.",
        () => rm(temporaryFile, { force: true }),
      );
    }

    const sourceAfter = await sourceAdapter.listInventory();
    if (inventoryChanged(sourceBefore, sourceAfter)) {
      stop("SOURCE_CHANGED", "The source inventory changed during migration; discard this run.");
    }
    if (checkedMode === MODE_FINAL && sourceAdapter.requiresFinalBodyVerification) {
      const objectByPath = new Map(objects.map((entry) => [entry.path, entry]));
      for (let index = 0; index < sourceAfter.length; index += 1) {
        const entry = sourceAfter[index];
        const temporaryFile = join(
          temporaryDirectory,
          `final-source-${String(index).padStart(8, "0")}`,
        );
        const current = await sourceAdapter.spool(entry, temporaryFile);
        const expected = objectByPath.get(entry.path);
        if (
          !expected ||
          current.size !== expected.size ||
          current.sha256 !== expected.sha256 ||
          comparableProperties(current.properties) !==
            comparableProperties(sourcePropertiesByPath.get(entry.path))
        ) {
          stop("SOURCE_CHANGED", "A linked CLI source object changed during final migration.");
        }
        await rm(temporaryFile, { force: true });
      }
    }

    const targetAfter = await listTargetPaths(container);
    const targetAfterSet = new Set(targetAfter);
    const missingTargetObjects = sourcePaths.filter((path) => !targetAfterSet.has(path));
    if (missingTargetObjects.length) {
      stop("MISSING_TARGET_OBJECTS", "Azure is missing one or more source objects after copy.");
    }
    const extraTargetObjects = setDifference(targetAfter, sourcePathSet);
    if (checkedMode === MODE_FINAL && extraTargetObjects.length) {
      stop("EXTRA_TARGET_OBJECTS", "Final mode requires an exact source/target object inventory.");
    }

    await runDecryptionSmoke(container, smokePath, encryptionSecret, smokeMaxBytes);
    const manifest = {
      version: 1,
      status: "verified",
      generatedAt: clock().toISOString(),
      mode: checkedMode,
      sourceMode: sourceAdapter.mode,
      sourceBucket: checkedSourceBucket,
      targetContainer: checkedTargetContainer,
      sourceObjectCount: objects.length,
      sourceBytes: objects.reduce((total, entry) => total + entry.size, 0),
      uploadedObjectCount: uploaded,
      resumedObjectCount: skipped,
      finalSourceBodyRecheck:
        checkedMode === MODE_FINAL && sourceAdapter.requiresFinalBodyVerification,
      databaseReferenceReport: {
        referencedObjectCount: references.length,
        missingSourcePaths: [],
        orphanObjectCount: orphanPaths.length,
        orphanPaths,
      },
      targetInventoryReport: {
        missingObjectCount: 0,
        extraObjectCount: extraTargetObjects.length,
        extraPaths: extraTargetObjects,
        exactMatchRequired: checkedMode === MODE_FINAL,
      },
      decryptionSmoke: { status: "passed" },
      objects,
    };
    if (manifestFile) await writeManifestAtomic(manifestFile, manifest);
    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function clientConfiguration(configuration) {
  let s3;
  let source;
  if (configuration.source.mode === SOURCE_LINKED_CLI) {
    source = createSupabaseLinkedCliSource({
      bucket: configuration.source.bucket,
      workdir: configuration.source.workdir,
      expectedProjectRef: configuration.source.expectedProjectRef,
    });
  } else {
    const { S3Client } = await awsS3Module();
    s3 = new S3Client({
      forcePathStyle: true,
      region: configuration.source.region,
      endpoint: configuration.source.endpoint,
      credentials: {
        accessKeyId: configuration.source.accessKeyId,
        secretAccessKey: configuration.source.secretAccessKey,
      },
    });
    source = createS3Source(s3, configuration.source.bucket);
  }
  const credential = new DefaultAzureCredential();
  const container = configuration.azure.containerUrl
    ? new ContainerClient(configuration.azure.containerUrl, credential)
    : new BlobServiceClient(configuration.azure.accountUrl, credential).getContainerClient(
        configuration.azure.containerName,
      );
  return { s3, source, container };
}

function helpText() {
  return [
    "Usage: node scripts/azure_blob_migrate_verify.mjs --mode=pre-copy|final",
    "",
    "pre-copy copies/verifies every source object and reports, but permits, stale Azure extras.",
    "final copies/verifies the final delta and requires exact source/Azure inventories.",
    "SOURCE_STORAGE_MODE=supabase-linked-cli is preferred; supabase-s3 is the full-access fallback.",
    "All endpoints, credentials, buckets, references, manifest and smoke settings are env-only.",
  ].join("\n");
}

export async function runCli(environment = process.env, argv = process.argv.slice(2)) {
  const configuration = configurationFromEnvironment(environment, argv);
  if (configuration.help) return { help: helpText() };
  const dbReferences = await readDatabaseReferences(
    configuration.referencesFile,
    configuration.source.bucket,
    configuration.allowedBuckets,
  );
  const { s3, source, container } = await clientConfiguration(configuration);
  try {
    const manifest = await migrateAndVerify({
      source,
      container,
      sourceBucket: configuration.source.bucket,
      targetContainer: configuration.azure.containerName,
      allowedBuckets: configuration.allowedBuckets,
      dbReferences,
      mode: configuration.mode,
      decryptionSmokePath: configuration.decryptionSmokePath,
      encryptionSecret: configuration.encryptionSecret,
      manifestFile: configuration.manifestFile,
      bufferBytes: configuration.bufferBytes,
      maxConcurrency: configuration.maxConcurrency,
      smokeMaxBytes: configuration.smokeMaxBytes,
    });
    return {
      status: manifest.status,
      mode: manifest.mode,
      sourceObjectCount: manifest.sourceObjectCount,
      sourceBytes: manifest.sourceBytes,
      uploadedObjectCount: manifest.uploadedObjectCount,
      resumedObjectCount: manifest.resumedObjectCount,
      orphanObjectCount: manifest.databaseReferenceReport.orphanObjectCount,
      extraTargetObjectCount: manifest.targetInventoryReport.extraObjectCount,
    };
  } finally {
    s3?.destroy?.();
  }
}

function safeFailure(error) {
  if (error instanceof MigrationError) {
    return { status: "failed", code: error.code, message: error.message };
  }
  return {
    status: "failed",
    code: "UNEXPECTED_FAILURE",
    message: "The migration failed without exposing provider details.",
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli()
    .then((result) => {
      if (result.help) console.log(result.help);
      else console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(JSON.stringify(safeFailure(error)));
      process.exitCode = 1;
    });
}
