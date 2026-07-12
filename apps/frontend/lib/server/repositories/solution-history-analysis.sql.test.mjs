import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const primaryRoleMigrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260711133000_atomic_primary_document_roles.sql",
);
const solutionHistoryMigrationPath = path.join(
  repositoryRoot,
  "supabase/migrations/20260711143000_preserve_customer_analysis_for_solution_history.sql",
);
const solutionHistoryMigration = readFileSync(
  solutionHistoryMigrationPath,
  "utf8",
);

function sqlFunctionBody(sql, name) {
  return sql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$(?<body>[\\s\\S]*?)\\$\\$;`,
      "u",
    ),
  )?.groups?.body;
}

test("solution-history migration keeps OLD/NEW analysis semantics explicit and service-only", () => {
  const predicate = sqlFunctionBody(
    solutionHistoryMigration,
    "project_document_affects_customer_analysis",
  );
  const revisionTrigger = sqlFunctionBody(
    solutionHistoryMigration,
    "bump_project_source_revision_from_document",
  );
  const readinessTrigger = sqlFunctionBody(
    solutionHistoryMigration,
    "invalidate_document_on_readiness_loss",
  );
  const setPrimary = sqlFunctionBody(
    solutionHistoryMigration,
    "set_primary_project_document",
  );
  const insertPrimary = sqlFunctionBody(
    solutionHistoryMigration,
    "insert_primary_project_document",
  );

  assert.ok(predicate, "analysis-source predicate is missing");
  assert.match(predicate, /p_role <> 'primary_solution_document'/u);
  assert.match(predicate, /'tidligere_losning'/u);
  assert.match(
    predicate,
    /coalesce\(p_supporting_subtype, p_legacy_subtype, ''\) = 'tidligere_losning'/u,
    "subtype-less supporting documents must produce true, never NULL",
  );
  assert.ok(revisionTrigger, "document revision trigger is missing");
  assert.match(
    revisionTrigger,
    /old\.role,[\s\S]*?old\.supporting_subtype,[\s\S]*?old\.subtype[\s\S]*?\) or public\.project_document_affects_customer_analysis\([\s\S]*?new\.role/u,
  );
  assert.match(revisionTrigger, /delete from public\.customer_analyses/u);
  assert.match(revisionTrigger, /delete from public\.solution_evaluations/u);
  assert.match(revisionTrigger, /delete from public\.executive_summaries/u);
  assert.ok(readinessTrigger, "readiness trigger is missing");
  assert.match(
    readinessTrigger,
    /project_document_affects_customer_analysis\([\s\S]*?new\.role/u,
  );
  assert.match(setPrimary ?? "", /else 'tidligere_losning'/u);
  assert.match(insertPrimary ?? "", /else 'tidligere_losning'/u);
  assert.doesNotMatch(setPrimary ?? "", /else 'utkast'/u);
  assert.doesNotMatch(insertPrimary ?? "", /else 'utkast'/u);
  assert.match(
    solutionHistoryMigration,
    /revoke execute on function public\.project_document_affects_customer_analysis\(text, text, text\)[\s\S]*?from public, anon, authenticated/u,
  );
  assert.match(
    solutionHistoryMigration,
    /grant execute on function public\.project_document_affects_customer_analysis\(text, text, text\)[\s\S]*?to service_role/u,
  );
});

test("canonical and durable SQL retain solution-history subtype and trigger predicate", () => {
  const schema = readFileSync(
    path.join(repositoryRoot, "supabase/schema.sql"),
    "utf8",
  );
  const durable = readFileSync(
    path.join(repositoryRoot, "supabase/project_jobs_durable_execution.sql"),
    "utf8",
  );
  const chunks = readFileSync(
    path.join(repositoryRoot, "supabase/document_chunks_and_embeddings.sql"),
    "utf8",
  );
  const normalizer = readFileSync(
    path.join(repositoryRoot, "supabase/normalize_document_upload_columns.sql"),
    "utf8",
  );
  const performance = readFileSync(
    path.join(repositoryRoot, "supabase/performance_metadata_and_indexes.sql"),
    "utf8",
  );

  for (const [label, sql] of [
    ["schema", schema],
    ["durable", durable],
  ]) {
    assert.match(
      sql,
      /create or replace function public\.project_document_affects_customer_analysis/u,
      `${label} SQL lacks the shared analysis-source predicate`,
    );
    assert.match(
      sql,
      /old\.role,[\s\S]*?old\.supporting_subtype,[\s\S]*?old\.subtype[\s\S]*?\) or public\.project_document_affects_customer_analysis\([\s\S]*?new\.role/u,
      `${label} SQL lacks OLD OR NEW analysis-source fencing`,
    );
    assert.match(
      sql,
      /coalesce\(p_supporting_subtype, p_legacy_subtype, ''\) = 'tidligere_losning'/u,
      `${label} SQL lets subtype-less support produce NULL`,
    );
  }
  for (const [label, sql] of [
    ["schema", schema],
    ["chunks", chunks],
    ["normalizer", normalizer],
    ["performance", performance],
  ]) {
    assert.match(
      sql,
      /'tidligere_losning'/u,
      `${label} SQL rejects the internal solution-history subtype`,
    );
  }
});

function runPsql(databaseUrl, sql, options = {}) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8", ...options },
  );
}

function runPsqlFile(databaseUrl, filePath) {
  return spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-f", filePath],
    { encoding: "utf8" },
  );
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
  "postgres: solution replacement preserves analysis while OLD/NEW requirement changes invalidate it",
  { skip: !liveDatabaseUrl, timeout: 30_000 },
  () => {
    const databaseName = `anbud_solution_history_${randomUUID().replaceAll("-", "")}`;
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
              customer_document_uploaded boolean not null default false,
              customer_analysis_generated boolean not null default false,
              solution_document_uploaded boolean not null default false,
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
              file_storage_bucket text not null default 'test-documents',
              file_storage_path text,
              file_base64 text not null default '',
              raw_text text not null default '',
              structure_map jsonb not null default '[]'::jsonb,
              processing_status text not null default 'enhanced_ready',
              processing_message text,
              processing_error text,
              parser_used text,
              indexed_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            create table public.document_chunks (
              id uuid primary key,
              supporting_subtype text check (
                supporting_subtype is null
                or supporting_subtype in (
                  'rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat',
                  'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet'
                )
              )
            );
            create table public.customer_analyses (
              id text primary key,
              project_id uuid not null unique references public.projects(id) on delete cascade
            );
            create table public.solution_evaluations (
              id text primary key,
              project_id uuid not null unique references public.projects(id) on delete cascade
            );
            create table public.executive_summaries (
              id text primary key,
              project_id uuid not null unique references public.projects(id) on delete cascade
            );

            create or replace function public.bump_project_source_revision_from_document()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            declare v_project_id uuid;
            begin
              v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
              update public.projects
              set source_revision = source_revision + 1,
                  artifact_source_revision = artifact_source_revision + 1,
                  customer_analysis_generated = false,
                  solution_evaluation_generated = false
              where id = v_project_id;
              delete from public.customer_analyses where project_id = v_project_id;
              delete from public.solution_evaluations where project_id = v_project_id;
              delete from public.executive_summaries where project_id = v_project_id;
              if tg_op = 'DELETE' then return old; end if;
              return new;
            end;
            $$;
            create trigger documents_source_revision_insert
            after insert on public.documents
            for each row execute function public.bump_project_source_revision_from_document();
            create trigger documents_source_revision_delete
            after delete on public.documents
            for each row execute function public.bump_project_source_revision_from_document();
            create trigger documents_source_revision_update
            after update of role, supporting_subtype, subtype, title, display_name,
              file_name, file_format, content_type, file_size_bytes, page_count,
              file_storage_bucket, file_storage_path, file_base64, raw_text,
              structure_map on public.documents
            for each row execute function public.bump_project_source_revision_from_document();

            create or replace function public.invalidate_document_on_readiness_loss()
            returns trigger language plpgsql security invoker set search_path = '' as $$
            begin
              return new;
            end;
            $$;
            create trigger documents_readiness_loss_invalidation
            after update of processing_status on public.documents
            for each row execute function public.invalidate_document_on_readiness_loss();
          `,
        ),
        "create trigger fixture",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), primaryRoleMigrationPath),
        "apply atomic primary-role migration",
      );
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), solutionHistoryMigrationPath),
        "apply solution-history migration",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(
              id, customer_document_uploaded, customer_analysis_generated,
              solution_document_uploaded, solution_evaluation_generated
            ) values
              ('00000000-0000-4000-8000-000000000101', true, true, true, true),
              ('00000000-0000-4000-8000-000000000201', true, true, true, true),
              ('00000000-0000-4000-8000-000000000301', true, true, true, true),
              ('00000000-0000-4000-8000-000000000401', true, true, true, true),
              ('00000000-0000-4000-8000-000000000501', true, true, true, true),
              ('00000000-0000-4000-8000-000000000601', true, true, true, true),
              ('00000000-0000-4000-8000-000000000701', true, true, true, true),
              ('00000000-0000-4000-8000-000000000801', true, true, true, true),
              ('00000000-0000-4000-8000-000000000901', true, true, true, true);

            insert into public.documents(id, project_id, role, supporting_subtype, subtype, title) values
              ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000101', 'primary_solution_document', null, null, 'Solution A'),
              ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000201', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000201', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000201', 'supporting_document', 'kravdokument', 'kravdokument', 'Requirements'),
              ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000301', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000312', '00000000-0000-4000-8000-000000000301', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000411', '00000000-0000-4000-8000-000000000401', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000412', '00000000-0000-4000-8000-000000000401', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000413', '00000000-0000-4000-8000-000000000401', 'supporting_document', 'kravdokument', 'kravdokument', 'Requirements'),
              ('00000000-0000-4000-8000-000000000511', '00000000-0000-4000-8000-000000000501', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000512', '00000000-0000-4000-8000-000000000501', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000513', '00000000-0000-4000-8000-000000000501', 'supporting_document', 'tidligere_losning', 'tidligere_losning', 'Historical solution'),
              ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000601', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000612', '00000000-0000-4000-8000-000000000601', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000701', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000701', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000713', '00000000-0000-4000-8000-000000000701', 'supporting_document', null, null, 'Subtype-less support'),
              ('00000000-0000-4000-8000-000000000811', '00000000-0000-4000-8000-000000000801', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000812', '00000000-0000-4000-8000-000000000801', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000813', '00000000-0000-4000-8000-000000000801', 'supporting_document', null, null, 'Subtype-less support'),
              ('00000000-0000-4000-8000-000000000911', '00000000-0000-4000-8000-000000000901', 'primary_customer_document', null, null, 'Customer'),
              ('00000000-0000-4000-8000-000000000912', '00000000-0000-4000-8000-000000000901', 'primary_solution_document', null, null, 'Solution'),
              ('00000000-0000-4000-8000-000000000913', '00000000-0000-4000-8000-000000000901', 'supporting_document', null, null, 'Subtype-less support');

            update public.projects
            set customer_analysis_generated = true,
                solution_evaluation_generated = true;
            insert into public.customer_analyses(id, project_id) values
              ('analysis-replace', '00000000-0000-4000-8000-000000000101'),
              ('analysis-requirement-edit', '00000000-0000-4000-8000-000000000201'),
              ('analysis-customer-edit', '00000000-0000-4000-8000-000000000301'),
              ('analysis-requirement-promotion', '00000000-0000-4000-8000-000000000401'),
              ('analysis-history-reclassification', '00000000-0000-4000-8000-000000000501'),
              ('analysis-null-subtype-insert', '00000000-0000-4000-8000-000000000601'),
              ('analysis-null-subtype-update', '00000000-0000-4000-8000-000000000701'),
              ('analysis-null-subtype-readiness', '00000000-0000-4000-8000-000000000801'),
              ('analysis-null-subtype-delete', '00000000-0000-4000-8000-000000000901');
            insert into public.solution_evaluations(id, project_id) values
              ('evaluation-replace', '00000000-0000-4000-8000-000000000101');
            insert into public.executive_summaries(id, project_id) values
              ('summary-replace', '00000000-0000-4000-8000-000000000101');
          `,
        ),
        "seed truth-table projects",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `select (public.insert_primary_project_document(
            '00000000-0000-4000-8000-000000000101',
            'primary_solution_document',
            jsonb_build_object(
              'id', '00000000-0000-4000-8000-000000000113',
              'title', 'Solution B',
              'display_name', 'Solution B',
              'file_name', 'solution-b.txt',
              'file_format', 'txt',
              'content_type', 'text/plain',
              'file_storage_bucket', 'test-documents',
              'file_storage_path', 'solution-b.txt'
            )
          )).id;`,
        ),
        "replace primary solution",
      );
      const replacementState = runPsql(
        databaseUrl.toString(),
        `
          select
            (select id from public.customer_analyses where project_id = project.id)
            || ':' || project.customer_analysis_generated
            || ':' || (select count(*) from public.solution_evaluations where project_id = project.id)
            || ':' || (select count(*) from public.executive_summaries where project_id = project.id)
            || ':' || (select role from public.documents where id = '00000000-0000-4000-8000-000000000112')
            || ':' || (select supporting_subtype from public.documents where id = '00000000-0000-4000-8000-000000000112')
            || ':' || (select role from public.documents where id = '00000000-0000-4000-8000-000000000113')
          from public.projects project
          where project.id = '00000000-0000-4000-8000-000000000101';
        `,
      );
      assertPsqlSucceeded(replacementState, "read solution replacement state");
      assert.equal(
        replacementState.stdout.trim(),
        "analysis-replace:true:0:0:supporting_document:tidligere_losning:primary_solution_document",
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            update public.documents
            set raw_text = 'new solution content'
            where id = '00000000-0000-4000-8000-000000000113';
            update public.documents
            set raw_text = 'late history content', processing_status = 'failed'
            where id = '00000000-0000-4000-8000-000000000112';
            select (public.set_primary_project_document(
              '00000000-0000-4000-8000-000000000101',
              '00000000-0000-4000-8000-000000000112',
              'primary_solution_document'
            )).id;
            delete from public.documents
            where id = '00000000-0000-4000-8000-000000000113';
          `,
        ),
        "ingest, restore, and delete solution history",
      );
      const preservedAnalysis = runPsql(
        databaseUrl.toString(),
        `select id || ':' || (
           select customer_analysis_generated::text
           from public.projects
           where id = customer_analyses.project_id
         )
         from public.customer_analyses
         where project_id = '00000000-0000-4000-8000-000000000101';`,
      );
      assertPsqlSucceeded(preservedAnalysis, "read preserved analysis");
      assert.equal(preservedAnalysis.stdout.trim(), "analysis-replace:true");

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            update public.documents set raw_text = 'changed requirement'
            where id = '00000000-0000-4000-8000-000000000213';
            update public.documents set raw_text = 'changed customer'
            where id = '00000000-0000-4000-8000-000000000311';
            select (public.set_primary_project_document(
              '00000000-0000-4000-8000-000000000401',
              '00000000-0000-4000-8000-000000000413',
              'primary_solution_document'
            )).id;
            update public.documents
            set supporting_subtype = 'kravdokument', subtype = 'kravdokument'
            where id = '00000000-0000-4000-8000-000000000513';
          `,
        ),
        "exercise OLD/NEW invalidation cases",
      );
      const invalidatedState = runPsql(
        databaseUrl.toString(),
        `
          select string_agg(
            project.id::text || ':' || project.customer_analysis_generated
              || ':' || (select count(*) from public.customer_analyses analysis where analysis.project_id = project.id),
            ',' order by project.id
          )
          from public.projects project
          where project.id in (
            '00000000-0000-4000-8000-000000000201',
            '00000000-0000-4000-8000-000000000301',
            '00000000-0000-4000-8000-000000000401',
            '00000000-0000-4000-8000-000000000501'
          );
        `,
      );
      assertPsqlSucceeded(invalidatedState, "read invalidated analyses");
      assert.equal(
        invalidatedState.stdout.trim(),
        [
          "00000000-0000-4000-8000-000000000201:false:0",
          "00000000-0000-4000-8000-000000000301:false:0",
          "00000000-0000-4000-8000-000000000401:false:0",
          "00000000-0000-4000-8000-000000000501:false:0",
        ].join(","),
      );

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.documents(
              id, project_id, role, supporting_subtype, subtype, title
            ) values (
              '00000000-0000-4000-8000-000000000613',
              '00000000-0000-4000-8000-000000000601',
              'supporting_document', null, null, 'Subtype-less support'
            );
            update public.documents set raw_text = 'changed support'
            where id = '00000000-0000-4000-8000-000000000713';
            update public.documents set processing_status = 'failed'
            where id = '00000000-0000-4000-8000-000000000813';
            delete from public.documents
            where id = '00000000-0000-4000-8000-000000000913';
          `,
        ),
        "invalidate subtype-less supporting documents",
      );
      const subtypeLessState = runPsql(
        databaseUrl.toString(),
        `
          select string_agg(
            project.id::text || ':' || project.customer_analysis_generated
              || ':' || (select count(*) from public.customer_analyses analysis where analysis.project_id = project.id),
            ',' order by project.id
          )
          from public.projects project
          where project.id in (
            '00000000-0000-4000-8000-000000000601',
            '00000000-0000-4000-8000-000000000701',
            '00000000-0000-4000-8000-000000000801',
            '00000000-0000-4000-8000-000000000901'
          );
        `,
      );
      assertPsqlSucceeded(
        subtypeLessState,
        "read subtype-less supporting invalidation state",
      );
      assert.equal(
        subtypeLessState.stdout.trim(),
        [
          "00000000-0000-4000-8000-000000000601:false:0",
          "00000000-0000-4000-8000-000000000701:false:0",
          "00000000-0000-4000-8000-000000000801:false:0",
          "00000000-0000-4000-8000-000000000901:false:0",
        ].join(","),
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
