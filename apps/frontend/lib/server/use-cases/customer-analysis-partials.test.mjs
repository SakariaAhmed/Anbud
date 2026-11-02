import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
const frontend=path.resolve(import.meta.dirname,"../../..");
test("analysis workflow streams into isolated preview storage and publishes once only after complete success",async(t)=>{
  const dir=mkdtempSync(path.join(tmpdir(),"analysis-partial-workflow-"));
  const state={source:1,revision:null,previous:null,writes:[],finals:[],failure:null,manualAfterStream:false};
  globalThis.__analysisPartialWorkflow=state;
  process.env.APP_ENCRYPTION_KEY="analysis-partial-workflow-only";
  t.after(()=>{delete globalThis.__analysisPartialWorkflow;rmSync(dir,{recursive:true,force:true});});
  const stub=path.join(dir,"stub.cjs");
  writeFileSync(stub,`
const state=()=>globalThis.__analysisPartialWorkflow;
exports.getProjectSourceRevision=async()=>state().source;
exports.listProjectDocumentsForAnalysis=async()=>[{id:'doc',project_id:'project',title:'Krav',role:'primary_customer_document',raw_text:'Kunden trenger sikker drift.',structure_map:[]}];
exports.listProjectServiceDescriptions=async()=>[];
exports.getFreshCustomerAnalysis=async()=>{if(state().manualDuringSnapshot)state().revision="manual-snapshot";return state().previous;};
exports.getProjectSnapshotAfterCommit=async()=>({id:'project'});
exports.assertCustomerAnalysisRequirementSourcesReady=()=>{};
exports.createServiceClient=()=>({from(){return {select(){return this;},eq(){return this;},limit:async()=>({data:state().revision?[{revision:state().revision}]:[]})};},async rpc(name,args){state().writes.push({name,args});if(state().failure==='fence')return {error:{message:'PROJECT_SOURCE_REVISION_CHANGED'}};return {data:null};}});
exports.analyzeCustomerDocuments=async(input)=>{
  await input.onCompletedField?.('customer_goals',['Sikre drift.']);
  if(state().failure==='provider')throw new Error('stream failed');
  await input.onCompletedField?.('customer_profile_summary','En norsk kunde.');
  if(state().manualAfterStream)state().revision='manual';
  return {customer_goals:['Sikre drift.'],customer_profile_summary:'En norsk kunde.'};
};
exports.saveCustomerAnalysis=async(project,ids,result,options)=>{
  if(options.expectedAnalysisRevision!==state().revision)throw new Error('CUSTOMER_ANALYSIS_CHANGED');
  state().finals.push({project,ids,result,options});return {...result,revision:'final'};
};
`);
  const jiti=createJiti(path.join(dir,"runner.cjs"),{alias:{
    ...Object.fromEntries(readdirSync(path.join(frontend,"lib/server/ai")).filter(file=>file.endsWith(".ts")).map(file=>[`@/lib/server/ai/${file.slice(0,-3)}`,path.join(frontend,"lib/server/ai",file)])),
    "@/lib/server/repositories/data-store":stub,"@/lib/server/repositories/analyses":stub,
    "@/lib/server/repositories/service-descriptions":stub,"@/lib/server/data-api":stub,
    "@/lib/server/requirements/source-readiness":stub,"@/lib/server/ai":stub,
    "@":frontend,"server-only":"/dev/null",
  }});
  const {generateCustomerAnalysis}=jiti(path.join(frontend,"lib/server/use-cases/project-workflows.ts"));
  const {runWithProjectWorkflowContext}=jiti(path.join(frontend,"lib/server/project-workflow-cancellation.ts"));
  const run=()=>runWithProjectWorkflowContext({signal:new AbortController().signal,lease:{jobId:'job',projectId:'project',leaseToken:'lease'}},()=>generateCustomerAnalysis({projectId:'project'}));
  const result=await run();assert.equal(result.analysis.revision,'final');assert.equal(state.writes.length,2);assert.equal(state.finals.length,1);
  assert.equal(state.finals[0].options.expectedAnalysisRevision,null);assert.equal(state.finals[0].options.expectedSourceRevision,1);
  for(const failure of ['provider','fence']){state.writes=[];state.finals=[];state.failure=failure;await assert.rejects(run());assert.equal(state.writes.length,1);assert.equal(state.finals.length,0);}
  state.failure=null;state.manualAfterStream=true;state.writes=[];state.finals=[];await assert.rejects(run(),/CUSTOMER_ANALYSIS_CHANGED/);assert.equal(state.finals.length,0);
  state.manualAfterStream=false;state.revision=null;state.manualDuringSnapshot=true;state.writes=[];
  await assert.rejects(run(),/Kundeanalysen er endret/);assert.equal(state.writes.length,0,'snapshot race must fail before model work');
});
