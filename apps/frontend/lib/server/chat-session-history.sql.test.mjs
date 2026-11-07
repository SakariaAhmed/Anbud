import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const databaseUrl=process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test('postgres: chat metadata counts concurrent inserts, orders previews and upgrades existing sessions', {skip:!databaseUrl,timeout:60000},async()=>{
  const name=`chat_history_${randomUUID().replaceAll('-','')}`;
  const target=new URL(databaseUrl); target.pathname=`/${name}`;
  function sql(url,input) {
    const result=spawnSync('psql',[url,'-X','-q','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
    assert.equal(result.status,0,result.stderr || result.stdout);
    return result.stdout;
  }
  async function concurrent(input) {
    await new Promise((resolve,reject)=>{
      const child=spawn('psql',[target.toString(),'-X','-q','-v','ON_ERROR_STOP=1'],{stdio:['pipe','ignore','pipe']});
      let error=''; child.stderr.on('data',chunk=>{error+=chunk;}); child.on('error',reject);
      child.on('close',code=>code===0?resolve():reject(new Error(error))); child.stdin.end(input);
    });
  }
  sql(databaseUrl,`create database ${name};`);
  try {
    const schema=readFileSync(new URL('../../../../database/schema.sql',import.meta.url),'utf8');
    const migration=readFileSync(new URL('../../../../database/migrations/20261107090000_chat_session_history_and_memory.sql',import.meta.url),'utf8');
    sql(target.toString(),`set client_min_messages=warning;set anbud.allow_destructive_schema_rebuild=on;\n${schema}\nset role service_role;
      insert into projects(id,title,client_name) values('00000000-0000-4000-8000-000000000001','Fiktivt prosjekt','Fiktiv kunde');
    insert into chat_sessions(project_id,id,title) values('00000000-0000-4000-8000-000000000001','shared','Felles chat');`);
    sql(target.toString(), `begin read only;set local role service_role;do $$begin
      if public.chat_session_consistency_preflight() <> 'chat-session-consistency-v1' then raise exception 'Wrong preflight version';end if;
      if has_function_privilege('anon','public.chat_session_consistency_preflight()','execute')
        or has_function_privilege('authenticated','public.chat_session_consistency_preflight()','execute')
        or not has_function_privilege('service_role','public.chat_session_consistency_preflight()','execute') then raise exception 'Preflight privileges failed';end if;
    end$$;commit;
    alter table chat_messages disable trigger chat_message_session_metadata;
    set role service_role;do $$begin
      begin
        perform public.chat_session_consistency_preflight();
        raise exception 'Missing trigger was accepted';
      exception when others then
        if sqlerrm not like 'CHAT_SESSION_SCHEMA_INCOMPLETE: enabled metadata trigger%' then raise;end if;
      end;
    end$$;reset role;alter table chat_messages enable trigger chat_message_session_metadata;
    alter table chat_sessions disable trigger chat_session_metadata_guard;
    set role service_role;do $$begin
      begin
        perform public.chat_session_consistency_preflight();raise exception 'Missing legacy guard was accepted';
      exception when others then
        if sqlerrm not like 'CHAT_SESSION_SCHEMA_INCOMPLETE: legacy metadata guard%' then raise;end if;
      end;
    end$$;reset role;alter table chat_sessions enable trigger chat_session_metadata_guard;`);
    await Promise.all([
      concurrent(`set role service_role;begin;insert into chat_messages(id,project_id,session_id,role,content,created_at) values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','shared','user','Nyeste melding','2026-11-07T12:00:00.123456Z');update chat_sessions set message_count=999,last_message_preview='Stale old client' where id='shared';select pg_sleep(0.1);commit;`),
      concurrent(`set role service_role;begin;insert into chat_messages(id,project_id,session_id,role,content,created_at) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','shared','assistant','Eldre melding','2026-11-07T12:00:00.123456Z');insert into chat_sessions(project_id,id,title,message_count,last_message_preview) values('00000000-0000-4000-8000-000000000001','shared','Felles chat',1,'Stale old upsert') on conflict(project_id,id) do update set message_count=excluded.message_count,last_message_preview=excluded.last_message_preview;commit;`),
    ]);
    sql(target.toString(),`set role service_role;do $$ begin
      if not exists(select 1 from chat_sessions where id='shared' and message_count=2 and last_message_preview='Nyeste melding') then raise exception 'Concurrent count or tied preview failed';end if;
      if has_function_privilege('anon','public.track_chat_session_message()','execute') or has_function_privilege('authenticated','public.track_chat_session_message()','execute') or has_function_privilege('anon','public.compare_and_swap_chat_session_memory(uuid,text,text,text,text[])','execute') or has_function_privilege('authenticated','public.protect_chat_session_message_metadata()','execute') then raise exception 'Trigger helper exposed';end if;
    end $$;
    do $$begin
      if not public.compare_and_swap_chat_session_memory('00000000-0000-4000-8000-000000000001','shared','','enc:v1:synthetic-a',array['Risiko']) then raise exception 'Initial CAS failed';end if;
      if public.compare_and_swap_chat_session_memory('00000000-0000-4000-8000-000000000001','shared','','enc:v1:synthetic-b',array['Risiko']) then raise exception 'Stale CAS replaced current memory';end if;
      if coalesce(current_setting('anbud.chat_memory_cas',true),'') <> '' then raise exception 'Successful CAS leaked context';end if;
      begin
        update chat_sessions set summary_encrypted='enc:v1:blind-old-summary',message_count=999,last_message_preview='Old completion' where id='shared';
        raise exception 'Blind summary overwrite accepted';
      exception when others then if sqlerrm not like 'CHAT_MEMORY_CAS_REQUIRED:%' then raise;end if;end;
      if not exists(select 1 from chat_sessions where id='shared' and summary_encrypted='enc:v1:synthetic-a' and message_count=2 and last_message_preview='Nyeste melding') then raise exception 'Old update clobbered canonical state';end if;
      begin
        perform public.compare_and_swap_chat_session_memory('00000000-0000-4000-8000-000000000001','shared','enc:v1:synthetic-a','enc:v1:failing-update',null);
        raise exception 'Invalid memory update accepted';
      exception when not_null_violation then null;end;
      if coalesce(current_setting('anbud.chat_memory_cas',true),'') <> '' then raise exception 'Failed CAS leaked context';end if;
      if (select count(*) from chat_messages where session_id='shared') <> 2 then raise exception 'Legacy summary rejection removed messages';end if;
      perform set_config('anbud.chat_memory_cas','outer-context',true);
      if not public.compare_and_swap_chat_session_memory('00000000-0000-4000-8000-000000000001','shared','enc:v1:synthetic-a','enc:v1:scoped-update',array['Risiko']) then raise exception 'Scoped CAS failed';end if;
      if current_setting('anbud.chat_memory_cas',true)<>'outer-context' then raise exception 'CAS did not restore previous context';end if;
      begin
        perform public.compare_and_swap_chat_session_memory('00000000-0000-4000-8000-000000000001','shared','enc:v1:scoped-update','enc:v1:scoped-failure',null);
        raise exception 'Invalid scoped memory update accepted';
      exception when not_null_violation then null;end;
      if current_setting('anbud.chat_memory_cas',true)<>'outer-context' then raise exception 'Failed CAS did not restore previous context';end if;
      perform set_config('anbud.chat_memory_cas','',true);

      begin
        update chat_sessions set summary_encrypted='enc:v1:blind-after-failure' where id='shared';raise exception 'Failed CAS left blind overwrite enabled';
      exception when others then if sqlerrm not like 'CHAT_MEMORY_CAS_REQUIRED:%' then raise;end if;end;
    end $$;
    insert into chat_sessions(project_id,id,title,message_count,last_message_preview) values('00000000-0000-4000-8000-000000000001','legacy','Eldre',99,'Old initial counter')
      on conflict(project_id,id) do update set message_count=excluded.message_count,last_message_preview=excluded.last_message_preview;
    do $$begin if not exists(select 1 from chat_sessions where id='legacy' and message_count=0 and last_message_preview='') then raise exception 'Legacy insert polluted initial metadata';end if;end$$;
    insert into chat_messages(id,project_id,role,content) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','user','Eldre tekst');
    update chat_messages set session_id='legacy' where id='00000000-0000-4000-8000-000000000003';
    do $$begin if not exists(select 1 from chat_sessions where id='legacy' and message_count=1) then raise exception 'Legacy materialization count failed';end if;end$$;
    delete from chat_messages where id='00000000-0000-4000-8000-000000000002';
    update chat_sessions set message_count=44,last_message_preview='Stale after delete',last_message_created_at='1900-01-01',last_message_id='00000000-0000-4000-8000-000000000099' where id='shared';
    do $$begin if not exists(select 1 from chat_sessions where id='shared' and message_count=1 and last_message_preview='Eldre melding') then raise exception 'Deleted preview/count failed';end if;end$$;`);
    // Upgrade path: repairing old counters must not touch encrypted memory.
    sql(target.toString(),`drop trigger chat_message_session_metadata on chat_messages;drop trigger chat_session_metadata_guard on chat_sessions;alter table chat_sessions drop column last_message_created_at,drop column last_message_id;drop index chat_messages_session_page_idx;drop index chat_messages_legacy_session_idx;update chat_sessions set message_count=999,last_message_preview='wrong',summary_encrypted='fictional-encrypted-memory';\n${migration}\n${migration}\nset role service_role;do $$begin if exists(select 1 from chat_sessions where message_count<>1 or summary_encrypted<>'fictional-encrypted-memory') then raise exception 'Additive migration or replay changed data';end if;end$$;`);
  } finally {sql(databaseUrl,`drop database ${name} with(force);`);}
});
