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
