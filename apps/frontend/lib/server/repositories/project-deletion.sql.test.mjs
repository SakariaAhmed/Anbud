import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const databaseUrl=process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;
function sql(url,input){const r=spawnSync('psql',[url,'-X','-q','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);}
test('postgres: whole-project deletion removes an edited provenance tree while individual guards remain', {skip:!databaseUrl,timeout:60000},()=>{
 const name='qa_delete_'+randomUUID().replaceAll('-','');const url=new URL(databaseUrl);url.pathname='/'+name;
 sql(databaseUrl,`create database ${name};`);
 try {
  const schema=readFileSync(new URL('../../../../../database/schema.sql',import.meta.url),'utf8');
  sql(url.toString(),"set anbud.allow_destructive_schema_rebuild = on;\n"+schema);
  sql(url.toString(),`do $$
  declare p uuid := gen_random_uuid(); parent uuid := gen_random_uuid(); child uuid := gen_random_uuid();
  begin
   insert into projects(id,client_name,title) values(p,'Synthetic','Deletion regression');
   insert into generated_artifacts(id,project_id,artifact_type,title,content_markdown,artifact_version)
     values(parent,p,'forbedret_kravsvar','Original','Synthetic answer',1);
   insert into generated_artifacts(id,project_id,artifact_type,title,content_markdown,artifact_version,parent_artifact_id)
     values(child,p,'forbedret_kravsvar','Edited','Synthetic edited answer',2,parent);
   begin
    delete from generated_artifacts where id=parent;
    raise exception 'expected child-version guard';
   exception when raise_exception then
    if sqlerrm not like 'ARTIFACT_HAS_CHILD_VERSION%' then raise; end if;
   end;
   insert into generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version,parent_artifact_id)
     values(p,'forbedret_kravsvar','Third version','More edits',3,child);
   insert into solution_evaluations(project_id,evaluated_generated_artifact_id,evaluation_provenance_mode,result_json)
     values(p,child,'generated_artifact','{}');
   delete from projects where id=p;
   if exists(select 1 from solution_evaluations where project_id=p) then raise exception 'orphan evaluation'; end if;
   if exists(select 1 from generated_artifacts where project_id=p) then raise exception 'orphan artifacts'; end if;
   if exists(select 1 from projects where id=p) then raise exception 'project still present'; end if;
  end $$;`);
 } finally {sql(databaseUrl,`drop database ${name} with (force);`);}
});
