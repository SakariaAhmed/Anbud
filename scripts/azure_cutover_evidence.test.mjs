import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CutoverEvidenceError,
  composeCutoverEvidence,
  runCli,
} from "./azure_cutover_evidence.mjs";
import {
  FIXTURE_ARTIFACT_TIME,
  FIXTURE_FROZEN_AT,
  FIXTURE_PREFIX,
  FIXTURE_TIME,
  validArtifactPayloads,
  validBlobManifest,
} from "./azure_cutover_evidence_test_fixtures.mjs";

const FILES = Object.freeze({
  preflight: "preflight.json",
  databaseComparison: "comparison.json",
  blobManifest: "blob.json",
  databaseDump: "database.dump",
  originalToc: "original.list",
  sanitizedToc: "sanitized.list",
  restoreLog: "restore.log",
  verifyLog: "verify.log",
});
const clock = () => new Date(FIXTURE_TIME);

async function fixtureDirectory(payloadOverrides = {}, modifiedAt = FIXTURE_ARTIFACT_TIME) {
  const directory = await mkdtemp(join(tmpdir(), "anbud-evidence-v2-test-"));
  const payloads = validArtifactPayloads(payloadOverrides);
  const artifactFiles = {};
  for (const [key, name] of Object.entries(FILES)) {
    const file = join(directory, name);
    await writeFile(file, payloads[key], { mode: 0o600 });
    await utimes(file, new Date(modifiedAt), new Date(modifiedAt));
    artifactFiles[key] = file;
  }
  return { directory, payloads, artifactFiles };
}

async function withFixture(callback, ...arguments_) {
  const fixture = await fixtureDirectory(...arguments_);
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("composer emits only a fresh v2 envelope with unique hash-bound private artifacts", async () => {
  await withFixture(async ({ artifactFiles, payloads }) => {
    const evidence = await composeCutoverEvidence({
      artifactFiles,
      artifactPrefix: FIXTURE_PREFIX,
      sourceFrozenAt: FIXTURE_FROZEN_AT,
      clock,
    });
    assert.equal(evidence.version, "azure-final-cutover-evidence-v2");
    assert.equal(evidence.generatedAt, FIXTURE_TIME);
    assert.deepEqual(Object.keys(evidence.artifacts), Object.keys(FILES));
    assert.equal("database" in evidence, false);
    assert.equal("blob" in evidence, false);
    assert.equal(JSON.stringify(evidence).includes("objects"), false);
    const paths = Object.values(evidence.artifacts).map(({ blobPath }) => blobPath);
    assert.equal(new Set(paths).size, paths.length);
    for (const [key, descriptor] of Object.entries(evidence.artifacts)) {
      assert.ok(descriptor.blobPath.startsWith(`${FIXTURE_PREFIX}/`));
      assert.equal(descriptor.size, payloads[key].byteLength);
      assert.equal(
        descriptor.sha256,
        createHash("sha256").update(payloads[key]).digest("hex"),
      );
    }
  });
});

test("composer rejects stale artifacts and artifacts produced before the freeze", async () => {
  await withFixture(
    async ({ artifactFiles }) => {
      await assert.rejects(
        composeCutoverEvidence({
          artifactFiles,
          artifactPrefix: FIXTURE_PREFIX,
          sourceFrozenAt: FIXTURE_FROZEN_AT,
          clock,
        }),
        CutoverEvidenceError,
      );
    },
    {},
    "2026-08-14T08:00:00.000Z",
  );
  await withFixture(
    async ({ artifactFiles }) => {
      await assert.rejects(
        composeCutoverEvidence({
          artifactFiles,
          artifactPrefix: FIXTURE_PREFIX,
          sourceFrozenAt: FIXTURE_FROZEN_AT,
          clock,
        }),
        /cutover_artifact_predates_freeze/u,
      );
    },
    {},
    "2026-08-14T11:45:00.000Z",
  );
});

test("composer rejects minimal, fake, and internally mismatched reports", async () => {
  for (const overrides of [
    { preflight: Buffer.from('{"status":"ready-for-database-validation-dump"}') },
    { databaseComparison: Buffer.from('{"status":"verified","tables":[]}') },
    {
      blobManifest: Buffer.from(
        JSON.stringify(
          validBlobManifest({
            sourceBytes: 13,
          }),
        ),
      ),
    },
    {
      blobManifest: Buffer.from(
        JSON.stringify(
          validBlobManifest({
            finalSourceBodyRecheck: false,
          }),
        ),
      ),
    },
    { databaseDump: Buffer.from("not-a-postgresql-custom-dump") },
  ]) {
    await withFixture(async ({ artifactFiles }) => {
      await assert.rejects(
        composeCutoverEvidence({
          artifactFiles,
          artifactPrefix: FIXTURE_PREFIX,
          sourceFrozenAt: FIXTURE_FROZEN_AT,
          clock,
        }),
      );
    }, overrides);
  }
});

test("composer rejects an oversized report before parsing it", async () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
  await withFixture(async ({ artifactFiles }) => {
    await assert.rejects(
      composeCutoverEvidence({
        artifactFiles,
        artifactPrefix: FIXTURE_PREFIX,
        sourceFrozenAt: FIXTURE_FROZEN_AT,
        clock,
      }),
      /cutover_artifact_size_invalid/u,
    );
  }, { preflight: oversized });
});

test("CLI writes the pinned envelope atomically without printing reports or row data", async () => {
  await withFixture(async ({ directory, artifactFiles }) => {
    const output = join(directory, "evidence-v2.json");
    const environment = {
      AZURE_CUTOVER_PREFLIGHT_FILE: artifactFiles.preflight,
      AZURE_CUTOVER_DATABASE_COMPARISON_FILE: artifactFiles.databaseComparison,
      AZURE_CUTOVER_BLOB_MANIFEST_FILE: artifactFiles.blobManifest,
      AZURE_CUTOVER_DATABASE_DUMP_FILE: artifactFiles.databaseDump,
      AZURE_CUTOVER_ORIGINAL_TOC_FILE: artifactFiles.originalToc,
      AZURE_CUTOVER_SANITIZED_TOC_FILE: artifactFiles.sanitizedToc,
      AZURE_CUTOVER_RESTORE_LOG_FILE: artifactFiles.restoreLog,
      AZURE_CUTOVER_VERIFY_LOG_FILE: artifactFiles.verifyLog,
      AZURE_CUTOVER_ARTIFACT_BLOB_PREFIX: FIXTURE_PREFIX,
      AZURE_CUTOVER_SOURCE_FROZEN_AT: FIXTURE_FROZEN_AT,
      AZURE_CUTOVER_EVIDENCE_OUTPUT_FILE: output,
    };
    const originalWrite = process.stdout.write;
    const writes = [];
    process.stdout.write = (value) => {
      writes.push(String(value));
      return true;
    };
    try {
      assert.equal(await runCli({ environment, clock }), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    const evidence = JSON.parse(await readFile(output, "utf8"));
    assert.equal(evidence.version, "azure-final-cutover-evidence-v2");
    assert.doesNotMatch(writes.join(""), /public_tables|objects|source_rows/u);
  });
});
