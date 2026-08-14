#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CUTOVER_ARTIFACTS,
  CUTOVER_EVIDENCE_VERSION,
  parseEvidenceTimestamp,
  validateBlobFinalManifest,
  validateDatabaseComparisonReport,
  validateFrozenPreflightReport,
} from "../apps/frontend/scripts/run_azure_migration_control.mjs";

const DEFAULT_MAX_AGE_SECONDS = 7_200;
const JSON_ARTIFACTS = new Set(["preflight", "databaseComparison", "blobManifest"]);

export class CutoverEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "CutoverEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new CutoverEvidenceError(code);
}

function required(value, code) {
  const normalized = value?.trim();
  if (!normalized) fail(code);
  return normalized;
}

function validArtifactPrefix(value) {
  const parts = value.split("/");
  return (
    value.length <= 512 &&
    parts.length === 3 &&
    parts[0] === "cutovers" &&
    parts[2] === "artifacts" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/u.test(parts[1])
  );
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("cutover_artifact_json_invalid");
  }
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

async function inspectLocalArtifact(file, maximumBytes, includeBytes) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch {
    fail("cutover_artifact_open_failed");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      fail("cutover_artifact_size_invalid");
    }
    const hash = createHash("sha256");
    const chunks = includeBytes ? [] : undefined;
    const prefix = Buffer.alloc(5);
    let prefixBytes = 0;
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximumBytes) fail("cutover_artifact_size_invalid");
      hash.update(bytes);
      if (chunks) chunks.push(bytes);
      if (prefixBytes < prefix.byteLength) {
        const copied = bytes.copy(
          prefix,
          prefixBytes,
          0,
          Math.min(bytes.byteLength, prefix.byteLength - prefixBytes),
        );
        prefixBytes += copied;
      }
    }
    const after = await handle.stat();
    if (size !== before.size || !sameFile(before, after)) {
      fail("cutover_artifact_changed_during_read");
    }
    return {
      size,
      sha256: hash.digest("hex"),
      modifiedAt: new Date(before.mtimeMs).toISOString(),
      prefix: prefix.subarray(0, prefixBytes),
      bytes: chunks ? Buffer.concat(chunks, size) : undefined,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function validateFresh(value, now, maxAgeMilliseconds, code) {
  let timestamp;
  try {
    timestamp = parseEvidenceTimestamp(value, code);
  } catch {
    fail(code);
  }
  if (timestamp > now + 60_000 || now - timestamp > maxAgeMilliseconds) fail(code);
  return timestamp;
}

export async function composeCutoverEvidence({
  artifactFiles,
  artifactPrefix,
  sourceFrozenAt,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  clock = () => new Date(),
}) {
  const artifactKeys = Object.keys(CUTOVER_ARTIFACTS);
  if (!exactKeys(artifactFiles, artifactKeys)) fail("cutover_artifact_files_invalid");
  if (!validArtifactPrefix(artifactPrefix)) fail("cutover_artifact_prefix_invalid");
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 300 || maxAgeSeconds > 86_400) {
    fail("cutover_evidence_max_age_invalid");
  }
  const now = clock().getTime();
  if (!Number.isFinite(now)) fail("cutover_evidence_clock_invalid");
  const maxAgeMilliseconds = maxAgeSeconds * 1_000;
  const frozenAt = validateFresh(
    sourceFrozenAt,
    now,
    maxAgeMilliseconds,
    "cutover_source_freeze_invalid",
  );

  const artifacts = {};
  const localPaths = new Set();
  for (const artifactKey of artifactKeys) {
    const localPath = resolve(required(artifactFiles[artifactKey], "cutover_artifact_file_missing"));
    if (localPaths.has(localPath)) fail("cutover_artifact_file_reused");
    localPaths.add(localPath);
    const inspected = await inspectLocalArtifact(
      localPath,
      CUTOVER_ARTIFACTS[artifactKey].maxBytes,
      JSON_ARTIFACTS.has(artifactKey),
    );
    const modifiedAt = validateFresh(
      inspected.modifiedAt,
      now,
      maxAgeMilliseconds,
      "cutover_artifact_stale",
    );
    if (modifiedAt < frozenAt) fail("cutover_artifact_predates_freeze");
    if (
      artifactKey === "databaseDump" &&
      inspected.prefix.toString("ascii") !== "PGDMP"
    ) {
      fail("cutover_database_dump_invalid");
    }

    let generatedAt = inspected.modifiedAt;
    if (artifactKey === "preflight") {
      validateFrozenPreflightReport(parseJson(inspected.bytes));
    } else if (artifactKey === "databaseComparison") {
      validateDatabaseComparisonReport(parseJson(inspected.bytes));
    } else if (artifactKey === "blobManifest") {
      const manifest = validateBlobFinalManifest(parseJson(inspected.bytes));
      const manifestTimestamp = validateFresh(
        manifest.generatedAt,
        now,
        maxAgeMilliseconds,
        "cutover_blob_manifest_stale",
      );
      if (manifestTimestamp < frozenAt) fail("cutover_artifact_predates_freeze");
      generatedAt = manifest.generatedAt;
    }
    artifacts[artifactKey] = {
      kind: CUTOVER_ARTIFACTS[artifactKey].kind,
      blobPath: `${artifactPrefix}/${CUTOVER_ARTIFACTS[artifactKey].filename}`,
      size: inspected.size,
      sha256: inspected.sha256,
      generatedAt,
    };
  }
  if (artifacts.originalToc.sha256 === artifacts.sanitizedToc.sha256) {
    fail("cutover_toc_not_sanitized");
  }
  const artifactTime = (key) => Date.parse(artifacts[key].generatedAt);
  if (
    artifactTime("sanitizedToc") < artifactTime("originalToc") ||
    artifactTime("restoreLog") < artifactTime("databaseDump") ||
    artifactTime("restoreLog") < artifactTime("sanitizedToc") ||
    artifactTime("verifyLog") < artifactTime("restoreLog") ||
    artifactTime("databaseComparison") < artifactTime("verifyLog")
  ) {
    fail("cutover_artifact_order_invalid");
  }

  return {
    version: CUTOVER_EVIDENCE_VERSION,
    generatedAt: new Date(now).toISOString(),
    source: {
      frozen: true,
      claimsEnabled: false,
      runningJobs: 0,
      frozenAt: new Date(frozenAt).toISOString(),
    },
    artifactPrefix,
    artifacts,
  };
}

