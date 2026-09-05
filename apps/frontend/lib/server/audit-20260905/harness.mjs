import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createJiti } from 'jiti';

export const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const root = path.resolve(frontend, '../..');
export const jiti = createJiti(import.meta.url, { alias: { '@': frontend, 'server-only': '/dev/null' }, interopDefault: true });
export const workflowFile = 'lib/server/use-cases/project-workflows.ts';
export const storeFile = 'lib/server/repositories/data-store.ts';
// Load the current function bodies using the TS AST; no copied business logic.
// Imports/IO are explicitly injected. This does not render React or emulate HTTP middleware.
export function actual(file, names, dependencies = {}) {
  const source = ts.createSourceFile(file, readFileSync(path.join(frontend, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(source).replace(/^export\s+/, ''));
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) assert.ok(found.has(name), `${file}: missing ${name}`);
  const code = ts.transpileModule([...found.values()].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}
export const dbUrl = process.env.ANBUD_AUDIT_DATABASE_URL;
assert.ok(dbUrl, 'Set ANBUD_AUDIT_DATABASE_URL to the DISPOSABLE audit0532 database');
const parsed = new URL(dbUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/audit0532', 'Audit writes are restricted to localhost/audit0532');
export function sql(statement) {
  const result = spawnSync('psql', [dbUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export const json = value => `${quote(JSON.stringify(value))}::jsonb`;
export const P = '00000000-0000-4000-8000-000000005321';
export const D = '00000000-0000-4000-8000-000000005322';
export const S = '00000000-0000-4000-8000-000000005323';
export const noop = () => {};
export const handlers = { setProgress: noop, assertActive: noop };
export function reset() {
  sql(`delete from projects where id=${quote(P)}; insert into projects(id,client_name,title) values (${quote(P)},'Audit','Audit'); insert into documents(id,project_id,role,raw_text,processing_status) values (${quote(D)},${quote(P)},'primary_customer_document','Kunden skal ha en sikker plattform.','basic_ready');`);
}
export const revision = () => Number(sql(`select source_revision from projects where id=${quote(P)}`));
export const document = () => JSON.parse(sql(`select row_to_json(d) from documents d where id=${quote(D)}`));
export function analysisResult(summary = 'AI baseline') {
  return { customer_profile_summary: 'Audit', customer_goals_summary: 'Audit', executive_summary: summary, high_level_solution_design: '', high_level_architecture_mermaid: '', positioning_recommendations: [], ambiguities: [], expected_solution_direction: [], likely_evaluation_criteria: [], risks: [], implicit_requirements: [], prioritized_requirements: [], signal_words: [], recommended_services: [], value_opportunities: [] };
}
const history = jiti(path.join(frontend, 'lib/customer-analysis-history.ts'));
const crypto = jiti(path.join(frontend, 'lib/server/crypto.ts'));
const snapshots = jiti(path.join(frontend, 'lib/server/use-cases/solution-evaluation-source-snapshot.ts'));
const domain = jiti(path.join(frontend, 'lib/server/domain/project-documents.ts'));
const services = jiti(path.join(frontend, 'lib/service-description.ts'));
const readiness = jiti(path.join(frontend, 'lib/server/use-cases/solution-evaluation-readiness.ts'));
process.env.APP_ENCRYPTION_KEY = 'disposable-audit-key-never-production';
export const freshAnalysis = async () => {
  const value = sql(`select row_to_json(a) from customer_analyses a where project_id=${quote(P)}`);
  if (!value) return null;
  const row = JSON.parse(value);
  return { ...crypto.decryptJson(row.result_json, {}), revision: row.revision };
};
export const { saveCustomerAnalysis } = actual(storeFile, ['saveCustomerAnalysis'], {
  ...history, ...crypto, ...jiti(path.join(frontend, "lib/customer-analysis-version.ts")),
  mapCustomerAnalysis: row => ({ ...crypto.decryptJson(row.result_json, {}), revision: row.revision }), CUSTOMER_ANALYSIS_EMPTY: {}, keywordsFromText: () => [], mergeKeywords: () => [],
  getFreshCustomerAnalysis: freshAnalysis, revalidateProjectCaches: noop,
  runLeaseFencedCustomerAnalysisMutation: async () => ({ fenced: false }),
  createServiceClient: () => ({ rpc: async (name, args) => {
    assert.equal(name, 'save_customer_analysis_if_source_revision');
    try { return { data: JSON.parse(sql(`select public.${name}(${quote(args.p_project_id)}, ${json(args.p_payload)})`)), error: null }; }
    catch (error) { return { data: null, error: { message: error.message } }; }
  } }),
});
export const save = async (text, source = 'manual_edit') => saveCustomerAnalysis(P, [D], analysisResult(text), { expectedSourceRevision: revision(), previousAnalysis: await freshAnalysis(), updatedSections: history.CUSTOMER_ANALYSIS_SECTIONS, historySource: source });
export function downstream() {
  sql(`insert into solution_evaluations(project_id,result_json) values(${quote(P)},'{}'); insert into executive_summaries(project_id,result_json) values(${quote(P)},'{}');`);
}
export const counts = () => JSON.parse(sql(`select jsonb_build_array((select count(*) from customer_analyses where project_id=${quote(P)}),(select count(*) from solution_evaluations where project_id=${quote(P)}),(select count(*) from executive_summaries where project_id=${quote(P)}))`));
export function workflow(names, overrides = {}) {
  return actual(workflowFile, names, {
    ...history, ...snapshots, ...domain, ...services, ...readiness,
    saveCustomerAnalysis, getFreshCustomerAnalysis: freshAnalysis,
    getProjectSourceRevision: async () => revision(), listProjectDocumentsForAnalysis: async () => [document()],
    getProjectSnapshotAfterCommit: async () => ({ id: P }),
    findWorkflowArtifact: async () => null, getProjectWorkflowLease: () => null,
    pendingEvaluationResult: (artifact, detail) => ({artifact, detail, completion_status: "evaluation_pending", resume_request: {kind: "perfect_system_solution", resume_artifact_id: artifact.id}}),
    rethrowAuthoritativeLeaseLoss: e => { if(e.message.includes("PROJECT_JOB_LEASE_LOST")) throw e; }, productionSafeErrorMessage: e => e.message,
    listProjectServiceDescriptions: async () => [], getProjectSnapshot: async () => ({ id: P }),
    assertWorkflowActive: h => h.assertActive?.(), ...overrides,
  });
}
