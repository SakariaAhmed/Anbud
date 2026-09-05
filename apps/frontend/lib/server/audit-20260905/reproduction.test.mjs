import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {spawn} from 'node:child_process';
import { actual, frontend, jiti, dbUrl, sql, quote, json, P, D, S, reset, revision, document, save, saveCustomerAnalysis, freshAnalysis, analysisResult, downstream, counts, workflow, handlers, noop, storeFile } from './harness.mjs';

// Regression assertions exercise the repaired behavior using real PostgreSQL and actual TS bodies.

test('REGRESSION D1: late Docling replacement archives completed results and manual history', async () => {
  reset(); await save('Manual customer strategy'); downstream();
  const before = revision();
  sql(`update documents set raw_text='Docling improved text',structure_map='[{"text":"improved"}]',processing_status='enhanced_ready' where id=${quote(D)}`);
  assert.deepEqual(counts(), [0, 0, 0]); assert.ok(revision() > before);
  assert.equal(sql(`select count(*) from project_result_history where project_id=${quote(P)}`), "3");
});

test('REGRESSION D2: SQL no-op document save preserves all completed results', async () => {
  reset(); await save('Preserve me'); downstream(); const before = revision();
  sql(`update documents set title=title,raw_text=raw_text,structure_map=structure_map where id=${quote(D)}`);
  assert.deepEqual(counts(), [1, 1, 1]); assert.equal(revision(), before);
});

test('CONTROL D3: status-only failed enhancement leaves basic text and analysis intact', async () => {
  reset(); await save('Preserve me'); downstream(); const before = revision();
  sql(`update documents set processing_status='basic_ready',processing_message='No better extraction' where id=${quote(D)}`);
  assert.deepEqual(counts(), [1, 1, 1]); assert.equal(revision(), before);
});

test('REGRESSION D4: service catalog changes archive affected results instead of losing manual work', async () => {
  reset(); await save('Manual customer strategy'); downstream();
  assert.equal(sql(`select count(*) from project_service_selections where project_id=${quote(P)}`), '0');
  const serviceId = '00000000-0000-4000-8000-000000005324';
  try {
    sql(`insert into service_descriptions(id,name,inclusion_mode) values(${quote(serviceId)},'Unselected audit service','selected')`);
    assert.deepEqual(counts(), [0, 0, 0]);
    assert.equal(sql(`select count(*) from project_result_history where project_id=${quote(P)}`), '3');
  } finally { sql(`delete from service_descriptions where id=${quote(serviceId)}`); }
});

test('CONTROL D5: stale analysis save is rejected atomically by the real RPC', async () => {
  reset(); await save('Current'); const stale = revision(); await save('New manual edit');
  await assert.rejects(saveCustomerAnalysis(P, [D], analysisResult('Stale'), { expectedSourceRevision: stale, previousAnalysis: null }), /PROJECT_SOURCE_REVISION_CHANGED/);
  assert.equal((await freshAnalysis()).executive_summary, 'New manual edit');
});

test('REGRESSION W1: full workflow rejects concurrent manual edit and preserves its history', async () => {
  reset(); await save('Before generation'); let attempts = 0;
  const { runCustomerAnalysisWorkflow } = workflow(['runCustomerAnalysisWorkflow'], {
    analyzeCustomerDocuments: async () => {
      attempts++;
      if (attempts === 1) await save('Manual edit committed while AI runs');
      return analysisResult(`AI attempt ${attempts}`);
    },
  });
  await assert.rejects(runCustomerAnalysisWorkflow({ kind: 'customer_analysis', projectId: P }, handlers), /PROJECT_SOURCE_REVISION_CHANGED|CUSTOMER_ANALYSIS_CHANGED/);
  const stored = await freshAnalysis();
  assert.equal(attempts, 1); assert.equal(stored.executive_summary, 'Manual edit committed while AI runs');
  assert.ok(JSON.stringify(stored).includes('Before generation'));
});

test('CONTROL W2: Docling replacement during analysis rejects stale output', async () => {
  reset(); const seen = [];
  const { runCustomerAnalysisWorkflow } = workflow(['runCustomerAnalysisWorkflow'], {
    analyzeCustomerDocuments: async ({ customerDocument }) => {
      seen.push(customerDocument.raw_text);
      if (seen.length === 1) sql(`update documents set raw_text='Enhanced second version' where id=${quote(D)}`);
      return analysisResult('AI');
    },
  });
  await assert.rejects(runCustomerAnalysisWorkflow({ kind: 'customer_analysis', projectId: P }, handlers), /PROJECT_SOURCE_REVISION_CHANGED/);
  assert.equal(seen.length, 1); assert.equal(await freshAnalysis(), null);
});

test('CONTROL W3: input change fails without retrying or saving stale analysis', async () => {
  reset(); let attempts = 0;
  const { runCustomerAnalysisWorkflow } = workflow(['runCustomerAnalysisWorkflow'], {
    analyzeCustomerDocuments: async () => {
      sql(`update documents set raw_text=${quote(`Version ${++attempts}`)} where id=${quote(D)}`);
      return analysisResult('Stale');
    },
  });
  await assert.rejects(runCustomerAnalysisWorkflow({ kind: 'customer_analysis', projectId: P }, handlers), /PROJECT_SOURCE_REVISION_CHANGED/);
  assert.equal(attempts, 1); assert.equal(await freshAnalysis(), null);
});

