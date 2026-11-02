import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const basicText = "Krav K-1 skal dokumenteres. ".repeat(100);
const settings = {
  DOCUMENT_ANALYSIS_VERSION: "off", DOCLING_INGESTION: "on", DOCLING_FORMATS: "pdf",
  DOCLING_ENHANCEMENT_MODE: "async", DOCLING_ASYNC_AUTO_RUN: "off", DOCLING_PDF_CHUNKING: "off", DOCLING_OCR: "off",
};

async function runEnhancement(t, { doclingScript, saveError, assertActive, sourceRevision } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "enhancement-failure-"));
  const command = path.join(directory, "docling.mjs");
  writeFileSync(command, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
${doclingScript}
`, { mode: 0o700 });
  const previous = Object.fromEntries(Object.keys({ ...settings, DOCLING_CLI_COMMAND: "" }).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings, { DOCLING_CLI_COMMAND: command });
  const document = {
    id: "document", project_id: "project", role: "supporting_document", supporting_subtype: "kravdokument",
    title: "Bilag 1", file_name: "bilag.pdf", file_format: "pdf", content_type: "application/pdf",
    file_size_bytes: 100, file_base64: Buffer.from("%PDF-1.4 syntetisk").toString("base64"), raw_text: basicText, structure_map: [],
    parser_used: "pdf-parse", processing_status: "basic_ready", processing_message: null, processing_error: null, chunk_source_revision: 3, page_count: 1,
  };
  const state = { document, saves: [], updates: [], saveError, onSave() {} };
  globalThis.__enhancementFailure = state;
  t.after(() => {
    delete globalThis.__enhancementFailure;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(path.join(directory, "store.cjs"), `
const state = () => globalThis.__enhancementFailure;
exports.getDocumentDetail = async () => state().document;
exports.getProjectSnapshotAfterCommit = async () => null;
exports.updateDocumentProcessingState = async input => { state().updates.push(input); };
exports.setDocumentEnhancementState = async input => { state().updates.push({ ...input, status: state().document.processing_status }); return true; };
exports.saveDocumentIngestionResult = async input => {
  state().saves.push(input);
  state().onSave();
  if (state().saveError) throw new Error(state().saveError);
  return { ...state().document, processing_status: input.status, parser_used: input.parserUsed, chunk_source_revision: 4 };
};`);
  const jiti = createJiti(path.join(directory, "test.cjs"), { moduleCache: false, alias: {
    "@/lib/server/repositories/data-store": path.join(directory, "store.cjs"),
    "@": frontend, "server-only": "/dev/null",
  } });
  const { runProjectWorkflow } = await jiti.import(path.join(frontend, "lib/server/use-cases/project-workflows.ts"));
  const run = () => runProjectWorkflow({ kind: "document_docling_enhancement", projectId: "project", documentId: "document", ...(sourceRevision === undefined ? {} : { sourceRevision }) }, { setProgress() {}, ...(assertActive ? { assertActive } : {}) });
  return { run, state };
}
const withMarkdown = text => `writeFileSync(path.join(output, "source.md"), ${JSON.stringify(text)});`;

test("a failing parser is recorded on the usable basic version, not reported as no improvement", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: "process.exit(75);" });
  const result = await run();
  assert.equal(state.saves.length, 0, "Nothing may replace the published version.");
  assert.equal(result.status, "basic_ready");
  assert.equal(result.parser_used, "pdf-parse");
  assert.equal(result.skipped, true);
  assert.match(result.document.processing_error, /feilet/u);
  assert.equal(result.document.processing_status, "basic_ready");
  const last = state.updates.at(-1);
  assert.equal(last.status, "basic_ready");
  assert.match(last.error, /Grunnversjonen er lagret/u);
});

test("a parser run that finds no text is also a failure the user can retry", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: withMarkdown("   ") });
  const result = await run();
  assert.equal(state.saves.length, 0);
  assert.match(result.document.processing_error, /feilet/u);
});

test("a working parser with a clearly shorter text keeps the basic version without any failure", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: withMarkdown("For kort tekst fra parseren.") });
  const result = await run();
  assert.equal(state.saves.length, 0);
  assert.equal(result.document.processing_error, null);
  assert.equal(state.updates.at(-1).error, null);
  assert.match(state.updates.at(-1).message, /ga ikke bedre tekstgrunnlag/u);
});

test("a useful parser result replaces the source and clears the earlier failure", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: withMarkdown(`${basicText}\n\nK-2 skal også dokumenteres.`) });
  state.document.processing_error = "Dokumentforbedringen feilet.";
  const result = await run();
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].status, "enhanced_ready");
  assert.equal(state.saves[0].expectedSourceRevision, 3, "Publication uses the revision parsing started from.");
  assert.equal(result.skipped, false);
  assert.equal(state.updates[0].error, null, "A running retry must clear the old failure.");
  assert.equal(result.parser_used, "docling");
});

test("a failed publication records the failure and still fails the job", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: withMarkdown(`${basicText}\n\nK-2.`), saveError: "publication refused" });
  await assert.rejects(run(), /publication refused/u);
  assert.match(state.updates.at(-1).error, /feilet/u);
  assert.equal(state.updates.at(-1).status, "basic_ready");
});
test("publication that replaces text and then fails keeps its failed unindexed state", async t => {
  const {run,state}=await runEnhancement(t,{doclingScript:withMarkdown(`${basicText}\n\nK-2.`),saveError:"indexing failed"});
  state.onSave=()=>{state.document={...state.document,raw_text:"New Docling source",chunk_source_revision:4,processing_status:"failed",parser_used:"docling",indexed_at:null};};
  await assert.rejects(run(),/indexing failed/);
  assert.equal(state.document.processing_status,"failed");assert.equal(state.document.indexed_at,null);
  assert.equal(state.updates.length,1,"Only the original in-progress message was written; no false ready state follows publication.");
});

test("a cancelled job records no failure on the document", async t => {
  let cancelled = false;
  const { run, state } = await runEnhancement(t, {
    doclingScript: withMarkdown(`${basicText}\n\nK-2.`), saveError: "publication interrupted",
    assertActive() { if (cancelled) throw new DOMException("Avbrutt", "AbortError"); },
  });
  state.onSave = () => { cancelled = true; };
  await assert.rejects(run(), /Avbrutt/u);
  assert.ok(state.updates.every(update => !update.error), "Cancellation is not a document failure.");
});

test("a lost lease writes nothing more to the document", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: withMarkdown(`${basicText}\n\nK-2.`), saveError: "PROJECT_JOB_LEASE_LOST: another worker owns this job" });
  await assert.rejects(run(), /PROJECT_JOB_LEASE_LOST/u);
  assert.ok(state.updates.every(update => !update.error), "The new lease holder owns the document state.");
});

// The real job runner, deadline race and enhancement workflow around one slow
// parser. Only the repositories are replaced, and the deadline is shortened.
async function runJobToDeadline(t, { doclingScript, scheduleDelayMs = 0, hangDocumentRead = false, terminalAccepted = true, loseLeaseAfterMs = null, retrySourceRevision, readError, retainedProcessingError = null, automaticIngestion = false, beforeEnhancementClaim, timeoutMs = 400 }) {
  const directory = mkdtempSync(path.join(tmpdir(), "enhancement-deadline-"));
  const command = path.join(directory, "docling.mjs");
  writeFileSync(command, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
${doclingScript}
`, { mode: 0o700 });
  const previous = Object.fromEntries(Object.keys({ ...settings, DOCLING_CLI_COMMAND: "" }).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings, { DOCLING_CLI_COMMAND: command });
  const state = globalThis.__enhancementDeadline = {
    document: { id: "document", project_id: "project", role: "supporting_document", supporting_subtype: "kravdokument", title: "Bilag 1", file_name: "bilag.pdf", file_format: "pdf", content_type: "application/pdf", file_size_bytes: 100, file_base64: Buffer.from("%PDF-1.4 syntetisk").toString("base64"), raw_text: basicText, structure_map: [], parser_used: "pdf-parse", processing_status: "basic_ready", processing_message: null, processing_error: retainedProcessingError, chunk_source_revision: 7, page_count: 1 },
    updates: [], saves: [], rpc: [], terminal: [], scheduleDelayMs, hangDocumentRead, terminalAccepted, loseLeaseAfterMs, retrySourceRevision, readError, automaticIngestion, queued: new Map(), timeoutMs,
  };
  t.after(() => {
    delete globalThis.__enhancementDeadline;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(path.join(directory, "store.cjs"), `
const state = () => globalThis.__enhancementDeadline;
exports.getDocumentDetail = async () => { if (state().hangDocumentRead) await new Promise(() => {}); if(state().readError) throw new Error(state().readError); return state().document; };
exports.getProjectSnapshotAfterCommit = async () => null;
exports.updateDocumentProcessingState = async input => { state().updates.push(input); };
exports.setDocumentEnhancementState = async input => { state().updates.push({ ...input, status: state().document.processing_status }); return true; };
exports.saveDocumentIngestionResult = async input => { state().saves.push(input); return { ...state().document, processing_status: input.status, parser_used: input.parserUsed, chunk_source_revision: state().document.chunk_source_revision + 1 }; };`);
  writeFileSync(path.join(directory, "jobs.cjs"), `
const state = () => globalThis.__enhancementDeadline;
exports.claimQueuedProjectJob = async () => ({ leaseToken: "lease" });
exports.findProjectJob = async () => null;
exports.findOldestQueuedProjectJob = async () => null;
exports.heartbeatProjectJob = async () => true;
exports.insertProjectJob = async () => { throw new Error("unexpected job"); };
exports.insertFollowUpProjectJob = async (record, input) => { state().queued.set(record.id, input); return record; };
exports.resetStaleRunningProjectJobs = async () => 0;
exports.getQueuedProjectJobInput = async id => state().automaticIngestion ? (id === "ingestion" ? {kind:"document_ingestion",projectId:"project",documentId:"document"} : state().queued.get(id)) : ({ kind: "document_docling_enhancement", projectId: "project", documentId: "document", ...(state().retrySourceRevision !== undefined ? {sourceRevision:state().retrySourceRevision} : {}) });
exports.listQueuedProjectJobIds = async () => [];
exports.updatePersistedProjectJob = async (jobId, patch) => { if (patch.status === "failed" || patch.status === "completed") state().terminal.push(patch); return true; };
exports.failDocumentEnhancementJob = async input => { state().rpc.push(input); return state().terminalAccepted; };`);
  writeFileSync(path.join(directory, "results.cjs"), "exports.recoverCommittedProjectJobResult = async () => null;");
  writeFileSync(path.join(directory, "analysis.cjs"), `
exports.dispatchReadyCustomerAnalyses = async () => {};
exports.scheduleReadyCustomerAnalysis = async () => { const state = globalThis.__enhancementDeadline; if (state.scheduleDelayMs) state.fireDeadline(); };`);
  writeFileSync(path.join(directory, "cache.cjs"), "exports.revalidateProjectCaches = () => { globalThis.__enhancementDeadline.revalidated = true; };");
  const realWorkflows = path.join(frontend, "lib/server/use-cases/project-workflows.ts");
  writeFileSync(path.join(directory, "workflows.ts"), `
export * from ${JSON.stringify(realWorkflows)};
import { runProjectWorkflow as run } from ${JSON.stringify(realWorkflows)};
export async function runProjectWorkflow(input: Parameters<typeof run>[0], handlers: Parameters<typeof run>[1]) {
  // Only ingestion's successful publication is stubbed. The job owner enqueues,
  // reads and claims its actual follow-up input; enhancement runs the real owner.
  if (input.kind === "document_ingestion") return { document_id: "document", document: (globalThis as any).__enhancementDeadline.document, docling_enhancement_requested: true };
  return run(input, handlers);
}`);
  const realHeartbeat = path.join(frontend, "lib/server/project-job-heartbeat.ts");
  writeFileSync(path.join(directory, "heartbeat.ts"), `
export * from ${JSON.stringify(realHeartbeat)};
export function startProjectJobHeartbeat(input: { onLeaseLost: () => void }) {
  const delay = (globalThis as any).__enhancementDeadline.loseLeaseAfterMs;
  const timer = delay === null ? undefined : setTimeout(input.onLeaseLost, delay);
  return () => clearTimeout(timer);
}`);
  const realDeadline = path.join(frontend, "lib/server/project-workflow-deadline.ts");
  writeFileSync(path.join(directory, "deadline.ts"), `
export * from ${JSON.stringify(realDeadline)};
import { runProjectWorkflowWithDeadline as run } from ${JSON.stringify(realDeadline)};
export function runProjectWorkflowWithDeadline(input: Parameters<typeof run>[0]) {
  const state = (globalThis as any).__enhancementDeadline;
  return state.scheduleDelayMs ? run({ ...input, timeoutMs: 60000, runtime: { setTimeout(callback: () => void) { state.fireDeadline = callback; return 1; }, clearTimeout() {} } }) : run({ ...input, timeoutMs: state.timeoutMs });
}`);
  const jiti = createJiti(path.join(directory, "test.cjs"), { moduleCache: false, alias: {
    "@/lib/server/repositories/data-store": path.join(directory, "store.cjs"),
    "@/lib/server/repositories/jobs": path.join(directory, "jobs.cjs"),
    "@/lib/server/repositories/automatic-analysis": path.join(directory, "analysis.cjs"),
    "@/lib/server/repositories/repository-cache": path.join(directory, "cache.cjs"),
    "@/lib/server/project-job-results": path.join(directory, "results.cjs"),
    "@/lib/server/use-cases/project-workflows": path.join(directory, "workflows.ts"),
    "@/lib/server/project-workflow-deadline": path.join(directory, "deadline.ts"),
    "@/lib/server/project-job-heartbeat": path.join(directory, "heartbeat.ts"),
    "@": frontend, "server-only": "/dev/null",
  } });
  t.mock.method(console, "warn", () => undefined);
  const { runQueuedProjectJob } = await jiti.import(path.join(frontend, "lib/server/project-jobs.ts"));
  if (automaticIngestion) {
    await runQueuedProjectJob("ingestion");
    assert.equal(state.queued.size, 1, "Ingestion enqueues one automatic enhancement.");
    state.terminal = [];
    beforeEnhancementClaim?.(state);
    await runQueuedProjectJob([...state.queued.keys()][0]);
  } else await runQueuedProjectJob("job");
  return state;
}
const slowDocling = `await new Promise(resolve => setTimeout(resolve, 900)); writeFileSync(path.join(output, "source.md"), ${JSON.stringify(`${basicText}\n\nK-2.`)});`;
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a parser reaching the job deadline records its failure through the job's terminal transition, and the late workflow writes nothing", async t => {
  const state = await runJobToDeadline(t, { doclingScript: slowDocling });
  assert.equal(state.rpc.length, 1);
  assert.equal(state.rpc[0].documentId, "document");
  assert.equal(state.rpc[0].sourceRevision, 7, "The failure is bound to the version the workflow read.");
  assert.equal(state.rpc[0].leaseToken, "lease");
  assert.match(state.rpc[0].jobMessage, /totalfristen/u);
  assert.match(state.rpc[0].documentError, /Grunnversjonen er lagret/u);
  assert.deepEqual(state.terminal, [], "The combined transition replaces the plain terminal update.");
  assert.equal(state.revalidated, true);
  const writesAtDeadline = state.updates.length;
  assert.ok(state.updates.every(update => !update.error), "assertActive still stops the workflow from recording it.");
  await settle(1000);
  assert.equal(state.updates.length, writesAtDeadline, "The abandoned workflow must not write when its parser returns.");
  assert.equal(state.saves.length, 0, "The abandoned workflow must not publish.");
});

