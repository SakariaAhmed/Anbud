import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createJiti} from "jiti";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":"/dev/null"}});
const {validateAnalysisPartialField}=jiti(path.join(root,"lib/server/analysis-partial-fields.ts"));
const {createCustomerAnalysisPartialPublisher,readCustomerAnalysisPartial,readCustomerAnalysisRevision}=jiti("./analysis-partials.ts");
const {runWithProjectWorkflowContext}=jiti(path.join(root,"lib/server/project-workflow-cancellation.ts"));
const {encryptJson,decryptJson}=jiti(path.join(root,"lib/server/crypto.ts"));
process.env.APP_ENCRYPTION_KEY="partial-analysis-unit-test-only";
const document={id:"doc",project_id:"project",title:"Kravgrunnlag",raw_text:"Kunden skal beholde kontroll over alle tilganger i løsningen.",structure_map:[]};
const input={projectId:"project",sourceRevision:3,expectedAnalysisRevision:null,documents:[document],serviceCandidates:[]};
const need={title:"Kontroll",description:"Kunden trenger kontroll over tilgangene.",category:"Sikkerhet",importance:"Viktig",kind:"Implisitt",source_reference:"Kravgrunnlag",source_excerpt:document.raw_text};
function context(run,controller=new AbortController()){return runWithProjectWorkflowContext({signal:controller.signal,lease:{jobId:"job",projectId:"project",leaseToken:"lease"}},run);}