test('REGRESSION W4: final snapshot failure preserves successful committed workflow', async () => {
  reset();
  const { runCustomerAnalysisWorkflow } = workflow(['runCustomerAnalysisWorkflow'], {
    analyzeCustomerDocuments: async () => analysisResult('Successfully persisted'),
    getProjectSnapshotAfterCommit: actual(storeFile, ['getProjectSnapshotAfterCommit'], { getProjectSnapshot: async () => { throw new Error('Injected snapshot network timeout'); }, safeErrorTelemetry: () => ({}) }).getProjectSnapshotAfterCommit,
  });
  const result = await runCustomerAnalysisWorkflow({ kind: 'customer_analysis', projectId: P }, handlers);
  assert.equal(result.project, null);
  assert.equal((await freshAnalysis()).executive_summary, 'Successfully persisted');
});

test('REGRESSION API1: stale manual editor is rejected without overwriting newer edit', async () => {
  reset(); await save('Original editor snapshot'); const editorRevision = (await freshAnalysis()).revision; await save('Other user newer text');
  const { PUT } = actual('app/api/projects/[id]/customer-analysis/route.ts', ['PUT', 'isCustomerAnalysisSection'], {
    CUSTOMER_ANALYSIS_SECTIONS: ['strategy'],
    ...jiti(path.join(frontend, 'lib/server/use-cases/solution-evaluation-source-snapshot.ts')),
    ...jiti(path.join(frontend, 'lib/server/domain/project-documents.ts')),
    ...jiti(path.join(frontend, 'lib/service-description.ts')),
    workflowErrorStatus: jiti(path.join(frontend, 'lib/server/workflow-errors.ts')).workflowErrorStatus,
    NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) },
    getProjectSourceRevision: async () => revision(), listProjectDocumentsForAnalysis: async () => [document()], getFreshCustomerAnalysis: freshAnalysis,
    saveCustomerAnalysis, recordDocumentIntelligenceEvent: async () => false, getProjectSnapshot: async () => ({ id: P }), productionSafeErrorMessage: e => e.message,
  });
  const response = await PUT(new Request('http://localhost/audit', { method: 'PUT', body: JSON.stringify({ analysis_text: 'Stale editor text', expected_analysis_revision: editorRevision }) }), { params: Promise.resolve({ id: P }) });
  assert.equal(response.status, 409); assert.equal((await freshAnalysis()).executive_summary, 'Other user newer text');
  // History survives manual/manual saves; active text still silently loses the newer edit.
  assert.ok(JSON.stringify((await freshAnalysis()).section_histories).includes('Original editor snapshot'));
  assert.ok(!JSON.stringify(await freshAnalysis()).includes('Stale editor text'));
});

test('REGRESSION UI1: failed save keeps editor open with unsaved draft', async () => {
  let error = ''; let editing = 'strategy'; let draft = { executive_summary: 'Unsaved work' };
  const { runAction } = actual('components/projects/project-workspace-page.tsx', ['runAction'], {
    busyActionRef: { current: null }, setBusy: noop, setError: value => error = value, setNotice: noop, startProgressTicker: noop, setBusyProgress: noop, stopProgressTicker: noop,
  });
  const { onSaveSectionEdit } = actual('components/projects/project-analysis-tab.tsx', ['onSaveSectionEdit'], {
    sectionRevision: "original-revision", sectionDraft: draft, sanitizeSectionDraft: (_, value) => value,
    onSaveAnalysis: () => runAction('save-analysis', async () => { throw new Error('Injected offline save'); }),
    setEditingSection: value => editing = value, setSectionDraft: value => draft = value, setSectionDraftError: noop,
  });
  await onSaveSectionEdit('strategy');
  assert.equal(error, 'Injected offline save'); assert.equal(editing, 'strategy'); assert.equal(draft.executive_summary, 'Unsaved work');
});

test('REGRESSION UI2: one local action holds busy state and rejects overlapping actions', async () => {
  let busy; let resolveA; let resolveB;
  const a = new Promise(resolve => resolveA = resolve); const b = new Promise(resolve => resolveB = resolve);
  const { runAction } = actual('components/projects/project-workspace-page.tsx', ['runAction'], {
    busyActionRef: { current: null }, setBusy: value => busy = value, setError: noop, setNotice: noop, startProgressTicker: noop, setBusyProgress: noop, stopProgressTicker: noop,
  });
  const first = runAction('analysis', () => a); const second = runAction('executive-summary', () => b);
  assert.equal(busy, 'analysis'); assert.equal(await second, false); resolveA(); await first;
  assert.equal(busy, null); resolveB(); await second;
});

