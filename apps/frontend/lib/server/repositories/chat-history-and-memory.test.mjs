import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");

function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-history-"));
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "fictional-chat-history-regression-key";
  const state = { messages: [], sessions: [], queries: [], casConflicts: 0 };
  globalThis.__chatHistoryRegression = state;
  const adapter = path.join(directory, "data.cjs");
  writeFileSync(adapter, `exports.createServiceClient = () => ({
    async rpc(name, body) {
      if(name!=='compare_and_swap_chat_session_memory') throw Error('Unexpected RPC');
      const state=globalThis.__chatHistoryRegression;
      const row=state.sessions.find(row=>row.project_id===body.p_project_id && row.id===body.p_session_id && row.summary_encrypted===body.p_expected_summary);
      if (!row) { state.casConflicts++;return {data:false,error:null}; }
      row.summary_encrypted=body.p_summary;row.domain_hints=body.p_domain_hints;
      return {data:true,error:null};
    }, from(table) {
    const state = globalThis.__chatHistoryRegression;
    const filters = []; let sorting=[], limit=Infinity, patch, inserted, options, disjunction;
    const matches = row => filters.every(([key,value,op]) => op === 'gt' ? row[key] > value : op === 'is' ? row[key] == null : row[key] === value) && (!disjunction || row.created_at < disjunction.time || (row.created_at === disjunction.time && row.id < disjunction.id));
    const query = {
      select() { return query; }, eq(key,value) { filters.push([key,value,'eq']); return query; },
      is(key,value) { filters.push([key,value,'is']); return query; }, gt(key,value) { filters.push([key,value,'gt']); return query; },
      order(key, opts) { sorting.push([key,opts.ascending]); return query; }, limit(value) { limit=value; return query; },
      or(value) { const match=/^created_at.lt.(.*),and\\(created_at.eq.(.*),id.lt.(.*)\\)$/.exec(value); if (!match || match[1] !== match[2]) throw Error('Bad keyset'); disjunction={time:match[1],id:match[3]}; return query; },
      update(value) { patch=value; return query; }, upsert(value, opts) { inserted=value; options=opts; return query; },
      async single() { const result=await execute(); return {data:result.data[0] ?? null,error:null}; },
      then(resolve,reject) { return execute().then(resolve,reject); }
    };
    async function execute() {
      const rows=table==='chat_messages'?state.messages:state.sessions;
      if (inserted) {
        const existing=rows.find(row=>row.project_id===inserted.project_id && row.id===inserted.id);
        if (!existing) rows.push({title:'Ny chat',summary_encrypted:'',domain_hints:[],status:'active',message_count:0,pinned:false,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...inserted});
        else if(!options.ignoreDuplicates) Object.assign(existing,inserted);
        return {data:null,error:null};
      }
      let selected=rows.filter(matches);
      if (patch) {
        if (!selected.length && 'summary_encrypted' in patch) state.casConflicts++;
        selected.forEach(row=>Object.assign(row,patch));
      }
      for (const [key,asc] of [...sorting].reverse()) selected.sort((a,b)=>(a[key]<b[key]?-1:a[key]>b[key]?1:0)*(asc?1:-1));
      state.queries.push({table,limit,filters:filters.map(f=>[...f]),patch});
      return {data:selected.slice(0,limit).map(row=>({...row})),error:null};
    }
    return query;
  } });`);
  const cache = path.join(directory, "cache.cjs");
  writeFileSync(cache, "exports.revalidateProjectCaches=()=>{};");
  const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@/lib/server/data-api": adapter, "@/lib/server/repositories/repository-cache": cache,
    "@": frontend, "server-only": "/dev/null",
  } });
  return {state, repository:load("./chat.ts"), crypto:load("../crypto.ts"), cleanup() {
    if(previousKey===undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY=previousKey;
    delete globalThis.__chatHistoryRegression; rmSync(directory,{recursive:true,force:true});
  }};
}
function message(index, sessionId='requested') {
  return {id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`, project_id:'project',session_id:sessionId,
    role:'user',content:`Melding ${index}`,context_snapshot:{},created_at:'2026-01-01T00:00:00.123456+00:00'};
}

test('per-session history pages retain tied timestamps, omit other projects, and survive newer messages between pages',async()=>{
  const h=harness();
  try {
    h.state.messages=[...Array.from({length:1201},(_,i)=>message(i+1000,'other')),...Array.from({length:205},(_,i)=>message(i))];
    h.state.messages.push({...message(9000),project_id:'denied-project'});
    const first=await h.repository.listChatMessagePage('project','requested');
    assert.equal(first.messages.length,100);
    assert.equal(first.messages[0].content,'Melding 105');
    assert.ok(first.nextCursor);
    h.state.messages.push(message(999));
    const second=await h.repository.listChatMessagePage('project','requested',h.repository.decodeChatMessageCursor(first.nextCursor));
    const third=await h.repository.listChatMessagePage('project','requested',h.repository.decodeChatMessageCursor(second.nextCursor));
    assert.equal(third.nextCursor,null);
    const ids=[...third.messages,...second.messages,...first.messages].map(m=>m.id);
    assert.equal(ids.length,205); assert.equal(new Set(ids).size,205);
    assert.deepEqual(ids,Array.from({length:205},(_,i)=>message(i).id));
    assert.ok(h.state.queries.every(q=>q.limit===101));
    assert.deepEqual(await h.repository.listChatMessages('project','missing'),[]);
    assert.throws(()=>h.repository.decodeChatMessageCursor('bad cursor'),/Ugyldig/);
    assert.throws(()=>h.repository.decodeChatMessageCursor(Buffer.from(JSON.stringify({createdAt:'2026-01-01T00:00:00Z),project_id.eq.other',id:message(0).id})).toString('base64url')),/Ugyldig/);
  } finally {h.cleanup();}
});

test('encrypted legacy snapshot ids are materialized across bounded pages and their ciphertext stays intact',async()=>{
  const h=harness();
  try {
    h.state.messages=Array.from({length:205},(_,i)=>({...message(i,null),context_snapshot:h.crypto.encryptJson({chat_session_id:i%2?'legacy-custom':'legacy-other',chat_session_title:'Eldre chat'})}));
    h.state.messages.push({...message(500,null),context_snapshot:{}});
    const ciphertext=h.state.messages[0].context_snapshot.payload;
    const sessions=await h.repository.listChatSessions('project');
    assert.deepEqual(sessions.map(s=>s.id).sort(),['legacy','legacy-custom','legacy-other']);
    assert.equal(h.state.messages.filter(m=>m.session_id===null).length,0);
    assert.equal(h.state.messages[0].context_snapshot.payload,ciphertext);
    const page=await h.repository.listChatMessagePage('project','legacy-custom');
    assert.equal(page.messages.length,100); assert.ok(page.nextCursor);
    const legacyReads=h.state.queries.filter(q=>q.table==='chat_messages' && !q.patch && q.filters.some(f=>f[0]==='session_id'&&f[2]==='is'));
    assert.equal(legacyReads.length,4); assert.ok(legacyReads.every(q=>q.limit===100));
    const before=h.state.queries.length;
    await h.repository.listChatSessions('project');
    assert.equal(h.state.queries.slice(before).filter(q=>q.table==='chat_messages').length,1,'current sessions do not rescan their message history');
  } finally {h.cleanup();}
});

test('ciphertext CAS appends both concurrent memory turns without replacing counts, previews or session metadata',async()=>{
  const h=harness();
  try {
    h.state.sessions=[{project_id:'project',id:'session',title:'Existing title',summary_encrypted:h.crypto.encryptString('Start'),domain_hints:['Risiko'],message_count:4,last_message_preview:'Nyeste',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}];
    await h.repository.upsertChatSession({projectId:'project',sessionId:'session',title:'Older request title',domainHints:[]});
    assert.equal(h.state.sessions[0].title,'Existing title');
    await Promise.all(['Turn A','Turn B'].map(turn=>h.repository.updateChatSessionMemory({projectId:'project',sessionId:'session',appendSummary:summary=>summary+' '+turn,domainHints:['Kunde og behov']})));
    const row=h.state.sessions[0];
    const summary=h.crypto.decryptString(row.summary_encrypted);
    assert.ok(summary.includes('Turn A')); assert.ok(summary.includes('Turn B'));
    assert.ok(h.state.casConflicts>=1,'both contenders begin from the same old ciphertext');
    assert.equal(row.message_count,4); assert.equal(row.last_message_preview,'Nyeste');
    assert.deepEqual(row.domain_hints,['Risiko','Kunde og behov']);
    assert.ok(!row.summary_encrypted.includes('Turn A'));
  } finally {h.cleanup();}
});
