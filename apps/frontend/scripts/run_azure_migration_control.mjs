#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const REQUIRED_PROJECT_JOB_COLUMNS = [
  "input_json",
  "locked_at",
  "lease_token",
  "started_at",
  "completed_at",
  "terminal_metadata",
  "parent_job_id",
  "idempotency_key",
];

const REQUIRED_PREFLIGHTS = new Map([
  ["project_job_fencing_preflight", "authoritative-lease-fencing-v1"],
  [
    "project_job_terminal_audit_preflight",
    "transactional-project-job-terminal-audit-v2",
  ],
  [
    "stable_main_rollback_bridge_preflight",
    "stable-main-rollback-bridge-v1",
  ],
  [
    "atomic_service_document_write_preflight",
    "atomic-service-document-write-v1",
  ],
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EVIDENCE_MAX_AGE_SECONDS = 7_200;
const MAX_EVIDENCE_BYTES = 256 * 1024;
export const CUTOVER_EVIDENCE_VERSION = "azure-final-cutover-evidence-v2";
const PROJECT_JOB_CUTOVER_VERSION = "project-job-cutover-v1";
const DATABASE_REFERENCE_BINDING_VERSION =
  "anbud-database-storage-references-v1";
const DATABASE_REFERENCE_PAGE_SIZE = 1_000;
const MAX_DATABASE_REFERENCE_ROWS = 1_000_000;

export const EXPECTED_PUBLIC_TABLES = Object.freeze([
  "activity_events",
  "app_group_members",
  "app_groups",
  "app_principal_aliases",
  "app_principal_roles",
  "app_principals",
  "app_rate_limits",
  "app_sessions",
  "artifact_source_state",
  "audit_events",
  "chat_messages",
  "chat_sessions",
  "customer_analyses",
  "document_chunks",
  "document_intelligence_artifacts",
  "document_intelligence_events",
  "documents",
  "executive_summaries",
  "generated_artifacts",
  "guest_credentials",
  "project_group_grants",
  "project_job_claim_control",
  "project_jobs",
  "project_memberships",
  "project_service_selections",
  "projects",
  "service_descriptions",
  "service_documents",
  "solution_evaluations",
  "stable_customer_analysis_context_sync",
  "stable_primary_document_authority",
]);

export const CUTOVER_ARTIFACTS = Object.freeze({
  preflight: Object.freeze({
    kind: "frozen-preflight",
    filename: "frozen-preflight.json",
    maxBytes: 2 * 1024 * 1024,
  }),
  databaseComparison: Object.freeze({
    kind: "database-comparison",
    filename: "database-comparison.json",
    maxBytes: 8 * 1024 * 1024,
  }),
  blobManifest: Object.freeze({
    kind: "blob-final-manifest",
    filename: "blob-final-manifest.json",
    maxBytes: 64 * 1024 * 1024,
  }),
  databaseDump: Object.freeze({
    kind: "database-dump",
    filename: "database.dump",
    maxBytes: 64 * 1024 * 1024,
  }),
  originalToc: Object.freeze({
    kind: "original-toc",
    filename: "database-toc-original.list",
    maxBytes: 8 * 1024 * 1024,
  }),
  sanitizedToc: Object.freeze({
    kind: "sanitized-toc",
    filename: "database-toc-sanitized.list",
    maxBytes: 8 * 1024 * 1024,
  }),
  restoreLog: Object.freeze({
    kind: "restore-log",
    filename: "restore.log",
    maxBytes: 16 * 1024 * 1024,
  }),
  verifyLog: Object.freeze({
    kind: "verify-log",
    filename: "verify.log",
    maxBytes: 16 * 1024 * 1024,
  }),
});
const CUTOVER_ARTIFACT_KEYS = Object.freeze(Object.keys(CUTOVER_ARTIFACTS));
const MAX_TOTAL_ARTIFACT_BYTES = Object.values(CUTOVER_ARTIFACTS).reduce(
  (sum, value) => sum + value.maxBytes,
  0,
);
const INVENTORY_COUNT_KEYS = Object.freeze([
  "tables",
  "sequences",
  "extensions",
  "functions",
  "indexes",
  "constraints",
  "triggers",
  "policies",
]);

export class MigrationControlError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationControlError";
    this.code = code;
  }
}

function fail(code) {
  throw new MigrationControlError(code);
}

function required(value, code) {
  const normalized = value?.trim();
  if (!normalized) fail(code);
  return normalized;
}

function validBlobPath(value) {
  if (
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f?#]/u.test(value) ||
    /%(?:2f|5c)/iu.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(segment),
  );
}

function validManifestObjectPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\p{Cc}\p{Cf}]/u.test(value) &&
    !/%(?:00|2e|2f|5c)/iu.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

