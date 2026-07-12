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
  "supabase/migrations/20260711133000_atomic_primary_document_roles.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

function sqlFunctionBody(name) {
  return migrationSql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$(?<body>[\\s\\S]*?)\\$\\$;`,
      "u",
    ),
  )?.groups?.body;
}

test("primary role migration is deterministic, unique, locked, and non-destructive", () => {
  assert.match(
    migrationSql,
    /partition by document\.project_id, document\.role[\s\S]*order by document\.updated_at desc, document\.created_at desc, document\.id desc/u,
  );
  assert.match(
    migrationSql,
    /documents_one_primary_customer_per_project_idx[\s\S]*where role = 'primary_customer_document'/u,
  );
  assert.match(
    migrationSql,
    /documents_one_primary_solution_per_project_idx[\s\S]*where role = 'primary_solution_document'/u,
  );
  assert.doesNotMatch(migrationSql, /delete from public\.documents/u);

  for (const functionName of [
    "set_primary_project_document",
    "insert_primary_project_document",
  ]) {
    const body = sqlFunctionBody(functionName);
    assert.ok(body, `${functionName} body is missing`);
    assert.ok(
      body.indexOf("from public.projects project") <
        body.indexOf("update public.documents document"),
      `${functionName} must lock the project before changing roles`,
    );
    assert.match(body, /from public\.projects project[\s\S]*for update/u);
    assert.doesNotMatch(body, /delete from public\./u);
  }

  const insertBody = sqlFunctionBody("insert_primary_project_document");
  assert.match(insertBody, /insert into public\.documents/u);
  assert.doesNotMatch(
    insertBody,
    /values \([\s\S]*'supporting_document'/u,
    "new primary uploads must never be staged as supporting rows",
  );
  assert.doesNotMatch(insertBody, /customer_analysis_generated\s*=\s*false/u);
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
  "postgres: dedupe, rollback, unique constraints, and concurrent promotion are atomic",
  { skip: !liveDatabaseUrl, timeout: 30_000 },
  async () => {
    const databaseName = `anbud_primary_role_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = new URL(liveDatabaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const quotedDatabaseName = `"${databaseName}"`;

    assertPsqlSucceeded(
      runPsql(liveDatabaseUrl, `create database ${quotedDatabaseName}`),
      "create disposable database",
    );

    try {
      const setup = runPsql(
        databaseUrl.toString(),
        `
          create table public.projects (
            id uuid primary key,
            customer_document_uploaded boolean not null default false,
            customer_analysis_generated boolean not null default true,
            solution_document_uploaded boolean not null default false,
            solution_evaluation_generated boolean not null default true,
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
            processing_status text not null default 'queued',
            processing_message text,
            processing_error text,
            parser_used text,
            indexed_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          );
          insert into public.projects(id) values
            ('00000000-0000-4000-8000-000000000001');
          insert into public.documents(id, project_id, role, created_at, updated_at) values
            ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'primary_customer_document', '2026-01-01', '2026-01-01'),
            ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'primary_customer_document', '2026-01-02', '2026-01-02'),
            ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'primary_solution_document', '2026-01-01', '2026-01-01'),
            ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001', 'primary_solution_document', '2026-01-02', '2026-01-02');
        `,
      );
      assertPsqlSucceeded(setup, "create SQL fixture");
      assertPsqlSucceeded(
        runPsqlFile(databaseUrl.toString(), migrationPath),
        "apply primary role migration",
      );

      const deduped = runPsql(
        databaseUrl.toString(),
        `
          select id::text || ':' || role || ':' || coalesce(supporting_subtype, '')
          from public.documents
          where project_id = '00000000-0000-4000-8000-000000000001'
          order by id;
        `,
      );
      assertPsqlSucceeded(deduped, "read deduplicated rows");
      assert.deepEqual(deduped.stdout.trim().split("\n"), [
        "00000000-0000-4000-8000-000000000011:supporting_document:rfp",
        "00000000-0000-4000-8000-000000000012:primary_customer_document:",
        "00000000-0000-4000-8000-000000000013:supporting_document:utkast",
        "00000000-0000-4000-8000-000000000014:primary_solution_document:",
      ]);
      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `select (public.set_primary_project_document(
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000014',
            'primary_solution_document'
          )).id;`,
        ),
        "reconcile idempotent primary selection",
      );
      const reconciledFlags = runPsql(
        databaseUrl.toString(),
        `select customer_document_uploaded || ':' || solution_document_uploaded
         from public.projects
         where id = '00000000-0000-4000-8000-000000000001';`,
      );
      assertPsqlSucceeded(reconciledFlags, "read reconciled project flags");
      assert.equal(reconciledFlags.stdout.trim(), "true:true");

      const replacementInsert = runPsql(
        databaseUrl.toString(),
        `
          insert into public.documents(id, project_id, role)
          values ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000001', 'primary_customer_document');
        `,
      );
      assertPsqlSucceeded(
        replacementInsert,
        "bridge direct stable primary replacement",
      );
      const replacementRoles = runPsql(
        databaseUrl.toString(),
        `select id::text || ':' || role || ':' || coalesce(supporting_subtype, '')
         from public.documents
         where id in (
           '00000000-0000-4000-8000-000000000012',
           '00000000-0000-4000-8000-000000000015'
         ) order by id;`,
      );
      assertPsqlSucceeded(replacementRoles, "read bridged primary replacement");
      assert.deepEqual(replacementRoles.stdout.trim().split("\n"), [
        "00000000-0000-4000-8000-000000000012:supporting_document:rfp",
        "00000000-0000-4000-8000-000000000015:primary_customer_document:",
      ]);

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            insert into public.projects(id) values
              ('00000000-0000-4000-8000-000000000002'),
              ('00000000-0000-4000-8000-000000000003'),
              ('00000000-0000-4000-8000-000000000004');
            insert into public.documents(id, project_id, role, supporting_subtype) values
              ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002', 'primary_solution_document', null),
              ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000002', 'supporting_document', 'utkast'),
              ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000003', 'primary_solution_document', null),
              ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000003', 'supporting_document', 'utkast'),
              ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000003', 'supporting_document', 'utkast');
            create or replace function public.reject_selected_primary()
            returns trigger language plpgsql as $$
            begin
              if new.id = '00000000-0000-4000-8000-000000000022'::uuid
                 and new.role = 'primary_solution_document' then
                raise exception 'forced promotion failure';
              end if;
              return new;
            end;
            $$;
            create trigger reject_selected_primary
            before update on public.documents
            for each row execute function public.reject_selected_primary();
          `,
        ),
        "create rollback and concurrency fixtures",
      );

      const failedPromotion = runPsql(
        databaseUrl.toString(),
        `select (public.set_primary_project_document(
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000022',
          'primary_solution_document'
        )).id;`,
      );
      assert.notEqual(failedPromotion.status, 0);
      assert.match(failedPromotion.stderr, /forced promotion failure/u);
      const rolledBack = runPsql(
        databaseUrl.toString(),
        `select id::text || ':' || role from public.documents
         where project_id = '00000000-0000-4000-8000-000000000002'
         order by id;`,
      );
      assertPsqlSucceeded(rolledBack, "verify promotion rollback");
      assert.deepEqual(rolledBack.stdout.trim().split("\n"), [
        "00000000-0000-4000-8000-000000000021:primary_solution_document",
        "00000000-0000-4000-8000-000000000022:supporting_document",
      ]);

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            drop trigger reject_selected_primary on public.documents;
            drop function public.reject_selected_primary();
            create or replace function public.reject_inserted_primary()
            returns trigger language plpgsql as $$
            begin
              if new.id = '00000000-0000-4000-8000-000000000023'::uuid then
                raise exception 'forced primary insert failure';
              end if;
              return new;
            end;
            $$;
            create trigger reject_inserted_primary
            before insert on public.documents
            for each row execute function public.reject_inserted_primary();
          `,
        ),
        "install primary insert rollback trigger",
      );
      const failedPrimaryInsert = runPsql(
        databaseUrl.toString(),
        `select (public.insert_primary_project_document(
          '00000000-0000-4000-8000-000000000002',
          'primary_solution_document',
          jsonb_build_object(
            'id', '00000000-0000-4000-8000-000000000023',
            'title', 'Rejected primary',
            'display_name', 'Rejected primary',
            'file_name', 'rejected.txt',
            'file_format', 'txt',
            'content_type', 'text/plain',
            'file_storage_bucket', 'test-documents',
            'file_storage_path', 'rejected.txt'
          )
        )).id;`,
      );
      assert.notEqual(failedPrimaryInsert.status, 0);
      assert.match(failedPrimaryInsert.stderr, /forced primary insert failure/u);
      const insertRolledBack = runPsql(
        databaseUrl.toString(),
        `select id::text || ':' || role from public.documents
         where project_id = '00000000-0000-4000-8000-000000000002'
         order by id;`,
      );
      assertPsqlSucceeded(insertRolledBack, "verify primary insert rollback");
      assert.deepEqual(insertRolledBack.stdout.trim().split("\n"), [
        "00000000-0000-4000-8000-000000000021:primary_solution_document",
        "00000000-0000-4000-8000-000000000022:supporting_document",
      ]);

      assertPsqlSucceeded(
        runPsql(
          databaseUrl.toString(),
          `
            drop trigger reject_inserted_primary on public.documents;
            drop function public.reject_inserted_primary();
            create or replace function public.slow_primary_promotion()
            returns trigger language plpgsql as $$
            begin
              if tg_op = 'INSERT'
                 and new.role = 'primary_solution_document' then
                perform pg_sleep(0.2);
              elsif old.role = 'supporting_document'
                    and new.role = 'primary_solution_document' then
                perform pg_sleep(0.2);
              end if;
              return new;
            end;
            $$;
            create trigger slow_primary_promotion
            before update on public.documents
            for each row execute function public.slow_primary_promotion();
            create trigger slow_primary_insert
            before insert on public.documents
            for each row execute function public.slow_primary_promotion();
          `,
        ),
        "install concurrency overlap trigger",
      );

      const concurrentResults = await Promise.all([
        runPsqlAsync(
          databaseUrl.toString(),
          `select (public.set_primary_project_document(
            '00000000-0000-4000-8000-000000000003',
            '00000000-0000-4000-8000-000000000032',
            'primary_solution_document'
          )).id;`,
        ),
        runPsqlAsync(
          databaseUrl.toString(),
          `select (public.set_primary_project_document(
            '00000000-0000-4000-8000-000000000003',
            '00000000-0000-4000-8000-000000000033',
            'primary_solution_document'
          )).id;`,
        ),
      ]);
      concurrentResults.forEach((result, index) =>
        assertPsqlSucceeded(result, `concurrent promotion ${index + 1}`),
      );
      const concurrentState = runPsql(
        databaseUrl.toString(),
        `select count(*) filter (where role = 'primary_solution_document') || ':' || count(*)
         from public.documents
         where project_id = '00000000-0000-4000-8000-000000000003';`,
      );
      assertPsqlSucceeded(concurrentState, "verify concurrent primary state");
      assert.equal(concurrentState.stdout.trim(), "1:3");

      const primaryPayloadSql = (id, fileName) => `jsonb_build_object(
        'id', '${id}',
        'title', '${fileName}',
        'display_name', '${fileName}',
        'file_name', '${fileName}',
        'file_format', 'txt',
        'content_type', 'text/plain',
        'file_storage_bucket', 'test-documents',
        'file_storage_path', '${fileName}'
      )`;
      const concurrentInsertResults = await Promise.all([
        runPsqlAsync(
          databaseUrl.toString(),
          `select (public.insert_primary_project_document(
            '00000000-0000-4000-8000-000000000004',
            'primary_solution_document',
            ${primaryPayloadSql(
              "00000000-0000-4000-8000-000000000041",
              "concurrent-a.txt",
            )}
          )).id;`,
        ),
        runPsqlAsync(
          databaseUrl.toString(),
          `select (public.insert_primary_project_document(
            '00000000-0000-4000-8000-000000000004',
            'primary_solution_document',
            ${primaryPayloadSql(
              "00000000-0000-4000-8000-000000000042",
              "concurrent-b.txt",
            )}
          )).id;`,
        ),
      ]);
      concurrentInsertResults.forEach((result, index) =>
        assertPsqlSucceeded(result, `concurrent primary insert ${index + 1}`),
      );
      const concurrentInsertState = runPsql(
        databaseUrl.toString(),
        `select count(*) filter (where role = 'primary_solution_document') || ':' || count(*)
         from public.documents
         where project_id = '00000000-0000-4000-8000-000000000004';`,
      );
      assertPsqlSucceeded(
        concurrentInsertState,
        "verify concurrent primary insert state",
      );
      assert.equal(concurrentInsertState.stdout.trim(), "1:2");
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
