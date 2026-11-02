import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertOwnedSystemTestStack, systemTestStatusPath } from './system-test-runtime.mjs';
// Explicit synthetic database-state injection; this never invokes parsing or models.
if (!process.argv.includes('--injected-fixtures')) throw new Error('Explicit --injected-fixtures is required.');
const status=JSON.parse(fs.readFileSync(systemTestStatusPath()));
const runtime=JSON.parse(fs.readFileSync(path.join(status.directory,'environment.json')));
assertOwnedSystemTestStack(status,runtime);
async function api(route,body){
 const response=await fetch(status.baseUrl+route,{method:body?'POST':'GET',headers:{cookie:runtime.sessions.adminCookie,origin:status.baseUrl,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.ok(response.ok,`App route ${route}: ${response.status}`);return response.json();
}
async function data(route,body,method='POST'){
 const response=await fetch(runtime.env.DATA_API_URL+route,{method,headers:{authorization:`Bearer ${runtime.env.DATA_API_SERVICE_ROLE_KEY}`,'content-type':'application/json',prefer:'return=representation'},...(body?{body:JSON.stringify(body)}:{})});
 assert.ok(response.ok,`Owned data fixture ${route}: ${response.status}`);return response.status===204?null:response.json();
}
assert.equal(await data('/rpc/automatic_customer_analysis_preflight',{}),'automatic-customer-analysis-v1');
const results=[];
for(const reason of ['customer_document_required','document_basis_not_ready']){
 const project=await api('/api/projects',{name:`Syntetisk feilstatskontroll ${reason}`,customer_name:'Fiktiv kommune'});
 if(reason==='document_basis_not_ready')await data('/documents',{project_id:project.id,role:'primary_customer_document',processing_status:'failed',title:'Syntetisk feilet dokument'});
 await data('/project_analysis_requests',{project_id:project.id,status:'pending'});
 await data('/rpc/schedule_ready_customer_analysis',{p_project_id:project.id,p_parent_job_id:null,p_parent_lease_token:null});
 const state=await api(`/api/projects/${project.id}/jobs`);
 assert.equal(state.automatic_analysis?.status,'failed');assert.equal(state.automatic_analysis.reason_code,reason);assert.equal(state.jobs.length,0);
 // Repairing the fixture later cannot resurrect an old one-shot paid request.
 if(reason==='document_basis_not_ready')await data(`/documents?project_id=eq.${project.id}`,undefined,'DELETE');
 await data('/rpc/schedule_ready_customer_analysis',{p_project_id:project.id,p_parent_job_id:null,p_parent_lease_token:null});
 const after=await api(`/api/projects/${project.id}/jobs`);
 assert.equal(after.automatic_analysis?.status,'failed');assert.equal(after.jobs.length,0);
 results.push({reason,project_id:project.id,status:'failed',queued_jobs:0});
}
fs.writeFileSync(path.join(status.directory,'automatic-analysis-failure-status-result.json'),JSON.stringify({fixture:'Injected synthetic persisted failure states, no parser/model execution',results},null,2),{mode:0o600});
console.log(JSON.stringify({checks:results.length,preflight:'passed',results},null,2));
