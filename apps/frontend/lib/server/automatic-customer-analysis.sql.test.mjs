import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
const root = path.resolve(import.meta.dirname, "../../../..");
const admin = process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
function sql(url, input) {
  const r = spawnSync("psql", [String(url), "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
}
function asyncSql(url, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("psql", [String(url), "-X", "-Atq", "-v", "ON_ERROR_STOP=1"]); let error = "";
    p.stdout.resume(); p.stderr.on("data", data => error += data); p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(error))); p.stdin.end(input);
  });
}
test("postgres: automatic analysis is one-shot, readiness/lease fenced, manual-safe and service-only", { skip: !admin, timeout: 90_000 }, async () => {
  const name = `anbud_auto_analysis_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(admin); url.pathname = `/${name}`;
  sql(admin, `create database "${name}";`);
  try {
    sql(url, `set client_min_messages=warning; set anbud.allow_destructive_schema_rebuild=on;\n${readFileSync(path.join(root, "database/schema.sql"), "utf8")}`);
    const migration = readFileSync(path.join(root, "database/migrations/20261102120000_automatic_customer_analysis.sql"), "utf8");
    sql(url, migration); sql(url, migration);
    const project = randomUUID(), doc = randomUUID(), parent = randomUUID(), lease = randomUUID(), other = randomUUID();
    const callback = `select public.schedule_ready_customer_analysis('${project}','${parent}','${lease}');`;
    sql(url, `
      insert into public.projects(id,client_name,title) values('${project}','Syntetisk kunde','Automatisk analyse');
      insert into public.documents(id,project_id,role,processing_status) values('${doc}','${project}','primary_customer_document','queued');
      insert into public.project_jobs(id,project_id,kind,status,lease_token,input_json) values('${parent}','${project}','document_ingestion','running','${lease}','{}');
      do $$ begin if exists(select from public.project_analysis_requests where project_id='${project}') then raise exception 'absent choice armed automation'; end if; end $$;
      insert into public.project_jobs(project_id,kind,status,input_json) values('${project}','document_ingestion','completed','{"requestAutoAnalysis":true}');
      do $$ declare r uuid; begin
        select request_id into r from public.project_analysis_requests where project_id='${project}';
        insert into public.project_jobs(project_id,kind,status,input_json) values('${project}','document_ingestion','completed','{"requestAutoAnalysis":true}');
        if r is distinct from (select request_id from public.project_analysis_requests where project_id='${project}') then raise exception 'pending uploads rearmed a request'; end if;
        begin perform public.schedule_ready_customer_analysis('${project}','${parent}',gen_random_uuid()); raise exception 'wrong lease accepted'; exception when raise_exception then if sqlerrm not like 'PROJECT_JOB_LEASE_LOST%' then raise; end if; end;
      end $$;
      ${callback}
      do $$ begin if exists(select from public.project_jobs where project_id='${project}' and kind='customer_analysis') then raise exception 'unready document started analysis'; end if; end $$;
      update public.documents set processing_status='basic_ready',indexed_at=now() where id='${doc}';
      ${callback}
      insert into public.document_chunks(source_type,source_id,project_id,document_title,file_name,file_format,chunk_index,kind,text_encrypted,content_hash)
      values('project_document','${doc}','${project}','Krav','krav.txt','txt',0,'paragraph','syntetisk','hash');
      ${callback}
      do $$ begin if exists(select from public.project_jobs where project_id='${project}' and kind='customer_analysis') then raise exception 'missing metadata started analysis'; end if; end $$;
      insert into public.document_intelligence_artifacts(document_id,project_id,source_revision,compiler_version,content_hash,parser_used,artifact_encrypted,analysis_context_encrypted)
      select id,project_id,chunk_source_revision,'test','hash','test','{}','syntetisk' from public.documents where id='${doc}';
      insert into public.project_jobs(id,project_id,kind,status,input_json) values('${other}','${project}','document_docling_enhancement','queued','{}');
      ${callback}
      do $$ begin if exists(select from public.project_jobs where project_id='${project}' and kind='customer_analysis') then raise exception 'queued enhancement was ignored'; end if; end $$;
      update public.project_jobs set status='completed' where id='${other}';
    `);
    await Promise.all([asyncSql(url, `begin; set role service_role; ${callback} select pg_sleep(0.15); commit;`), asyncSql(url, `set role service_role; ${callback}`)]);
    assert.equal(sql(url, `select count(*) from public.project_jobs where project_id='${project}' and kind='customer_analysis';`), "1");
    sql(url, `
      do $$ declare r public.project_analysis_requests; v_payload jsonb; begin
        select * into r from public.project_analysis_requests where project_id='${project}';
        if r.status<>'scheduled' then raise exception 'request not scheduled'; end if;
        v_payload:=jsonb_build_object('expected_source_revision',r.source_revision,'expected_analysis_revision',null,'automatic_request_id',r.request_id,'source_document_ids',jsonb_build_array('${doc}'),'result_json','{}'::jsonb,'last_activity_at',now(),'context_keywords','[]'::jsonb);
        -- A new manual analysis after the automatic snapshot must win.
        insert into public.customer_analyses(project_id,result_json,provenance_verified) values('${project}','{"manual":true}',true);
        begin perform public.save_customer_analysis_if_source_revision('${project}',v_payload); raise exception 'automatic save overwrote manual work'; exception when raise_exception then if sqlerrm<>'CUSTOMER_ANALYSIS_CHANGED' and sqlerrm not like 'PROJECT_SOURCE_REVISION_CHANGED%' then raise; end if; end;
        -- Isolate the explicit-null CAS even when analysis context publication
        -- also advanced the project source revision.
        begin perform public.save_customer_analysis_if_source_revision('${project}',jsonb_set(v_payload-'automatic_request_id','{expected_source_revision}',to_jsonb((select source_revision from public.projects where id='${project}')))); raise exception 'null first-save CAS overwrote manual work'; exception when raise_exception then if sqlerrm<>'CUSTOMER_ANALYSIS_CHANGED' then raise; end if; end;
        delete from public.customer_analyses where project_id='${project}';
        v_payload:=jsonb_set(v_payload,'{expected_source_revision}',to_jsonb((select source_revision from public.projects where id='${project}')));
        -- An explicit opt-out during generation prevents publication.
        insert into public.project_jobs(project_id,kind,status,input_json) values('${project}','document_ingestion','completed','{"requestAutoAnalysis":false}');
        begin perform public.save_customer_analysis_if_source_revision('${project}',v_payload); raise exception 'cancelled request published'; exception when raise_exception then if sqlerrm not like 'AUTOMATIC_ANALYSIS_CANCELLED%' then raise; end if; end;
        insert into public.project_jobs(project_id,kind,status,input_json) values('${project}','document_ingestion','completed','{"requestAutoAnalysis":true}');
        if r.request_id=(select request_id from public.project_analysis_requests where project_id='${project}') then raise exception 'explicit rearm reused old identity'; end if;
        update public.project_jobs set status='failed',error='Syntetisk feil' where id=r.job_id;
        if (select status from public.project_analysis_requests where project_id='${project}')<>'pending' then raise exception 'old failure changed newer request'; end if;
      end $$;
      ${callback}
      do $$ declare r public.project_analysis_requests; begin
        select * into r from public.project_analysis_requests where project_id='${project}';
        update public.project_jobs set status='failed',error='Syntetisk feil' where id=r.job_id;
        perform public.schedule_ready_customer_analysis('${project}','${parent}','${lease}');
        if (select status from public.project_analysis_requests where project_id='${project}')<>'failed' then raise exception 'failed request auto-retried'; end if;
        if (select count(*) from public.project_jobs where project_id='${project}' and kind='customer_analysis')<>2 then raise exception 'duplicate retry was inserted'; end if;
      end $$;
      insert into public.customer_analyses(project_id,result_json,provenance_verified) values('${project}','{"manual":true}',true);
      insert into public.project_jobs(project_id,kind,status,input_json) values('${project}','document_ingestion','completed','{"requestAutoAnalysis":true}');
      ${callback}
      do $$ begin
        if not exists(select from public.project_analysis_requests where project_id='${project}' and status='completed' and reason_code='existing_analysis_preserved') then raise exception 'existing analysis not preserved'; end if;
        if not exists(select from public.customer_analyses where project_id='${project}' and result_json='{"manual":true}') then raise exception 'manual analysis changed'; end if;
        if has_table_privilege('authenticated','public.project_analysis_requests','select') or has_table_privilege('anon','public.project_analysis_requests','select')
          or has_function_privilege('authenticated','public.schedule_ready_customer_analysis(uuid,uuid,uuid)','execute') then raise exception 'public automation access granted'; end if;
      end $$;
    `);
    const recovery = randomUUID(), recoveryDoc = randomUUID(), unready = randomUUID();
    sql(url, `
      insert into public.projects(id,client_name,title) values('${recovery}','Syntetisk kunde','Gjenopprettet kø');
      insert into public.documents(id,project_id,role,processing_status,indexed_at) values('${recoveryDoc}','${recovery}','primary_customer_document','basic_ready',now());
      insert into public.document_chunks(source_type,source_id,project_id,document_title,file_name,file_format,chunk_index,kind,text_encrypted,content_hash)
      values('project_document','${recoveryDoc}','${recovery}','Krav','krav.txt','txt',0,'paragraph','syntetisk','hash');
      insert into public.document_intelligence_artifacts(document_id,project_id,source_revision,compiler_version,content_hash,parser_used,artifact_encrypted,analysis_context_encrypted)
      select id,project_id,chunk_source_revision,'test','hash','test','{}','syntetisk' from public.documents where id='${recoveryDoc}';
      -- A legacy job without input must not create an intent or reject history.
      insert into public.project_jobs(project_id,kind,status) values('${recovery}','document_ingestion','completed');
      insert into public.project_jobs(project_id,kind,status,input_json) values('${recovery}','document_ingestion','completed','{"requestAutoAnalysis":true}');
      insert into public.projects(id,client_name,title) values('${unready}','Syntetisk kunde','Venter på dokument');
      insert into public.project_analysis_requests(project_id,status,updated_at) values('${unready}','pending','2020-01-01');
      set role service_role;
      select public.dispatch_ready_customer_analyses(1);
      select public.dispatch_ready_customer_analyses(1);
      select public.dispatch_ready_customer_analyses(20);
      reset role;
      do $$ begin
        if (select count(*) from public.project_jobs where project_id='${recovery}' and kind='customer_analysis')<>1 then raise exception 'recovery dispatcher failed or duplicated the job'; end if;
        if has_function_privilege('authenticated','public.dispatch_ready_customer_analyses(integer)','execute') then raise exception 'public recovery dispatch access granted'; end if;
      end $$;
    `);
  } finally { sql(admin, `drop database "${name}" with (force);`); }
});
