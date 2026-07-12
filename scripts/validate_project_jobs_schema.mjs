#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const REQUIRED_AUDIT_EVENT_COLUMNS = ["subject_project_id"];

const REQUIRED_INDEXES = [
  "project_jobs_queue_claim_idx",
  "project_jobs_running_lease_idx",
  "project_jobs_parent_job_idx",
  "audit_events_subject_project_idx",
];

const REQUIRED_FUNCTIONS = [
  "lease_fenced_project_write",
  "lease_fenced_enqueue_project_job",
  "project_job_fencing_preflight",
  "audit_project_job_terminal_state",
  "protect_project_job_terminal_state",
  "project_job_terminal_audit_preflight",
  "enforce_project_job_claim_gate",
  "set_project_job_claims_enabled",
  "requeue_project_jobs_for_cutover",
  "prepare_stable_main_rollback",
  "stable_main_rollback_bridge_preflight",
  "insert_service_document_with_keywords",
  "atomic_service_document_write_preflight",
];

const FENCING_VERSION = "authoritative-lease-fencing-v1";
const TERMINAL_AUDIT_VERSION =
  "transactional-project-job-terminal-audit-v2";
const STABLE_ROLLBACK_BRIDGE_VERSION = "stable-main-rollback-bridge-v1";
const ATOMIC_SERVICE_DOCUMENT_WRITE_VERSION =
  "atomic-service-document-write-v1";

export function validateCanonicalProjectJobMigration(input) {
  const missing = [];
  for (const column of [
    ...REQUIRED_PROJECT_JOB_COLUMNS,
    ...REQUIRED_AUDIT_EVENT_COLUMNS,
  ]) {
    if (!new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`, "iu").test(input)) {
      missing.push(`column:${column}`);
    }
  }
  for (const index of REQUIRED_INDEXES) {
    if (!new RegExp(`create\\s+index\\s+if\\s+not\\s+exists\\s+${index}\\b`, "iu").test(input)) {
      missing.push(`index:${index}`);
    }
  }
  for (const functionName of REQUIRED_FUNCTIONS) {
    if (!new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\b`, "iu").test(input)) {
      missing.push(`function:${functionName}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Canonical durable-job migration is incomplete: ${missing.join(", ")}`);
  }
}

