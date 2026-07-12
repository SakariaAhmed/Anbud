import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260712131500_stable_main_rollback_bridge.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

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

function assertSucceeded(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout}`,
  );
}

test("rollback bridge SQL declares exact locked compatibility and cutover contracts", () => {
  assert.match(
    migrationSql,
    /assign_generated_artifact_insert_defaults[\s\S]*from public\.projects project[\s\S]*for update[\s\S]*max\(artifact\.artifact_version\)/u,
  );
  assert.match(migrationSql, /alter column origin set default 'legacy'/u);
  assert.match(
    migrationSql,
    /downgrade_legacy_artifact_content_update[\s\S]*old\.artifact_type = 'losningsutkast'/u,
  );
  assert.match(migrationSql, /guard_legacy_generated_artifact_delete/u);
  assert.match(
    migrationSql,
    /prepare_legacy_primary_document_insert[\s\S]*'tidligere_losning'/u,
  );
  assert.match(migrationSql, /guard_stale_stable_primary_demotion/u);
  assert.match(
    migrationSql,
    /stable_customer_analysis_context_sync[\s\S]*not analysis\.provenance_verified/u,
  );
  assert.match(
    migrationSql,
    /enforce_project_job_claim_gate[\s\S]*new\.lease_token := null[\s\S]*for share/u,
  );
  assert.match(
    migrationSql,
    /prepare_stable_main_rollback[\s\S]*'cleared_encrypted_results', v_cleared_encrypted_results/u,
  );
  const rollbackBody = migrationSql.match(
    /create or replace function public\.prepare_stable_main_rollback\(\)[\s\S]*?as \$\$(?<body>[\s\S]*?)\$\$;/u,
  )?.groups?.body;
  assert.ok(rollbackBody);
  assert.doesNotMatch(rollbackBody, /result_json\s*=\s*null/u);
  assert.match(migrationSql, /return 'stable-main-rollback-bridge-v1'/u);

  for (const relativePath of [
    "supabase/schema.sql",
    "supabase/project_jobs_durable_execution.sql",
  ]) {
    const canonicalSql = readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    const parityStart = canonicalSql.indexOf(
      "-- Compatibility and cutover contract for rolling back to stable main",
    );
    assert.notEqual(parityStart, -1, `${relativePath} is missing rollback parity`);
    assert.equal(
      canonicalSql.slice(parityStart).trim(),
      migrationSql.trim(),
      `${relativePath} must exactly match the authoritative rollback migration`,
    );
  }
});

const liveDatabaseUrl =
  process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL ??
  process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test(
  "postgres: exact stable DML stays compatible, concurrent, truthful, and cutover-safe",
  { skip: !liveDatabaseUrl, timeout: 60_000 },
  async () => {
    const databaseName = `anbud_rollback_bridge_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(liveDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;
    assertSucceeded(
      runPsql(liveDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create disposable database",
    );

    try {
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            do $$ begin
              if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
              if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
              if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
            end $$;
            create table public.projects (
              id uuid primary key,
              name text, title text, customer_name text, client_name text,
              description text, industry text,
              context_keywords text[] not null default '{}',
              customer_document_uploaded boolean not null default false,
              solution_document_uploaded boolean not null default false,
              customer_analysis_generated boolean not null default false,
              solution_evaluation_generated boolean not null default false,
              source_revision bigint not null default 0,
              artifact_source_revision bigint not null default 0,
              last_activity_at timestamptz not null default now()
            );
            create table public.documents (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              role text not null,
              supporting_subtype text,
              subtype text,
              title text not null default 'Document',
              display_name text not null default 'Document',
              file_name text not null default 'document.txt',
              file_format text not null default 'txt',
              content_type text not null default 'text/plain',
              file_size_bytes integer not null default 0,
              page_count integer,
              file_storage_bucket text not null default 'test',
              file_storage_path text,
              file_base64 text not null default '',
              raw_text text not null default '',
              structure_map jsonb not null default '[]',
              processing_status text not null default 'queued',
              processing_message text,
              processing_error text,
              parser_used text,
              indexed_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create unique index documents_one_primary_customer_per_project_idx
              on public.documents(project_id) where role = 'primary_customer_document';
            create unique index documents_one_primary_solution_per_project_idx
              on public.documents(project_id) where role = 'primary_solution_document';
            create table public.customer_analyses (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null unique references public.projects(id) on delete cascade,
              source_document_ids uuid[] not null default '{}',
              result_json jsonb not null,
              provenance_verified boolean not null default false,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.solution_evaluations (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null references public.projects(id) on delete cascade,
              evaluated_generated_artifact_id uuid,
              result_json jsonb not null default '{}',
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.executive_summaries (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null references public.projects(id) on delete cascade,
              result_json jsonb not null default '{}'
            );
            create table public.project_jobs (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null references public.projects(id) on delete cascade,
              kind text not null default 'customer_analysis',
              status text not null default 'queued',
              message text not null default '',
              error text,
              input_json jsonb,
              result_json jsonb,
              locked_at timestamptz,
              lease_token uuid,
              started_at timestamptz,
              completed_at timestamptz,
              terminal_metadata jsonb not null default '{}',
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.audit_events (
              id uuid primary key,
              action text not null,
              metadata jsonb not null default '{}'
            );
            create table public.generated_artifacts (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null references public.projects(id) on delete cascade,
              artifact_type text not null,
              title text not null,
              content_markdown text not null,
              input_snapshot jsonb not null default '{}',
              artifact_version bigint,
              generation_job_id uuid,
              generation_submission_sequence bigint,
              input_artifact_source_revision bigint,
              input_service_library_revision bigint,
              used_solution_evaluation boolean not null default false,
              input_solution_evaluation_id uuid,
              input_solution_evaluation_updated_at timestamptz,
              input_solution_evaluation_hash text,
              generator_revision text,
              origin text,
              parent_artifact_id uuid references public.generated_artifacts(id) on delete set null,
              source_snapshot_hash text,
              knowledge_base_manifest jsonb not null default '[]',
              knowledge_artifact_manifest jsonb not null default '[]',
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            alter table public.solution_evaluations add constraint solution_eval_artifact_fk
              foreign key (evaluated_generated_artifact_id) references public.generated_artifacts(id);
            create or replace function public.invalidate_project_metadata_dependents()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            declare v_changed boolean;
            begin
              v_changed := to_jsonb(old) -> 'context_keywords'
                is distinct from to_jsonb(new) -> 'context_keywords';
              if v_changed and coalesce(current_setting('anbud.persisting_customer_analysis_context', true), '') <> 'on' then
                delete from public.customer_analyses where project_id = new.id;
                delete from public.solution_evaluations where project_id = new.id;
                delete from public.executive_summaries where project_id = new.id;
              end if;
              return new;
            end $$;
            create trigger projects_analysis_input_invalidation
              after update on public.projects for each row
              execute function public.invalidate_project_metadata_dependents();
            insert into public.projects(id, name, customer_name) values
              ('00000000-0000-4000-8000-000000000001', 'P1', 'Customer'),
              ('00000000-0000-4000-8000-000000000002', 'P2', 'Customer'),
              ('00000000-0000-4000-8000-000000000003', 'P3', 'Customer');
          `,
        ),
        "create forward-schema fixture",
      );
      assertSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply rollback bridge migration",
      );

      const preflight = runPsql(
        databaseUrl.toString(),
        "select public.stable_main_rollback_bridge_preflight();",
      );
      assertSucceeded(preflight, "run exact rollback preflight");
      assert.equal(preflight.stdout.trim(), "stable-main-rollback-bridge-v1");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.generated_artifacts(project_id, artifact_type, title, content_markdown, input_snapshot)
           values
             ('00000000-0000-4000-8000-000000000001', 'forbedret_kravsvar', 'A1', 'one', '{}'),
             ('00000000-0000-4000-8000-000000000001', 'forbedret_kravsvar', 'A2', 'two', '{}');`,
        ),
        "insert exact stable artifact payloads",
      );
      const sequential = runPsql(
        databaseUrl.toString(),
        `select string_agg(artifact_version::text || ':' || origin, ',' order by artifact_version)
         from public.generated_artifacts where artifact_type = 'forbedret_kravsvar';`,
      );
      assertSucceeded(sequential, "read sequential artifact versions");
      assert.equal(sequential.stdout.trim(), "1:legacy,2:legacy");

      const concurrentArtifacts = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          runPsqlAsync(
            databaseUrl.toString(),
            `insert into public.generated_artifacts(project_id, artifact_type, title, content_markdown, input_snapshot)
             values ('00000000-0000-4000-8000-000000000001', 'forbedret_kravsvar', 'C${index}', 'body', '{}');`,
          ),
        ),
      );
      for (const [index, result] of concurrentArtifacts.entries()) {
        assertSucceeded(result, `concurrent artifact ${index}`);
      }
      const versionSet = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || count(distinct artifact_version) || ':' || min(artifact_version) || ':' || max(artifact_version)
         from public.generated_artifacts where artifact_type = 'forbedret_kravsvar';`,
      );
      assertSucceeded(versionSet, "read concurrent version set");
      assert.equal(versionSet.stdout.trim(), "8:8:1:8");
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.generated_artifacts(project_id, artifact_type, artifact_version, origin, title, content_markdown)
           values ('00000000-0000-4000-8000-000000000001', 'losningsutkast', 40, 'generated', 'Explicit', 'generated');`,
        ),
        "insert explicit feature artifact authority",
      );

      const explicitId = runPsql(
        databaseUrl.toString(),
        `select id from public.generated_artifacts where title = 'Explicit';`,
      ).stdout.trim();
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.generated_artifacts set generation_job_id = null,
             input_artifact_source_revision = 9, input_service_library_revision = 7,
             generator_revision = 'feature', source_snapshot_hash = repeat('a', 64),
             knowledge_base_manifest = '[{"id":"x"}]'
           where id = '${explicitId}';
           insert into public.solution_evaluations(project_id, evaluated_generated_artifact_id)
             values ('00000000-0000-4000-8000-000000000001', '${explicitId}');
           insert into public.executive_summaries(project_id) values
             ('00000000-0000-4000-8000-000000000001');
           update public.projects set solution_evaluation_generated = true
             where id = '00000000-0000-4000-8000-000000000001';
           update public.generated_artifacts set title = 'Stable edit', content_markdown = 'edited',
             input_snapshot = '{"edited_manually":true}' where id = '${explicitId}';`,
        ),
        "apply exact stable in-place system artifact edit",
      );
      const downgraded = runPsql(
        databaseUrl.toString(),
        `select origin || ':' || (generation_job_id is null) || ':' ||
           (input_artifact_source_revision is null) || ':' ||
           (generator_revision is null) || ':' ||
           knowledge_base_manifest::text || ':' ||
           (select count(*) from public.solution_evaluations where evaluated_generated_artifact_id = artifact.id) || ':' ||
           (select count(*) from public.executive_summaries where project_id = artifact.project_id) || ':' ||
           (select solution_evaluation_generated from public.projects where id = artifact.project_id)
         from public.generated_artifacts artifact where id = '${explicitId}';`,
      );
      assertSucceeded(downgraded, "read downgraded stable edit");
      assert.equal(downgraded.stdout.trim(), "manual_edit:true:true:true:[]:0:0:false");

      const requirementId = runPsql(
        databaseUrl.toString(),
        `select id from public.generated_artifacts where artifact_type = 'forbedret_kravsvar' order by artifact_version limit 1;`,
      ).stdout.trim();
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.solution_evaluations(project_id, result_json) values
             ('00000000-0000-4000-8000-000000000001', '{"unrelated":true}');
           insert into public.executive_summaries(project_id) values
             ('00000000-0000-4000-8000-000000000001');
           update public.projects set solution_evaluation_generated = true
             where id = '00000000-0000-4000-8000-000000000001';
           update public.generated_artifacts set content_markdown = 'requirements edit'
             where id = '${requirementId}';`,
        ),
        "edit non-system artifact without over-invalidation",
      );
      const unrelatedAuthority = runPsql(
        databaseUrl.toString(),
        `select origin || ':' ||
           (select count(*) from public.solution_evaluations where project_id = artifact.project_id) || ':' ||
           (select count(*) from public.executive_summaries where project_id = artifact.project_id) || ':' ||
           (select solution_evaluation_generated from public.projects where id = artifact.project_id)
         from public.generated_artifacts artifact where id = '${requirementId}';`,
      );
      assertSucceeded(unrelatedAuthority, "read unrelated authority state");
      assert.equal(unrelatedAuthority.stdout.trim(), "manual_edit:1:1:true");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.generated_artifacts(project_id, artifact_type, artifact_version, origin, title, content_markdown, parent_artifact_id)
           values ('00000000-0000-4000-8000-000000000001', 'losningsutkast', 41, 'manual_edit', 'Child', 'child', '${explicitId}');`,
        ),
        "insert manual child",
      );
      const guardedParentDelete = runPsql(
        databaseUrl.toString(),
        `delete from public.generated_artifacts where id = '${explicitId}';`,
      );
      assert.notEqual(guardedParentDelete.status, 0);
      assert.match(guardedParentDelete.stderr, /ARTIFACT_HAS_CHILD_VERSION/u);
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `delete from public.generated_artifacts where title = 'Child';`,
        ),
        "delete leaf artifact through stable DML",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.generated_artifacts(project_id, artifact_type, artifact_version, origin, title, content_markdown)
           values ('00000000-0000-4000-8000-000000000001', 'losningsutkast', 50, 'generated', 'Evaluated delete guard', 'body');
           insert into public.solution_evaluations(project_id, evaluated_generated_artifact_id)
           select project_id, id from public.generated_artifacts where title = 'Evaluated delete guard';`,
        ),
        "seed evaluated delete guard",
      );
      const guardedEvaluatedDelete = runPsql(
        databaseUrl.toString(),
        `delete from public.generated_artifacts where title = 'Evaluated delete guard';`,
      );
      assert.notEqual(guardedEvaluatedDelete.status, 0);
      assert.match(guardedEvaluatedDelete.stderr, /ARTIFACT_IS_EVALUATED/u);

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.documents(id, project_id, role, title)
           values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'primary_customer_document', 'Old customer');
           insert into public.documents(id, project_id, role, title)
           values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 'primary_customer_document', 'New customer');`,
        ),
        "replace customer primary with exact stable insert",
      );
      const customerPrimary = runPsql(
        databaseUrl.toString(),
        `select string_agg(id::text || ':' || role || ':' || coalesce(supporting_subtype, ''), ',' order by id)
         from public.documents where project_id = '00000000-0000-4000-8000-000000000001'
           and id in ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102');`,
      );
      assertSucceeded(customerPrimary, "read customer primary replacement");
      assert.equal(
        customerPrimary.stdout.trim(),
        "00000000-0000-4000-8000-000000000101:supporting_document:rfp,00000000-0000-4000-8000-000000000102:primary_customer_document:",
      );

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.documents(id, project_id, role, title)
           values ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000001', 'primary_solution_document', 'A');
           insert into public.documents(id, project_id, role, title)
           values ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000001', 'primary_solution_document', 'B');
           update public.documents set role = 'supporting_document', supporting_subtype = 'utkast'
             where project_id = '00000000-0000-4000-8000-000000000001'
               and role = 'primary_solution_document'
               and id <> '00000000-0000-4000-8000-000000000112';
           update public.projects set solution_document_uploaded = true, last_activity_at = clock_timestamp()
             where id = '00000000-0000-4000-8000-000000000001';
           update public.documents set role = 'supporting_document', supporting_subtype = 'utkast'
             where project_id = '00000000-0000-4000-8000-000000000001'
               and role = 'primary_solution_document'
               and id <> '00000000-0000-4000-8000-000000000111';`,
        ),
        "run delayed A follow-up after completed B replacement",
      );
      const interleavedPrimary = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(id::text) from public.documents
         where project_id = '00000000-0000-4000-8000-000000000001'
           and role = 'primary_solution_document';`,
      );
      assertSucceeded(interleavedPrimary, "read interleaved stable primary");
      assert.equal(
        interleavedPrimary.stdout.trim(),
        "1:00000000-0000-4000-8000-000000000112",
      );
      const oldSolutionSubtype = runPsql(
        databaseUrl.toString(),
        `select supporting_subtype from public.documents where id = '00000000-0000-4000-8000-000000000111';`,
      );
      assert.equal(oldSolutionSubtype.stdout.trim(), "tidligere_losning");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `select (public.insert_primary_project_document(
             '00000000-0000-4000-8000-000000000001',
             'primary_solution_document',
             '{
               "id":"00000000-0000-4000-8000-000000000113",
               "title":"Feature B",
               "file_name":"feature-b.txt",
               "file_format":"txt",
               "content_type":"text/plain",
               "file_storage_bucket":"test",
               "file_storage_path":"projects/p1/feature-b.txt"
             }'::jsonb
           )).id;`,
        ),
        "insert feature primary during mixed rollout",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents set role = 'supporting_document', supporting_subtype = 'utkast'
           where project_id = '00000000-0000-4000-8000-000000000001'
             and role = 'primary_solution_document'
             and id <> '00000000-0000-4000-8000-000000000111';`,
        ),
        "protect feature insert from delayed stable follow-up",
      );
      const mixedInsertPrimary = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(id::text) from public.documents
         where project_id = '00000000-0000-4000-8000-000000000001'
           and role = 'primary_solution_document';`,
      );
      assertSucceeded(mixedInsertPrimary, "read mixed insert authority");
      assert.equal(
        mixedInsertPrimary.stdout.trim(),
        "1:00000000-0000-4000-8000-000000000113",
      );

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.documents(id, project_id, role, supporting_subtype, subtype, title)
           values ('00000000-0000-4000-8000-000000000114',
             '00000000-0000-4000-8000-000000000001', 'supporting_document',
             'utkast', 'utkast', 'Feature promotion');
           select (public.set_primary_project_document(
             '00000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-000000000114',
             'primary_solution_document'
           )).id;`,
        ),
        "promote feature primary during mixed rollout",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents set role = 'supporting_document', supporting_subtype = 'utkast'
           where project_id = '00000000-0000-4000-8000-000000000001'
             and role = 'primary_solution_document'
             and id <> '00000000-0000-4000-8000-000000000111';`,
        ),
        "protect feature promotion from delayed stable follow-up",
      );
      const mixedPromotionPrimary = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(id::text) from public.documents
         where project_id = '00000000-0000-4000-8000-000000000001'
           and role = 'primary_solution_document';`,
      );
      assertSucceeded(mixedPromotionPrimary, "read mixed promotion authority");
      assert.equal(
        mixedPromotionPrimary.stdout.trim(),
        "1:00000000-0000-4000-8000-000000000114",
      );

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.documents(id, project_id, role, supporting_subtype, subtype, title)
           values ('00000000-0000-4000-8000-000000000115',
             '00000000-0000-4000-8000-000000000001', 'supporting_document',
             'utkast', 'utkast', 'Stable selected solution');`,
        ),
        "seed stable mark-primary candidate",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents
           set role = 'supporting_document', supporting_subtype = 'utkast'
           where project_id = '00000000-0000-4000-8000-000000000001'
             and role = 'primary_solution_document'
             and id <> '00000000-0000-4000-8000-000000000115';`,
        ),
        "run exact stable mark-primary demotion request",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents
           set role = 'primary_solution_document', supporting_subtype = null,
             updated_at = clock_timestamp()
           where project_id = '00000000-0000-4000-8000-000000000001'
             and id = '00000000-0000-4000-8000-000000000115';`,
        ),
        "run exact stable mark-primary promotion request",
      );
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.documents set role = 'supporting_document', supporting_subtype = 'utkast'
           where project_id = '00000000-0000-4000-8000-000000000001'
             and role = 'primary_solution_document'
             and id <> '00000000-0000-4000-8000-000000000111';`,
        ),
        "protect stable promoted authority from delayed upload follow-up",
      );
      const stableMarkedPrimary = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || min(id::text) from public.documents
         where project_id = '00000000-0000-4000-8000-000000000001'
           and role = 'primary_solution_document';`,
      );
      assertSucceeded(stableMarkedPrimary, "read stable marked authority");
      assert.equal(
        stableMarkedPrimary.stdout.trim(),
        "1:00000000-0000-4000-8000-000000000115",
      );

      const concurrentPrimaryInserts = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          runPsqlAsync(
            databaseUrl.toString(),
            `insert into public.documents(id, project_id, role, title)
             values ('00000000-0000-4000-8000-00000000012${index}',
               '00000000-0000-4000-8000-000000000002',
               'primary_solution_document', 'Concurrent ${index}');`,
          ),
        ),
      );
      for (const [index, result] of concurrentPrimaryInserts.entries()) {
        assertSucceeded(result, `concurrent primary insert ${index}`);
      }
      const concurrentPrimaryState = runPsql(
        databaseUrl.toString(),
        `select
           count(*) filter (where role = 'primary_solution_document') || ':' ||
           count(*) filter (
             where role = 'supporting_document'
               and supporting_subtype = 'tidligere_losning'
           )
         from public.documents
         where project_id = '00000000-0000-4000-8000-000000000002';`,
      );
      assertSucceeded(concurrentPrimaryState, "read concurrent primary state");
      assert.equal(concurrentPrimaryState.stdout.trim(), "1:5");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `delete from public.customer_analyses where project_id = '00000000-0000-4000-8000-000000000002';
           insert into public.customer_analyses(project_id, result_json)
             values ('00000000-0000-4000-8000-000000000002', '{"stable":true}');
           update public.projects set customer_analysis_generated = true,
             context_keywords = array['derived'], last_activity_at = clock_timestamp()
             where id = '00000000-0000-4000-8000-000000000002';`,
        ),
        "run exact stable customer-analysis persistence sequence",
      );
      const stableAnalysis = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses where project_id = project.id)
         from public.projects project where id = '00000000-0000-4000-8000-000000000002';`,
      );
      assertSucceeded(stableAnalysis, "read stable analysis persistence");
      assert.equal(stableAnalysis.stdout.trim(), "true:1");
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.projects set context_keywords = array['real-input-change'],
             last_activity_at = clock_timestamp()
           where id = '00000000-0000-4000-8000-000000000002';`,
        ),
        "apply ordinary stale context change",
      );
      const invalidatedAnalysis = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses where project_id = project.id)
         from public.projects project where id = '00000000-0000-4000-8000-000000000002';`,
      );
      assertSucceeded(invalidatedAnalysis, "read invalidated analysis");
      assert.equal(invalidatedAnalysis.stdout.trim(), "false:0");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.customer_analyses(project_id, result_json)
             values ('00000000-0000-4000-8000-000000000003', '{"same_keywords":true}');
           update public.projects set customer_analysis_generated = true,
             context_keywords = '{}', last_activity_at = clock_timestamp()
             where id = '00000000-0000-4000-8000-000000000003';`,
        ),
        "complete stable analysis with unchanged keywords",
      );
      const consumedNoChangeMarker = runPsql(
        databaseUrl.toString(),
        `select count(*) from public.stable_customer_analysis_context_sync
         where project_id = '00000000-0000-4000-8000-000000000003';`,
      );
      assertSucceeded(consumedNoChangeMarker, "read no-change sync marker");
      assert.equal(consumedNoChangeMarker.stdout.trim(), "0");
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.projects set context_keywords = array['later-real-change'],
             last_activity_at = clock_timestamp()
           where id = '00000000-0000-4000-8000-000000000003';`,
        ),
        "invalidate after same-keyword stable completion",
      );
      const sameKeywordInvalidation = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses where project_id = project.id)
         from public.projects project where id = '00000000-0000-4000-8000-000000000003';`,
      );
      assertSucceeded(sameKeywordInvalidation, "read same-keyword invalidation");
      assert.equal(sameKeywordInvalidation.stdout.trim(), "false:0");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.project_jobs(id, project_id, status, lease_token, locked_at, started_at)
           values ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 'running', '00000000-0000-4000-8000-000000000901', now(), now());
           insert into public.project_jobs(id, project_id, status, result_json, completed_at)
           values
             ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', 'completed', '{"plain":true}', now()),
             ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001', 'completed', '{"encrypted":true,"payload":"enc:v1:test"}', now());
           insert into public.audit_events(id, action, metadata) values
             ('00000000-0000-4000-8000-000000000202', 'project_job_completed', '{"kept":true}'),
             ('00000000-0000-4000-8000-000000000203', 'project_job_completed', '{"kept":true}');`,
        ),
        "seed cutover jobs",
      );
      const openRequeue = runPsql(
        databaseUrl.toString(),
        "select public.requeue_project_jobs_for_cutover();",
      );
      assert.notEqual(openRequeue.status, 0);
      assert.match(openRequeue.stderr, /PROJECT_JOB_CLAIMS_MUST_BE_CLOSED/u);
      const closeClaims = runPsql(
        databaseUrl.toString(),
        "select public.set_project_job_claims_enabled(false);",
      );
      assertSucceeded(closeClaims, "close project-job claims");
      assert.match(closeClaims.stdout, /project-job-cutover-v1/u);
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.project_jobs(id, project_id, status)
           values ('00000000-0000-4000-8000-000000000204',
             '00000000-0000-4000-8000-000000000001', 'queued');`,
        ),
        "allow queued job insertion while claims are closed",
      );
      const blockedQueuedClaim = runPsql(
        databaseUrl.toString(),
        `update public.project_jobs set status = 'running', locked_at = now()
         where id = '00000000-0000-4000-8000-000000000204';`,
      );
      assert.notEqual(blockedQueuedClaim.status, 0);
      assert.match(blockedQueuedClaim.stderr, /PROJECT_JOB_CLAIMS_CLOSED/u);
      const blockedClaim = runPsql(
        databaseUrl.toString(),
        `insert into public.project_jobs(project_id, status)
         values ('00000000-0000-4000-8000-000000000001', 'running');`,
      );
      assert.notEqual(blockedClaim.status, 0);
      assert.match(blockedClaim.stderr, /PROJECT_JOB_CLAIMS_CLOSED/u);
      const rollback = runPsql(
        databaseUrl.toString(),
        "select public.prepare_stable_main_rollback();",
      );
      assertSucceeded(rollback, "prepare stable rollback behind closed gate");
      assert.match(rollback.stdout, /"requeued_jobs": 1/u);
      assert.match(rollback.stdout, /"cleared_encrypted_results": 0/u);
      const cutoverState = runPsql(
        databaseUrl.toString(),
        `select string_agg(id::text || ':' || status || ':' ||
           (lease_token is null) || ':' || coalesce(result_json::text, 'NULL'), ',' order by id)
         from public.project_jobs where id in (
           '00000000-0000-4000-8000-000000000201',
           '00000000-0000-4000-8000-000000000202',
           '00000000-0000-4000-8000-000000000203'
         );`,
      );
      assertSucceeded(cutoverState, "read cutover job state");
      assert.match(cutoverState.stdout, /201:queued:true:NULL/u);
      assert.match(cutoverState.stdout, /202:completed:true:\{"plain": true\}/u);
      assert.match(
        cutoverState.stdout,
        /203:completed:true:\{"payload": "enc:v1:test", "encrypted": true\}/u,
      );
      const preservedAudit = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || bool_and(metadata = '{"kept":true}'::jsonb)
         from public.audit_events;`,
      );
      assertSucceeded(preservedAudit, "verify terminal audit preservation");
      assert.equal(preservedAudit.stdout.trim(), "2:true");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          `select public.set_project_job_claims_enabled(true);
           update public.project_jobs set status = 'running', locked_at = now()
             where id = '00000000-0000-4000-8000-000000000201';
           update public.project_jobs set status = 'queued', message = 'stable reset'
             where id = '00000000-0000-4000-8000-000000000201';
           update public.project_jobs set status = 'running', locked_at = now()
             where id = '00000000-0000-4000-8000-000000000201';`,
        ),
        "run exact stable reset and reclaim sequence",
      );
      const staleLease = runPsql(
        databaseUrl.toString(),
        `with heartbeat as (
           update public.project_jobs set locked_at = now()
           where id = '00000000-0000-4000-8000-000000000201'
             and status = 'running'
             and lease_token = '00000000-0000-4000-8000-000000000901'
           returning id
         ) select (select lease_token is null from public.project_jobs
           where id = '00000000-0000-4000-8000-000000000201') || ':' || count(*)
           from heartbeat;`,
      );
      assertSucceeded(staleLease, "verify retired lease cannot revive");
      assert.equal(staleLease.stdout.trim(), "true:0");

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.generated_artifacts alter column origin drop default;",
        ),
        "corrupt required origin default",
      );
      const wrongDefaultPreflight = runPsql(
        databaseUrl.toString(),
        "select public.stable_main_rollback_bridge_preflight();",
      );
      assert.notEqual(wrongDefaultPreflight.status, 0);
      assert.match(wrongDefaultPreflight.stderr, /origin or its legacy default/u);
      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.generated_artifacts alter column origin set default 'legacy';",
        ),
        "restore required origin default",
      );

      assertSucceeded(
        runPsql(
          databaseUrl.toString(),
          "alter table public.generated_artifacts disable trigger generated_artifacts_insert_defaults;",
        ),
        "disable required bridge trigger",
      );
      const brokenPreflight = runPsql(
        databaseUrl.toString(),
        "select public.stable_main_rollback_bridge_preflight();",
      );
      assert.notEqual(brokenPreflight.status, 0);
      assert.match(brokenPreflight.stderr, /trigger definitions/u);
    } finally {
      runPsql(
        liveDatabaseUrl,
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${databaseName}' and pid <> pg_backend_pid();`,
      );
      runPsql(liveDatabaseUrl, `drop database if exists ${quotedDatabaseName}`);
    }
  },
);
