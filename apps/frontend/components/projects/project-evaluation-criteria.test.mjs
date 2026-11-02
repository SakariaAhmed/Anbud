import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
const frontend=path.resolve(import.meta.dirname,"../..");
const require=createRequire(path.join(frontend,"package.json"));
const {createElement}=require("react");
const {renderToStaticMarkup}=require("react-dom/server");
const {ProjectEvaluationTab}=createJiti(import.meta.url,{fsCache:false,jsx:{runtime:"automatic"},alias:{"@":frontend}})("./project-evaluation-tab.tsx");
const customer={id:"customer",title:"Kravgrunnlag",role:"primary_customer_document",chunk_source_revision:1};
const solution={id:"solution",title:"Løsning",file_format:"pdf",file_name:"losning.pdf",role:"primary_solution_document",chunk_source_revision:2,processing_status:"basic_ready",indexed_at:"2026-11-02",metadata_status:"completed"};
const criterion={criterion_id:"criterion",criterion_index:0,criterion:"Overgangsplan",origin:"observed",assessment:"Godt",rationale:"Planens milepæler er dokumentert.",evidence:"En kontrollert overgang med tre milepæler.",criterion_scope:{version:1,analysis_revision:"a1",analysis_criteria:["Overgangsplan"],documents:[{id:"customer",revision:1,fingerprint:"c"}],solution:{id:"solution",revision:2,fingerprint:"s"}}};
const evaluation={criterion_coverage:[criterion],solution_document_id:"solution",document_findings:[],strengths:[],weaknesses:[],generic_sections:[],missing_elements:[],risks_to_customer:[],trust_signals:[],improvement_recommendations:[],value_assessment:[],rewrite_suggestions:[],fit_to_customer_needs:"",likely_score_assessment:{quality:"",delivery_confidence:"",risk:"",competitiveness:""}};
const render=sourceDocuments=>renderToStaticMarkup(createElement(ProjectEvaluationTab,{documents:[solution],sourceDocuments,solutionEvaluation:evaluation,hasSolutionDocument:true,busy:false,busyMessage:"",busyProgress:0,onGenerate:async()=>{},importBusy:false,onImportArchitectureDocument:async()=>null}));
test("criterion evidence stays visible with solution-only selection candidates and all current sources",()=>{
  const html=render([customer,solution]);
  assert.match(html,/Godt: Planens milepæler er dokumentert/);
  assert.match(html,/En kontrollert overgang med tre milepæler/);
  assert.match(html,/Dokumentert evalueringskriterium/);
  assert.doesNotMatch(html,/gjelder tidligere kilder/);
  for(const sources of [[solution],[{...customer,chunk_source_revision:2},solution]]){
    const stale=render(sources);assert.match(stale,/gjelder tidligere kilder/);assert.doesNotMatch(stale,/En kontrollert overgang med tre milepæler/);
  }
});
