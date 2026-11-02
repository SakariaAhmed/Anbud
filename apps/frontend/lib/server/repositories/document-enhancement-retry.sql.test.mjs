import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"../../../../..");
const baseline=readFileSync(path.join(root,"database/schema.sql"),"utf8");
const migration=readFileSync(path.join(root,"database/migrations/20261102150000_atomic_document_enhancement_retry.sql"),"utf8");
const url=process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL;
test("postgres: enhancement retry serializes with publication and rolls back failed enqueues",{skip:!url,timeout:180000},async()=>{
  const name=`enhancement_retry_${randomUUID().replaceAll("-","")}`;
  const target=new URL(url);target.pathname=`/${name}`;target.searchParams.delete("dbname");
  const run=(input,database=target.toString())=>spawnSync("psql",[database,"-X","-q","-At","-v","ON_ERROR_STOP=1"],{input,encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});
  const sql=(input,database)=>{const r=run(input,database);assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout.trim();};
  sql(`create database ${name};`,url);
  try{
    sql(`set client_min_messages=warning;set anbud.allow_destructive_schema_rebuild=on;\n${baseline.replace(migration,"")}`);
    sql(migration);
    sql(migration);
    const fixture=()=>{
      const project=randomUUID(),document=randomUUID(),job=randomUUID();
      sql(`insert into projects(id,client_name,title) values('${project}','Fiktiv','Test');
        insert into documents(id,project_id,role,supporting_subtype,title,display_name,file_name,content_type,file_format,raw_text,processing_status,processing_error,parser_used,indexed_at)
        values('${document}','${project}','supporting_document','kravdokument','Krav','Krav','krav.pdf','application/pdf','pdf','encrypted','basic_ready','Enhancement failed','pdf-parse',now());`);
      const revision=Number(sql(`select chunk_source_revision from documents where id='${document}'`));
      const payload={id:job,project_id:project,kind:"document_docling_enhancement",status:"queued",message:"Retry",input_json:{projectId:project,documentId:document,kind:"document_docling_enhancement"},created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      return {project,document,job,revision,payload};
    };
    const call=(f,payload=f.payload,revision=f.revision)=>`set role service_role;select public.enqueue_document_enhancement_retry('${f.project}','${JSON.stringify(payload)}'::jsonb,${revision});`;
    const state=f=>sql(`select to_jsonb(d) from documents d where id='${f.document}'`);
    const happy=fixture();const before=JSON.parse(state(happy));
    const queued=JSON.parse(sql(call(happy)));assert.equal(queued.id,happy.job);
    const after=JSON.parse(state(happy));assert.equal(after.processing_error,null);assert.match(after.processing_message,/satt i kø/);
    for(const key of ['processing_status','chunk_source_revision','raw_text','parser_used'])assert.equal(after[key],before[key]);
    assert.equal(JSON.parse(sql(call(happy,{...happy.payload,id:randomUUID()}))).id,happy.job);
    assert.equal(sql(`select count(*) from project_jobs where project_id='${happy.project}'`),'1');
    assert.equal(queued.input_json.sourceRevision,happy.revision);
    sql(`update documents set processing_error='Old queued failure' where id='${happy.document}'`);
    assert.equal(JSON.parse(sql(call(happy,{...happy.payload,id:randomUUID()}))).id,happy.job);
    assert.equal(JSON.parse(state(happy)).processing_error,null,"Coalescing a queued retry clears the failure atomically.");

    // A failed parser has recorded its document error but has not terminated its
    // running job yet. Returning that job would falsely promise a new attempt.
    sql(`update project_jobs set status='running',lease_token='22222222-2222-4222-8222-222222222222' where id='${happy.job}';
      update documents set processing_error='Parser failed' where id='${happy.document}'`);
    const failingState=state(happy);
    assert.match(run(call(happy,{...happy.payload,id:randomUUID()})).stderr,/DOCUMENT_ENHANCEMENT_RETRY_NOT_ELIGIBLE/);
    assert.equal(state(happy),failingState);assert.equal(sql(`select count(*) from project_jobs where project_id='${happy.project}'`),'1');
    sql(`update project_jobs set status='failed',lease_token=null where id='${happy.job}'`);
    assert.notEqual(JSON.parse(sql(call(happy,{...happy.payload,id:randomUUID()}))).id,happy.job);

    const failed=fixture();const original=state(failed);
    const invalid={...failed.payload,id:'not-a-uuid'};
    assert.notEqual(run(call(failed,invalid)).status,0);assert.equal(state(failed),original);
    assert.equal(sql(`select count(*) from project_jobs where project_id='${failed.project}'`),'0');
    const foreign=fixture();assert.notEqual(run(call(failed,{...failed.payload,input_json:{...failed.payload.input_json,documentId:foreign.document}})).status,0);
    assert.equal(state(failed),original);
    assert.equal(sql("select has_function_privilege('authenticated','public.enqueue_document_enhancement_retry(uuid,jsonb,bigint)','execute')"),'f');

    // The caller read revision 1. Publication acquires the shared project lock
    // before retry enters; retry must recheck the now-published revision 2.
    const raced=fixture();
    const writer=spawn("psql",[target.toString(),"-X","-q","-At","-v","ON_ERROR_STOP=1"],{stdio:['pipe','pipe','pipe']});
    const done=new Promise((resolve,reject)=>{writer.once('error',reject);writer.once('exit',code=>code===0?resolve():reject(new Error('Publication writer failed')));});
    const locked=new Promise((resolve,reject)=>{let out='';writer.stdout.on('data',chunk=>{out+=chunk;if(out.includes('LOCKED'))resolve();});writer.once('error',reject);writer.once('exit',()=>{if(!out.includes('LOCKED'))reject(new Error('Publication never locked'));});});
    writer.stdin.end(`begin;select id from projects where id='${raced.project}' for update;update documents set raw_text='new encrypted source',processing_status='enhanced_ready',parser_used='docling',processing_error=null where id='${raced.document}';\n\\echo LOCKED\nselect pg_sleep(0.3);commit;`);
    await locked;const conflict=run(call(raced));await done;
    assert.notEqual(conflict.status,0);assert.match(conflict.stderr,/DOCUMENT_ENHANCEMENT_RETRY_STALE/);
    const published=JSON.parse(state(raced));assert.ok(published.chunk_source_revision>raced.revision);assert.equal(published.processing_status,'enhanced_ready');assert.equal(published.parser_used,'docling');assert.equal(published.processing_error,null);
    assert.equal(sql(`select count(*) from project_jobs where project_id='${raced.project}'`),'0');
    const unchanged=state(raced);assert.match(run(call(raced,raced.payload,published.chunk_source_revision)).stderr,/DOCUMENT_ENHANCEMENT_RETRY_NOT_ELIGIBLE/);assert.equal(state(raced),unchanged);
    const messageCall=(f,revision=f.revision,lease="null",job="null")=>`set role service_role;select set_document_enhancement_state('${f.project}','${f.document}',${revision},'Basic version ready','Parser failed',${job},${lease});`;
    assert.equal(sql(messageCall(raced)),'f');assert.equal(state(raced),unchanged,"Old workflow messages cannot relabel published sources.");
    const message=fixture();assert.equal(sql(messageCall(message)),'t');
    assert.equal(JSON.parse(state(message)).processing_status,'basic_ready');
    assert.match(run(messageCall(message,message.revision,"'22222222-2222-4222-8222-222222222222'",`'${message.job}'`)).stderr,/PROJECT_JOB_LEASE_LOST/);
    sql(`update documents set processing_status='failed',indexed_at=null where id='${message.document}'`);
    const failedState=state(message);assert.equal(sql(messageCall(message)),'f');assert.equal(state(message),failedState);
    assert.equal(sql("select has_function_privilege('authenticated','public.set_document_enhancement_state(uuid,uuid,bigint,text,text,uuid,uuid)','execute')"),'f');
  }finally{sql(`drop database ${name} with (force);`,url);}
});