test('REGRESSION ERR1: known preconditions/conflicts have safe actionable production messages', () => {
  const { productionSafeErrorMessage, errorHash } = jiti(path.join(frontend, 'lib/server/safe-errors.ts'));
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    for (const [message, expected] of [
      ['PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running', '4df10a8f27dea78363160c57'],
      ['Generer kundeanalyse før løsningsvurdering.', 'b408d4abe1e43f2086a8aabb'],
      ['Generer vurdering før lederoppsummering.', 'b5ccf74d416a4f5a431e6f74'],
    ]) {
      const error = new Error(message); assert.equal(errorHash(error), expected);
      const safe = productionSafeErrorMessage(error, 'Jobben feilet. Kontakt support med feilreferansen.');
      assert.ok(!safe.includes(expected)); assert.match(safe, /Generer|Prosjektgrunnlaget/);
    }
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

const J = '00000000-0000-4000-8000-000000005330';
const lease = '00000000-0000-4000-8000-000000005331';
function ingestionRepository(chunks) {
  sql(`insert into project_jobs(id,project_id,kind,status,message,input_json,lease_token) values (${quote(J)},${quote(P)},'document_ingestion','running','Audit','{}',${quote(lease)})`);
  const crypto = jiti(path.join(frontend, 'lib/server/crypto.ts'));
  return actual(storeFile, ['saveDocumentIngestionResult', 'updateDocumentProcessingState', 'publishDocumentReadiness'], {
    ...crypto, fetchSingleDocumentRow: async () => { const v = sql(`select row_to_json(d) from documents d where id=${quote(D)}`); return v ? JSON.parse(v) : null; },
    getProjectWorkflowLease: () => ({jobId: J, leaseToken: lease}),
    createServiceClient: () => ({rpc: async (name,args) => { try { return {data: JSON.parse(sql(`select public.publish_document_readiness(${quote(args.p_project_id)},${quote(args.p_document_id)},${args.p_source_revision},${quote(args.p_status)},${quote(args.p_message)},${quote(args.p_parser_used)},${quote(J)},${quote(lease)})`)),error:null}; } catch(error) { return {data:null,error:{message:error.message}}; } }}), pageCountFromStructureMap: () => null, pageCountFromRawText: () => null,
    runLeaseFencedProjectMutation: async (projectId, operation, payload) => ({ fenced: true, data: JSON.parse(sql(`select public.lease_fenced_project_write(${quote(J)},${quote(lease)},${quote(projectId)},${quote(operation)},${json(payload)})`)) }),
    fromUnknownDocumentRow: row => row, normalizeDocumentChunkStructureMap: value => value,
    replaceProjectDocumentChunks: async value => {
      await chunks(value);
      sql(`insert into document_chunks(source_type,source_id,project_id,document_title,file_name,file_format,chunk_index,kind,text_encrypted,content_hash) values ('project_document',${quote(D)},${quote(P)},'Audit','audit.txt','txt',0,'paragraph','synthetic','synthetic') on conflict(source_type,source_id,chunk_index) do update set text_encrypted=excluded.text_encrypted`);
    }, rethrowAuthoritativeLeaseLoss: error => { if (error.message.includes('PROJECT_JOB_LEASE_LOST')) throw error; },
    isDocumentAnalysisEnabled: () => false, isHistoricalSolutionDocument: () => false,
    updateProjectContextKeywords: async () => {}, revalidateProjectCaches: noop, mapDocumentSummary: row => row,
  });
}
const ingestInput = () => ({ projectId: P, documentId: D, role: 'primary_customer_document', title: 'Audit', fileName: 'audit.txt', fileFormat: 'txt', contentType: 'text/plain', rawText: 'Enhanced text', structureMap: [], parserUsed: 'docling', status: 'enhanced_ready', message: 'Ready' });

test('REGRESSION ING1: ingestion stays processing with no indexed_at until all chunks are committed', async () => {
  reset(); let observed;
  const { saveDocumentIngestionResult } = ingestionRepository(async () => {
    observed = document();
    assert.equal(sql(`select count(*) from document_chunks where source_id=${quote(D)}`), '0');
    throw new Error('Injected embedding timeout');
  });
  await assert.rejects(saveDocumentIngestionResult(ingestInput()), /embedding timeout/);
  assert.equal(observed.processing_status, 'processing'); assert.equal(observed.indexed_at, null);
  assert.equal(document().processing_status, 'failed'); assert.equal(document().indexed_at, null);
});

test('CONTROL ING2: processing status used by metadata fix stays unready during indexing', async () => {
  reset(); let observed;
  const { saveDocumentIngestionResult } = ingestionRepository(async () => { observed = document(); });
  await saveDocumentIngestionResult({ ...ingestInput(), status: 'processing' });
  assert.equal(observed.processing_status, 'processing');
});

test('CONTROL ING3: lease takeover rejects old worker write without changing text', async () => {
  reset(); const { saveDocumentIngestionResult } = ingestionRepository(async () => {});
  sql(`update project_jobs set lease_token=gen_random_uuid() where id=${quote(J)}`);
  await assert.rejects(saveDocumentIngestionResult(ingestInput()), /PROJECT_JOB_LEASE_LOST/);
  assert.equal(document().raw_text, 'Kunden skal ha en sikker plattform.');
});

test('CONTROL ING4: deleted document cannot be resurrected by old ingestion worker', async () => {
  reset(); const { saveDocumentIngestionResult } = ingestionRepository(async () => {});
  sql(`delete from documents where id=${quote(D)}`);
  await assert.rejects(saveDocumentIngestionResult(ingestInput()));
  assert.equal(sql(`select count(*) from documents where id=${quote(D)}`), '0');
});

test('REGRESSION PERF1: reevaluation failure returns a recoverable partial result with its committed artifact', async () => {
  reset(); await save('Analysis'); downstream();
  const { runPerfectSystemSolutionWorkflow } = workflow(['runPerfectSystemSolutionWorkflow'], {
    getProjectDetail: async () => ({ solution_evaluation: { architecture_comparison: { system_solution_score: 60 } } }),
    generateAndSaveProjectArtifact: async () => {
      // Generation IO is stubbed; its successful COMMIT is represented by a real insert.
      sql(`insert into generated_artifacts(project_id,artifact_type,title,content_markdown,artifact_version) values (${quote(P)},'losningsutkast','Improved','Improved solution',1)`);
      return { artifact: { id: 'improved' } };
    },
    readStableEvaluationSources: async () => { throw new Error('Injected reevaluation snapshot timeout'); },
  });
  const result = await runPerfectSystemSolutionWorkflow({ kind: 'perfect_system_solution', projectId: P }, handlers);
  assert.equal(result.completion_status, 'evaluation_pending'); assert.equal(result.resume_request.resume_artifact_id, 'improved');
  assert.equal(sql(`select count(*) from generated_artifacts where project_id=${quote(P)}`), '1');
  assert.deepEqual(counts(), [1, 1, 1]);
});

test('REGRESSION PERF2: missing reevaluation document explicitly reports evaluation pending', async () => {
  reset(); await save('Analysis');
  const { runPerfectSystemSolutionWorkflow } = workflow(['runPerfectSystemSolutionWorkflow'], {
    getProjectDetail: async () => ({ solution_evaluation: { architecture_comparison: { system_solution_score: 60 } } }),
    generateAndSaveProjectArtifact: async () => ({ artifact: { id: 'improved' } }),
    readStableEvaluationSources: async () => ({ documents: [], customerAnalysis: null, sourceRevision: revision() }),
  });
  const result = await runPerfectSystemSolutionWorkflow({ kind: 'perfect_system_solution', projectId: P }, handlers);
  assert.equal(result.artifact.id, 'improved'); assert.equal(result.evaluation, undefined); assert.equal(result.completion_status, 'evaluation_pending');
});

function enqueue(kind, extra = {}) {
  const id = crypto.randomUUID();
  const payload = { id, project_id: P, kind, status: 'queued', message: 'Audit', input_json: { kind, projectId: P, ...extra }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  return JSON.parse(sql(`select public.enqueue_project_job_serialized(${quote(P)},${json(payload)})`));
}

test('REGRESSION JOB1: DB rejects missing prerequisites before enqueue', () => {
  reset();
  assert.throws(() => enqueue('solution_evaluation'), /CUSTOMER_ANALYSIS_REQUIRED/);
  assert.throws(() => enqueue('executive_summary'), /SOLUTION_EVALUATION_REQUIRED/);
  assert.equal(sql(`select count(*) from project_jobs where project_id=${quote(P)}`), '0');
});

test('CONTROL JOB2: duplicate identical request coalesces and competing model is rejected', () => {
  reset(); const first = enqueue('customer_analysis'); const duplicate = enqueue('customer_analysis');
  assert.equal(first.id, duplicate.id);
  assert.throws(() => enqueue('customer_analysis', { model: 'audit-other-model' }), /PROJECT_WORKFLOW_BUSY/);
});

test('REGRESSION JOB3: DB claim serializes workers for the same project', () => {
  reset();
  const a = enqueue('document_ingestion', {documentId:D}); const b = enqueue('document_docling_enhancement', {documentId:D});
  assert.ok(JSON.parse(sql(`select public.claim_project_job_serialized(${quote(a.id)},gen_random_uuid())`)));
  assert.equal(sql(`select public.claim_project_job_serialized(${quote(b.id)},gen_random_uuid()) is null`), 't');
  assert.equal(sql(`select count(*) from project_jobs where project_id=${quote(P)} and status='running'`), '1');
});

test('REGRESSION UI3: ingestion watcher follows the queued enhancement job', async () => {
  const watched = [];
  const completedDocument = { id: D, processing_status: 'basic_ready' };
  const { trackDocumentIngestionJob } = actual('components/projects/project-workspace-page.tsx', ['trackDocumentIngestionJob'], {
    project: { id: P }, documentJobAbortControllersRef: { current: new Set() }, isProjectSnapshotOlder: jiti(path.join(frontend, "components/projects/project-workflow-status.ts")).isProjectSnapshotOlder, setNotice: noop, setBusyMessage: noop, fetchProjectState: async () => ({id:P}),
    watchProjectJob: async ({ jobId }) => { watched.push(jobId); return { result: { document: completedDocument, docling_enhancement_job_id: jobId === "first" ? "follow-up" : null } }; },
    documentFromJobResult: result => result.document, setProject: noop,
  });
  await trackDocumentIngestionJob({ id: 'first', kind: 'document_ingestion' }, D);
  assert.deepEqual(watched, ['first', 'follow-up']);
});

test('REGRESSION UI4: watcher network failure preserves authoritative ready document status', async () => {
  let state = { id: P, documents: [{ id: D, processing_status: 'basic_ready' }] };
  const { trackDocumentIngestionJob } = actual('components/projects/project-workspace-page.tsx', ['trackDocumentIngestionJob'], {
    project: state, documentJobAbortControllersRef: { current: new Set() }, isProjectSnapshotOlder: jiti(path.join(frontend, "components/projects/project-workflow-status.ts")).isProjectSnapshotOlder, setNotice: noop, setBusyMessage: noop, fetchProjectState: async () => ({id:P}),
    watchProjectJob: async () => { throw new Error('Injected polling offline'); },
    normalizeProjectState: value => value, setProject: fn => state = fn(state),
  });
  await trackDocumentIngestionJob({ id: 'first', kind: 'document_ingestion' }, D);
  assert.equal(state.documents[0].processing_status, 'basic_ready');
});

for (const mode of ['success', 'parser_failure']) {
  test(`${mode === 'success' ? 'REPRO' : 'CONTROL'} DOC: actual background enhancement ${mode} after completed analysis`, async () => {
    reset();
    sql(`update documents set file_format='docx',file_base64='YXVkaXQ=',parser_used='mammoth' where id=${quote(D)}`);
    await save('Manual strategy to preserve'); downstream();
    const repository = ingestionRepository(async () => {});
    const { runDocumentDoclingEnhancementWorkflow } = workflow([
      'runDocumentDoclingEnhancementWorkflow', 'shouldRunDoclingEnhancement', 'shouldUseDoclingOcr', 'isUsableDoclingResult', 'isDoclingResultWorthReplacing',
    ], {
      ...repository, getDocumentDetail: async () => document(),
      isDocumentAnalysisV3Enabled: () => false, isDocumentAnalysisEnabled: () => false,
      isDoclingEnabled: () => true, canUseDoclingForFormat: () => true,
      rethrowAuthoritativeLeaseLoss: error => { if (error.message.includes('PROJECT_JOB_LEASE_LOST')) throw error; },
      extractTextFromBuffer: async () => {
        assert.equal(document().processing_status, 'basic_ready');
        assert.deepEqual(counts(), [1, 1, 1]);
        if (mode === 'parser_failure') throw new Error('Injected Docling subprocess failure');
        return { fileName: 'audit.docx', fileFormat: 'docx', contentType: 'application/octet-stream', rawText: 'Docling replacement', sourceMap: [], parserUsed: 'docling' };
      },
    });
    const result = await runDocumentDoclingEnhancementWorkflow({ kind: 'document_docling_enhancement', projectId: P, documentId: D }, handlers);
    assert.equal(result.skipped, mode === 'parser_failure');
    assert.deepEqual(counts(), mode === 'parser_failure' ? [1,1,1] : [0,0,0]);
  });
}

test('CONTROL META: actual ingestion keeps primary document processing through inferred metadata write', async () => {
  reset(); sql(`update documents set file_base64='YXVkaXQ=' where id=${quote(D)}`);
  const repository = ingestionRepository(async () => {}); const statuses = [];
  const parsed = { fileName: 'audit.txt', fileFormat: 'txt', contentType: 'text/plain', rawText: 'Audit customer text', sourceMap: [], parserUsed: 'text' };
  const { runDocumentIngestionWorkflow } = workflow(['runDocumentIngestionWorkflow'], {
    ...repository, getDocumentDetail: async () => document(), extractTextFromBuffer: async () => parsed,
    selectBestDocumentParse: async () => ({ parsed, localAttempted: false }),
    isDoclingEnabled: () => false, shouldRunDoclingEnhancement: () => false,
    doclingEnhancementMode: () => 'off', recordParserSelectionEvents: async () => {},
    inferProjectMetadataFromCustomerDocument: async () => { statuses.push(document().processing_status); return {}; },
    updateProjectMetadataFromInference: async () => { statuses.push(document().processing_status); sql(`update projects set title='Inferred title' where id=${quote(P)}`); },
    rethrowAuthoritativeLeaseLoss: error => { throw error; },
  });
  await runDocumentIngestionWorkflow({ kind: 'document_ingestion', projectId: P, documentId: D }, handlers);
  assert.deepEqual(statuses, ['processing','processing']); assert.equal(document().processing_status, 'enhanced_ready');
});

test('REGRESSION UI5: delayed ingestion result refreshes current project and preserves newer analysis', async () => {
  const { applyProjectSnapshot } = jiti(path.join(frontend, 'components/projects/project-workflow-status.ts'));
  let state = { id: P, documents: [], generated_artifacts: [], customer_analysis: analysisResult('Latest successful analysis'), customer_analysis_generated: true, solution_evaluation_generated: false };
  const { trackDocumentIngestionJob } = actual('components/projects/project-workspace-page.tsx', ['trackDocumentIngestionJob'], {
    project: state, documentJobAbortControllersRef: { current: new Set() }, isProjectSnapshotOlder: jiti(path.join(frontend, "components/projects/project-workflow-status.ts")).isProjectSnapshotOlder, setNotice: noop, setBusyMessage: noop, fetchProjectState: async () => ({id:P}),
    watchProjectJob: async () => ({ result: { document: { id: D }, project: { customer_analysis_generated: false, solution_evaluation_generated: false } } }),
    documentFromJobResult: result => result.document, normalizeProjectState: value => value,
    fetchProjectState: async () => state, applyProjectSnapshot, dedupeDocuments: value => value, setProject: fn => state = fn(state),
  });
  await trackDocumentIngestionJob({ id: 'old-response', kind: 'document_ingestion' }, D);
  assert.equal(state.customer_analysis_generated, true); assert.equal(state.customer_analysis.executive_summary, 'Latest successful analysis');
});

for (const kind of ['solution_evaluation', 'executive_summary']) {
  test(`REGRESSION API2: actual jobs POST rejects ${kind} with an actionable 422 before enqueue`, async () => {
    reset();
    const queued = actual('lib/server/project-jobs.ts', ['queueSolutionEvaluationJob','queueExecutiveSummaryJob'], { enqueueProjectJob: async input => enqueue(input.kind) });
    const { POST } = actual('app/api/projects/[id]/jobs/route.ts', ['POST','queueSimpleProjectJob','jobAcceptedResponse'], {
      ...queued, workflowErrorStatus: jiti(path.join(frontend, 'lib/server/workflow-errors.ts')).workflowErrorStatus,
    NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) },
      enforceRateLimit: async () => null, withTiming: async (_, __, fn) => fn(),
      resolveOpenAIModelOverride: async () => undefined, auditEvent: async () => {}, productionSafeErrorMessage: error => error.message,
    });
    const response = await POST(new Request('http://localhost/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) }), { params: Promise.resolve({ id: P }) });
    assert.equal(response.status, 422); assert.equal(response.body.job, undefined);
    const runners = workflow(['runSolutionEvaluationWorkflow','runExecutiveSummaryWorkflow','readStableEvaluationSources'], {
      getProjectDetail: async () => ({ name: 'Audit' }), getFreshSolutionEvaluationSnapshot: async () => null,
    });
    await assert.rejects(kind === 'solution_evaluation' ? runners.runSolutionEvaluationWorkflow({ kind, projectId: P }, handlers) : runners.runExecutiveSummaryWorkflow({ kind, projectId: P }, handlers), kind === 'solution_evaluation' ? /Generer kundeanalyse før løsningsvurdering/ : /Generer vurdering før lederoppsummering/);
  });
}

test('REGRESSION NET1: actual polling recovers from a transient fetch failure', async () => {
  let requests = 0;
  const { pollProjectJob } = actual('lib/client/project-api.ts', ['pollProjectJob'], {
    sleep: async () => {}, invalidateProjectReadCache: noop, readJsonPayload: async () => ({job:{status:'completed',result:{ok:true}}}), fetch: async () => { if (++requests === 1) throw new Error('Injected transient network failure'); return {ok:true}; },
  });
  await pollProjectJob({ projectId: P, jobId: J, onStatus: noop });
  assert.equal(requests, 2);
});

test('REGRESSION W1F: lease-fenced worker rejects a concurrent manual edit', async () => {
  reset(); await save('Before generation');
  sql(`insert into project_jobs(id,project_id,kind,status,message,input_json,lease_token) values (${quote(J)},${quote(P)},'customer_analysis','running','Audit','{}',${quote(lease)})`);
  const history = jiti(path.join(frontend, 'lib/customer-analysis-history.ts'));
  const cryptoModule = jiti(path.join(frontend, 'lib/server/crypto.ts'));
  const saver = actual(storeFile, ['saveCustomerAnalysis'], {
    ...history, ...cryptoModule, ...jiti(path.join(frontend, "lib/customer-analysis-version.ts")), mapCustomerAnalysis: row => ({...cryptoModule.decryptJson(row.result_json,{}),revision:row.revision}), CUSTOMER_ANALYSIS_EMPTY: {}, createServiceClient: () => ({}),
    keywordsFromText: () => [], mergeKeywords: () => [], revalidateProjectCaches: noop,
    runLeaseFencedCustomerAnalysisMutation: async (projectId, payload) => ({ fenced: true, data: JSON.parse(sql(`select public.lease_fenced_save_customer_analysis(${quote(J)},${quote(lease)},${quote(projectId)},${json(payload)})`)) }),
  });
  let attempts = 0;
  const { runCustomerAnalysisWorkflow } = workflow(['runCustomerAnalysisWorkflow'], {
    saveCustomerAnalysis: saver.saveCustomerAnalysis,
    analyzeCustomerDocuments: async () => {
      if (++attempts === 1) await save('Manual edit during leased generation');
      return analysisResult('Worker overwrites manual edit');
    },
  });
  await assert.rejects(runCustomerAnalysisWorkflow({ kind: 'customer_analysis', projectId: P }, handlers), /PROJECT_SOURCE_REVISION_CHANGED|CUSTOMER_ANALYSIS_CHANGED/);
  assert.equal(attempts, 1); const current = await freshAnalysis();
  assert.equal(current.executive_summary, 'Manual edit during leased generation');
  assert.ok(JSON.stringify(current).includes('Before generation'));
});

test('REGRESSION D2B: saving unchanged analysis preserves evaluation and summary', async () => {
  reset(); await save('Unchanged user content'); downstream(); const before = revision();
  await save('Unchanged user content');
  assert.deepEqual(counts(), [1, 1, 1]); assert.equal(revision(), before);
  assert.equal((await freshAnalysis()).executive_summary, 'Unchanged user content');
});

test('CONTROL ING5: stale ingestion role does not undo a role change made during processing', async () => {
  reset(); let indexedRole;
  const { saveDocumentIngestionResult } = ingestionRepository(async value => { indexedRole = value.role; });
  sql(`insert into documents(id,project_id,role,raw_text) values (${quote(S)},${quote(P)},'supporting_document','New primary'); select public.set_primary_project_document(${quote(P)},${quote(S)},'primary_customer_document');`);
  assert.equal(document().role, 'supporting_document');
  await saveDocumentIngestionResult(ingestInput());
  assert.equal(document().role, 'supporting_document'); assert.equal(indexedRole, 'supporting_document');
});

test('REVIEW HIST: archived manual text remains encrypted and readable only through service role', async () => {
  reset(); await save('Confidential manual history');
  sql(`update documents set raw_text='Changed source' where id=${quote(D)}`);
  const encrypted = JSON.parse(sql(`select result_json from project_result_history where project_id=${quote(P)} limit 1`));
  assert.ok(!JSON.stringify(encrypted).includes('Confidential manual history'));
  assert.equal(jiti(path.join(frontend,'lib/server/crypto.ts')).decryptJson(encrypted,{}).executive_summary, 'Confidential manual history');
  assert.equal(sql(`select has_table_privilege('authenticated','public.project_result_history','select')`), 'f');
  assert.equal(sql(`select has_table_privilege('anon','public.project_result_history','select')`), 'f');
  assert.equal(sql(`select has_table_privilege('service_role','public.project_result_history','update,delete')`), 'f');
  sql(`delete from projects where id=${quote(P)}`);
  assert.equal(sql(`select count(*) from project_result_history where project_id=${quote(P)}`), '0');
});

test('REVIEW VERSION: result-only changes advance UI revision without changing input provenance', () => {
  reset(); const sourceBefore = revision();
  const before = Number(sql(`select snapshot_revision from projects where id=${quote(P)}`));
  sql(`update projects set solution_evaluation_generated=true where id=${quote(P)}`);
  assert.equal(revision(), sourceBefore);
  assert.ok(Number(sql(`select snapshot_revision from projects where id=${quote(P)}`)) > before);
  const {applyProjectSnapshot,isProjectSnapshotOlder} = jiti(path.join(frontend,'components/projects/project-workflow-status.ts'));
  const current = {source_revision:sourceBefore,snapshot_revision:20,solution_evaluation_generated:true};
  const stale = {source_revision:sourceBefore,snapshot_revision:19,solution_evaluation_generated:false};
  assert.equal(applyProjectSnapshot(current,stale),current);
  assert.equal(isProjectSnapshotOlder(current,stale),true);
  assert.equal(isProjectSnapshotOlder(current,null),true);
});

function recovery() {
  const cryptoModule = jiti(path.join(frontend,'lib/server/crypto.ts'));
  return actual('lib/server/project-job-results.ts', ['recoverCommittedProjectJobResult','pendingEvaluationResult'], {
    ...cryptoModule, getProjectSnapshotAfterCommit: async () => null,
    listGeneratedArtifactsFresh: async () => JSON.parse(sql(`select coalesce(json_agg(a),'[]') from generated_artifacts a where project_id=${quote(P)}`)).map(a=>({...a,is_current:true,source_is_current:true})),
    createServiceClient: () => ({from(table) {
      assert.ok(['project_jobs','customer_analyses','solution_evaluations','executive_summaries'].includes(table));
      const filters=[];
      return { select(){return this;}, eq(key,value){assert.ok(['id','project_id'].includes(key));filters.push(`${key}=${quote(value)}`);return this;}, async maybeSingle(){
        const v=sql(`select row_to_json(t) from ${table} t where ${filters.join(' and ')}`);
        return {data:v?JSON.parse(v):null,error:null};
      }};
    }}),
  }).recoverCommittedProjectJobResult;
}

test('REVIEW CHECKPOINT: analysis commit can be recovered after a failed response, but not after a newer edit', async () => {
  reset();
  sql(`insert into project_jobs(id,project_id,kind,status,input_json,lease_token) values(${quote(J)},${quote(P)},'customer_analysis','running','{}',${quote(lease)})`);
  const cryptoModule=jiti(path.join(frontend,'lib/server/crypto.ts'));
  const payload={expected_source_revision:revision(),source_document_ids:[D],result_json:cryptoModule.encryptJson(analysisResult('Committed before disconnection')),context_keywords:[],last_activity_at:new Date().toISOString()};
  sql(`select public.lease_fenced_save_customer_analysis(${quote(J)},${quote(lease)},${quote(P)},${json(payload)})`);
  assert.ok(sql(`select result_checkpoint->>'revision' from project_jobs where id=${quote(J)}`));
  const recovered=await recovery()(P,J);
  assert.equal(recovered.analysis.executive_summary,'Committed before disconnection');
  assert.equal(recovered.project,null);
  await save('Newer manual edit');
  await assert.rejects(recovery()(P,J),/PROJECT_JOB_SUPERSEDED/);
});

test('REVIEW CHECKPOINT: perfect-solution artifact commits a checkpoint and retry uses the same artifact', async () => {
  reset();
  sql(`insert into project_jobs(id,project_id,kind,status,input_json,lease_token) values(${quote(J)},${quote(P)},'perfect_system_solution','running','{}',${quote(lease)})`);
  const refs=JSON.parse(sql(`select public.get_artifact_source_revisions(${quote(P)})`));
  const payload={artifact_type:'losningsutkast',title:'Synthetic solution',content_markdown:'Saved solution',input_snapshot:{},knowledge_artifact_manifest:[],generator_revision:'audit',source_snapshot_hash:'a'.repeat(64),expected_artifact_source_revision:refs.artifact_source_revision,expected_service_library_revision:refs.service_library_revision,solution_evaluation_dependency:refs.solution_evaluation_dependency,last_activity_at:new Date().toISOString()};
  const row=JSON.parse(sql(`select public.lease_fenced_save_generated_artifact(${quote(J)},${quote(lease)},${quote(P)},${json(payload)})`));
  assert.equal(sql(`select result_checkpoint->>'id' from project_jobs where id=${quote(J)}`),row.id);
  const recovered=await recovery()(P,J);
  assert.equal(recovered.completion_status,'evaluation_pending');
  assert.equal(recovered.resume_request.resume_artifact_id,row.id);
  let generated=0;
  const {runPerfectSystemSolutionWorkflow}=workflow(['runPerfectSystemSolutionWorkflow'], {
    getProjectDetail:async()=>({solution_evaluation:null}),
    findWorkflowArtifact:async()=>({...row,is_current:true,source_is_current:true}),
    generateAndSaveProjectArtifact:async()=>{generated++;throw new Error('must not regenerate');},
    readStableEvaluationSources:async()=>{throw new Error('Still offline');},
  });
  const retried=await runPerfectSystemSolutionWorkflow({kind:'perfect_system_solution',projectId:P,resumeArtifactId:row.id},handlers);
  assert.equal(generated,0); assert.equal(retried.artifact.id,row.id); assert.equal(retried.completion_status,'evaluation_pending');
});

test('REVIEW CHECKPOINT: successful perfect reevaluation recovery includes the saved artifact', async () => {
  reset();
  const artifactId='00000000-0000-4000-8000-000000005339';
  sql(`insert into generated_artifacts(id,project_id,artifact_type,title,content_markdown) values(${quote(artifactId)},${quote(P)},'losningsutkast','Audit','Saved');
    insert into solution_evaluations(project_id,result_json,evaluated_generated_artifact_id) values(${quote(P)},'{"summary":"Recovered evaluation"}',${quote(artifactId)});
    insert into project_jobs(id,project_id,kind,status,input_json,lease_token,result_checkpoint)
    select ${quote(J)},${quote(P)},'perfect_system_solution','running','{}',${quote(lease)},jsonb_build_object('kind','solution_evaluation','id',id,'updated_at',updated_at) from solution_evaluations where project_id=${quote(P)};`);
  const result=await recovery()(P,J);
  assert.equal(result.artifact.id,artifactId); assert.equal(result.evaluation.summary,'Recovered evaluation');
  assert.equal(result.completion_status,undefined);
});

test('REVIEW READY: readiness publication rejects an outdated source revision and an empty index', async () => {
  reset();
  const {publishDocumentReadiness}=ingestionRepository(async()=>{});
  await assert.rejects(publishDocumentReadiness({projectId:P,documentId:D,sourceRevision:document().chunk_source_revision,status:'enhanced_ready',message:'Ready',parserUsed:'text'}),/DOCUMENT_INDEX_NOT_READY/);
  await assert.rejects(publishDocumentReadiness({projectId:P,documentId:D,sourceRevision:document().chunk_source_revision-1,status:'enhanced_ready',message:'Ready',parserUsed:'text'}),/PROJECT_SOURCE_REVISION_CHANGED/);
});


test('REVIEW CONCURRENCY: two independent database sessions cannot run jobs in the same project', async () => {
  reset(); const first=enqueue('document_ingestion',{documentId:D}); const second=enqueue('document_docling_enhancement',{documentId:D});
  function claim(id) {
    return new Promise((resolve,reject)=>{
      const child=spawn('psql',[dbUrl,'-X','-Atq','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
      let out='',error='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>error+=v);
      child.on('error',reject);child.on('exit',code=>code?reject(new Error(error)):resolve(out.trim()));
      child.stdin.end(`begin; select public.claim_project_job_serialized(${quote(id)},gen_random_uuid()) is not null; select pg_sleep(0.2); commit;`);
    });
  }
  const results=await Promise.all([claim(first.id),claim(second.id)]);
  assert.deepEqual(results.sort(),['f','t']);
  assert.equal(sql(`select count(*) from project_jobs where project_id=${quote(P)} and status='running'`),'1');
});

test('REGRESSION UI8: completed job body cannot overwrite a newer edit paired with its snapshot', async () => {
  const newer = { id: P, snapshot_revision: 12, customer_analysis: { executive_summary: 'Newer manual edit' }, generated_artifacts: [] };
  let state = { ...newer, generated_artifacts: [{ id: 'loaded-artifact' }] };
  let reads = 0;
  const { refreshProjectAfterMutation } = actual('components/projects/project-workspace-page.tsx', ['refreshProjectAfterMutation'], {
    project: { id: P }, fetchProjectState: async () => { reads++; return newer; },
    setProject: update => state = update(state), normalizeProjectState: value => value,
    isProjectSnapshotOlder: (current, fresh) => fresh.snapshot_revision < current.snapshot_revision,
    window: { dispatchEvent: noop }, Event,
  });
  const { onGenerateCustomerAnalysis } = actual('components/projects/project-workspace-page.tsx', ['onGenerateCustomerAnalysis'], {
    runAction: async (_, action) => action(), startWorkspaceJob: async () => ({ id: 'finished', message: '' }),
    setBusyMessage: noop, setAnalysisLoaded: noop, refreshProjectAfterMutation,
    waitForProjectJob: async () => ({ result: { analysis: { executive_summary: 'Old generated text' }, project: newer } }),
  });
  await onGenerateCustomerAnalysis();
  assert.equal(reads, 1);
  assert.equal(state.customer_analysis.executive_summary, 'Newer manual edit');
  assert.deepEqual(state.generated_artifacts, [{ id: 'loaded-artifact' }]);
});

test('REGRESSION UI9: post-save refresh failure does not report committed edit as a failed save', async () => {
  let retryRequested = false;
  const { refreshProjectAfterMutation } = actual('components/projects/project-workspace-page.tsx', ['refreshProjectAfterMutation'], {
    project: { id: P }, fetchProjectState: async () => { throw new Error('Injected offline read'); },
    window: { dispatchEvent: () => retryRequested = true }, Event,
  });
  const { onSaveAnalysis } = actual('components/projects/project-workspace-page.tsx', ['onSaveAnalysis'], {
    project: { id: P }, runAction: async (_, action) => { await action(); return true; },
    saveCustomerAnalysisSection: async () => ({ analysis: {}, project: null }),
    refreshProjectAfterMutation, setAnalysisLoaded: noop, setNotice: noop,
  });
  assert.equal(await onSaveAnalysis('strategy', {}, 'revision'), true);
  assert.equal(retryRequested, true);
});