test("validator rejects unknown fields, wrong shapes and enums, foreign sources and services",()=>{
  for(const [key,value]of [["revision","fake"],["customer_goals","array expected"],["customer_goals",[5]],["customer_profile_summary",{}],
    ["implicit_requirements",[{...need,importance:"Invented"}]],["implicit_requirements",[{...need,source_reference:"Other document"}]],
    ["implicit_requirements",[{...need,source_excerpt:"Invented quote not in source"}]],["recommended_services",[{service_id:"foreign",service_name:"Foreign",usefulness_percent:80,customer_need:"Need",recommendation_reason:"Reason",evidence:"Evidence",risk_or_caveat:"Risk"}]],
    ["high_level_architecture_mermaid","broken"],["customer_goals",["ok","ok","ok","ok","ok","too many"]]])
    assert.throws(()=>validateAnalysisPartialField({key,value,documents:[document],serviceCandidates:[]}));
});
test("normalization publishes only the received field and grounds source-backed needs",()=>{
  assert.deepEqual(validateAnalysisPartialField({key:"customer_goals",value:["  Sikre drift.  "],documents:[document]}),{customer_goals:["Sikre drift."]});
  const result=validateAnalysisPartialField({key:"implicit_requirements",value:[need],documents:[document]});
  assert.equal(result.implicit_requirements.length,1);assert.equal(result.implicit_requirements[0].source_excerpt,document.raw_text);
});
test("diagram previews are withheld on publish and reload without stopping validated prose",async()=>{
  const diagram='flowchart TD\n A["K-99.7 krever døgnbemanning på side 37"]';
  assert.throws(()=>validateAnalysisPartialField({key:"high_level_architecture_mermaid",value:diagram,documents:[document]}),/withheld/);
  const calls=[];
  await context(async()=>{
    const publish=createCustomerAnalysisPartialPublisher(input,{client:{async rpc(name,args){calls.push(args);return {data:null,error:null};}}});
    await publish("high_level_architecture_mermaid",diagram);
    await publish("customer_goals",["Sikre drift."]);
  });
  assert.equal(calls.length,1);assert.equal(calls[0].p_payload.field,"customer_goals");
  const row={status:"incomplete",job_id:"job",job_status:"failed",source_revision:3,updated_at:"2026-11-02T00:00:00Z",fields:{high_level_architecture_mermaid:encryptJson(diagram),customer_goals:encryptJson(["Sikre drift."])}};
  const result=await readCustomerAnalysisPartial("project",{client:{rpc:async()=>({data:row})}});
  assert.deepEqual(result.fields,{customer_goals:["Sikre drift."]});
});
test("preview prose rejects invented quotations, IDs and unsupported locator precision before persistence",async()=>{
  for (const value of ['Kunden sier «Tilgjengelighet skal være 99,99 prosent».', "Krav K-99.7 krever døgnbemanning.", "Kontrollen står på side 37."]) {
    assert.throws(()=>validateAnalysisPartialField({key:"customer_profile_summary",value,documents:[document]}));
  }
  const corrected=validateAnalysisPartialField({key:"implicit_requirements",value:[{...need,source_reference:"Kravgrunnlag, side 37"}],documents:[document]});
  assert.doesNotMatch(corrected.implicit_requirements[0].source_reference,/side 37/);
  const value=`Kunden sier «${document.raw_text}»`;
  assert.equal(validateAnalysisPartialField({key:"customer_profile_summary",value,documents:[document]}).customer_profile_summary,value);
  await context(async()=>{
    const publish=createCustomerAnalysisPartialPublisher(input,{client:{rpc(){assert.fail("invalid evidence reached persistence");}}});
    await assert.rejects(publish("customer_profile_summary","Krav K-99.7 krever døgnbemanning."));
  });
});
test("publisher encrypts fields and carries source, lease and manual CAS fences without complete publication",async()=>{
  assert.equal(createCustomerAnalysisPartialPublisher(input),undefined);
  const calls=[],client={async rpc(name,args){calls.push([name,args]);return {data:null,error:null};}};
  await context(async()=>{const publish=createCustomerAnalysisPartialPublisher(input,{client});await publish("customer_goals",["Sikre drift."]);await publish("customer_profile_summary","En kunde.");await assert.rejects(publish("customer_goals",["Endret"]),/Duplicate/);});
  assert.equal(calls.length,2);
  for(const [name,args]of calls){assert.equal(name,"save_customer_analysis_partial");assert.equal(args.p_job_id,"job");assert.equal(args.p_lease_token,"lease");assert.equal(args.p_payload.expected_source_revision,3);assert.equal(args.p_payload.expected_analysis_revision,null);assert.equal(args.p_payload.value.encrypted,true);assert.match(args.p_payload.value.payload,/^enc:v1:/);assert.match(args.p_payload.digest,/^[a-f0-9]{64}$/);assert.deepEqual(args.p_payload.source_document_ids,["doc"]);assert.doesNotMatch(JSON.stringify(args),/Sikre drift|En kunde/);}
  assert.deepEqual(decryptJson(calls[0][1].p_payload.value,null),["Sikre drift."]);assert.equal(calls[0][1].p_payload.generation_id,calls[1][1].p_payload.generation_id);
});
test("publisher fails closed on lease loss, cancellation and malformed input",async()=>{
  const calls=[];
  await context(async()=>{const publish=createCustomerAnalysisPartialPublisher(input,{client:{async rpc(){calls.push(1);return {error:{message:"PROJECT_JOB_LEASE_LOST"}};}}});await assert.rejects(publish("customer_goals",["Sikre drift"]),error=>error.name==="ProjectJobLeaseLostError");await assert.rejects(publish("customer_goals",{malformed:true}));});
  assert.equal(calls.length,1);
  const controller=new AbortController();await context(async()=>{const publish=createCustomerAnalysisPartialPublisher(input,{client:{rpc(){assert.fail("cancelled publisher wrote");}}});controller.abort();await assert.rejects(publish("customer_goals",["Sikre drift"]));},controller);
});
test("reload reader decrypts incomplete failed snapshot, propagates stale/null and fails closed on errors",async()=>{
  const row={status:"incomplete",job_id:"job",job_status:"failed",source_revision:3,updated_at:"2026-11-02T00:00:00Z",fields:{customer_goals:encryptJson(["Sikre drift."])}};
  const result=await readCustomerAnalysisPartial("project",{client:{rpc:async()=>({data:row})}});assert.equal(result.status,"incomplete");assert.equal(result.job_status,"failed");assert.deepEqual(result.fields.customer_goals,["Sikre drift."]);
  assert.equal(await readCustomerAnalysisPartial("project",{client:{rpc:async()=>({data:null})}}),null);
  await assert.rejects(readCustomerAnalysisPartial("project",{client:{rpc:async()=>({error:{message:"unavailable"}})}}),/unavailable/);
  await assert.rejects(readCustomerAnalysisPartial("project",{client:{rpc:async()=>({data:{...row,fields:{customer_goals:["unencrypted"]}}})}}),/Unencrypted/);
  await assert.rejects(readCustomerAnalysisPartial("project",{client:{rpc:async()=>({data:{...row,fields:{customer_goals:{encrypted:true,payload:"enc:v1:broken"}}}})}}),/Unreadable/);
});
test("manual CAS captures persisted revision independently of fresh/provenance filtering",async()=>{
  const query={select(){return this;},eq(){return this;},limit:async()=>({data:[{revision:"persisted-old-revision"}]})};assert.equal(await readCustomerAnalysisRevision("project",{client:{from:()=>query}}),"persisted-old-revision");
});
