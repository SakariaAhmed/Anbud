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
  add column if not exists parent_job_id uuid,
  add column if not exists idempotency_key text;
create index if not exists project_jobs_queue_claim_idx on public.project_jobs(status, locked_at, created_at);
create index if not exists project_jobs_running_lease_idx on public.project_jobs(id, lease_token);
create index if not exists project_jobs_parent_job_idx on public.project_jobs(parent_job_id);
create or replace function public.lease_fenced_project_write() returns void language sql as 'select';
create or replace function public.lease_fenced_enqueue_project_job() returns void language sql as 'select';
create or replace function public.project_job_fencing_preflight() returns text language sql as 'select';
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
      return url.pathname.includes("project_job_fencing_preflight")
        ? {
            ok: true,
            status: 200,
            async json() {
              return "authoritative-lease-fencing-v1";
            },
          }
        : { ok: true, status: 200 };
    },
  });

  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].url.searchParams.get("limit"), "0");
  assert.match(calls[0].url.searchParams.get("select"), /lease_token/u);
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url.pathname, /project_job_fencing_preflight/u);
  assert.equal(result.host, "example.supabase.co");
  assert.equal(result.fencingVersion, "authoritative-lease-fencing-v1");
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
  let calls = 0;
  await assert.rejects(
    preflightRemoteProjectJobSchema({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "synthetic-test-key",
      async fetchImpl() {
        calls += 1;
        return calls === 1
          ? { ok: true, status: 200 }
          : { ok: false, status: 404 };
      },
    }),
    /fencing preflight failed with HTTP 404/u,
  );
});
