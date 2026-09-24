import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = readFileSync(path.join(root, "database/migrations/20260906100000_clean_project_job_results.sql"), "utf8");
const database = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL ?? process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;
function sql(url, input) {
  const result = spawnSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test("postgres: cleanup RPC protects exact result, lifecycle, metadata and service-role access", { skip: !database }, () => {
  const name = `anbud_job_cleanup_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(database);
  url.pathname = `/${name}`;
  sql(database, `create database "${name}";`);
  try {
    sql(url.toString(), `
      create table public.project_jobs(id uuid primary key, status text, updated_at timestamptz, result_json jsonb, message text);
      grant select, update on public.project_jobs to service_role;
      ${migration}
      ${migration}
      insert into public.project_jobs values ('00000000-0000-4000-8000-000000000001', 'completed', '2026-09-06Z', '{"encrypted":true,"payload":"enc:v1:old"}', 'unchanged');
      set role service_role;
      do $test$
      declare
        v_id uuid := '00000000-0000-4000-8000-000000000001';
        v_old jsonb := '{"encrypted":true,"payload":"enc:v1:old"}';
        v_denied boolean := false;
        v_new jsonb := '{"encrypted":true,"payload":"enc:v1:new"}';
      begin
        begin
          perform public.clean_project_job_result(v_id, 'running', '2026-09-06Z', v_old, v_new);
        exception when raise_exception then v_denied := true; end;
        if not v_denied then raise exception 'live job cleanup accepted'; end if;
        if public.clean_project_job_result(v_id, 'completed', '2026-09-06Z', '{"changed":true}', v_new) then raise exception 'stale result accepted'; end if;
        if public.clean_project_job_result(v_id, 'failed', '2026-09-06Z', v_old, v_new) then raise exception 'wrong lifecycle accepted'; end if;
        if public.clean_project_job_result(v_id, 'completed', '2026-09-07Z', v_old, v_new) then raise exception 'wrong timestamp accepted'; end if;
        if not public.clean_project_job_result(v_id, 'completed', '2026-09-06Z', v_old, v_new) then raise exception 'valid cleanup failed'; end if;
        if public.clean_project_job_result(v_id, 'completed', '2026-09-06Z', v_old, v_new) then raise exception 'stale retry accepted'; end if;
        if not exists (select from public.project_jobs where id=v_id and result_json=v_new and message='unchanged' and status='completed' and updated_at='2026-09-06Z') then raise exception 'metadata changed'; end if;
      end $test$;
      reset role;
      set role authenticated;
      do $test$
      declare v_denied boolean := false;
      begin
        begin
          perform public.clean_project_job_result('00000000-0000-4000-8000-000000000001', 'completed', '2026-09-06Z', '{}', '{}');
        exception when insufficient_privilege then v_denied := true; end;
        if not v_denied then raise exception 'authenticated call accepted'; end if;
      end $test$;
      reset role;
      do $test$
      begin
        if has_function_privilege('anon', 'public.clean_project_job_result(uuid,text,timestamptz,jsonb,jsonb)', 'execute') or has_function_privilege('authenticated', 'public.clean_project_job_result(uuid,text,timestamptz,jsonb,jsonb)', 'execute') then raise exception 'unprivileged RPC execution allowed'; end if;
      end $test$;
    `);
  } finally {
    sql(database, `drop database "${name}" with (force);`);
  }
});