test("a deadline before the workflow read the document changes only the job", async t => {
  const state = await runJobToDeadline(t, { doclingScript: "", hangDocumentRead: true });
  assert.equal(state.rpc.length, 0);
  assert.equal(state.terminal.length, 1);
  assert.equal(state.terminal[0].status, "failed");
  assert.deepEqual(state.updates, []);
});
test("retry read failures and pre-read deadlines preserve a revision-fenced recovery action",async t=>{
  const state=await runJobToDeadline(t,{doclingScript:"",hangDocumentRead:true,retrySourceRevision:7});
  assert.equal(state.rpc.length,1);assert.equal(state.rpc[0].sourceRevision,7);assert.deepEqual(state.terminal,[]);
});
test("an unreadable retry source records failure through the terminal owner",async t=>{
  const state=await runJobToDeadline(t,{doclingScript:"",readError:"storage unavailable",retrySourceRevision:7});
  assert.equal(state.rpc.length,1);assert.equal(state.rpc[0].sourceRevision,7);assert.deepEqual(state.terminal,[]);
});

test("automatic enhancements retain the published revision when their first read fails", async t => {
  const state = await runJobToDeadline(t, { doclingScript: "", automaticIngestion: true, readError: "storage unavailable" });
  assert.equal(state.rpc.length, 1, "The claimed automatic follow-up must record a recoverable document failure.");
  assert.equal(state.rpc[0].sourceRevision, 7);
  assert.equal(state.rpc[0].documentId, "document");
  assert.deepEqual(state.terminal, [], "The fenced combined transition owns the failure.");
});

