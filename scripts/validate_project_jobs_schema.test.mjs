import assert from "node:assert/strict";
import test from "node:test";

import {
  preflightRemoteProjectJobSchema,
  validateCanonicalProjectJobMigration,
} from "./validate_project_jobs_schema.mjs";

const completeMigration = `
alter table public.project_jobs
  add column if not exists input_json jsonb,
  add column if not exists locked_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists terminal_metadata jsonb not null default '{}'::jsonb,
  add column if not exists parent_job_id uuid,
  add column if not exists idempotency_key text;
alter table public.audit_events add column if not exists subject_project_id uuid;
create index if not exists project_jobs_queue_claim_idx on public.project_jobs(status, locked_at, created_at);
create index if not exists project_jobs_running_lease_idx on public.project_jobs(id, lease_token);
create index if not exists project_jobs_parent_job_idx on public.project_jobs(parent_job_id);
create index if not exists audit_events_subject_project_idx on public.audit_events(subject_project_id);
create or replace function public.lease_fenced_project_write() returns void language sql as 'select';
create or replace function public.lease_fenced_enqueue_project_job() returns void language sql as 'select';
create or replace function public.project_job_fencing_preflight() returns text language sql as 'select';
create or replace function public.audit_project_job_terminal_state() returns trigger language plpgsql as 'begin return new; end';
create or replace function public.protect_project_job_terminal_state() returns trigger language plpgsql as 'begin return new; end';
create or replace function public.project_job_terminal_audit_preflight() returns text language sql as 'select';
create or replace function public.enforce_project_job_claim_gate() returns trigger language plpgsql as 'begin return new; end';
create or replace function public.set_project_job_claims_enabled(boolean) returns jsonb language sql as 'select';
create or replace function public.requeue_project_jobs_for_cutover() returns jsonb language sql as 'select';
create or replace function public.prepare_stable_main_rollback() returns jsonb language sql as 'select';
create or replace function public.stable_main_rollback_bridge_preflight() returns text language sql as 'select';
create or replace function public.insert_service_document_with_keywords(uuid, jsonb, text[]) returns void language sql as 'select';
create or replace function public.atomic_service_document_write_preflight() returns text language sql as 'select';
`;

const versions = new Map([
  ["project_job_fencing_preflight", "authoritative-lease-fencing-v1"],
  ["project_job_terminal_audit_preflight", "transactional-project-job-terminal-audit-v2"],
  ["stable_main_rollback_bridge_preflight", "stable-main-rollback-bridge-v1"],
  ["atomic_service_document_write_preflight", "atomic-service-document-write-v1"],
]);

function successfulFetch(calls, failureName = null) {
  return async (url, options) => {
    calls.push({ url, options });
    const functionName = [...versions.keys()].find((name) =>
      url.pathname.endsWith(name),
    );
    if (functionName === failureName) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      async json() {
        return functionName ? versions.get(functionName) : null;
      },
    };
  };
}

const configuration = {
  dataApiUrl:
    "https://anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
  dataApiServiceRoleKey: "synthetic-azure-key",
  dataApiAllowedHostSuffix:
    ".internal.example.norwayeast.azurecontainerapps.io",
};

test("canonical migration requires every durable column and index", () => {
  assert.doesNotThrow(() => validateCanonicalProjectJobMigration(completeMigration));
  assert.throws(
    () =>
      validateCanonicalProjectJobMigration(
        completeMigration.replace("lease_token uuid,", ""),
      ),
    /column:lease_token/u,
  );
});

test("remote preflight checks only the internal PostgREST contract", async () => {
  const calls = [];
  const result = await preflightRemoteProjectJobSchema({
    ...configuration,
    fetchImpl: successfulFetch(calls),
  });

  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].url.pathname, "/project_jobs");
  assert.equal(calls[1].url.pathname, "/audit_events");
  assert.equal(calls[2].options.method, "POST");
  assert.ok(calls.every((call) => call.options.headers.apikey === "synthetic-azure-key"));
  assert.equal(
    result.host,
    "anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
  );
  assert.equal(result.fencingVersion, "authoritative-lease-fencing-v1");
  assert.equal(
    result.terminalAuditVersion,
    "transactional-project-job-terminal-audit-v2",
  );
});

test("remote preflight requires a complete credential pair and safe URL", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({ dataApiUrl: configuration.dataApiUrl }),
    /required together/u,
  );
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      ...configuration,
      dataApiUrl: "https://user:password@credential-capture.example",
    }),
    /credential-free HTTPS/u,
  );
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      ...configuration,
      dataApiUrl: "https://credential-capture.example",
    }),
    /expected internal ACA host suffix/u,
  );
});

test("remote preflight fails closed when a required RPC is absent", async () => {
  const calls = [];
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      ...configuration,
      fetchImpl: successfulFetch(calls, "project_job_fencing_preflight"),
    }),
    /fencing preflight failed with HTTP 404/u,
  );
});

test("remote preflight fails closed when table metadata is unavailable", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      ...configuration,
      async fetchImpl() {
        return { ok: false, status: 400 };
      },
    }),
    /schema preflight failed with HTTP 400/u,
  );
});
