import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
const adminUrl = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
const root = path.resolve(import.meta.dirname, "../../../..");
function sql(url, statement, file) {
  const result = spawnSync("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", ...(file ? ["-f", file] : [])], { input: statement, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "SQL failed");
  return result.stdout.trim();
}
function concurrentSql(url, statement) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
    child.stdin.end(statement);
  });
}
test("overlapping scheduled workers claim at most one job across projects while web concurrency remains available", { skip: !adminUrl, timeout: 30_000 }, async () => {
  const name = `anbud_worker_capacity_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  sql(adminUrl, `create database "${name}";`);
  try {
    const url = target.toString();
    sql(url, `create table public.projects(id uuid primary key);
      create table public.project_jobs(id uuid primary key,project_id uuid,status text,lease_token uuid,locked_at timestamptz,started_at timestamptz,updated_at timestamptz,message text);
      insert into public.projects select md5(i::text)::uuid from generate_series(1,3) i;
      insert into public.project_jobs(id,project_id,status) select md5(('job'||i)::text)::uuid,md5(i::text)::uuid,'queued' from generate_series(1,3) i;`);
    sql(url, undefined, path.join(root, "database/migrations/20261101213000_scheduled_worker_capacity.sql"));
    const claim = i => `select coalesce(public.claim_project_job_serialized(md5('job${i}')::uuid,md5('lease${i}')::uuid)::text,'null');`;
    const scheduled = i => `begin; set local request.headers='{"x-anbud-job-runner":"scheduled"}'; ${claim(i)} select pg_sleep(0.2); commit;`;
    const outcomes = await Promise.all([concurrentSql(url, scheduled(1)), concurrentSql(url, scheduled(2))]);
    assert.equal(outcomes.filter(output => output.includes('"id"')).length, 1);
    assert.equal(sql(url, "select count(*) from public.project_jobs where status='running' and run_class='scheduled';"), "1");
    assert.ok(sql(url, claim(3)).includes('"id"'), "an independent web job retains per-project concurrency");
    assert.equal(sql(url, "select count(*) from public.project_jobs where status='running';"), "2");
    sql(url, "update public.project_jobs set status='completed',lease_token=null where run_class='scheduled' and status='running';");
    const waiting = sql(url, "select (regexp_match(id::text, '.*'))[1] from public.project_jobs where status='queued' limit 1;");
    assert.ok(sql(url, `set request.headers='{"x-anbud-job-runner":"scheduled"}'; select public.claim_project_job_serialized('${waiting}'::uuid,md5('next')::uuid);`).includes('"id"'), "capacity is released by the existing terminal state");
    assert.equal(sql(url, "select has_function_privilege('anon','public.claim_project_job_serialized(uuid,uuid)','execute'), has_function_privilege('authenticated','public.claim_project_job_serialized(uuid,uuid)','execute'),has_function_privilege('service_role','public.claim_project_job_serialized(uuid,uuid)','execute');"), "f|f|t");
  } finally { sql(adminUrl, `drop database if exists "${name}" with (force);`); }
});