test("manual enhancement retries still reject stale revisions and disabled configuration", async t => {
  const { run, state } = await runEnhancement(t, { doclingScript: "process.exit(99)", sourceRevision: 3 });
  state.document.chunk_source_revision = 4;
  await assert.rejects(run(), /endret siden forbedringen/u);
  state.document.chunk_source_revision = 3;
  process.env.DOCLING_INGESTION = "off";
  await assert.rejects(run(), /gjeldende oppsett/u);
  assert.equal(state.saves.length, 0);
  assert.equal(state.updates.length, 0);
});

test("automatic failure revisions are validated separately from explicit retry preconditions", async () => {
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@": frontend, "server-only": "/dev/null" } });
  const { parseProjectWorkflowInput } = await jiti.import(path.join(frontend, "lib/server/use-cases/project-workflows.ts"));
  const input = { kind: "document_docling_enhancement", projectId: "project", documentId: "document" };
  assert.deepEqual(parseProjectWorkflowInput({ ...input, failureSourceRevision: 7 }), { ...input, failureSourceRevision: 7 });
  assert.deepEqual(parseProjectWorkflowInput({ ...input, sourceRevision: 7 }), { ...input, sourceRevision: 7 });
  for (const failureSourceRevision of [-1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parseProjectWorkflowInput({ ...input, failureSourceRevision }), /Ugyldig kildeversjon/u);
  assert.throws(() => parseProjectWorkflowInput({ ...input, sourceRevision: 7, failureSourceRevision: 7 }), /både automatisk/u);
});

test("an automatic enhancement reads and publishes the current revision after a role change", async t => {
  const state = await runJobToDeadline(t, { automaticIngestion: true, timeoutMs: 60000,
    doclingScript: withMarkdown(`${basicText}\n\nK-2 skal også dokumenteres.`),
    beforeEnhancementClaim(state) { state.document = { ...state.document, chunk_source_revision: 8, role: "primary_customer_document" }; },
  });
  assert.equal(state.rpc.length, 0);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].expectedSourceRevision, 8);
  assert.equal(state.saves[0].role, "primary_customer_document");
  assert.equal(state.terminal.at(-1).status, "completed");
});

