import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertOwnedSystemTestStack, isolatedApplicationEnvironment } from "./system-test-runtime.mjs";
import { requireCondition, sha256, validateSourceReferences } from "./rag_holdout_eval_protocol.mjs";

export const PROXY_ORIGIN = "http://127.0.0.1:4340";
export const DOCUMENT_ROLE_PROTOCOL = {
  version: "single-primary-with-requirement-attachments.v1",
  selection: "First primary customer document in frozen document order remains primary; additional customer documents use supporting_document/kravdokument. Source bytes, identities and case labels stay unchanged.",
};

export function uploadDocumentPlan(fixture) {
  let customerSelected = false;
  return fixture.documents.map(document => {
    const additionalCustomer = document.role === "primary_customer_document" && customerSelected;
    if (document.role === "primary_customer_document") customerSelected = true;
    return { document, role: additionalCustomer ? "supporting_document" : document.role,
      supporting_subtype: additionalCustomer ? "kravdokument" : document.supporting_subtype ?? "vedlegg" };
  });
}

export function validateOwnedEnvironment(status, runtime) {
  assertOwnedSystemTestStack(status, runtime);
  requireCondition(path.isAbsolute(status.directory ?? "") && status.aiMode === "budgeted loopback model proxy", "OWNED_ENVIRONMENT", "Consume an already running owned system environment configured for the budgeted loopback proxy; this runner never starts or restarts it.");
  requireCondition(runtime.env.OPENAI_BASE_URL === `${PROXY_ORIGIN}/v1` && /^local-budget-proxy(?:-only)?$/u.test(runtime.env.OPENAI_API_KEY ?? ""), "MODEL_ENDPOINT", "Only the authorized owned budget proxy is allowed; direct providers and stubs are forbidden.");
  requireCondition(runtime.env.APP_PUBLIC_ORIGIN === status.baseUrl && runtime.env.PROJECT_JOB_WORKER_PROCESS === "1" && runtime.env.RAG_MODEL_RERANK === "on", "RUNTIME_MODE", "Use the owned scheduled-worker mode, real model reranking and matching app origin. The environment owner must configure these before setup.");
  requireCondition(runtime.sessions?.adminCookie?.startsWith("bidsite_session=") && runtime.env.DATA_API_SERVICE_ROLE_KEY && runtime.env.PROJECT_JOB_WORKER_TOKEN, "AUTHENTICATION", "Run the owned HTTP authentication harness first; its private runtime must contain the persisted administrator session.");
  for (const [key, value] of Object.entries(runtime.env)) {
    if (/^(?:AZURE_DOCUMENT_INTELLIGENCE_|AZURE_COMMUNICATION_|MICROSOFT_ENTRA_)/u.test(key)) requireCondition(!value, "EXTERNAL_SERVICE", "The owned runtime must disable external identity, email and document-intelligence services.");
    if (/^(?:OPENAI|AZURE_OPENAI).*?(?:URL|ENDPOINT)$/u.test(key) && value) requireCondition(value === `${PROXY_ORIGIN}/v1`, "MODEL_ENDPOINT", "An alternate model endpoint could bypass the active budget proxy.");
  }
  requireCondition(!runtime.env.AZURE_STORAGE_ACCOUNT_URL && runtime.env.AZURE_STORAGE_CONTAINER === "anbud-system-test" && Number.isSafeInteger(status.ports?.blob) && runtime.env.AZURE_STORAGE_EMULATOR_CONNECTION_STRING?.endsWith(`;BlobEndpoint=http://127.0.0.1:${status.ports.blob}/anbudtest`), "STORAGE_ENDPOINT", "Original-document storage must use the owned loopback Azurite container.");
  const database = new URL(runtime.databaseUrl);
  requireCondition(database.protocol === "postgresql:" && database.hostname === "127.0.0.1" && database.port === String(status.ports.postgres) && database.pathname === "/postgres" && !database.search, "DATABASE_ENDPOINT", "Only the recorded disposable loopback PostgreSQL database is allowed.");
}

export function uploadConstraintConflicts(fixtures, indexes) {
  const conflicts = [];
  for (const fixture of fixtures) for (const role of ["primary_customer_document", "primary_solution_document"]) {
    if (uploadDocumentPlan(fixture).filter(document => document.role === role).length <= 1) continue;
    const unique = indexes.find(index => /CREATE UNIQUE INDEX/iu.test(index.indexdef) && /\(project_id\)/u.test(index.indexdef) && index.indexdef.includes(`'${role}'`));
    if (unique) conflicts.push({ fixture_version: fixture.version, role, index: unique.indexname });
  }
  return conflicts;
}

