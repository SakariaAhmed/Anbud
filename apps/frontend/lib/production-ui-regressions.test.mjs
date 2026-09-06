import test from 'node:test';import assert from 'node:assert/strict';import {createJiti} from 'jiti';
const j=createJiti(import.meta.url);const {sanitizeMermaidChart}=j('./mermaid-safety.ts');const {buildArchitectureActions}=j('./evaluation-actions.ts');
test('normal directed Mermaid graphs pass while HTML and directives stay blocked',()=>{
 for(const chart of ['flowchart LR\n A[Brukere] --> B[Microsoft 365]','graph LR\n A <-- B','flowchart LR\n A ==> B']) assert.equal(sanitizeMermaidChart(chart).error,'');
 for(const chart of ['flowchart LR\n A[<script>alert(1)</script>]','flowchart LR\n click A "https://evil.test"','flowchart LR\n style A fill:red','flowchart LR\n A[javascript:alert(1)]']) assert.ok(sanitizeMermaidChart(chart).error);
});
test('rewrite suggestions do not acquire unrelated weaknesses by array position',()=>{
 const result=buildArchitectureActions({document_findings:[],rewrite_suggestions:[{target:'K-02',suggestion:'Clarify availability'}],weaknesses:['K-05 lacks 24/7'],missing_elements:[],improvement_recommendations:[],generic_sections:[]});
 assert.deepEqual(result,[{location:'K-02',action:'Clarify availability',reason:''}]);
});


test('complete coverage contributes omitted deficiencies without duplicating sampled findings',()=>{
 const result=buildArchitectureActions({
  requirement_coverage:{items:[
   {reference:'K-02',source_reference:'Source K-02',assessment:'Dårlig',rationale:'Availability is only a goal',recommendation:'Commit to the SLA'},
   {reference:'K-05',source_reference:'Source K-05',assessment:'Dårlig',rationale:'No out-of-hours coverage',recommendation:'Clarify 24/7 staffing'},
  ]},
  document_findings:[{reference:'Source K-02',assessment:'Dårlig',finding:'Availability is only a goal',recommendation:'Commit to the SLA'}],
  rewrite_suggestions:[],weaknesses:[],
 });
 assert.deepEqual(result,[
  {location:'K-02',action:'Commit to the SLA',reason:'Availability is only a goal'},
  {location:'K-05',action:'Clarify 24/7 staffing',reason:'No out-of-hours coverage'},
 ]);
});

test('saved fallback diagrams repair identity group cycles without changing edges',()=>{
 for(const label of ['Microsoft Entra ID','Identitet og tilgang']) {
  const chart=`flowchart LR\n subgraph Identity["Identitet"]\n Identity[${label}]\n end\n Identity --> Platform[Azure]\n IdentityLayer[Existing node]`;
  const result=sanitizeMermaidChart(chart);
  assert.equal(result.error,'');
  assert.match(result.chart,/subgraph IdentityLayer2\["Identitet"\]/);
  assert.ok(result.chart.includes(`Identity[${label}]`));
  assert.ok(result.chart.includes('Identity --> Platform[Azure]'));
  assert.equal(sanitizeMermaidChart(result.chart).chart,result.chart);
 }
});

test('rendered Mermaid themes retain local gradients without accepting external content',()=>{
 const {isSafeRenderedMermaidCss}=j('./mermaid-safety.ts');
 for(const css of ['.node{stroke:url(#mermaid-_R_1_-gradient)}','.node{fill:url("#gradient")}','.node{fill:url(\'#gradient\')}']) assert.equal(isSafeRenderedMermaidCss(css),true,css);
 for(const css of ['.node{fill:url(https://evil.test/image)}','.node{fill:url(#ok);stroke:url(//evil.test)}','@import "https://evil.test";','.node{fill:url(data:image/svg+xml,test)}','.node{fill:expression(alert(1))}']) assert.equal(isSafeRenderedMermaidCss(css),false,css);
});
