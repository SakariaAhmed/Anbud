import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260712133000_atomic_service_document_write.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const storeSource = readFileSync(
  path.join(
    repositoryRoot,
    "apps/frontend/lib/server/repositories/supabase-store.ts",
  ),
  "utf8",
);
const canonicalSchema = readFileSync(
  path.join(repositoryRoot, "supabase/schema.sql"),
  "utf8",
);
const durableSchema = readFileSync(
  path.join(repositoryRoot, "supabase/project_jobs_durable_execution.sql"),
  "utf8",
);

test("service-document writer is atomic, service-only, and used by the repository", () => {
  assert.match(
    migrationSql,
    /function public\.insert_service_document_with_keywords\(\s*p_service_id uuid,\s*p_payload jsonb,\s*p_keywords text\[\]/u,
  );
  assert.match(
    migrationSql,
    /insert into public\.service_documents[\s\S]*update public\.service_descriptions/u,
  );
  assert.match(migrationSql, /anbud\.service_library_invalidated/u);
  assert.match(
    migrationSql,
    /nullif\(btrim\(p_payload ->> 'file_storage_path'\), ''\) is null/u,
  );
  assert.match(
    migrationSql,
    /revoke execute on function public\.insert_service_document_with_keywords\([\s\S]*from public, anon, authenticated/u,
  );
  assert.match(
    storeSource,
    /export async function saveServiceDocument[\s\S]*\.rpc\(\s*"insert_service_document_with_keywords"/u,
  );
  for (const [label, source] of [
    ["fresh schema", canonicalSchema],
    ["durable repair schema", durableSchema],
  ]) {
    assert.match(
      source,
      /function public\.insert_service_document_with_keywords\(\s*p_service_id uuid,\s*p_payload jsonb,\s*p_keywords text\[\]/u,
      `${label} must include the atomic writer`,
    );
    assert.match(
      source,
      /function public\.atomic_service_document_write_preflight\(\)/u,
      `${label} must include the remote preflight`,
    );
  }
  const saveBody = storeSource.match(
    /export async function saveServiceDocument[\s\S]*?\n\}\n\nexport async function/u,
  )?.[0];
  assert.ok(saveBody);
  assert.doesNotMatch(
    saveBody,
    /\.from\("service_documents"\)\s*\.insert/u,
  );
  assert.doesNotMatch(
    saveBody,
    /\.from\("service_descriptions"\)\s*\.update/u,
  );
});

function runPsql(databaseUrl, sql) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8" },
  );
}

function runPsqlFile(databaseUrl, filePath) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath],
    { encoding: "utf8" },
  );
}