export function syntheticAnalysis(fixture) {
  return { high_level_solution_design: "", high_level_architecture_mermaid: "", customer_profile: [], customer_goals: [], implicit_requirements: [], prioritized_requirements: [], ambiguities: [], risks: [], likely_evaluation_criteria: [], signal_words: [], expected_solution_direction: [], recommended_services: [], value_opportunities: [], positioning_recommendations: [], ...fixture.saved_analysis, executive_summary: `[LOKALT SÅDD SYNTETISK ANALYSE – IKKE MODELLGENERERT]\n${fixture.saved_analysis.executive_summary}` };
}

export function loadApplicationOwners(root, runtime) {
  const frontend = path.join(root, "apps/frontend");
  isolatedApplicationEnvironment(frontend, {}); // Refuse dotenv/provider leakage.
  for (const key of Object.keys(process.env)) if (/^(?:OPENAI_|AZURE_|APP_|DATA_API_|MICROSOFT_ENTRA_|RAG_|DOCUMENT_|DOCLING_|PROJECT_JOB_)/u.test(key)) delete process.env[key];
  Object.assign(process.env, runtime.env);
  const { createJiti } = createRequire(path.join(frontend, "package.json"))("jiti");
  const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null", "next/cache": path.join(root, "scripts/rag_holdout_eval_cache.mjs") } });
  const owner = relative => load(path.join(frontend, relative));
  return { store: owner("lib/server/repositories/data-store.ts"), chunks: owner("lib/server/document-chunks.ts"), evidence: owner("lib/server/source-evidence.ts"), documentSelection: owner("lib/server/domain/project-documents.ts"), parser: owner("lib/server/documents.ts"), models: owner("lib/server/ai/model-config.ts") };
}