export async function preflightRemoteProjectJobSchema({
  supabaseUrl,
  serviceRoleKey,
  expectedProjectRef,
  fetchImpl = fetch,
}) {
  if (!supabaseUrl?.trim() || !serviceRoleKey?.trim()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const url = new URL("/rest/v1/project_jobs", supabaseUrl);
  if (
    expectedProjectRef?.trim() &&
    url.hostname !== `${expectedProjectRef.trim()}.supabase.co`
  ) {
    throw new Error("SUPABASE_URL does not match SUPABASE_PROJECT_REF.");
  }
  url.searchParams.set("select", REQUIRED_PROJECT_JOB_COLUMNS.join(","));
  url.searchParams.set("limit", "0");
  const response = await fetchImpl(url, {
    method: "HEAD",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Durable project_jobs schema preflight failed with HTTP ${response.status}.`,
    );
  }

  const auditEventsUrl = new URL("/rest/v1/audit_events", supabaseUrl);
  auditEventsUrl.searchParams.set(
    "select",
    REQUIRED_AUDIT_EVENT_COLUMNS.join(","),
  );
  auditEventsUrl.searchParams.set("limit", "0");
  const auditEventsResponse = await fetchImpl(auditEventsUrl, {
    method: "HEAD",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
    },
  });
  if (!auditEventsResponse.ok) {
    throw new Error(
      `Audit-events schema preflight failed with HTTP ${auditEventsResponse.status}.`,
    );
  }

  const fencingUrl = new URL(
    "/rest/v1/rpc/project_job_fencing_preflight",
    supabaseUrl,
  );
  const fencingResponse = await fetchImpl(fencingUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!fencingResponse.ok) {
    throw new Error(
      `Authoritative project-job fencing preflight failed with HTTP ${fencingResponse.status}.`,
    );
  }
  const fencingVersion = await fencingResponse.json();
  if (fencingVersion !== FENCING_VERSION) {
    throw new Error("Authoritative project-job fencing version is missing or unexpected.");
  }

  const terminalAuditUrl = new URL(
    "/rest/v1/rpc/project_job_terminal_audit_preflight",
    supabaseUrl,
  );
  const terminalAuditResponse = await fetchImpl(terminalAuditUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!terminalAuditResponse.ok) {
    throw new Error(
      `Transactional terminal-audit preflight failed with HTTP ${terminalAuditResponse.status}.`,
    );
  }
  const terminalAuditVersion = await terminalAuditResponse.json();
  if (terminalAuditVersion !== TERMINAL_AUDIT_VERSION) {
    throw new Error(
      "Transactional terminal-audit version is missing or unexpected.",
    );
  }

  const rollbackBridgeUrl = new URL(
    "/rest/v1/rpc/stable_main_rollback_bridge_preflight",
    supabaseUrl,
  );
  const rollbackBridgeResponse = await fetchImpl(rollbackBridgeUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!rollbackBridgeResponse.ok) {
    throw new Error(
      `Stable-main rollback bridge preflight failed with HTTP ${rollbackBridgeResponse.status}.`,
    );
  }
  const rollbackBridgeVersion = await rollbackBridgeResponse.json();
  if (rollbackBridgeVersion !== STABLE_ROLLBACK_BRIDGE_VERSION) {
    throw new Error(
      "Stable-main rollback bridge version is missing or unexpected.",
    );
  }

  const serviceDocumentWriteUrl = new URL(
    "/rest/v1/rpc/atomic_service_document_write_preflight",
    supabaseUrl,
  );
  const serviceDocumentWriteResponse = await fetchImpl(
    serviceDocumentWriteUrl,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  if (!serviceDocumentWriteResponse.ok) {
    throw new Error(
      `Atomic service-document write preflight failed with HTTP ${serviceDocumentWriteResponse.status}.`,
    );
  }
  const serviceDocumentWriteVersion =
    await serviceDocumentWriteResponse.json();
  if (serviceDocumentWriteVersion !== ATOMIC_SERVICE_DOCUMENT_WRITE_VERSION) {
    throw new Error(
      "Atomic service-document write version is missing or unexpected.",
    );
  }

  return {
    host: url.host,
    columns: [...REQUIRED_PROJECT_JOB_COLUMNS],
    auditColumns: [...REQUIRED_AUDIT_EVENT_COLUMNS],
    fencingVersion,
    terminalAuditVersion,
    rollbackBridgeVersion,
    serviceDocumentWriteVersion,
  };
}

function canonicalMigrationSql(repoRoot) {
  const migrationsDirectory = path.join(repoRoot, "supabase", "migrations");
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return files
    .map((file) => readFileSync(path.join(migrationsDirectory, file), "utf8"))
    .join("\n");
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  validateCanonicalProjectJobMigration(canonicalMigrationSql(repoRoot));

  if (process.argv.includes("--remote")) {
    const result = await preflightRemoteProjectJobSchema({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      expectedProjectRef: process.env.SUPABASE_PROJECT_REF,
    });
    console.log(
      JSON.stringify({
        project_jobs_schema: "ready",
        target_host: result.host,
        checked_columns: result.columns,
        fencing_version: result.fencingVersion,
        terminal_audit_version: result.terminalAuditVersion,
        stable_rollback_bridge_version: result.rollbackBridgeVersion,
        atomic_service_document_write_version:
          result.serviceDocumentWriteVersion,
      }),
    );
    return;
  }

  console.log(JSON.stringify({ project_jobs_migration: "valid" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
