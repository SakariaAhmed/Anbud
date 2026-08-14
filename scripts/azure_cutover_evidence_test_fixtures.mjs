import { createHash } from "node:crypto";

import {
  CUTOVER_ARTIFACTS,
  CUTOVER_EVIDENCE_VERSION,
  EXPECTED_PUBLIC_TABLES,
} from "../apps/frontend/scripts/run_azure_migration_control.mjs";

export const FIXTURE_TIME = "2026-08-14T12:00:00.000Z";
export const FIXTURE_FROZEN_AT = "2026-08-14T11:50:00.000Z";
export const FIXTURE_ARTIFACT_TIME = "2026-08-14T11:55:00.000Z";
export const FIXTURE_EVIDENCE_TIME = "2026-08-14T11:58:00.000Z";
export const FIXTURE_PREFIX = "cutovers/final-20260814-115500-abcdef/artifacts";

function securityDefiner(name, overrides = {}) {
  return {
    name,
    arguments: "",
    owner: "postgres",
    language: "plpgsql",
    result: "trigger",
    source_sha256: "1".repeat(64),
    settings: ['search_path=""'],
    public_execute: false,
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
    ...overrides,
  };
}

export function validPreflightReport(overrides = {}) {
  return {
    status: "ready-for-database-validation-dump",
    source: {
      postgres_major: 17,
      public_tables: [...EXPECTED_PUBLIC_TABLES],
      rls_disabled_tables: [],
      database_bytes: 16 * 1024 * 1024,
      database_collation: "en_US.UTF-8",
      database_ctype: "en_US.UTF-8",
      database_encoding: "UTF8",
      database_locale_provider: "i",
      database_locale: "en-US",
      database_icu_rules: null,
      database_collation_version: "153.120",
      migrations: ["20260814115500"],
      running_jobs: 0,
      security_definers: [
        securityDefiner("audit_project_job_terminal_state"),
        securityDefiner("rls_auto_enable", {
          result: "event_trigger",
          source_sha256:
            "2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1",
          settings: ["search_path=pg_catalog"],
        }),
        securityDefiner("sync_project_owner_membership"),
      ],
    },
    target_storage_gib: 32,
    note: "Database gate; Blob verification is separate.",
    failures: [],
    ...overrides,
  };
}

function inventoryCounts(functions) {
  return {
    tables: EXPECTED_PUBLIC_TABLES.length,
    sequences: 1,
    extensions: 2,
    functions,
    indexes: 45,
    constraints: 61,
    triggers: 5,
    policies: 31,
  };
}

export function validDatabaseComparisonReport(overrides = {}) {
  return {
    status: "verified",
    postgres_major: 17,
    snapshot: {
      source: "management-api-read-only-explicitly-frozen-source",
      target: "repeatable-read-read-only",
    },
    inventory_counts: {
      source: inventoryCounts(11),
      target: inventoryCounts(10),
    },
    tables: EXPECTED_PUBLIC_TABLES.map((table) => ({
      table,
      source_rows: 0,
      target_rows: 0,
      count_match: true,
      content_match: true,
    })),
    sequences: [{ sequence: "projects_id_seq", state_match: true }],
    failures: [],
    source_mode: "supabase-linked",
    source_frozen_attested: true,
    test_only_insecure_transport: false,
    ...overrides,
  };
}

export function validBlobManifest(overrides = {}) {
  return {
    version: 1,
    status: "verified",
    generatedAt: FIXTURE_ARTIFACT_TIME,
    mode: "final",
    sourceMode: "supabase-linked-cli",
    sourceBucket: "anbud-documents",
    targetContainer: "anbud-documents",
    sourceObjectCount: 1,
    sourceBytes: 12,
    uploadedObjectCount: 1,
    resumedObjectCount: 0,
    finalSourceBodyRecheck: true,
    databaseReferenceReport: {
      referencedObjectCount: 1,
      missingSourcePaths: [],
      orphanObjectCount: 0,
      orphanPaths: [],
    },
    targetInventoryReport: {
      missingObjectCount: 0,
      extraObjectCount: 0,
      extraPaths: [],
      exactMatchRequired: true,
    },
    decryptionSmoke: { status: "passed" },
    objects: [
      {
        path: "documents/encrypted.bin",
        size: 12,
        sha256: "2".repeat(64),
        contentType: "application/octet-stream",
        cacheControl: null,
        contentDisposition: null,
        contentEncoding: null,
        contentLanguage: null,
        metadata: {},
        unsupportedSourceProperties: [
          "source-http-metadata-unavailable-via-linked-cli",
        ],
      },
    ],
    ...overrides,
  };
}

export function validArtifactPayloads(overrides = {}) {
  return {
    preflight: Buffer.from(`${JSON.stringify(validPreflightReport())}\n`),
    databaseComparison: Buffer.from(
      `${JSON.stringify(validDatabaseComparisonReport())}\n`,
    ),
    blobManifest: Buffer.from(`${JSON.stringify(validBlobManifest())}\n`),
    databaseDump: Buffer.from("PGDMP synthetic PostgreSQL 17 custom dump\n"),
    originalToc: Buffer.from(
      "1; TABLE DATA public projects postgres\n2; FUNCTION public rls_auto_enable() postgres\n",
    ),
    sanitizedToc: Buffer.from("1; TABLE DATA public projects postgres\n"),
    restoreLog: Buffer.from("pg_restore completed with zero errors\n"),
    verifyLog: Buffer.from("bootstrap and verify completed with zero errors\n"),
    ...overrides,
  };
}

export function validEvidenceBundle(overrides = {}) {
  const payloads = validArtifactPayloads(overrides.payloads);
  const artifacts = Object.fromEntries(
    Object.keys(CUTOVER_ARTIFACTS).map((key) => [
      key,
      {
        kind: CUTOVER_ARTIFACTS[key].kind,
        blobPath: `${FIXTURE_PREFIX}/${CUTOVER_ARTIFACTS[key].filename}`,
        size: payloads[key].byteLength,
        sha256: createHash("sha256").update(payloads[key]).digest("hex"),
        generatedAt: FIXTURE_ARTIFACT_TIME,
      },
    ]),
  );
  const envelope = {
    version: CUTOVER_EVIDENCE_VERSION,
    generatedAt: FIXTURE_EVIDENCE_TIME,
    source: {
      frozen: true,
      claimsEnabled: false,
      runningJobs: 0,
      frozenAt: FIXTURE_FROZEN_AT,
    },
    artifactPrefix: FIXTURE_PREFIX,
    artifacts,
    ...overrides.envelope,
  };
  const envelopeBytes = Buffer.from(JSON.stringify(envelope));
  return {
    payloads,
    envelope,
    envelopeBytes,
    envelopeSha256: createHash("sha256").update(envelopeBytes).digest("hex"),
  };
}