test("an automatic enhancement disabled before claim skips without a retry failure", async t => {
  const state = await runJobToDeadline(t, { automaticIngestion: true, doclingScript: "process.exit(99)", timeoutMs: 60000,
    beforeEnhancementClaim() { process.env.DOCLING_INGESTION = "off"; },
  });
  assert.equal(state.rpc.length, 0);
  assert.equal(state.saves.length, 0);
  assert.equal(state.terminal.at(-1).status, "completed");
  assert.match(state.updates.at(-1).message, /hoppet over/u);
  assert.equal(state.updates.at(-1).error, null);
});

test("an unversioned requeued attempt cannot erase the error retained by rejected recovery", async t => {
  const state = await runJobToDeadline(t, { doclingScript: "", readError: "storage unavailable", retainedProcessingError: "Original parser failed" });
  assert.equal(state.rpc.length, 0);
  assert.equal(state.terminal.length, 1);
  assert.equal(state.terminal[0].status, "failed");
  assert.deepEqual(state.updates, []);
  assert.equal(state.document.processing_error, "Original parser failed");
});

test("a deadline after the workflow settled its own outcome does not rewrite it as a failure", async t => {
  const state = await runJobToDeadline(t, { doclingScript: withMarkdown("For kort tekst fra parseren."), scheduleDelayMs: 1200 });
  assert.equal(state.rpc.length, 0);
  assert.equal(state.terminal.length, 1);
  assert.equal(state.terminal[0].status, "failed");
  assert.match(state.updates.at(-1).message, /ga ikke bedre tekstgrunnlag/u);
  assert.ok(state.updates.every(update => !update.error));
});

test("a lease already lost when the deadline transition runs reports no terminal state", async t => {
  const state = await runJobToDeadline(t, { doclingScript: slowDocling, terminalAccepted: false });
  assert.equal(state.rpc.length, 1, "The database decides, under the lease it holds.");
  assert.deepEqual(state.terminal, []);
  assert.ok(!state.revalidated);
  await settle(1000);
});

test("a user cancellation or lost lease before the deadline is not recorded as an enhancement failure", async t => {
  const state = await runJobToDeadline(t, { doclingScript: slowDocling, loseLeaseAfterMs: 150 });
  assert.equal(state.rpc.length, 0, "Losing the lease is not a deadline.");
  assert.deepEqual(state.terminal, [], "The new lease holder owns the job.");
  assert.ok(state.updates.every(update => !update.error), "The document keeps its state.");
  const writes = state.updates.length;
  await settle(1000);
  assert.equal(state.updates.length, writes);
  assert.equal(state.saves.length, 0);
});