export function createDatabaseReferenceBinding(entries, expectedContainer) {
  if (!Array.isArray(entries)) fail("database_reference_inventory_invalid");
  const unique = new Map();
  for (const entry of entries) {
    if (
      !exactKeys(entry, ["bucket", "path"]) ||
      typeof entry.bucket !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(entry.bucket) ||
      (expectedContainer && entry.bucket !== expectedContainer) ||
      !validManifestObjectPath(entry.path)
    ) {
      fail("database_reference_inventory_invalid");
    }
    unique.set(`${entry.bucket}\u0000${entry.path}`, entry);
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const leftKey = `${left.bucket}\u0000${left.path}`;
    const rightKey = `${right.bucket}\u0000${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, DATABASE_REFERENCE_BINDING_VERSION);
  for (const entry of sorted) {
    updateLengthPrefixed(hash, entry.bucket);
    updateLengthPrefixed(hash, entry.path);
  }
  return {
    version: DATABASE_REFERENCE_BINDING_VERSION,
    count: sorted.length,
    sha256: hash.digest("hex"),
  };
}

function validArtifactPrefix(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return (
    value.length <= 512 &&
    parts.length === 3 &&
    parts[0] === "cutovers" &&
    parts[2] === "artifacts" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/u.test(parts[1])
  );
}

export function validateMigrationControlConfiguration(environment = process.env) {
  const dataApiUrl = new URL(
    required(environment.DATA_API_URL, "data_api_url_missing"),
  );
  const allowedHostSuffix = required(
    environment.DATA_API_ALLOWED_HOST_SUFFIX,
    "data_api_host_boundary_missing",
  ).toLowerCase();
  if (
    dataApiUrl.protocol !== "https:" ||
    dataApiUrl.username ||
    dataApiUrl.password ||
    dataApiUrl.search ||
    dataApiUrl.hash ||
    !["", "/"].includes(dataApiUrl.pathname) ||
    !/^\.internal\.[a-z0-9.-]+$/u.test(allowedHostSuffix) ||
    !dataApiUrl.hostname.toLowerCase().endsWith(allowedHostSuffix) ||
    dataApiUrl.hostname.length <= allowedHostSuffix.length
  ) {
    fail("data_api_host_boundary_invalid");
  }

  const storageAccountUrl = new URL(
    required(
      environment.AZURE_STORAGE_ACCOUNT_URL,
      "storage_account_url_missing",
    ),
  );
  if (
    storageAccountUrl.protocol !== "https:" ||
    storageAccountUrl.username ||
    storageAccountUrl.password ||
    storageAccountUrl.search ||
    storageAccountUrl.hash ||
    !["", "/"].includes(storageAccountUrl.pathname) ||
    !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(
      storageAccountUrl.hostname,
    )
  ) {
    fail("storage_account_url_invalid");
  }

  const storageContainer = required(
    environment.AZURE_STORAGE_CONTAINER,
    "storage_container_missing",
  );
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(storageContainer)) {
    fail("storage_container_invalid");
  }

  const evidenceContainer = required(
    environment.AZURE_MIGRATION_EVIDENCE_CONTAINER,
    "evidence_container_missing",
  );
  if (
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(evidenceContainer) ||
    evidenceContainer === storageContainer
  ) {
    fail("evidence_container_invalid");
  }
  const evidenceBlob = required(
    environment.MIGRATION_CONTROL_EVIDENCE_BLOB,
    "cutover_evidence_blob_missing",
  );
  if (!validBlobPath(evidenceBlob)) fail("cutover_evidence_blob_invalid");
  const evidenceSha256 = required(
    environment.MIGRATION_CONTROL_EVIDENCE_SHA256,
    "cutover_evidence_digest_missing",
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(evidenceSha256)) {
    fail("cutover_evidence_digest_invalid");
  }
  const evidenceMaxAgeSeconds = Number(
    environment.MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS ||
      DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
  );
  if (
    !Number.isInteger(evidenceMaxAgeSeconds) ||
    evidenceMaxAgeSeconds < 300 ||
    evidenceMaxAgeSeconds > 86_400
  ) {
    fail("cutover_evidence_max_age_invalid");
  }

  const image = required(
    environment.MIGRATION_CONTROL_IMAGE,
    "control_image_missing",
  );
  if (
    !/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(
      image,
    )
  ) {
    fail("control_image_not_digest_pinned");
  }

  const timeoutMs = Number(
    environment.MIGRATION_CONTROL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    fail("control_timeout_invalid");
  }

  const identityEndpoint = new URL(
    required(environment.IDENTITY_ENDPOINT, "identity_endpoint_missing"),
  );
  if (
    identityEndpoint.protocol !== "http:" ||
    identityEndpoint.username ||
    identityEndpoint.password ||
    identityEndpoint.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(
      identityEndpoint.hostname.toLowerCase(),
    )
  ) {
    fail("identity_endpoint_invalid");
  }

  return {
    dataApiRoot: dataApiUrl.toString().replace(/\/+$/u, ""),
    dataApiServiceRoleKey: required(
      environment.DATA_API_SERVICE_ROLE_KEY,
      "data_api_credential_missing",
    ),
    storageAccountUrl: storageAccountUrl.toString().replace(/\/+$/u, ""),
    storageContainer,
    evidenceContainer,
    evidenceBlob,
    evidenceSha256,
    evidenceMaxAgeSeconds,
    managedIdentityClientId: required(
      environment.AZURE_CLIENT_ID,
      "managed_identity_client_id_missing",
    ),
    identityEndpoint: identityEndpoint.toString(),
    identityHeader: required(
      environment.IDENTITY_HEADER,
      "identity_header_missing",
    ),
    image,
    timeoutMs,
  };
}

function requestSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

async function checkedFetch(fetchImpl, url, options, failureCode) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    fail(failureCode);
  }
  if (!response?.ok) fail(failureCode);
  return response;
}

async function probeInternalDataApi(config, fetchImpl = fetch) {
  const headers = {
    accept: "application/json",
    apikey: config.dataApiServiceRoleKey,
    authorization: `Bearer ${config.dataApiServiceRoleKey}`,
  };
  const projectJobsUrl = new URL(`${config.dataApiRoot}/project_jobs`);
  projectJobsUrl.searchParams.set(
    "select",
    REQUIRED_PROJECT_JOB_COLUMNS.join(","),
  );
  projectJobsUrl.searchParams.set("limit", "0");
  await checkedFetch(
    fetchImpl,
    projectJobsUrl,
    {
      method: "HEAD",
      headers,
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "data_api_project_jobs_contract_failed",
  );

  const auditEventsUrl = new URL(`${config.dataApiRoot}/audit_events`);
  auditEventsUrl.searchParams.set("select", "subject_project_id");
  auditEventsUrl.searchParams.set("limit", "0");
  await checkedFetch(
    fetchImpl,
    auditEventsUrl,
    {
      method: "HEAD",
      headers,
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "data_api_audit_contract_failed",
  );

  for (const [functionName, expectedVersion] of REQUIRED_PREFLIGHTS) {
    const response = await checkedFetch(
      fetchImpl,
      new URL(`${config.dataApiRoot}/rpc/${functionName}`),
      {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: requestSignal(config.timeoutMs),
      },
      `data_api_${functionName}_failed`,
    );
    let version;
    try {
      version = await response.json();
    } catch {
      fail(`data_api_${functionName}_invalid`);
    }
    if (version !== expectedVersion) {
      fail(`data_api_${functionName}_invalid`);
    }
  }
  const claimControlUrl = new URL(
    `${config.dataApiRoot}/project_job_claim_control`,
  );
  claimControlUrl.searchParams.set("select", "claims_enabled");
  claimControlUrl.searchParams.set("singleton", "eq.true");
  const claimControlResponse = await checkedFetch(
    fetchImpl,
    claimControlUrl,
    {
      method: "GET",
      headers,
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "data_api_claim_gate_probe_failed",
  );
  let claimControl;
  try {
    claimControl = await claimControlResponse.json();
  } catch {
    fail("data_api_claim_gate_invalid");
  }
  if (
    !Array.isArray(claimControl) ||
    claimControl.length !== 1 ||
    claimControl[0]?.claims_enabled !== false
  ) {
    fail("data_api_claim_gate_not_closed");
  }

  const runningJobsUrl = new URL(`${config.dataApiRoot}/project_jobs`);
  runningJobsUrl.searchParams.set("select", "id");
  runningJobsUrl.searchParams.set("status", "eq.running");
  runningJobsUrl.searchParams.set("limit", "1");
  const runningJobsResponse = await checkedFetch(
    fetchImpl,
    runningJobsUrl,
    {
      method: "GET",
      headers,
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "data_api_running_jobs_probe_failed",
  );
  let runningJobs;
  try {
    runningJobs = await runningJobsResponse.json();
  } catch {
    fail("data_api_running_jobs_invalid");
  }
  if (!Array.isArray(runningJobs) || runningJobs.length !== 0) {
    fail("data_api_running_jobs_present");
  }
}

export async function queryTargetDatabaseReferenceBinding(
  config,
  fetchImpl = fetch,
) {
  const entries = [];
  const headers = {
    accept: "application/json",
    apikey: config.dataApiServiceRoleKey,
    authorization: `Bearer ${config.dataApiServiceRoleKey}`,
  };
  let rowCount = 0;
  for (const table of ["documents", "service_documents"]) {
    let offset = 0;
    while (true) {
      const url = new URL(`${config.dataApiRoot}/${table}`);
      url.searchParams.set("select", "file_storage_bucket,file_storage_path");
      url.searchParams.set("file_storage_path", "not.is.null");
      url.searchParams.set(
        "order",
        "file_storage_bucket.asc,file_storage_path.asc,id.asc",
      );
      url.searchParams.set("limit", String(DATABASE_REFERENCE_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      const response = await checkedFetch(
        fetchImpl,
        url,
        {
          method: "GET",
          headers,
          redirect: "error",
          signal: requestSignal(config.timeoutMs),
        },
        "data_api_database_reference_query_failed",
      );
      let page;
      try {
        page = await response.json();
      } catch {
        fail("data_api_database_reference_inventory_invalid");
      }
      if (!Array.isArray(page) || page.length > DATABASE_REFERENCE_PAGE_SIZE) {
        fail("data_api_database_reference_inventory_invalid");
      }
      rowCount += page.length;
      if (rowCount > MAX_DATABASE_REFERENCE_ROWS) {
        fail("data_api_database_reference_inventory_too_large");
      }
      for (const row of page) {
        if (
          !exactKeys(row, ["file_storage_bucket", "file_storage_path"]) ||
          typeof row.file_storage_bucket !== "string" ||
          typeof row.file_storage_path !== "string"
        ) {
          fail("data_api_database_reference_inventory_invalid");
        }
        entries.push({
          bucket: row.file_storage_bucket,
          path: row.file_storage_path,
        });
      }
      if (page.length < DATABASE_REFERENCE_PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return createDatabaseReferenceBinding(entries, config.storageContainer);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(value);
}

function lowercaseSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function parseEvidenceTimestamp(value, code = "cutover_evidence_timestamp_invalid") {
  if (typeof value !== "string") fail(code);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(code);
  }
  return timestamp;
}

function validateFreshTimestamp(value, generatedAt, now, maxAgeMilliseconds, code) {
  const timestamp = parseEvidenceTimestamp(value, `${code}_timestamp_invalid`);
  if (
    timestamp > generatedAt ||
    timestamp > now + 60_000 ||
    now - timestamp > maxAgeMilliseconds
  ) {
    fail(`${code}_stale`);
  }
  return timestamp;
}

function validateSecurityDefiners(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== 3) return false;
  const expectedNames = [
    "audit_project_job_terminal_state",
    "rls_auto_enable",
    "sync_project_owner_membership",
  ];
  const expectedKeys = [
    "name",
    "arguments",
    "owner",
    "language",
    "result",
    "source_sha256",
    "settings",
    "public_execute",
    "anon_execute",
    "authenticated_execute",
    "service_execute",
  ];
  const sorted = [...definitions].sort((left, right) => left.name.localeCompare(right.name));
  return sorted.every((definition, index) => {
    if (
      !exactKeys(definition, expectedKeys) ||
      definition.name !== expectedNames[index] ||
      definition.arguments !== "" ||
      definition.owner !== "postgres" ||
      typeof definition.language !== "string" ||
      typeof definition.result !== "string" ||
      !lowercaseSha256(definition.source_sha256) ||
      !Array.isArray(definition.settings) ||
      definition.public_execute !== false ||
      definition.anon_execute !== false ||
      definition.authenticated_execute !== false ||
      definition.service_execute !== true
    ) {
      return false;
    }
    if (definition.name === "rls_auto_enable") {
      return (
        definition.language === "plpgsql" &&
        definition.result === "event_trigger" &&
        definition.source_sha256 ===
          "2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1" &&
        exactArray(definition.settings, ["search_path=pg_catalog"])
      );
    }
    return definition.settings.includes('search_path=""');
  });
}

export function validateFrozenPreflightReport(report) {
  const sourceKeys = [
    "postgres_major",
    "public_tables",
    "rls_disabled_tables",
    "database_bytes",
    "database_collation",
    "database_ctype",
    "database_encoding",
    "database_locale_provider",
    "database_locale",
    "database_icu_rules",
    "database_collation_version",
    "migrations",
    "running_jobs",
    "security_definers",
  ];
  const source = report?.source;
  if (
    !exactKeys(report, ["status", "source", "target_storage_gib", "note", "failures"]) ||
    report.status !== "ready-for-database-validation-dump" ||
    !exactKeys(source, sourceKeys) ||
    source.postgres_major !== 17 ||
    !exactArray(source.public_tables, EXPECTED_PUBLIC_TABLES) ||
    !exactArray(source.rls_disabled_tables, []) ||
    !nonNegativeSafeInteger(source.database_bytes) ||
    source.database_collation !== "en_US.UTF-8" ||
    source.database_ctype !== "en_US.UTF-8" ||
    source.database_encoding !== "UTF8" ||
    source.database_locale_provider !== "i" ||
    source.database_locale !== "en-US" ||
    source.database_icu_rules !== null ||
    source.database_collation_version !== "153.120" ||
    !Array.isArray(source.migrations) ||
    source.migrations.length === 0 ||
    !source.migrations.every((value) => /^\d{14}$/u.test(value)) ||
    !exactArray(source.migrations, [...new Set(source.migrations)].sort()) ||
    source.running_jobs !== 0 ||
    !validateSecurityDefiners(source.security_definers) ||
    ![32, 64, 128].includes(report.target_storage_gib) ||
    typeof report.note !== "string" ||
    report.note.length === 0 ||
    !exactArray(report.failures, [])
  ) {
    fail("cutover_preflight_unverified");
  }
  const maximumSourceBytes = report.target_storage_gib * 1024 ** 3 * 0.7;
  if (source.database_bytes > maximumSourceBytes) {
    fail("cutover_preflight_storage_margin_invalid");
  }
  return report;
}

function validateInventoryCounts(value) {
  return (
    exactKeys(value, INVENTORY_COUNT_KEYS) &&
    INVENTORY_COUNT_KEYS.every((key) => nonNegativeSafeInteger(value[key]))
  );
}

export function validateDatabaseComparisonReport(report) {
  if (
    !exactKeys(report, [
      "status",
      "postgres_major",
      "snapshot",
      "inventory_counts",
      "tables",
      "sequences",
      "failures",
      "source_mode",
      "source_frozen_attested",
      "test_only_insecure_transport",
    ]) ||
    report.status !== "verified" ||
    report.postgres_major !== 17 ||
    !exactKeys(report.snapshot, ["source", "target"]) ||
    report.snapshot.source !== "management-api-read-only-explicitly-frozen-source" ||
    report.snapshot.target !== "repeatable-read-read-only" ||
    !exactKeys(report.inventory_counts, ["source", "target"]) ||
    !validateInventoryCounts(report.inventory_counts.source) ||
    !validateInventoryCounts(report.inventory_counts.target) ||
    !Array.isArray(report.tables) ||
    report.tables.length !== EXPECTED_PUBLIC_TABLES.length ||
    !Array.isArray(report.sequences) ||
    !exactArray(report.failures, []) ||
    report.source_mode !== "supabase-linked" ||
    report.source_frozen_attested !== true ||
    report.test_only_insecure_transport !== false
  ) {
    fail("cutover_database_comparison_unverified");
  }
  for (let index = 0; index < EXPECTED_PUBLIC_TABLES.length; index += 1) {
    const table = report.tables[index];
    if (
      !exactKeys(table, ["table", "source_rows", "target_rows", "count_match", "content_match"]) ||
      table.table !== EXPECTED_PUBLIC_TABLES[index] ||
      !nonNegativeSafeInteger(table.source_rows) ||
      table.source_rows !== table.target_rows ||
      table.count_match !== true ||
      table.content_match !== true
    ) {
      fail("cutover_database_table_mismatch");
    }
  }
  const sourceCounts = report.inventory_counts.source;
  const targetCounts = report.inventory_counts.target;
  if (
    sourceCounts.tables !== EXPECTED_PUBLIC_TABLES.length ||
    targetCounts.tables !== EXPECTED_PUBLIC_TABLES.length ||
    sourceCounts.sequences !== targetCounts.sequences ||
    sourceCounts.sequences !== report.sequences.length ||
    sourceCounts.functions !== targetCounts.functions + 1 ||
    ["extensions", "indexes", "constraints", "triggers", "policies"].some(
      (key) => sourceCounts[key] !== targetCounts[key],
    )
  ) {
    fail("cutover_database_inventory_mismatch");
  }
  const seenSequences = new Set();
  for (const sequence of report.sequences) {
    if (
      !exactKeys(sequence, ["sequence", "state_match"]) ||
      !safeIdentifier(sequence.sequence) ||
      sequence.state_match !== true ||
      seenSequences.has(sequence.sequence)
    ) {
      fail("cutover_database_sequence_mismatch");
    }
    seenSequences.add(sequence.sequence);
  }
  if (!exactArray([...seenSequences].sort(), [...seenSequences])) {
    fail("cutover_database_sequence_mismatch");
  }
  return report;
}

function validateBlobMetadata(value) {
  if (!plainObject(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      /^[a-z_][a-z0-9_]*$/u.test(key) &&
      typeof entry === "string" &&
      !/[\u0000-\u001f\u007f]/u.test(entry),
  );
}

export function validateBlobFinalManifest(
  manifest,
  expectedTargetContainer,
  expectedSourceFrozenAt,
) {
  const rootKeys = [
    "version",
    "status",
    "generatedAt",
    "mode",
    "sourceMode",
    "sourceBucket",
    "targetContainer",
    "sourceObjectCount",
    "sourceBytes",
    "uploadedObjectCount",
    "resumedObjectCount",
    "finalSourceBodyRecheck",
    "databaseReferenceReport",
    "targetInventoryReport",
    "decryptionSmoke",
    "objects",
  ];
  if (
    !exactKeys(manifest, rootKeys) ||
    manifest.version !== 1 ||
    manifest.status !== "verified" ||
    manifest.mode !== "final" ||
    manifest.sourceMode !== "supabase-linked-cli" ||
    typeof manifest.sourceBucket !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(manifest.sourceBucket) ||
    manifest.sourceBucket !== manifest.targetContainer ||
    (expectedTargetContainer && manifest.targetContainer !== expectedTargetContainer) ||
    !nonNegativeSafeInteger(manifest.sourceObjectCount) ||
    manifest.sourceObjectCount === 0 ||
    !nonNegativeSafeInteger(manifest.sourceBytes) ||
    manifest.sourceBytes === 0 ||
    !nonNegativeSafeInteger(manifest.uploadedObjectCount) ||
    !nonNegativeSafeInteger(manifest.resumedObjectCount) ||
    manifest.uploadedObjectCount + manifest.resumedObjectCount !== manifest.sourceObjectCount ||
    manifest.finalSourceBodyRecheck !== true ||
    !exactKeys(manifest.databaseReferenceReport, [
      "bindingVersion",
      "referenceInventorySha256",
      "referencedObjectCount",
      "missingSourcePaths",
      "orphanObjectCount",
      "orphanPaths",
      "sourceReferenceFile",
    ]) ||
    manifest.databaseReferenceReport.bindingVersion !==
      DATABASE_REFERENCE_BINDING_VERSION ||
    !lowercaseSha256(manifest.databaseReferenceReport.referenceInventorySha256) ||
    !nonNegativeSafeInteger(manifest.databaseReferenceReport.referencedObjectCount) ||
    manifest.databaseReferenceReport.referencedObjectCount === 0 ||
    !exactArray(manifest.databaseReferenceReport.missingSourcePaths, []) ||
    !nonNegativeSafeInteger(manifest.databaseReferenceReport.orphanObjectCount) ||
    !Array.isArray(manifest.databaseReferenceReport.orphanPaths) ||
    manifest.databaseReferenceReport.orphanObjectCount !==
      manifest.databaseReferenceReport.orphanPaths.length ||
    manifest.databaseReferenceReport.referencedObjectCount +
      manifest.databaseReferenceReport.orphanObjectCount !==
      manifest.sourceObjectCount ||
    !exactKeys(manifest.databaseReferenceReport.sourceReferenceFile, [
      "status",
      "size",
      "sha256",
      "modifiedAt",
      "sourceFrozenAttested",
      "sourceFrozenAt",
      "sourceProjectRef",
    ]) ||
    manifest.databaseReferenceReport.sourceReferenceFile.status !== "sha256-verified" ||
    !Number.isSafeInteger(manifest.databaseReferenceReport.sourceReferenceFile.size) ||
    manifest.databaseReferenceReport.sourceReferenceFile.size <= 0 ||
    manifest.databaseReferenceReport.sourceReferenceFile.size > 64 * 1024 * 1024 ||
    !lowercaseSha256(manifest.databaseReferenceReport.sourceReferenceFile.sha256) ||
    manifest.databaseReferenceReport.sourceReferenceFile.sourceFrozenAttested !== true ||
    !/^[a-z0-9]{20}$/u.test(
      manifest.databaseReferenceReport.sourceReferenceFile.sourceProjectRef,
    ) ||
    !exactKeys(manifest.targetInventoryReport, [
      "missingObjectCount",
      "extraObjectCount",
      "extraPaths",
      "exactMatchRequired",
    ]) ||
    manifest.targetInventoryReport.missingObjectCount !== 0 ||
    manifest.targetInventoryReport.extraObjectCount !== 0 ||
    !exactArray(manifest.targetInventoryReport.extraPaths, []) ||
    manifest.targetInventoryReport.exactMatchRequired !== true ||
    !exactKeys(manifest.decryptionSmoke, ["status"]) ||
    manifest.decryptionSmoke.status !== "passed" ||
    !Array.isArray(manifest.objects) ||
    manifest.objects.length !== manifest.sourceObjectCount
  ) {
    fail("cutover_blob_manifest_unverified");
  }
  const manifestGeneratedAt = parseEvidenceTimestamp(
    manifest.generatedAt,
    "cutover_blob_manifest_timestamp_invalid",
  );
  const referenceModifiedAt = parseEvidenceTimestamp(
    manifest.databaseReferenceReport.sourceReferenceFile.modifiedAt,
    "cutover_blob_reference_timestamp_invalid",
  );
  const sourceFrozenAt = parseEvidenceTimestamp(
    manifest.databaseReferenceReport.sourceReferenceFile.sourceFrozenAt,
    "cutover_blob_reference_freeze_invalid",
  );
  if (
    (expectedSourceFrozenAt &&
      manifest.databaseReferenceReport.sourceReferenceFile.sourceFrozenAt !==
        expectedSourceFrozenAt) ||
    referenceModifiedAt < sourceFrozenAt ||
    referenceModifiedAt > manifestGeneratedAt
  ) {
    fail("cutover_blob_reference_provenance_invalid");
  }
  const seenPaths = new Set();
  let sourceBytes = 0;
  for (const object of manifest.objects) {
    if (
      !exactKeys(object, [
        "path",
        "size",
        "sha256",
        "contentType",
        "cacheControl",
        "contentDisposition",
        "contentEncoding",
        "contentLanguage",
        "metadata",
        "unsupportedSourceProperties",
      ]) ||
      !validManifestObjectPath(object.path) ||
      seenPaths.has(object.path) ||
      !nonNegativeSafeInteger(object.size) ||
      !lowercaseSha256(object.sha256) ||
      object.contentType !== "application/octet-stream" ||
      object.cacheControl !== "max-age=31536000" ||
      object.contentDisposition !== null ||
      object.contentEncoding !== null ||
      object.contentLanguage !== null ||
      !validateBlobMetadata(object.metadata) ||
      Object.keys(object.metadata).length !== 0 ||
      !exactArray(object.unsupportedSourceProperties, [
        "source-http-metadata-unavailable-via-linked-cli",
      ])
    ) {
      fail("cutover_blob_object_invalid");
    }
    sourceBytes += object.size;
    if (!Number.isSafeInteger(sourceBytes)) fail("cutover_blob_size_invalid");
    seenPaths.add(object.path);
  }
  if (
    sourceBytes !== manifest.sourceBytes ||
    !exactArray([...seenPaths].sort(), [...seenPaths]) ||
    !exactArray(
      [...new Set(manifest.databaseReferenceReport.orphanPaths)].sort(),
      manifest.databaseReferenceReport.orphanPaths,
    ) ||
    manifest.databaseReferenceReport.orphanPaths.some((path) => !seenPaths.has(path))
  ) {
    fail("cutover_blob_inventory_mismatch");
  }
  const orphanSet = new Set(manifest.databaseReferenceReport.orphanPaths);
  const referenceBinding = createDatabaseReferenceBinding(
    manifest.objects
      .filter((object) => !orphanSet.has(object.path))
      .map((object) => ({ bucket: manifest.sourceBucket, path: object.path })),
    manifest.targetContainer,
  );
  if (
    referenceBinding.count !== manifest.databaseReferenceReport.referencedObjectCount ||
    referenceBinding.sha256 !==
      manifest.databaseReferenceReport.referenceInventorySha256
  ) {
    fail("cutover_blob_reference_binding_mismatch");
  }
  return manifest;
}

function validateArtifactDescriptor(descriptor, artifactKey, evidence, config, now) {
  const artifact = CUTOVER_ARTIFACTS[artifactKey];
  if (
    !exactKeys(descriptor, ["kind", "blobPath", "size", "sha256", "generatedAt"]) ||
    descriptor.kind !== artifact.kind ||
    descriptor.blobPath !== `${evidence.artifactPrefix}/${artifact.filename}` ||
    !validBlobPath(descriptor.blobPath) ||
    descriptor.blobPath === config.evidenceBlob ||
    !descriptor.blobPath.startsWith(`${evidence.artifactPrefix}/`) ||
    !nonNegativeSafeInteger(descriptor.size) ||
    descriptor.size === 0 ||
    descriptor.size > artifact.maxBytes ||
    !lowercaseSha256(descriptor.sha256)
  ) {
    fail("cutover_artifact_descriptor_invalid");
  }
  const timestamp = validateFreshTimestamp(
    descriptor.generatedAt,
    Date.parse(evidence.generatedAt),
    now,
    config.evidenceMaxAgeSeconds * 1_000,
    "cutover_artifact",
  );
  if (timestamp < Date.parse(evidence.source.frozenAt)) {
    fail("cutover_artifact_predates_freeze");
  }
}

export function validateFinalCutoverEvidence(
  evidence,
  config,
  clock = () => new Date(),
) {
  if (!plainObject(evidence)) {
    fail("cutover_evidence_invalid");
  }
  const generatedAt = parseEvidenceTimestamp(
    evidence.generatedAt,
    "cutover_evidence_timestamp_invalid",
  );
  const now = clock().getTime();
  if (
    !Number.isFinite(now) ||
    generatedAt > now + 60_000 ||
    now - generatedAt > config.evidenceMaxAgeSeconds * 1_000
  ) {
    fail("cutover_evidence_stale");
  }
  if (
    !exactKeys(evidence, ["version", "generatedAt", "source", "artifactPrefix", "artifacts"]) ||
    evidence.version !== CUTOVER_EVIDENCE_VERSION ||
    !exactKeys(evidence.source, ["frozen", "claimsEnabled", "runningJobs", "frozenAt"]) ||
    evidence.source.frozen !== true ||
    evidence.source.claimsEnabled !== false ||
    evidence.source.runningJobs !== 0 ||
    !validArtifactPrefix(evidence.artifactPrefix) ||
    config.evidenceBlob !==
      `${evidence.artifactPrefix.slice(0, -"/artifacts".length)}/evidence-v2.json` ||
    !exactKeys(evidence.artifacts, CUTOVER_ARTIFACT_KEYS)
  ) {
    fail("cutover_evidence_unverified");
  }
  validateFreshTimestamp(
    evidence.source.frozenAt,
    generatedAt,
    now,
    config.evidenceMaxAgeSeconds * 1_000,
    "cutover_source_freeze",
  );
  const paths = new Set();
  let totalBytes = 0;
  for (const artifactKey of CUTOVER_ARTIFACT_KEYS) {
    const descriptor = evidence.artifacts[artifactKey];
    validateArtifactDescriptor(descriptor, artifactKey, evidence, config, now);
    if (paths.has(descriptor.blobPath)) fail("cutover_artifact_path_reused");
    paths.add(descriptor.blobPath);
    totalBytes += descriptor.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail("cutover_artifacts_too_large");
    }
  }
  if (evidence.artifacts.originalToc.sha256 === evidence.artifacts.sanitizedToc.sha256) {
    fail("cutover_toc_not_sanitized");
  }
  const artifactTime = (key) => Date.parse(evidence.artifacts[key].generatedAt);
  if (
    artifactTime("sanitizedToc") < artifactTime("originalToc") ||
    artifactTime("restoreLog") < artifactTime("databaseDump") ||
    artifactTime("restoreLog") < artifactTime("sanitizedToc") ||
    artifactTime("verifyLog") < artifactTime("restoreLog") ||
    artifactTime("databaseComparison") < artifactTime("verifyLog")
  ) {
    fail("cutover_artifact_order_invalid");
  }
  return evidence;
}

export async function probeAzureBlobWithManagedIdentity(
  config,
  fetchImpl = fetch,
  clock = () => new Date(),
) {
  const tokenUrl = new URL(config.identityEndpoint);
  tokenUrl.searchParams.set("resource", "https://storage.azure.com/");
  tokenUrl.searchParams.set("api-version", "2019-08-01");
  tokenUrl.searchParams.set("client_id", config.managedIdentityClientId);
  const tokenResponse = await checkedFetch(
    fetchImpl,
    tokenUrl,
    {
      method: "GET",
      headers: {
        "x-identity-header": config.identityHeader,
      },
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "managed_identity_token_failed",
  );
  let tokenBody;
  try {
    tokenBody = await tokenResponse.json();
  } catch {
    fail("managed_identity_token_invalid");
  }
  const accessToken = tokenBody?.access_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length < 100 ||
    tokenBody?.client_id?.toLowerCase() !==
      config.managedIdentityClientId.toLowerCase()
  ) {
    fail("managed_identity_token_invalid");
  }

  const containerUrl = new URL(
    `${config.storageAccountUrl}/${config.storageContainer}`,
  );
  containerUrl.searchParams.set("restype", "container");
  await checkedFetch(
    fetchImpl,
    containerUrl,
    {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-ms-client-request-id": randomUUID(),
        "x-ms-date": new Date().toUTCString(),
        "x-ms-version": "2023-11-03",
      },
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "blob_managed_identity_probe_failed",
  );

  const evidenceContainerUrl = new URL(
    `${config.storageAccountUrl}/${config.evidenceContainer}`,
  );
  evidenceContainerUrl.searchParams.set("restype", "container");
  const evidenceContainerResponse = await checkedFetch(
    fetchImpl,
    evidenceContainerUrl,
    {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-ms-client-request-id": randomUUID(),
        "x-ms-date": clock().toUTCString(),
        "x-ms-version": "2023-11-03",
      },
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "evidence_container_probe_failed",
  );
  if (evidenceContainerResponse.headers?.get?.("x-ms-blob-public-access")) {
    fail("evidence_container_not_private");
  }

  const readBlob = async (blobPath, failureCode) => {
    const url = new URL(
      `${config.storageAccountUrl}/${config.evidenceContainer}/${blobPath}`,
    );
    return checkedFetch(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-ms-client-request-id": randomUUID(),
          "x-ms-date": clock().toUTCString(),
          "x-ms-version": "2023-11-03",
        },
        redirect: "error",
        signal: requestSignal(config.timeoutMs),
      },
      failureCode,
    );
  };
  const responseBytes = async (response, maximumBytes, expectedBytes, code) => {
    const rawLength = response.headers?.get?.("content-length");
    if (rawLength === null || rawLength === undefined) {
      fail(`${code}_size_mismatch`);
    }
    const declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength <= 0 ||
      declaredLength > maximumBytes ||
      (expectedBytes !== undefined && declaredLength !== expectedBytes)
    ) {
      fail(`${code}_size_mismatch`);
    }
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      fail(`${code}_read_failed`);
    }
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes ||
      (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)
    ) {
      fail(`${code}_size_mismatch`);
    }
    return bytes;
  };

  const evidenceResponse = await readBlob(
    config.evidenceBlob,
    "cutover_evidence_read_failed",
  );
  const evidenceBytes = await responseBytes(
    evidenceResponse,
    MAX_EVIDENCE_BYTES,
    undefined,
    "cutover_evidence",
  );
  const actualDigest = createHash("sha256").update(evidenceBytes).digest("hex");
  if (actualDigest !== config.evidenceSha256) {
    fail("cutover_evidence_digest_mismatch");
  }
  let evidence;
  try {
    evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes));
  } catch {
    fail("cutover_evidence_invalid");
  }
  validateFinalCutoverEvidence(evidence, config, clock);

  const verifiedArtifacts = [];
  let verifiedBlobManifest;
  for (const artifactKey of CUTOVER_ARTIFACT_KEYS) {
    const descriptor = evidence.artifacts[artifactKey];
    const response = await readBlob(
      descriptor.blobPath,
      "cutover_artifact_read_failed",
    );
    const bytes = await responseBytes(
      response,
      CUTOVER_ARTIFACTS[artifactKey].maxBytes,
      descriptor.size,
      "cutover_artifact",
    );
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
      fail("cutover_artifact_digest_mismatch");
    }
    if (
      artifactKey === "databaseDump" &&
      bytes.subarray(0, 5).toString("ascii") !== "PGDMP"
    ) {
      fail("cutover_database_dump_invalid");
    }

    if (["preflight", "databaseComparison", "blobManifest"].includes(artifactKey)) {
      let report;
      try {
        report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        fail("cutover_artifact_json_invalid");
      }
      if (artifactKey === "preflight") validateFrozenPreflightReport(report);
      if (artifactKey === "databaseComparison") validateDatabaseComparisonReport(report);
      if (artifactKey === "blobManifest") {
        validateBlobFinalManifest(
          report,
          config.storageContainer,
          evidence.source.frozenAt,
        );
        if (report.generatedAt !== descriptor.generatedAt) {
          fail("cutover_blob_manifest_timestamp_mismatch");
        }
        verifiedBlobManifest = report;
      }
    }
    verifiedArtifacts.push({
      kind: descriptor.kind,
      size: descriptor.size,
      sha256: descriptor.sha256,
    });
  }
  if (!verifiedBlobManifest) fail("cutover_blob_manifest_unverified");
  const targetReferenceBinding = await queryTargetDatabaseReferenceBinding(
    config,
    fetchImpl,
  );
  if (
    targetReferenceBinding.version !==
      verifiedBlobManifest.databaseReferenceReport.bindingVersion ||
    targetReferenceBinding.count !==
      verifiedBlobManifest.databaseReferenceReport.referencedObjectCount ||
    targetReferenceBinding.sha256 !==
      verifiedBlobManifest.databaseReferenceReport.referenceInventorySha256
  ) {
    fail("target_database_reference_binding_mismatch");
  }
  return {
    version: evidence.version,
    generatedAt: evidence.generatedAt,
    verifiedArtifacts,
  };
}

export async function activateTargetProjectJobClaims(config, fetchImpl = fetch) {
  const response = await checkedFetch(
    fetchImpl,
    new URL(`${config.dataApiRoot}/rpc/set_project_job_claims_enabled`),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: config.dataApiServiceRoleKey,
        authorization: `Bearer ${config.dataApiServiceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_claims_enabled: true }),
      redirect: "error",
      signal: requestSignal(config.timeoutMs),
    },
    "data_api_claim_gate_activation_failed",
  );
  let result;
  try {
    result = await response.json();
  } catch {
    fail("data_api_claim_gate_activation_invalid");
  }
  if (
    result?.version !== PROJECT_JOB_CUTOVER_VERSION ||
    result?.claims_enabled !== true
  ) {
    fail("data_api_claim_gate_activation_invalid");
  }
}

