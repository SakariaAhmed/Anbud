import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;
const root = new URL("../../../../../", import.meta.url);
function sql(url, input) {
  const result = spawnSync("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("postgres: authorized-page counts are complete, isolated and service-role-only across migration", { skip: !databaseUrl, timeout: 180_000 }, () => {
  const admin = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(admin.hostname), "Only a disposable local PostgreSQL is allowed");
  const name = `qa_dashboard_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(admin);
  target.pathname = `/${name}`;
  sql(admin.toString(), `create database ${name};`);
  try {
    sql(target.toString(), "set anbud.allow_destructive_schema_rebuild = on;\n" + readFileSync(new URL("database/schema.sql", root), "utf8"));
    const baselineDefinition = sql(target.toString(), "select pg_get_functiondef('public.get_project_dashboard_counts(uuid[])'::regprocedure);");
    sql(target.toString(), `
      insert into public.projects(id,client_name,title) values
        ('00000000-0000-4000-8000-000000000001','Synthetic','Large'),
        ('00000000-0000-4000-8000-000000000002','Synthetic','Small'),
        ('00000000-0000-4000-8000-000000000003','Synthetic','Empty'),
        ('00000000-0000-4000-8000-000000000004','Synthetic','Outside selected page');
      -- Bulk fixtures retain FK/check/index constraints. Source invalidation
      -- and artifact publication triggers are unrelated to aggregate reads.
      alter table public.documents disable trigger user;
      alter table public.generated_artifacts disable trigger user;
      insert into public.documents(project_id,role)
        select '00000000-0000-4000-8000-000000000001',
          case when n = 1 then 'primary_customer_document' else 'supporting_document' end
        from generate_series(1,5010) n;
      insert into public.documents(project_id,role) values
        ('00000000-0000-4000-8000-000000000002','supporting_document'),
        ('00000000-0000-4000-8000-000000000004','supporting_document');
      insert into public.generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version)
        select '00000000-0000-4000-8000-000000000001','losningsutkast','Synthetic','Synthetic',n from generate_series(1,10010) n;
      insert into public.generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version) values
        ('00000000-0000-4000-8000-000000000002','losningsutkast','Synthetic','Synthetic',1),
        ('00000000-0000-4000-8000-000000000004','losningsutkast','Synthetic','Synthetic',1);
      alter table public.documents enable trigger user;
      alter table public.generated_artifacts enable trigger user;
    `);
    const assertion = `
      do $$ declare found record; begin
        select * into found from public.get_project_dashboard_counts(array['00000000-0000-4000-8000-000000000001'::uuid]);
        if found.document_count <> 5010 or found.supporting_document_count <> 5009 or found.artifact_count <> 10010 then raise exception 'large project counts are truncated or multiplied'; end if;
        select * into found from public.get_project_dashboard_counts(array['00000000-0000-4000-8000-000000000002'::uuid]);
        if found.document_count <> 1 or found.supporting_document_count <> 1 or found.artifact_count <> 1 then raise exception 'small project counts lost behind large project'; end if;
        select * into found from public.get_project_dashboard_counts(array['00000000-0000-4000-8000-000000000003'::uuid]);
        if found.document_count <> 0 or found.supporting_document_count <> 0 or found.artifact_count <> 0 then raise exception 'empty project missing'; end if;
        if (select count(*) from public.get_project_dashboard_counts(array['00000000-0000-4000-8000-000000000002'::uuid,'00000000-0000-4000-8000-000000000003'::uuid])) <> 2 then raise exception 'rows escaped selected project page'; end if;
        if exists(select 1 from public.get_project_dashboard_counts('{}'::uuid[])) then raise exception 'empty page returned projects'; end if;
        if pg_catalog.has_function_privilege('anon','public.get_project_dashboard_counts(uuid[])','execute') or
          pg_catalog.has_function_privilege('authenticated','public.get_project_dashboard_counts(uuid[])','execute') or
          not pg_catalog.has_function_privilege('service_role','public.get_project_dashboard_counts(uuid[])','execute') then raise exception 'invalid RPC privileges'; end if;
        begin
          perform * from public.get_project_dashboard_counts(array_fill('00000000-0000-4000-8000-000000000001'::uuid,array[501]));
          raise exception 'oversized page accepted';
        exception when invalid_parameter_value then null; end;
        begin
          perform * from public.get_project_dashboard_counts(array[null::uuid]);
          raise exception 'null project ID accepted';
        exception when invalid_parameter_value then null; end;
      end $$;
      set role service_role;
      select document_count || '|' || artifact_count from public.get_project_dashboard_counts(array['00000000-0000-4000-8000-000000000002'::uuid]);
      reset role;
      set role anon;
      do $$ begin
        begin
          perform * from public.get_project_dashboard_counts('{}'::uuid[]);
          raise exception 'anonymous execution accepted';
        exception when insufficient_privilege then null; end;
      end $$;
      reset role;
    `;
    assert.equal(sql(target.toString(), assertion), "1|1");
    // Exercise an additive upgrade and idempotent re-application against
    // populated tables, comparing the function to the clean baseline.
    sql(target.toString(), "drop function public.get_project_dashboard_counts(uuid[]);");
    const migration = readFileSync(new URL("database/migrations/20261101170000_project_dashboard_counts.sql", root), "utf8");
    sql(target.toString(), migration + "\n" + migration);
    assert.equal(sql(target.toString(), "select pg_get_functiondef('public.get_project_dashboard_counts(uuid[])'::regprocedure);"), baselineDefinition);
    assert.equal(sql(target.toString(), assertion), "1|1");
  } finally {
    sql(admin.toString(), `drop database ${name} with (force);`);
  }
});
