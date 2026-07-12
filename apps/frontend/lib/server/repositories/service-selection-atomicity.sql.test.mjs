import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const frontendRoot = path.join(repositoryRoot, "apps/frontend");
const migrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260711134500_atomic_project_service_selections.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const canonicalSchemaSql = readFileSync(
  path.join(repositoryRoot, "supabase/schema.sql"),
  "utf8",
);

function sqlFunctionBody(name) {
  return migrationSql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$(?<body>[\\s\\S]*?)\\$\\$;`,
      "u",
    ),
  )?.groups?.body;
}

test("service selection replacement is one locked, validated RPC with fail-closed invalidation", () => {
  const replacementBody = sqlFunctionBody(
    "replace_project_service_selections",
  );
  assert.ok(replacementBody, "atomic selection RPC is missing");

  const projectLock = replacementBody.indexOf("from public.projects project");
  const serviceValidation = replacementBody.indexOf(
    "from public.service_descriptions service",
  );
  const noOpReturn = replacementBody.indexOf(
    "if v_current_rows_are_canonical and v_current_ids = v_requested_ids",
  );
  const firstMutation = replacementBody.indexOf(
    "delete from public.project_service_selections",
  );
  const selectionTableLock = replacementBody.indexOf(
    "lock table public.project_service_selections",
  );
  assert.ok(serviceValidation >= 0 && serviceValidation < projectLock);
  assert.ok(selectionTableLock > serviceValidation && selectionTableLock < projectLock);
  assert.ok(projectLock < firstMutation);
  assert.ok(noOpReturn < firstMutation);
  assert.match(replacementBody, /for update/u);
  assert.match(replacementBody, /for key share/u);
  assert.match(replacementBody, /pg_advisory_xact_lock/u);
  assert.match(replacementBody, /in share row exclusive mode/u);
  assert.match(
    replacementBody,
    /from public\.project_service_selections selection[\s\S]*selection\.service_id = service\.id/u,
  );
  assert.match(replacementBody, /PROJECT_SERVICE_SELECTION_INVALID/u);
  assert.match(replacementBody, /'changed', false/u);
  assert.match(replacementBody, /'changed', true/u);
  assert.match(replacementBody, /replacing_project_service_selections/u);
  assert.match(
    replacementBody,
    /update public\.projects[\s\S]*source_revision = source_revision \+ 1/u,
  );

  const triggerBody = sqlFunctionBody(
    "bump_artifact_revision_from_service_selection",
  );
  assert.ok(triggerBody, "selection invalidation trigger is missing");
  assert.match(triggerBody, /source_revision = source_revision \+ 1/u);
  assert.match(triggerBody, /replacing_project_service_selections/u);
  assert.match(
    triggerBody,
    /artifact_source_revision = artifact_source_revision \+ 1/u,
  );
  assert.match(triggerBody, /customer_analysis_generated = false/u);
  assert.match(triggerBody, /solution_evaluation_generated = false/u);
  assert.match(triggerBody, /delete from public\.customer_analyses/u);
  assert.match(triggerBody, /delete from public\.solution_evaluations/u);
  assert.match(triggerBody, /delete from public\.executive_summaries/u);
  assert.ok(
    triggerBody.indexOf("update public.projects") <
      triggerBody.indexOf("delete from public.customer_analyses"),
    "project row must be locked before dependent invalidation",
  );

  const serviceLibraryBody = sqlFunctionBody("bump_service_library_revision");
  assert.ok(serviceLibraryBody, "service-library invalidation trigger is missing");
  assert.match(
    serviceLibraryBody,
    /from public\.projects project[\s\S]*order by project\.id[\s\S]*for no key update/u,
  );
  assert.match(serviceLibraryBody, /update public\.projects/u);
  assert.match(serviceLibraryBody, /source_revision = source_revision \+ 1/u);
  assert.match(serviceLibraryBody, /delete from public\.customer_analyses/u);
  assert.match(serviceLibraryBody, /delete from public\.solution_evaluations/u);
  assert.match(serviceLibraryBody, /delete from public\.executive_summaries/u);
  assert.match(serviceLibraryBody, /service_library_invalidated/u);
  assert.match(serviceLibraryBody, /if tg_op = 'DELETE' then return old/u);
  assert.match(serviceLibraryBody, /return new/u);
  assert.match(
    migrationSql,
    /service_descriptions_artifact_source_revision[\s\S]*for each row execute function public\.bump_service_library_revision/u,
  );
  assert.match(
    migrationSql,
    /service_documents_artifact_source_revision[\s\S]*for each row execute function public\.bump_service_library_revision/u,
  );

  const immutableIdentityBody = sqlFunctionBody(
    "reject_project_service_selection_identity_change",
  );
  assert.ok(immutableIdentityBody);
  assert.match(immutableIdentityBody, /old\.project_id is distinct from new\.project_id/u);
  assert.match(immutableIdentityBody, /old\.service_id is distinct from new\.service_id/u);
  assert.match(immutableIdentityBody, /PROJECT_SERVICE_SELECTION_IDENTITY_IMMUTABLE/u);
  assert.ok(
    serviceLibraryBody.indexOf("update public.projects") <
      serviceLibraryBody.indexOf("update public.artifact_source_state"),
    "project locks must precede the global artifact-state lock",
  );

  const metadataBody = sqlFunctionBody(
    "bump_artifact_revision_from_project_metadata",
  );
  const metadataInvalidationBody = sqlFunctionBody(
    "invalidate_project_metadata_dependents",
  );
  assert.ok(metadataBody && metadataInvalidationBody);
  for (const field of [
    "name",
    "title",
    "customer_name",
    "client_name",
    "description",
    "industry",
    "context_keywords",
  ]) {
    assert.match(metadataBody, new RegExp(`'${field}'`, "u"));
  }
  assert.doesNotMatch(
    metadataBody,
    /'last_activity_at',\s*to_jsonb\((?:old|new)\)/u,
  );
  assert.match(metadataBody, /new\.source_revision := old\.source_revision \+ 1/u);
  assert.match(metadataInvalidationBody, /delete from public\.customer_analyses/u);
  assert.match(metadataInvalidationBody, /persisting_customer_analysis_context/u);

  const saveAnalysisBody = sqlFunctionBody(
    "save_customer_analysis_if_source_revision",
  );
  assert.ok(saveAnalysisBody, "customer-analysis save override is missing");
  assert.match(saveAnalysisBody, /persisting_customer_analysis_context/u);
  assert.ok(
    saveAnalysisBody.indexOf("set_config") <
      saveAnalysisBody.indexOf("update public.projects"),
    "analysis context marker must be active during the project update",
  );

  assert.match(
    migrationSql,
    /revoke execute on function public\.replace_project_service_selections\(uuid, uuid\[\]\)[\s\S]*from public, anon, authenticated/u,
  );
  assert.match(
    migrationSql,
    /grant execute on function public\.replace_project_service_selections\(uuid, uuid\[\]\)[\s\S]*to service_role/u,
  );

  const storeSource = readFileSync(
    path.join(
      frontendRoot,
      "lib/server/repositories/supabase-store.ts",
    ),
    "utf8",
  );
  const storeBody = storeSource.match(
    /export async function setProjectServiceSelections\((?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  assert.ok(storeBody, "store selection function is missing");
  assert.match(storeBody, /\.rpc\("replace_project_service_selections"/u);
  assert.doesNotMatch(storeBody, /\.delete\(|\.insert\(/u);
  assert.doesNotMatch(storeBody, /listServiceDescriptions/u);

  assert.match(
    canonicalSchemaSql,
    /create or replace function public\.replace_project_service_selections/u,
  );
  assert.match(canonicalSchemaSql, /PROJECT_SERVICE_SELECTION_INVALID/u);
  const canonicalDocumentTrigger = canonicalSchemaSql.match(
    /create or replace function public\.bump_project_source_revision_from_document\(\)(?<definition>[\s\S]*?)\$\$;/u,
  )?.groups?.definition;
  const canonicalSelectionTrigger = canonicalSchemaSql.match(
    /create or replace function public\.bump_artifact_revision_from_service_selection\(\)(?<definition>[\s\S]*?)\$\$;/u,
  )?.groups?.definition;
  assert.ok(canonicalDocumentTrigger && canonicalSelectionTrigger);
  assert.doesNotMatch(canonicalDocumentTrigger, /old\.selected|new\.selected/u);
  assert.match(canonicalSelectionTrigger, /old\.selected is not distinct from new\.selected/u);
  for (const relativePath of [
    "supabase/schema.sql",
    "supabase/project_jobs_durable_execution.sql",
  ]) {
    const bootstrapSql = readFileSync(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.match(bootstrapSql, /persisting_customer_analysis_context/u);
    assert.match(
      bootstrapSql,
      /return public\.save_customer_analysis_if_source_revision\(p_project_id, p_payload\)/u,
    );
  }

  const workflowSource = readFileSync(
    path.join(
      frontendRoot,
      "lib/server/use-cases/project-workflows.ts",
    ),
    "utf8",
  );
  const workflowAnalysisBody = workflowSource.match(
    /async function runCustomerAnalysisWorkflow\((?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  assert.ok(workflowAnalysisBody);
  assert.match(workflowAnalysisBody, /readStableProjectSourceSnapshot/u);
  assert.match(workflowAnalysisBody, /listProjectServiceDescriptions/u);
  assert.doesNotMatch(
    workflowAnalysisBody,
    /const \[documentSnapshot, serviceCandidates\] = await Promise\.all/u,
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

const liveDatabaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test(
  "postgres: selection replacement no-op, validation, rollback, invalidation, ACL, and concurrency",
  { skip: !liveDatabaseUrl, timeout: 30_000 },
  async () => {
    const databaseName = `anbud_service_selection_${randomUUID().replaceAll("-", "")}`;
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
              title text not null default 'Project',
              client_name text not null default 'Customer',
              description text not null default '',
              context_keywords text[] not null default '{}',
              source_revision bigint not null default 0,
              artifact_source_revision bigint not null default 0,
              customer_analysis_generated boolean not null default true,
              solution_evaluation_generated boolean not null default true,
              last_activity_at timestamptz not null default now()
            );
            create table public.documents (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              role text not null,
              supporting_subtype text,
              subtype text
            );
            create table public.service_descriptions (
              id uuid primary key,
              name text not null default 'Service',
              description text not null default ''
            );
            create table public.service_documents (
              id uuid primary key,
              service_id uuid not null references public.service_descriptions(id) on delete cascade,
              title text not null default 'Document'
            );
            create table public.artifact_source_state (
              singleton boolean primary key default true check (singleton),
              service_library_revision bigint not null default 0,
              updated_at timestamptz not null default now()
            );
            create table public.project_service_selections (
              project_id uuid not null references public.projects(id) on delete cascade,
              service_id uuid not null references public.service_descriptions(id) on delete cascade,
              selected boolean not null default true,
              primary key (project_id, service_id)
            );
            create table public.customer_analyses (
              id uuid primary key default gen_random_uuid(),
              project_id uuid not null unique references public.projects(id) on delete cascade,
              source_document_ids uuid[] not null default '{}',
              result_json jsonb not null default '{}',
              provenance_verified boolean not null default false,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.solution_evaluations (
              id uuid primary key,
              project_id uuid not null unique references public.projects(id) on delete cascade
            );
            create table public.executive_summaries (
              id uuid primary key,
              project_id uuid not null unique references public.projects(id) on delete cascade
            );
            create table public.project_jobs (
              id uuid primary key,
              project_id uuid not null references public.projects(id) on delete cascade,
              kind text not null,
              status text not null,
              lease_token uuid,
              submission_sequence bigint not null default 0
            );
            insert into public.artifact_source_state(singleton) values (true);
            insert into public.projects(id) values ('00000000-0000-4000-8000-000000000001');
            insert into public.service_descriptions(id) values
              ('00000000-0000-4000-8000-000000000011'),
              ('00000000-0000-4000-8000-000000000012'),
              ('00000000-0000-4000-8000-000000000013'),
              ('00000000-0000-4000-8000-000000000014');
            insert into public.project_service_selections(project_id, service_id) values
              ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011');
            insert into public.customer_analyses(id, project_id) values
              ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001');
            insert into public.solution_evaluations values
              ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000001');
            insert into public.executive_summaries values
              ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000001');

            create or replace function public.bump_service_library_revision()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            begin
              update public.artifact_source_state
              set service_library_revision = service_library_revision + 1
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

            create or replace function public.invalidate_customer_analysis_dependents()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            begin
              update public.projects
              set source_revision = source_revision + 1,
                  artifact_source_revision = artifact_source_revision + 1,
                  solution_evaluation_generated = false
              where id = case when tg_op = 'DELETE' then old.project_id else new.project_id end;
              delete from public.solution_evaluations
              where project_id = case when tg_op = 'DELETE' then old.project_id else new.project_id end;
              delete from public.executive_summaries
              where project_id = case when tg_op = 'DELETE' then old.project_id else new.project_id end;
              if tg_op = 'DELETE' then return old; end if;
              return new;
            end;
            $$;
            create trigger customer_analysis_invalidates_dependents
            after insert or update or delete on public.customer_analyses
            for each row execute function public.invalidate_customer_analysis_dependents();

            create or replace function public.lease_fenced_save_customer_analysis(
              p_job_id uuid,
              p_lease_token uuid,
              p_project_id uuid,
              p_payload jsonb
            )
            returns jsonb language plpgsql security invoker set search_path = '' as $$
            declare v_job public.project_jobs%rowtype;
            begin
              select * into v_job from public.project_jobs
              where id = p_job_id and project_id = p_project_id
                and status = 'running' and lease_token = p_lease_token
              for update;
              if not found then
                raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST';
              end if;
              if v_job.kind not in ('customer_analysis', 'high_level_design') then
                raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH';
              end if;
              if exists (
                select 1 from public.project_jobs newer_job
                where newer_job.project_id = p_project_id
                  and newer_job.kind in ('customer_analysis', 'high_level_design')
                  and newer_job.submission_sequence > v_job.submission_sequence
              ) then
                raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED';
              end if;
              return public.save_customer_analysis_if_source_revision(p_project_id, p_payload);
            end;
            $$;
          `,
        ),
        "create selection fixture",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply service selection migration",
      );

      const noOp = runPsql(
        databaseUrl.toString(),
        `select public.replace_project_service_selections(
          '00000000-0000-4000-8000-000000000001',
          array[
            '00000000-0000-4000-8000-000000000011'::uuid,
            '00000000-0000-4000-8000-000000000011'::uuid
          ]
        ) ->> 'changed';`,
      );
      assertPsqlSucceeded(noOp, "save canonical no-op");
      assert.equal(noOp.stdout.trim(), "false");
      const unchanged = runPsql(
        databaseUrl.toString(),
        `select source_revision || ':' || artifact_source_revision || ':' ||
          customer_analysis_generated || ':' || solution_evaluation_generated || ':' ||
          (select count(*) from public.customer_analyses) || ':' ||
          (select count(*) from public.solution_evaluations) || ':' ||
          (select count(*) from public.executive_summaries)
         from public.projects;`,
      );
      assertPsqlSucceeded(unchanged, "verify no-op preservation");
      assert.equal(unchanged.stdout.trim(), "0:0:true:true:1:1:1");

      const invalid = runPsql(
        databaseUrl.toString(),
        `select public.replace_project_service_selections(
          '00000000-0000-4000-8000-000000000001',
          array['00000000-0000-4000-8000-000000000099'::uuid]
        );`,
      );
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /PROJECT_SERVICE_SELECTION_INVALID/u);
      assert.equal(
        runPsql(
          databaseUrl.toString(),
          "select service_id from public.project_service_selections;",
        ).stdout.trim(),
        "00000000-0000-4000-8000-000000000011",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create or replace function public.reject_service_selection()
            returns trigger language plpgsql as $$
            begin
              if new.service_id = '00000000-0000-4000-8000-000000000012'::uuid then
                raise exception 'forced selection failure';
              end if;
              return new;
            end;
            $$;
            create trigger reject_service_selection
            before insert on public.project_service_selections
            for each row execute function public.reject_service_selection();
          `,
        ),
        "install rollback trigger",
      );
      const failedReplacement = runPsql(
        databaseUrl.toString(),
        `select public.replace_project_service_selections(
          '00000000-0000-4000-8000-000000000001',
          array['00000000-0000-4000-8000-000000000012'::uuid]
        );`,
      );
      assert.notEqual(failedReplacement.status, 0);
      assert.match(failedReplacement.stderr, /forced selection failure/u);
      const rolledBack = runPsql(
        databaseUrl.toString(),
        `select source_revision || ':' || artifact_source_revision || ':' ||
          (select string_agg(service_id::text, ',' order by service_id) from public.project_service_selections) || ':' ||
          (select count(*) from public.customer_analyses) || ':' ||
          (select count(*) from public.solution_evaluations) || ':' ||
          (select count(*) from public.executive_summaries)
         from public.projects;`,
      );
      assertPsqlSucceeded(rolledBack, "verify full transaction rollback");
      assert.equal(
        rolledBack.stdout.trim(),
        "0:0:00000000-0000-4000-8000-000000000011:1:1:1",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `drop trigger reject_service_selection on public.project_service_selections;
           drop function public.reject_service_selection();`,
        ),
        "remove rollback trigger",
      );
      const changed = runPsql(
        databaseUrl.toString(),
        `select public.replace_project_service_selections(
          '00000000-0000-4000-8000-000000000001',
          array[
            '00000000-0000-4000-8000-000000000012'::uuid,
            '00000000-0000-4000-8000-000000000013'::uuid
          ]
        ) ->> 'changed';`,
      );
      assertPsqlSucceeded(changed, "replace selection set");
      assert.equal(changed.stdout.trim(), "true");
      const invalidated = runPsql(
        databaseUrl.toString(),
        `select source_revision || ':' || artifact_source_revision || ':' ||
          customer_analysis_generated || ':' || solution_evaluation_generated || ':' ||
          (select string_agg(service_id::text, ',' order by service_id) from public.project_service_selections) || ':' ||
          (select count(*) from public.customer_analyses) || ':' ||
          (select count(*) from public.solution_evaluations) || ':' ||
          (select count(*) from public.executive_summaries)
         from public.projects;`,
      );
      assertPsqlSucceeded(invalidated, "verify changed-set invalidation");
      assert.equal(
        invalidated.stdout.trim(),
        "1:1:false:false:00000000-0000-4000-8000-000000000012,00000000-0000-4000-8000-000000000013:0:0:0",
      );

      const acl = runPsql(
        databaseUrl.toString(),
        `select
          has_function_privilege('anon', 'public.replace_project_service_selections(uuid,uuid[])', 'execute') || ':' ||
          has_function_privilege('authenticated', 'public.replace_project_service_selections(uuid,uuid[])', 'execute') || ':' ||
          has_function_privilege('service_role', 'public.replace_project_service_selections(uuid,uuid[])', 'execute');`,
      );
      assertPsqlSucceeded(acl, "verify RPC ACL");
      assert.equal(acl.stdout.trim(), "false:false:true");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            create or replace function public.slow_service_selection()
            returns trigger language plpgsql as $$
            begin
              perform pg_sleep(0.15);
              return new;
            end;
            $$;
            create trigger slow_service_selection
            before insert on public.project_service_selections
            for each row execute function public.slow_service_selection();
          `,
        ),
        "install overlap trigger",
      );
      const concurrentResults = await Promise.all([
        runPsqlAsync(
          databaseUrl.toString(),
          `select public.replace_project_service_selections(
            '00000000-0000-4000-8000-000000000001',
            array[
              '00000000-0000-4000-8000-000000000011'::uuid,
              '00000000-0000-4000-8000-000000000014'::uuid
            ]
          );`,
        ),
        runPsqlAsync(
          databaseUrl.toString(),
          `select public.replace_project_service_selections(
            '00000000-0000-4000-8000-000000000001',
            array[
              '00000000-0000-4000-8000-000000000012'::uuid,
              '00000000-0000-4000-8000-000000000013'::uuid
            ]
          );`,
        ),
      ]);
      concurrentResults.forEach((result, index) =>
        assertPsqlSucceeded(result, `concurrent replacement ${index + 1}`),
      );
      const concurrentState = runPsql(
        databaseUrl.toString(),
        `select count(*) || ':' || (
          array_agg(service_id order by service_id) = array[
            '00000000-0000-4000-8000-000000000011'::uuid,
            '00000000-0000-4000-8000-000000000014'::uuid
          ] or array_agg(service_id order by service_id) = array[
            '00000000-0000-4000-8000-000000000012'::uuid,
            '00000000-0000-4000-8000-000000000013'::uuid
          ]
        ) from public.project_service_selections;`,
      );
      assertPsqlSucceeded(concurrentState, "verify non-mixed concurrent state");
      assert.equal(concurrentState.stdout.trim(), "2:true");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `drop trigger slow_service_selection on public.project_service_selections;
           drop function public.slow_service_selection();`,
        ),
        "remove overlap trigger",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.project_jobs(
             id, project_id, kind, status, lease_token, submission_sequence
           ) values (
             '00000000-0000-4000-8000-000000000031',
             '00000000-0000-4000-8000-000000000001',
             'customer_analysis', 'running',
             'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1
           );`,
        ),
        "create leased analysis job",
      );
      const saveLeasedAnalysis = (marker) =>
        runPsql(
          databaseUrl.toString(),
          `select public.lease_fenced_save_customer_analysis(
             '00000000-0000-4000-8000-000000000031',
             'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
             '00000000-0000-4000-8000-000000000001',
             jsonb_build_object(
               'expected_source_revision', (
                 select source_revision from public.projects
                 where id = '00000000-0000-4000-8000-000000000001'
               ),
               'source_document_ids', '[]'::jsonb,
               'result_json', jsonb_build_object('marker', '${marker}'),
               'context_keywords', jsonb_build_array('${marker}', 'service'),
               'last_activity_at', '2026-07-11T12:00:00.000Z'
             )
           ) -> 'result_json' ->> 'marker';`,
        );
      const leasedSave = saveLeasedAnalysis("leased-one");
      assertPsqlSucceeded(leasedSave, "persist analysis through leased save");
      assert.equal(leasedSave.stdout.trim(), "leased-one");
      const leasedState = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses where provenance_verified) || ':' ||
          array_to_string(context_keywords, ',')
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(leasedState, "verify leased analysis stays current");
      assert.equal(leasedState.stdout.trim(), "true:1:leased-one,service");

      const beforeActivityOnly = runPsql(
        databaseUrl.toString(),
        `select source_revision || ':' || artifact_source_revision || ':' ||
          (select count(*) from public.customer_analyses)
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(beforeActivityOnly, "read activity-only baseline");
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.projects
           set last_activity_at = last_activity_at + interval '1 second'
           where id = '00000000-0000-4000-8000-000000000001';`,
        ),
        "update last activity only",
      );
      const afterActivityOnly = runPsql(
        databaseUrl.toString(),
        `select source_revision || ':' || artifact_source_revision || ':' ||
          (select count(*) from public.customer_analyses)
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(afterActivityOnly, "verify activity-only no-op");
      assert.equal(
        afterActivityOnly.stdout.trim(),
        beforeActivityOnly.stdout.trim(),
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.projects set title = 'Changed analysis input'
           where id = '00000000-0000-4000-8000-000000000001';`,
        ),
        "change project candidate-ranking metadata",
      );
      const metadataInvalidated = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' || solution_evaluation_generated || ':' ||
          (select count(*) from public.customer_analyses)
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(metadataInvalidated, "verify metadata invalidation");
      assert.equal(metadataInvalidated.stdout.trim(), "false:false:0");

      const secondLeasedSave = saveLeasedAnalysis("leased-two");
      assertPsqlSucceeded(
        secondLeasedSave,
        "recreate analysis before service document change",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.projects(id, title) values (
             '00000000-0000-4000-8000-000000000002',
             'Second project'
           );
           insert into public.customer_analyses(project_id, provenance_verified)
           values ('00000000-0000-4000-8000-000000000002', true);`,
        ),
        "create second project with current analysis",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.service_documents(id, service_id, title) values (
             '00000000-0000-4000-8000-000000000041',
             '00000000-0000-4000-8000-000000000012',
             'New service evidence'
           );`,
        ),
        "insert service document",
      );
      const serviceDocumentInvalidated = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses) || ':' ||
          (select service_library_revision from public.artifact_source_state)
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(
        serviceDocumentInvalidated,
        "verify service document invalidation",
      );
      assert.match(
        serviceDocumentInvalidated.stdout.trim(),
        /^false:0:[1-9][0-9]*$/u,
      );
      const allProjectsInvalidated = runPsql(
        databaseUrl.toString(),
        `select count(*) filter (where not customer_analysis_generated) || ':' ||
          (select count(*) from public.customer_analyses)
         from public.projects;`,
      );
      assertPsqlSucceeded(
        allProjectsInvalidated,
        "verify deterministic all-project invalidation",
      );
      assert.equal(allProjectsInvalidated.stdout.trim(), "2:0");

      const thirdLeasedSave = saveLeasedAnalysis("leased-three");
      assertPsqlSucceeded(
        thirdLeasedSave,
        "recreate analysis before service insert",
      );
      const serviceRevisionBeforeInsert = Number(
        runPsql(
          databaseUrl.toString(),
          "select service_library_revision from public.artifact_source_state;",
        ).stdout.trim(),
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.service_descriptions(id, name) values (
             '00000000-0000-4000-8000-000000000015',
             'New global candidate'
           );`,
        ),
        "insert global service candidate",
      );
      const serviceInsertInvalidated = runPsql(
        databaseUrl.toString(),
        `select customer_analysis_generated || ':' ||
          (select count(*) from public.customer_analyses) || ':' ||
          (select service_library_revision from public.artifact_source_state)
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(
        serviceInsertInvalidated,
        "verify global service invalidation",
      );
      const [serviceFlag, analysisCount, serviceRevision] =
        serviceInsertInvalidated.stdout.trim().split(":");
      assert.equal(serviceFlag, "false");
      assert.equal(analysisCount, "0");
      assert.ok(Number(serviceRevision) > serviceRevisionBeforeInsert);

      let previousServiceRevision = Number(serviceRevision);
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.service_documents(id, service_id, title) values
             ('00000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000012', 'Batch A'),
             ('00000000-0000-4000-8000-000000000043', '00000000-0000-4000-8000-000000000012', 'Batch B');`,
        ),
        "insert multiple service documents in one statement",
      );
      let nextServiceRevision = Number(
        runPsql(
          databaseUrl.toString(),
          "select service_library_revision from public.artifact_source_state;",
        ).stdout.trim(),
      );
      assert.equal(
        nextServiceRevision,
        previousServiceRevision + 1,
        "multi-row service insert must invalidate only once",
      );
      previousServiceRevision = nextServiceRevision;
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `delete from public.service_documents
           where id in (
             '00000000-0000-4000-8000-000000000042',
             '00000000-0000-4000-8000-000000000043'
           );`,
        ),
        "delete multiple service documents in one statement",
      );
      nextServiceRevision = Number(
        runPsql(
          databaseUrl.toString(),
          "select service_library_revision from public.artifact_source_state;",
        ).stdout.trim(),
      );
      assert.equal(
        nextServiceRevision,
        previousServiceRevision + 1,
        "multi-row service delete must invalidate only once",
      );
      previousServiceRevision = nextServiceRevision;
      for (const [label, sql] of [
        [
          "update service document",
          `update public.service_documents set title = 'Updated evidence'
           where id = '00000000-0000-4000-8000-000000000041';`,
        ],
        [
          "delete service document",
          `delete from public.service_documents
           where id = '00000000-0000-4000-8000-000000000041';`,
        ],
        [
          "update service description",
          `update public.service_descriptions set name = 'Updated candidate'
           where id = '00000000-0000-4000-8000-000000000015';`,
        ],
        [
          "delete service description",
          `delete from public.service_descriptions
           where id = '00000000-0000-4000-8000-000000000015';`,
        ],
      ]) {
        assertPsqlSucceeded(
          runPsql(databaseUrl.toString(), sql),
          label,
        );
        nextServiceRevision = Number(
          runPsql(
            databaseUrl.toString(),
            "select service_library_revision from public.artifact_source_state;",
          ).stdout.trim(),
        );
        assert.ok(
          nextServiceRevision > previousServiceRevision,
          `${label} must advance service_library_revision`,
        );
        previousServiceRevision = nextServiceRevision;
      }

      const zeroRowAnalysis = saveLeasedAnalysis("zero-row-guard");
      assertPsqlSucceeded(
        zeroRowAnalysis,
        "recreate analysis before zero-row service mutations",
      );
      const beforeZeroRowMutation = runPsql(
        databaseUrl.toString(),
        `select
          (select service_library_revision from public.artifact_source_state) || ':' ||
          string_agg(
            project.id::text || '=' || project.source_revision || ',' ||
            project.artifact_source_revision || ',' || project.customer_analysis_generated,
            ';' order by project.id
          ) || ':' || (select count(*) from public.customer_analyses)
         from public.projects project;`,
      );
      assertPsqlSucceeded(
        beforeZeroRowMutation,
        "read zero-row mutation baseline",
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `update public.service_documents set title = 'No row'
           where id = '00000000-0000-4000-8000-000000000099';
           delete from public.service_descriptions
           where id = '00000000-0000-4000-8000-000000000099';
           update public.service_descriptions set name = name
           where id = '00000000-0000-4000-8000-000000000012';`,
        ),
        "run zero-row and no-content service mutations",
      );
      const afterZeroRowMutation = runPsql(
        databaseUrl.toString(),
        `select
          (select service_library_revision from public.artifact_source_state) || ':' ||
          string_agg(
            project.id::text || '=' || project.source_revision || ',' ||
            project.artifact_source_revision || ',' || project.customer_analysis_generated,
            ';' order by project.id
          ) || ':' || (select count(*) from public.customer_analyses)
         from public.projects project;`,
      );
      assertPsqlSucceeded(
        afterZeroRowMutation,
        "verify zero-row mutations preserve authority",
      );
      assert.equal(
        afterZeroRowMutation.stdout.trim(),
        beforeZeroRowMutation.stdout.trim(),
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `select public.replace_project_service_selections(
             '00000000-0000-4000-8000-000000000001',
             array['00000000-0000-4000-8000-000000000011'::uuid]
           );`,
        ),
        "prepare service-delete lock-order fixture",
      );
      const deletingService = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '3s';
         select id from public.service_descriptions
         where id = '00000000-0000-4000-8000-000000000011'
         for update;
         select pg_sleep(0.2);
         delete from public.service_descriptions
         where id = '00000000-0000-4000-8000-000000000011';
         commit;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const replacementDuringDelete = runPsqlAsync(
        databaseUrl.toString(),
        `set statement_timeout = '3s';
         select public.replace_project_service_selections(
           '00000000-0000-4000-8000-000000000001',
           array['00000000-0000-4000-8000-000000000012'::uuid]
         );`,
      );
      const [deleteResult, blockedReplacementResult] = await Promise.all([
        deletingService,
        replacementDuringDelete,
      ]);
      assertPsqlSucceeded(deleteResult, "delete selected service without deadlock");
      assertPsqlSucceeded(
        blockedReplacementResult,
        "replace a deleting current service without deadlock",
      );
      assert.doesNotMatch(
        blockedReplacementResult.stderr,
        /deadlock detected|statement timeout/u,
      );
      assert.equal(
        runPsql(
          databaseUrl.toString(),
          "select service_id from public.project_service_selections;",
        ).stdout.trim(),
        "00000000-0000-4000-8000-000000000012",
      );

      const legacyDelete = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '3s';
         delete from public.project_service_selections
         where project_id = '00000000-0000-4000-8000-000000000001';
         select pg_sleep(0.2);
         commit;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const replacementDuringLegacyDelete = runPsqlAsync(
        databaseUrl.toString(),
        `set statement_timeout = '3s';
         select public.replace_project_service_selections(
           '00000000-0000-4000-8000-000000000001',
           array['00000000-0000-4000-8000-000000000013'::uuid]
         );`,
      );
      const [legacyDeleteResult, afterLegacyDeleteResult] = await Promise.all([
        legacyDelete,
        replacementDuringLegacyDelete,
      ]);
      assertPsqlSucceeded(
        legacyDeleteResult,
        "legacy direct selection DELETE",
      );
      assertPsqlSucceeded(
        afterLegacyDeleteResult,
        "RPC during legacy direct DELETE",
      );
      assert.doesNotMatch(
        `${legacyDeleteResult.stderr}${afterLegacyDeleteResult.stderr}`,
        /deadlock detected|statement timeout/u,
      );
      assert.equal(
        runPsql(
          databaseUrl.toString(),
          "select service_id from public.project_service_selections;",
        ).stdout.trim(),
        "00000000-0000-4000-8000-000000000013",
      );

      const legacyInsert = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '3s';
         insert into public.project_service_selections(project_id, service_id)
         values (
           '00000000-0000-4000-8000-000000000001',
           '00000000-0000-4000-8000-000000000014'
         );
         select pg_sleep(0.2);
         commit;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const replacementDuringLegacyInsert = runPsqlAsync(
        databaseUrl.toString(),
        `set statement_timeout = '3s';
         select public.replace_project_service_selections(
           '00000000-0000-4000-8000-000000000001',
           array['00000000-0000-4000-8000-000000000012'::uuid]
         );`,
      );
      const [legacyInsertResult, afterLegacyInsertResult] = await Promise.all([
        legacyInsert,
        replacementDuringLegacyInsert,
      ]);
      assertPsqlSucceeded(
        legacyInsertResult,
        "legacy direct selection INSERT",
      );
      assertPsqlSucceeded(
        afterLegacyInsertResult,
        "RPC during legacy direct INSERT",
      );
      assert.doesNotMatch(
        `${legacyInsertResult.stderr}${afterLegacyInsertResult.stderr}`,
        /deadlock detected|statement timeout/u,
      );
      assert.equal(
        runPsql(
          databaseUrl.toString(),
          "select string_agg(service_id::text, ',' order by service_id) from public.project_service_selections;",
        ).stdout.trim(),
        "00000000-0000-4000-8000-000000000012",
      );

      const reparentedSelection = runPsql(
        databaseUrl.toString(),
        `update public.project_service_selections
         set project_id = '00000000-0000-4000-8000-000000000002'
         where project_id = '00000000-0000-4000-8000-000000000001'
           and service_id = '00000000-0000-4000-8000-000000000012';`,
      );
      assert.notEqual(reparentedSelection.status, 0);
      assert.match(
        reparentedSelection.stderr,
        /PROJECT_SERVICE_SELECTION_IDENTITY_IMMUTABLE/u,
      );
      const selectionOwnership = runPsql(
        databaseUrl.toString(),
        `select project_id::text || ':' || service_id::text
         from public.project_service_selections
         order by project_id, service_id;`,
      );
      assertPsqlSucceeded(
        selectionOwnership,
        "verify rejected reparent preserves selection identity",
      );
      assert.equal(
        selectionOwnership.stdout.trim(),
        "00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000012",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `insert into public.service_documents(id, service_id, title) values (
             '00000000-0000-4000-8000-000000000044',
             '00000000-0000-4000-8000-000000000012',
             'Delete concurrency fixture'
           );`,
        ),
        "create service-document delete fixture",
      );
      const chunkReader = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '3s';
         select id from public.projects
         where id = '00000000-0000-4000-8000-000000000001'
         for key share;
         select pg_sleep(0.1);
         select id from public.service_documents
         where id = '00000000-0000-4000-8000-000000000044'
         for update;
         commit;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const childDelete = runPsqlAsync(
        databaseUrl.toString(),
        `begin;
         set local statement_timeout = '3s';
         select id from public.service_documents
         where id = '00000000-0000-4000-8000-000000000044'
         for update;
         select pg_sleep(0.15);
         delete from public.service_documents
         where id = '00000000-0000-4000-8000-000000000044';
         commit;`,
      );
      const [chunkReaderResult, childDeleteResult] = await Promise.all([
        chunkReader,
        childDelete,
      ]);
      assertPsqlSucceeded(
        chunkReaderResult,
        "project KEY SHARE reader during service-document delete",
      );
      assertPsqlSucceeded(
        childDeleteResult,
        "service-document child delete with NO KEY UPDATE invalidation",
      );
      assert.doesNotMatch(
        `${chunkReaderResult.stderr}${childDeleteResult.stderr}`,
        /deadlock detected|statement timeout/u,
      );

      const canonicalDocumentPredicateSql = canonicalSchemaSql.match(
        /create or replace function public\.project_document_affects_customer_analysis\([\s\S]*?\$\$;/u,
      )?.[0];
      assert.ok(canonicalDocumentPredicateSql);
      const canonicalDocumentFunctionSql = canonicalSchemaSql.match(
        /create or replace function public\.bump_project_source_revision_from_document\(\)[\s\S]*?\$\$;/u,
      )?.[0];
      assert.ok(canonicalDocumentFunctionSql);
      const sourceRevisionBeforeDocumentInsert = Number(
        runPsql(
          databaseUrl.toString(),
          `select source_revision from public.projects
           where id = '00000000-0000-4000-8000-000000000001';`,
        ).stdout.trim(),
      );
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `${canonicalDocumentPredicateSql}
           ${canonicalDocumentFunctionSql}
           create trigger canonical_documents_source_revision_insert
           after insert on public.documents
           for each row execute function public.bump_project_source_revision_from_document();
           insert into public.documents(id, project_id, role) values (
             '00000000-0000-4000-8000-000000000051',
             '00000000-0000-4000-8000-000000000001',
             'supporting_document'
           );`,
        ),
        "execute canonical document trigger on a real INSERT",
      );
      const sourceRevisionAfterDocumentInsert = Number(
        runPsql(
          databaseUrl.toString(),
          `select source_revision from public.projects
           where id = '00000000-0000-4000-8000-000000000001';`,
        ).stdout.trim(),
      );
      assert.ok(
        sourceRevisionAfterDocumentInsert > sourceRevisionBeforeDocumentInsert,
        "canonical document INSERT must advance source revision",
      );
    } finally {
      runPsql(
        liveDatabaseUrl,
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${databaseName}';`,
      );
      const dropped = runPsql(
        liveDatabaseUrl,
        `drop database if exists ${quotedDatabaseName}`,
      );
      assertPsqlSucceeded(dropped, "drop disposable database");
    }
  },
);
