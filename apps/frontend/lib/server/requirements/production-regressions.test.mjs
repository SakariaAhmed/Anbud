import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const jiti = createJiti(import.meta.url, {alias: {'@':root, 'server-only':'/dev/null'}});
const { extractRequirementLedgerForDocument } = jiti('./extraction.ts');
const { narrativeAnswerEvidence } = jiti('./narrative-answer-evidence.ts');
const { buildDeclaredHeadingRequirementLedger } = jiti('./legacy-corpus-parser.ts');
const { supplierAnswerNeedsConfirmation, mergeRequirementCoverageLedgerWithSolutionAnswers, correctCoverageAssessmentWithSourceEvidence } = jiti('../ai.ts');
function document(name, role) {
 return {id:name,title:name,role,file_format:'txt',structure_map:[],file_base64:null,
 raw_text:readFileSync(new URL(`./fixtures/production-regressions/${name}.txt`,import.meta.url),'utf8')};
}
test('six line-anchored source requirements keep the correct IDs and text',async()=>{
 const rows=await extractRequirementLedgerForDocument(document('customer','primary_customer_document'));
 assert.equal(rows.length,6);
 assert.deepEqual(rows.map(r=>r.id),['K-01','K-02','K-03','K-04','K-05','K-06']);
 assert.match(rows[0].text,/flerfaktor/);assert.match(rows[1].text,/99,9/);
});
test('narrative supplier answers remain source-bound and preserve explicit gaps',async()=>{
 const rows=await extractRequirementLedgerForDocument(document('customer','primary_customer_document'));
 const solution=document('solution','primary_solution_document');
 const answers=narrativeAnswerEvidence(solution,rows);
 assert.equal(answers.length,6);
 const merged=mergeRequirementCoverageLedgerWithSolutionAnswers({sourceRequirements:rows,solutionEntries:answers});
 assert.equal(merged.filter(r=>r.answerExcerpt).length,6);
 assert.match(merged.find(r=>r.id==='K-05').answerExcerpt,/ikke priset og må avklares/);
 assert.equal(supplierAnswerNeedsConfirmation(merged.find(r=>r.id==='K-05').answerExcerpt),true);
 assert.equal(supplierAnswerNeedsConfirmation(merged.find(r=>r.id==='K-01').answerExcerpt),false);
 for(const entry of merged){
 const assessment=correctCoverageAssessmentWithSourceEvidence({entry,assessment:'Uklart',rationale:'Requires review',evidence:entry.answerExcerpt,recommendation:'Review'});
 assert.notEqual(assessment.assessment,'Mangler');
 }
 const ambiguous=narrativeAnswerEvidence(solution,[...rows,{...rows[0],heading:'Another independent source section'}]);
 assert.equal(ambiguous.some(r=>r.id==='K-01'),false);
});

test('identical wording under distinct explicit IDs preserves both source requirements',async()=>{
 const source=document('customer','primary_customer_document');
 source.raw_text='Absolutte krav\nK-01: Leverandøren skal dokumentere daglig sikkerhetskopiering.\nK-02: Leverandøren skal dokumentere daglig sikkerhetskopiering.\n';
 const rows=await extractRequirementLedgerForDocument(source);
 assert.deepEqual(rows.map(row=>row.id),['K-01','K-02']);
});

test('declared mandatory heading IDs keep full acceptance sections in source order', async () => {
 const source=document('customer','primary_customer_document');
 source.file_format='md';
 source.raw_text='# Kravspesifikasjon\nAlle B-krav nedenfor er obligatoriske.\n\n## B12 – Gjenoppretting\nMaksimal gjenopprettingstid er 90 minutter for journalintegrasjonen.\n\n### Akseptansekriterium\nEn tidsstemplet øvelse skal vise en fungerende journalintegrasjon.\n\n## B03 – Dataplassering\nKundedata og sikkerhetskopier skal lagres og behandles i Norge.\n\nAkseptansekriterium: Kunden skal motta dokumentert oversikt over alle lagringssteder.\n\n## Generell informasjon\nDenne omtalen beskriver kontaktpersonen for anskaffelsen.';
 const rows=await extractRequirementLedgerForDocument(source);
 assert.deepEqual(rows.map(row=>row.id),['B12','B03']);
 assert.match(rows[0].text,/90 minutter/);
 assert.match(rows[0].text,/tidsstemplet øvelse/);
 assert.match(rows[1].text,/alle lagringssteder/);
 assert.doesNotMatch(rows[1].text,/kontaktpersonen/);
 assert.ok(rows[0].documentEntryOrder < rows[1].documentEntryOrder);
 for(const row of rows) assert.ok(source.raw_text.includes(row.sourceExcerpt));
});

test('a declaration must actually make the ID series mandatory', () => {
 const source=document('customer','primary_customer_document');
 source.file_format='md';
 for (const declaration of ['', 'Alle B-krav er ikke obligatoriske.', 'Ikke alle B-krav er obligatoriske.']) {
  source.raw_text=`${declaration}\n\n## B12 – Plattform\nLøsningen skal dokumentere tilgang og logging for alle administratorer.`;
  assert.deepEqual(buildDeclaredHeadingRequirementLedger(source), []);
 }
 source.raw_text='Alle B-krav er obligatoriske.\n\n## ISO27001 – Standard\nLeverandøren skal dokumentere gyldig sertifisering og avgrensning.';
 assert.deepEqual(buildDeclaredHeadingRequirementLedger(source), []);
});

test('mixed extraction paths retain the explicit source line order', async () => {
 const source=document('customer','primary_customer_document');
 source.raw_text='K-9: Leverandøren skal dokumentere tilgangsstyring for alle administratorer.\n\nK-2: Maksimal gjenopprettingstid er 90 minutter for journalintegrasjonen.\n\nK-7: Leverandøren skal levere rapportering av sikkerhetshendelser hver måned.';
 const rows=await extractRequirementLedgerForDocument(source);
 assert.deepEqual(rows.map(row=>row.id),['K-9','K-2','K-7']);
});