function configuration(environment) {
  const artifactFiles = {
    preflight: required(environment.AZURE_CUTOVER_PREFLIGHT_FILE, "cutover_preflight_file_missing"),
    databaseComparison: required(
      environment.AZURE_CUTOVER_DATABASE_COMPARISON_FILE,
      "cutover_database_comparison_file_missing",
    ),
    blobManifest: required(
      environment.AZURE_CUTOVER_BLOB_MANIFEST_FILE,
      "cutover_blob_manifest_file_missing",
    ),
    databaseDump: required(
      environment.AZURE_CUTOVER_DATABASE_DUMP_FILE,
      "cutover_database_dump_file_missing",
    ),
    originalToc: required(
      environment.AZURE_CUTOVER_ORIGINAL_TOC_FILE,
      "cutover_original_toc_file_missing",
    ),
    sanitizedToc: required(
      environment.AZURE_CUTOVER_SANITIZED_TOC_FILE,
      "cutover_sanitized_toc_file_missing",
    ),
    restoreLog: required(
      environment.AZURE_CUTOVER_RESTORE_LOG_FILE,
      "cutover_restore_log_file_missing",
    ),
    verifyLog: required(
      environment.AZURE_CUTOVER_VERIFY_LOG_FILE,
      "cutover_verify_log_file_missing",
    ),
  };
  const maxAgeSeconds = Number(
    environment.MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS || DEFAULT_MAX_AGE_SECONDS,
  );
  return {
    artifactFiles,
    artifactPrefix: required(
      environment.AZURE_CUTOVER_ARTIFACT_BLOB_PREFIX,
      "cutover_artifact_prefix_missing",
    ),
    sourceFrozenAt: required(
      environment.AZURE_CUTOVER_SOURCE_FROZEN_AT,
      "cutover_source_freeze_missing",
    ),
    maxAgeSeconds,
    outputFile: resolve(
      required(
        environment.AZURE_CUTOVER_EVIDENCE_OUTPUT_FILE,
        "cutover_evidence_output_missing",
      ),
    ),
  };
}

async function writeAtomic(file, bytes) {
  const temporary = resolve(
    dirname(file),
    `.${basename(file)}.${randomBytes(10).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    fail("cutover_evidence_write_failed");
  }
}

export async function runCli({ environment = process.env, clock = () => new Date() } = {}) {
  try {
    const config = configuration(environment);
    const outputPath = resolve(config.outputFile);
    if (Object.values(config.artifactFiles).map((value) => resolve(value)).includes(outputPath)) {
      fail("cutover_evidence_output_overlaps_input");
    }
    const evidence = await composeCutoverEvidence({ ...config, clock });
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await writeAtomic(outputPath, bytes);
    process.stdout.write(
      `${JSON.stringify({
        status: "composed",
        version: evidence.version,
        generatedAt: evidence.generatedAt,
        artifactCount: Object.keys(evidence.artifacts).length,
        evidenceSize: bytes.byteLength,
        evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        status: "stop",
        code: error?.code || error?.message || "cutover_evidence_composition_failed",
      })}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
