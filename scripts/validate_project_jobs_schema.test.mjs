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
alter table public.audit_events
  add column if not exists subject_project_id uuid;
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

test("remote preflight makes a metadata-only HEAD request", async () => {
  const calls = [];
  const result = await preflightRemoteProjectJobSchema({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "synthetic-test-key",
    expectedProjectRef: "example",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (url.pathname.includes("project_job_fencing_preflight")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return "authoritative-lease-fencing-v1";
          },
        };
      }
      if (url.pathname.includes("stable_main_rollback_bridge_preflight")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return "stable-main-rollback-bridge-v1";
          },
        };
      }
      if (url.pathname.includes("atomic_service_document_write_preflight")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return "atomic-service-document-write-v1";
          },
        };
      }
      return url.pathname.includes("project_job_terminal_audit_preflight")
        ? {
            ok: true,
            status: 200,
            async json() {
              return "transactional-project-job-terminal-audit-v2";
            },
          }
        : { ok: true, status: 200 };
    },
  });

  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].url.searchParams.get("limit"), "0");
  assert.match(calls[0].url.searchParams.get("select"), /lease_token/u);
  assert.equal(calls[1].options.method, "HEAD");
  assert.match(calls[1].url.pathname, /audit_events/u);
  assert.equal(calls[1].url.searchParams.get("limit"), "0");
  assert.equal(
    calls[1].url.searchParams.get("select"),
    "subject_project_id",
  );
  assert.equal(calls[2].options.method, "POST");
  assert.match(calls[2].url.pathname, /project_job_fencing_preflight/u);
  assert.equal(calls[3].options.method, "POST");
  assert.match(
    calls[3].url.pathname,
    /project_job_terminal_audit_preflight/u,
  );
  assert.equal(calls[4].options.method, "POST");
  assert.match(
    calls[4].url.pathname,
    /stable_main_rollback_bridge_preflight/u,
  );
  assert.equal(calls[5].options.method, "POST");
  assert.match(
    calls[5].url.pathname,
    /atomic_service_document_write_preflight/u,
  );
  assert.equal(result.host, "example.supabase.co");
  assert.equal(result.fencingVersion, "authoritative-lease-fencing-v1");
  assert.equal(
    result.terminalAuditVersion,
    "transactional-project-job-terminal-audit-v2",
  );
  assert.equal(
    result.rollbackBridgeVersion,
    "stable-main-rollback-bridge-v1",
  );
  assert.equal(
    result.serviceDocumentWriteVersion,
    "atomic-service-document-write-v1",
  );
});

test("remote preflight rejects a mismatched project identity before fetching", async () => {
  let fetched = false;
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://unexpected.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      expectedProjectRef: "intended",
      async fetchImpl() {
        fetched = true;
        return { ok: true, status: 200 };
      },
    }),
    /does not match SUPABASE_PROJECT_REF/u,
  );
  assert.equal(fetched, false);
});

test("remote preflight fails closed on an absent schema", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl() {
        return { ok: false, status: 400 };
      },
    }),
    /schema preflight failed with HTTP 400/u,
  );
});

test("remote preflight fails closed when authoritative fencing is absent", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl(url) {
        return url.pathname.includes("project_job_fencing_preflight")
          ? { ok: false, status: 404 }
          : { ok: true, status: 200 };
      },
    }),
    /fencing preflight failed with HTTP 404/u,
  );
});

test("remote preflight fails closed when transactional terminal audit is absent", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl(url) {
        if (url.pathname.includes("project_job_fencing_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "authoritative-lease-fencing-v1";
            },
          };
        }
        return url.pathname.includes("project_job_terminal_audit_preflight")
          ? { ok: false, status: 404 }
          : { ok: true, status: 200 };
      },
    }),
    /terminal-audit preflight failed with HTTP 404/u,
  );
});

test("remote preflight fails closed when audit subject schema is absent", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl(url) {
        return url.pathname === "/rest/v1/audit_events"
          ? { ok: false, status: 400 }
          : { ok: true, status: 200 };
      },
    }),
    /Audit-events schema preflight failed with HTTP 400/u,
  );
});

test("remote preflight fails closed when stable rollback bridge is absent", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl(url) {
        if (url.pathname.includes("project_job_fencing_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "authoritative-lease-fencing-v1";
            },
          };
        }
        if (url.pathname.includes("project_job_terminal_audit_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "transactional-project-job-terminal-audit-v2";
            },
          };
        }
        return url.pathname.includes("stable_main_rollback_bridge_preflight")
          ? { ok: false, status: 404 }
          : { ok: true, status: 200 };
      },
    }),
    /rollback bridge preflight failed with HTTP 404/u,
  );
});

test("remote preflight fails closed when atomic service-document writing is absent", async () => {
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl(url) {
        if (url.pathname.includes("project_job_fencing_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "authoritative-lease-fencing-v1";
            },
          };
        }
        if (url.pathname.includes("project_job_terminal_audit_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "transactional-project-job-terminal-audit-v2";
            },
          };
        }
        if (url.pathname.includes("stable_main_rollback_bridge_preflight")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return "stable-main-rollback-bridge-v1";
            },
          };
        }
        return url.pathname.includes("atomic_service_document_write_preflight")
          ? { ok: false, status: 404 }
          : { ok: true, status: 200 };
      },
    }),
    /service-document write preflight failed with HTTP 404/u,
  );
});
