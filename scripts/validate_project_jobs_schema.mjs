#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_COLUMNS = [
  "input_json",
  "locked_at",
  "lease_token",
  "started_at",
  "completed_at",
  "parent_job_id",
  "idempotency_key",
];

const REQUIRED_INDEXES = [
  "project_jobs_queue_claim_idx",
  "project_jobs_running_lease_idx",
  "project_jobs_parent_job_idx",
];

const REQUIRED_FUNCTIONS = [
  "lease_fenced_project_write",
  "lease_fenced_enqueue_project_job",
  "project_job_fencing_preflight",
];

const FENCING_VERSION = "authoritative-lease-fencing-v1";

export function validateCanonicalProjectJobMigration(input) {
  const missing = [];
  for (const column of REQUIRED_COLUMNS) {
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
  url.searchParams.set("select", REQUIRED_COLUMNS.join(","));
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

  return {
    host: url.host,
    columns: [...REQUIRED_COLUMNS],
    fencingVersion,
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
      }),
    );
    return;
  }

  console.log(JSON.stringify({ project_jobs_migration: "valid" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
