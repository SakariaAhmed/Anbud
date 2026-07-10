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
  add column if not exists completed_at timestamptz;
create index if not exists project_jobs_queue_claim_idx on public.project_jobs(status, locked_at, created_at);
create index if not exists project_jobs_running_lease_idx on public.project_jobs(id, lease_token);
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
      return { ok: true, status: 200 };
    },
  });

  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].url.searchParams.get("limit"), "0");
  assert.match(calls[0].url.searchParams.get("select"), /lease_token/u);
  assert.equal(result.host, "example.supabase.co");
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