function runPsqlAsync(databaseUrl, sql) {
  return new Promise((resolve) => {
    const child = spawn(
      "psql",
      [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function assertPsqlSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

const liveDatabaseUrl = process.env.SERVICE_DOCUMENT_SQL_TEST_DATABASE_URL;

test(
  "postgres: one document write causes one global invalidation and concurrent keywords do not get lost",
  { skip: !liveDatabaseUrl, timeout: 45_000 },
  async () => {
    const databaseName = `anbud_service_document_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(liveDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;

    assertPsqlSucceeded(
      runPsql(liveDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create disposable database",
    );

    try {
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create table public.projects (
              id uuid primary key,
              source_revision bigint not null default 0,
              artifact_source_revision bigint not null default 0,
              customer_analysis_generated boolean not null default true,
              solution_evaluation_generated boolean not null default true
            );
            create table public.customer_analyses (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null
            );
            create table public.solution_evaluations (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null
            );
            create table public.executive_summaries (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null
            );
            create table public.artifact_source_state (
              singleton boolean primary key default true check (singleton),
              service_library_revision bigint not null default 0,
              updated_at timestamptz not null default now()
            );
            insert into public.artifact_source_state(singleton) values (true);
            create table public.service_descriptions (
              id uuid primary key,
              name text not null,
              description text not null default '',
              keywords text[] not null default '{}',
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.service_documents (
              id uuid primary key,
              service_id uuid not null references public.service_descriptions(id) on delete cascade,
              title text not null default 'Tjenestedokument',
              file_name text not null default 'document.txt',
              file_format text not null default 'txt',
              content_type text not null default 'application/octet-stream',
              file_size_bytes integer not null default 0,
              page_count integer,
              file_storage_bucket text not null default 'anbud-documents',
              file_storage_path text,
              file_base64 text not null default '',
              raw_text text not null default '',
              structure_map jsonb not null default '[]'::jsonb,
              ai_summary text not null default '',
              ai_summary_updated_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );

            create or replace function public.bump_service_library_revision()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            begin
              if tg_op = 'UPDATE'
                 and (to_jsonb(old) - 'updated_at')
                   is not distinct from (to_jsonb(new) - 'updated_at') then
                return new;
              end if;
              if coalesce(
                   current_setting('anbud.service_library_invalidated', true),
                   ''
                 ) = 'on' then
                if tg_op = 'DELETE' then return old; end if;
                return new;
              end if;
              perform set_config('anbud.service_library_invalidated', 'on', true);
              perform 1 from public.projects project order by project.id for no key update;
              update public.projects
              set source_revision = source_revision + 1,
                  artifact_source_revision = artifact_source_revision + 1,
                  customer_analysis_generated = false,
                  solution_evaluation_generated = false;
              delete from public.customer_analyses;
              delete from public.solution_evaluations;
              delete from public.executive_summaries;
              update public.artifact_source_state
              set service_library_revision = service_library_revision + 1,
                  updated_at = now()
              where singleton = true;
              if tg_op = 'DELETE' then return old; end if;
              return new;
            end;
            $$;
            create trigger service_descriptions_artifact_source_revision
              after insert or update or delete on public.service_descriptions
              for each row execute function public.bump_service_library_revision();
            create trigger service_documents_artifact_source_revision
              after insert or update or delete on public.service_documents
              for each row execute function public.bump_service_library_revision();

            insert into public.projects(id)
            select ('00000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid
            from generate_series(1, 10) value;
            insert into public.customer_analyses(project_id) select id from public.projects;
            insert into public.solution_evaluations(project_id) select id from public.projects;
            insert into public.executive_summaries(project_id) select id from public.projects;
            insert into public.service_descriptions(id, name, keywords)
            values (
              '10000000-0000-4000-8000-000000000001',
              'Managed service',
              array['existing']
            );
            update public.projects
            set source_revision = 0,
                artifact_source_revision = 0,
                customer_analysis_generated = true,
                solution_evaluation_generated = true;
            update public.artifact_source_state set service_library_revision = 0;
            insert into public.customer_analyses(project_id)
              select id from public.projects
              on conflict do nothing;
            insert into public.solution_evaluations(project_id)
              select id from public.projects
              on conflict do nothing;
            insert into public.executive_summaries(project_id)
              select id from public.projects
              on conflict do nothing;
          `,
        ),
        "create SQL fixture",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply atomic service-document migration",
      );

      const missingStoragePath = runPsql(
        databaseUrl.toString(),
        `select public.insert_service_document_with_keywords(
          '10000000-0000-4000-8000-000000000001',
          jsonb_build_object(
            'id', '20000000-0000-4000-8000-000000000099',
            'service_id', '10000000-0000-4000-8000-000000000001',
            'title', 'missing path',
            'file_name', 'missing.txt',
            'file_format', 'txt',
            'content_type', 'text/plain',
            'file_storage_bucket', 'documents'
          ),
          '{}'::text[]
        );`,
      );
      assert.notEqual(missingStoragePath.status, 0);
      assert.match(
        missingStoragePath.stderr,
        /SERVICE_DOCUMENT_PAYLOAD_INVALID/u,
      );
      const stateAfterRejectedWrite = runPsql(
        databaseUrl.toString(),
        `select
           (select count(*) from public.service_documents) || ':' ||
           (select service_library_revision from public.artifact_source_state);`,
      );
      assertPsqlSucceeded(
        stateAfterRejectedWrite,
        "verify rejected write is side-effect free",
      );
      assert.equal(stateAfterRejectedWrite.stdout.trim(), "0:0");

      const insertCall = (documentId, keyword) => `
        select (public.insert_service_document_with_keywords(
          '10000000-0000-4000-8000-000000000001',
          jsonb_build_object(
            'id', '${documentId}',
            'service_id', '10000000-0000-4000-8000-000000000001',
            'title', '${keyword} document',
            'file_name', '${keyword}.txt',
            'file_format', 'txt',
            'content_type', 'text/plain',
            'file_size_bytes', 10,
            'file_storage_bucket', 'documents',
            'file_storage_path', 'services/${keyword}.txt',
            'file_base64', '',
            'raw_text', 'encrypted',
            'structure_map', '[]'::jsonb
          ),
          array['${keyword}']
        )).id;
      `;
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          insertCall("20000000-0000-4000-8000-000000000001", "alpha"),
        ),
        "insert first service document",
      );
      const oneInvalidation = runPsql(
        databaseUrl.toString(),
        `select
           (select min(source_revision) from public.projects) || ':' ||
           (select max(source_revision) from public.projects) || ':' ||
           (select service_library_revision from public.artifact_source_state) || ':' ||
           (select array_to_string(keywords, ',') from public.service_descriptions) || ':' ||
           (select count(*) from public.customer_analyses) || ':' ||
           public.atomic_service_document_write_preflight();`,
      );
      assertPsqlSucceeded(oneInvalidation, "verify first atomic write");
      assert.equal(
        oneInvalidation.stdout.trim(),
        "1:1:1:existing,alpha:0:atomic-service-document-write-v1",
      );

      const [left, right] = await Promise.all([
        runPsqlAsync(
          databaseUrl.toString(),
          insertCall("20000000-0000-4000-8000-000000000002", "bravo"),
        ),
        runPsqlAsync(
          databaseUrl.toString(),
          insertCall("20000000-0000-4000-8000-000000000003", "charlie"),
        ),
      ]);
      assertPsqlSucceeded(left, "concurrent service document A");
      assertPsqlSucceeded(right, "concurrent service document B");

      const concurrentState = runPsql(
        databaseUrl.toString(),
        `select
           (select min(source_revision) from public.projects) || ':' ||
           (select max(source_revision) from public.projects) || ':' ||
           (select service_library_revision from public.artifact_source_state) || ':' ||
           (select array_to_string(array(
              select keyword
              from unnest(keywords) keyword
              order by keyword
            ), ',') from public.service_descriptions);`,
      );
      assertPsqlSucceeded(concurrentState, "verify concurrent keyword merge");
      assert.equal(
        concurrentState.stdout.trim(),
        "3:3:3:alpha,bravo,charlie,existing",
      );

      const acl = runPsql(
        databaseUrl.toString(),
        `select
           has_function_privilege('service_role', 'public.insert_service_document_with_keywords(uuid,jsonb,text[])', 'EXECUTE') || ':' ||
           has_function_privilege('anon', 'public.insert_service_document_with_keywords(uuid,jsonb,text[])', 'EXECUTE') || ':' ||
           has_function_privilege('authenticated', 'public.insert_service_document_with_keywords(uuid,jsonb,text[])', 'EXECUTE');`,
      );
      assertPsqlSucceeded(acl, "verify service-only ACL");
      assert.equal(acl.stdout.trim(), "true:false:false");
    } finally {
      const cleanup = runPsql(
        liveDatabaseUrl,
        `drop database if exists ${quotedDatabaseName} with (force)`,
      );
      assertPsqlSucceeded(cleanup, "drop disposable database");
    }
  },
);