export function createOwnedRuntime(root, status, runtime) {
  validateOwnedEnvironment(status, runtime);
  const owners = loadApplicationOwners(root, runtime);
  async function request(route, options = {}, expected = 200) {
    requireCondition(route.startsWith("/api/") && !route.includes("..") && !route.includes("\\"), "APP_ROUTE", "Only owned application API paths are allowed.");
    const response = await fetch(status.baseUrl + route, { ...options, redirect: "manual", signal: AbortSignal.timeout(600_000), headers: { cookie: runtime.sessions.adminCookie, origin: status.baseUrl, ...options.headers } });
    requireCondition(response.status === expected, "APP_HTTP", `Owned application request ${options.method ?? "GET"} ${route} returned HTTP ${response.status}; inspect the owned app log. No retry was issued.`);
    return response;
  }
  async function data(route, body) {
    const response = await fetch(`${runtime.env.DATA_API_URL}/${route}`, { method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${runtime.env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    requireCondition(response.ok, "DATA_HTTP", `Owned data API read/check returned HTTP ${response.status}. Inspect local logs; backend bodies are not printed.`);
    return response.json();
  }
  const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const route = id => `/api/projects/${encodeURIComponent(id)}`;
  async function checkJobs(projectIds) {
    const jobs = await data("project_jobs?select=id,project_id,kind,status&status=in.(queued,running)");
    requireCondition(jobs.every(job => projectIds.includes(job.project_id) && job.kind === "document_ingestion"), "UNSAFE_JOBS", "Finish unrelated or non-ingestion jobs before evaluation. Worker dispatch could otherwise buy unrequested analysis/generation calls.");
    return jobs;
  }
  async function preflight(fixtures) {
    await request("/api/projects");
    await request("/api/health/ready");
    const state = JSON.parse(readFileSync(path.join(status.directory, "state.json"), "utf8"));
    requireCondition(status.appMode === "development" && state.directory === status.directory && Number.isSafeInteger(state.appPid) && state.appPid > 1, "APP_CODE_IDENTITY", "The existing status/state must identify the owned development app process. A server built from an unknown checkout cannot prove the pinned code.");
    let applicationProcess;
    try {
      const listeners = execFileSync("lsof", ["-nP", "-iTCP@127.0.0.1:4338", "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1)));
      requireCondition(listeners.length === 1, "APP_CODE_IDENTITY", "The owned app must have exactly one loopback listener.");
      let ancestor = listeners[0], owned = false;
      for (let depth = 0; depth < 10 && ancestor > 1; depth++) {
        if (ancestor === state.appPid) { owned = true; break; }
        ancestor = Number(execFileSync("ps", ["-p", String(ancestor), "-o", "ppid="], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim());
      }
      const cwd = execFileSync("lsof", ["-a", "-p", String(listeners[0]), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).split("\n").find(line => line.startsWith("n"))?.slice(1);
      requireCondition(owned && cwd && realpathSync(cwd) === realpathSync(path.join(root, "apps/frontend")), "APP_CODE_IDENTITY", "The actual listener must descend from the environment owner's PID and run in this frozen checkout's frontend directory.");
      applicationProcess = { listener_pid: listeners[0], owned_parent_pid: state.appPid, working_directory: cwd, mode: "development" };
    } catch (error) {
      if (error?.code === "APP_CODE_IDENTITY") throw error;
      requireCondition(false, "APP_CODE_IDENTITY", "Cannot verify the owned app listener/checkout. Provide lsof and ps and the environment owner's current state; the runner will not start or alter a server.");
    }
    // Read the actual disposable database catalog, rather than assuming that
    // code or a historical report establishes its deployed role constraints.
    const url = new URL(runtime.databaseUrl);
    let indexes;
    try {
      const output = execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: "postgres", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGOPTIONS: "-c default_transaction_read_only=on", PGCONNECT_TIMEOUT: "5" }, input: "select coalesce(json_agg(row_to_json(i)), '[]'::json) from (select indexname,indexdef from pg_catalog.pg_indexes where schemaname='public' and tablename='documents') i;\n" });
      indexes = JSON.parse(output);
    } catch { requireCondition(false, "CATALOG_PREFLIGHT", "Could not read the owned PostgreSQL document-role catalog. Install/provide psql and verify the recorded disposable database; no setup or model request was issued."); }
    const conflicts = uploadConstraintConflicts(fixtures, indexes);
    requireCondition(!conflicts.length, "FROZEN_ROLE_CONFLICT", `The registered upload role plan conflicts with the current database: ${conflicts.map(item => `${item.fixture_version}: ${item.index} permits one ${item.role}`).join("; ")}. Stop before setup spending.`);
    return { authenticated: true, ready: true, application_process: applicationProcess, document_role_indexes: indexes, document_role_protocol: DOCUMENT_ROLE_PROTOCOL };
  }
  async function waitForJob(projectId, jobId, projectIds) {
    const pending = await checkJobs(projectIds);
    if (pending.some(job => job.id === jobId && job.status === "queued")) await request("/api/project-jobs/worker", { ...json({ limit: 1 }), headers: { "content-type": "application/json", "x-worker-token": runtime.env.PROJECT_JOB_WORKER_TOKEN } });
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      const value = await (await request(`${route(projectId)}/jobs/${encodeURIComponent(jobId)}`)).json();
      if (["completed", "failed", "cancelled"].includes(value.job.status)) {
        requireCondition(value.job.status === "completed", "INGESTION_FAILED", "Owned ingestion did not complete. Preserve checkpoint and inspect the job; the runner does not retry it.");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    requireCondition(false, "INGESTION_TIMEOUT", "Owned ingestion has not published within six minutes. Resume verifies the same job; no reupload is allowed.");
  }
  async function readProof(fixture, mapping, { requireAnalysis = true } = {}) {
    const sourceRevision = await owners.store.getProjectSourceRevision(mapping.project_id);
    const documents = await owners.store.listProjectDocumentsForAnalysis(mapping.project_id);
    requireCondition(documents.length === fixture.documents.length, "DOCUMENT_SET", "Persisted corpus document set differs from the frozen fixture.");
    const proofs = {};
    for (const { document: original, role, supporting_subtype } of uploadDocumentPlan(fixture)) {
      const mapped = mapping.documents[original.id];
      const document = documents.find(document => document.id === mapped?.id);
      requireCondition(document && document.project_id === mapping.project_id && document.title === original.title && document.role === role && mapped.requested_role === role && mapped.fixture_role === original.role && (role !== "supporting_document" || document.supporting_subtype === supporting_subtype), "DOCUMENT_MAPPING", "An uploaded source differs from the registered role plan, identity or title.");
      const expected = await owners.parser.extractTextFromBuffer({ buffer: Buffer.from(original.raw_text), fileName: mapped.transport_file_name, contentType: "text/plain", role, useDocling: false });
      requireCondition(document.raw_text === expected.rawText && document.raw_text.length > 0 && ["basic_ready", "enhanced_ready"].includes(document.processing_status) && document.indexed_at && Number.isSafeInteger(document.chunk_source_revision), "PERSISTED_RAW_TEXT", "Persisted raw text must equal the real parser's complete output and be ready/indexed; file byte totals alone are insufficient.");
      const downloaded = await (await request(`${route(mapping.project_id)}/documents/${encodeURIComponent(document.id)}`)).text();
      requireCondition(downloaded === original.raw_text, "ORIGINAL_UPLOAD", "Original encrypted upload bytes no longer match frozen raw_text.");
      const fingerprint = owners.chunks.projectDocumentChunkSourceFingerprint(document);
      const count = owners.chunks.projectDocumentExpectedChunkCount(document);
      const complete = await data("rpc/document_chunks_are_complete", { p_source_type: "project_document", p_source_id: document.id, p_source_fingerprint: fingerprint, p_expected_source_revision: document.chunk_source_revision, p_expected_chunk_count: count, p_embedding_model: owners.chunks.DOCUMENT_EMBEDDING_MODEL, p_checked_at: new Date().toISOString() });
      const chunks = await data(`document_chunks?select=chunk_index,embedding_model,embedding_created_at&source_type=eq.project_document&source_id=eq.${encodeURIComponent(document.id)}&order=chunk_index`);
      requireCondition(complete === true && count > 0 && chunks.length === count && chunks.every((chunk, index) => chunk.chunk_index === index && chunk.embedding_model === owners.chunks.DOCUMENT_EMBEDDING_MODEL && chunk.embedding_created_at), "CHUNK_READINESS", "Every persisted source chunk must match its current revision/fingerprint and have a real embedding. Deferred retries are not readiness evidence.");
      proofs[original.id] = { id: document.id, fixture_role: original.role, role: document.role, supporting_subtype: document.supporting_subtype, original_file_sha256: sha256(original.raw_text), raw_text_sha256: sha256(document.raw_text), parser_normalized: document.raw_text !== original.raw_text, characters: document.raw_text.length, source_revision: document.chunk_source_revision, source_fingerprint: fingerprint, chunks: count };
    }
    const selected = owners.documentSelection.selectProjectDocuments(documents);
    const selectedDocuments = [selected.customerDocument, selected.solutionDocument, ...selected.supportingDocuments].filter(Boolean);
    requireCondition(new Set(selectedDocuments.map(document => document.id)).size === documents.length, "CHAT_CORPUS", "The actual chat document-selection owner must retain every authorized frozen source.");
    const characters = selectedDocuments.reduce((sum, document) => sum + document.raw_text.length, 0);
    requireCondition(characters >= 90_001, "LARGE_CORPUS", "The persisted raw corpus selected by chat must exceed the 90,000-character full-document bypass.");
    // Pin the actual branch contract too; do not infer a large path solely
    // from aggregate file size if the application's threshold changes later.
    const analysis = await owners.store.getFreshCustomerAnalysis(mapping.project_id);
    if (requireAnalysis) {
      requireCondition(analysis?.revision && mapping.analysis?.revision === analysis.revision && mapping.analysis?.content_sha256 === sha256(analysis), "ANALYSIS_PRESENCE", "The disclosed synthetic analysis must still be present at its exact persisted revision.");
      const rows = await data(`customer_analyses?select=source_document_ids,provenance_verified&project_id=eq.${encodeURIComponent(mapping.project_id)}`);
      requireCondition(rows.length === 1 && rows[0].provenance_verified === true && sha256([...rows[0].source_document_ids].sort()) === sha256(documents.map(document => document.id).sort()), "ANALYSIS_PROVENANCE", "Persisted analysis provenance must identify every frozen corpus document.");
    }
    requireCondition(sourceRevision === await owners.store.getProjectSourceRevision(mapping.project_id), "SOURCE_RACE", "Sources changed during proof capture.");
    return { source_revision: sourceRevision, characters, selected_document_ids: selectedDocuments.map(document => document.id), documents: proofs, analysis_present: Boolean(analysis), analysis_revision: analysis?.revision ?? null };
  }
  return { ...owners, request, data, json, route, preflight, checkJobs, waitForJob, readProof,
    async budget() {
      const response = await fetch(`${PROXY_ORIGIN}/budget`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      requireCondition(response.ok, "BUDGET_HTTP", `Owned budget guard returned HTTP ${response.status}.`);
      return response.json();
    },
    async sourceIntegrity(item, mapping) {
      const documents = await owners.store.listProjectDocumentsForAnalysis(mapping.project_id);
      return validateSourceReferences(item.answer_attempt.answer, item.answer_attempt.sources, documents, { fingerprint: owners.chunks.projectDocumentChunkSourceFingerprint, validateEvidence: owners.evidence.validateChatEvidence, question: item.contract.question, citationsRequired: item.contract.citations_required });
    },
  };
}
