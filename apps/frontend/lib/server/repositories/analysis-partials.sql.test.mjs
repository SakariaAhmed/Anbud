import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../../..");
const migration=readFileSync(path.join(root,"database/migrations/20261102130000_customer_analysis_partials.sql"),"utf8");
const regression=readFileSync(path.join(root,"database/tests/customer-analysis-partials.sql"),"utf8");
const url=process.env.CUSTOMER_ANALYSIS_PARTIALS_SQL_TEST_DATABASE_URL??process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
function sql(database,query){const result=spawnSync("psql",[database,"-X","-v","ON_ERROR_STOP=1","-Atq"],{input:query,encoding:"utf8",timeout:20000});assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout;}
test("partial schema baseline includes the exact ordered migration",()=>{assert.ok(readFileSync(path.join(root,"database/schema.sql"),"utf8").includes(migration));});
test("postgres: incomplete previews enforce source/manual/lease fences, immutable retries, failure reload and service-only access",{skip:!url,timeout:60000},()=>{
  const name=`anbud_partials_${randomUUID().replaceAll("-","")}`;
  const disposable=new URL(url);disposable.pathname=`/${name}`;
  sql(url,`create database "${name}"`);
  try{
    sql(disposable.toString(),`
      create table public.projects(id uuid primary key,source_revision bigint not null,customer_analysis_generated boolean not null default false);
      create table public.documents(id uuid primary key,project_id uuid not null references public.projects(id));
      create table public.customer_analyses(project_id uuid primary key references public.projects(id),revision uuid not null);
      create table public.project_jobs(id uuid primary key,project_id uuid not null references public.projects(id),kind text not null,status text not null,
        lease_token uuid,locked_at timestamptz,submission_sequence bigint not null,result_checkpoint jsonb);
      create table public.project_analysis_requests(project_id uuid primary key,request_id uuid,status text,source_revision bigint);
      grant select,insert,update,delete on public.projects,public.documents,public.customer_analyses,public.project_jobs,public.project_analysis_requests to service_role;
    `);
    sql(disposable.toString(),migration);
    sql(disposable.toString(),`set role service_role;\n${regression}`);
  }finally{
    sql(url,`select pg_terminate_backend(pid) from pg_stat_activity where datname='${name}';drop database "${name}";`);
  }
});