export async function runAzureMigrationControl({
  environment = process.env,
  fetchImpl = fetch,
  blobProbe = probeAzureBlobWithManagedIdentity,
  mode = "verify",
  clock = () => new Date(),
} = {}) {
  const config = validateMigrationControlConfiguration(environment);
  if (mode === "validate-target") {
    await probeInternalDataApi(config, fetchImpl);
    return {
      migration_control: "target_validated",
      checks: ["digest_pinned_image", "internal_data_api_contract"],
    };
  }
  if (mode === "activate-target") {
    await probeInternalDataApi(config, fetchImpl);
    await activateTargetProjectJobClaims(config, fetchImpl);
    return {
      migration_control: "target_claims_activated",
      checks: ["digest_pinned_image", "internal_target_claim_gate_opened"],
    };
  }
  if (mode !== "verify") fail("control_mode_invalid");
  await probeInternalDataApi(config, fetchImpl);
  await blobProbe(config, fetchImpl, clock);
  return {
    migration_control: "ready",
    checks: [
      "digest_pinned_image",
      "internal_data_api_contract",
      "managed_identity_blob_read",
      "fresh_digest_pinned_cutover_evidence",
      "source_and_target_claims_frozen",
      "source_and_target_running_jobs_zero",
    ],
  };
}

function safeFailureCode(error) {
  return error instanceof MigrationControlError
    ? error.code
    : "unexpected_control_failure";
}

async function main() {
  try {
    const mode = process.argv[2] || "verify";
    console.log(JSON.stringify(await runAzureMigrationControl({ mode })));
  } catch (error) {
    console.error(
      JSON.stringify({
        migration_control: "failed",
        code: safeFailureCode(error),
      }),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
