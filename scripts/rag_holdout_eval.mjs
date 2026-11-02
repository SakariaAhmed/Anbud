#!/usr/bin/env node
// Independent frozen large-corpus release tier. Importing this module is inert.
// See --help. This runner consumes the environment and budget; it owns neither.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFrozenRagHoldout } from "./rag_holdout_fixtures.mjs";
import { summarizeModelReleaseResults } from "./rag_model_release_metrics.mjs";
import { systemTestStatusPath } from "./system-test-runtime.mjs";
import { accountedCostUpperBound, prepareRequest } from "./speed-quality/budget.mjs";
import { createOwnedRuntime, DOCUMENT_ROLE_PROTOCOL, PROXY_ORIGIN, syntheticAnalysis, uploadDocumentPlan, validateOwnedEnvironment } from "./rag_holdout_eval_runtime.mjs";
import { answerEvidenceHash, assertFrozenCode, buildReport, caseContracts, createCheckpoint, HoldoutError, interpretJudge, issueAnswer, JUDGE_INSTRUCTIONS, judgeInput, requireBudgetHeadroom, requireCondition, RUNNER_VERSION, saveCheckpoint, sha256, validateBudget, validateCheckpoint } from "./rag_holdout_eval_protocol.mjs";

export const HELP = `Frozen independent holdout (60 factual + 20 negative). No provider calls without --ai.
node scripts/rag_holdout_eval.mjs --ai --phase preflight|setup|answers|judge|all
  --expected-commit <full frozen HEAD> --checkpoint <absolute file in owned status.directory>
  --model <exact app model> --judge-model <different exact app model>
  --proxy-phase <already active phase name> --phase-cap-usd <finite cap, e.g. 1.60>
  [--batch-size 4] [--resume | --judge-resume] [--vetoes <review.json>]

Start with preflight. Reuse the identical arguments/checkpoint and --resume for setup,
answers and judge. --judge-resume means --phase judge --resume; it never asks for
another answer. Issued/uncertain answers and judges are never retried. A crashed
process may leave a .lock: verify its PID has exited before removing that lock.
The environment owner must supply the running owned stack, session and finite
budget proxy. This command never starts services, refills a ledger or edits fixtures.
Setup uploads frozen raw_text as original TXT bytes, not invented PDF binaries,
opts out of automatic analysis, verifies real chunks/embeddings, and locally seeds
the fixture's disclosed synthetic analysis through the source-fenced repository.
All reports retain every case in its original denominator, including missing cases.`;

export function parseArguments(args) {
  const switches = new Set(["--ai", "--resume", "--judge-resume", "--help"]);
  const values = new Set(["--phase", "--expected-commit", "--checkpoint", "--model", "--judge-model", "--proxy-phase", "--phase-cap-usd", "--batch-size", "--vetoes"]);
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    requireCondition(!(flag in parsed), "ARGUMENT", "Duplicate arguments are forbidden.");
    if (switches.has(flag)) parsed[flag] = true;
    else {
      requireCondition(values.has(flag) && typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), "ARGUMENT", `Unknown or missing argument: ${flag}`);
      parsed[flag] = args[++index];
    }
  }
  if (parsed["--help"]) return { help: true };
  requireCondition(parsed["--ai"] === true, "AI_OPT_IN", "Explicit --ai is required, including preflight; no evaluation request was sent.");
  const phase = parsed["--phase"] ?? (parsed["--judge-resume"] ? "judge" : undefined);
  requireCondition(["preflight", "setup", "answers", "judge", "all"].includes(phase), "PHASE", "Choose an explicit evaluation phase.");
  requireCondition(!parsed["--judge-resume"] || phase === "judge", "PHASE", "Judge-only resume cannot dispatch answers.");
  for (const key of ["--expected-commit", "--checkpoint", "--model", "--judge-model", "--proxy-phase", "--phase-cap-usd"]) requireCondition(parsed[key], "ARGUMENT", `${key} is required; there are no implicit model or budget choices.`);
  const batchSize = Number(parsed["--batch-size"] ?? 4);
  requireCondition(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 5, "BATCH_SIZE", "Judge batches must contain one to five cases, each with the full corpus.");
  requireCondition(parsed["--model"] !== parsed["--judge-model"], "JUDGE_MODEL", "The independent judge must differ from the answer model.");
  return { phase, expectedCommit: parsed["--expected-commit"], checkpoint: parsed["--checkpoint"], answerModel: parsed["--model"], judgeModel: parsed["--judge-model"], proxyPhase: parsed["--proxy-phase"], phaseCapUsd: Number(parsed["--phase-cap-usd"]), batchSize, resume: Boolean(parsed["--resume"] || parsed["--judge-resume"]), vetoes: parsed["--vetoes"] };
}

export function applyIndependentVetoes(checkpoint, input) {
  requireCondition(input?.identity_sha256 === checkpoint.identity_sha256 && Array.isArray(input.cases), "VETO_IDENTITY", "Independent review must identify this exact frozen run.");
  const seen = new Set();
  for (const review of input.cases) {
    const item = checkpoint.cases.find(item => item.contract.id === review.id);
    requireCondition(item && !seen.has(review.id) && typeof review.reason === "string" && review.reason.trim(), "VETO_CASE", "Independent reviews need unique known case IDs and a reason.");
    seen.add(review.id);
    const keys = Object.keys(review).filter(key => !["id", "reason"].includes(key));
    requireCondition(keys.length > 0 && keys.every(key => ["grounded", "citations_correct", "abstention_correct"].includes(key) && review[key] === false), "VETO_UPGRADE", "Independent review may only add false vetoes; it cannot relabel or upgrade the judge.");
    item.independent_review = { ...(item.independent_review ?? {}), ...Object.fromEntries(keys.map(key => [key, false])) };
    item.independent_review_reasons = [...(item.independent_review_reasons ?? []), review.reason];
  }
}

export async function setupProjects({ checkpoint, fixtures, runtime, save, guardBudget }) {
  for (const fixture of fixtures) {
    let mapping = checkpoint.projects[fixture.version];
    if (!mapping) {
      await runtime.checkJobs(Object.values(checkpoint.projects).map(project => project.project_id));
      mapping = { creation_status: "issued", documents: {}, ready: false };
      checkpoint.projects[fixture.version] = mapping; save();
      const project = await (await runtime.request("/api/projects", runtime.json({ name: `Frossen holdout ${fixture.version} ${checkpoint.identity_sha256.slice(0, 12)}`, customer_name: "Fiktiv uavhengig evaluering", description: "Frossen syntetisk holdout; analyse sås lokalt og er ikke modellgenerert." }), 201)).json();
      requireCondition(typeof project.id === "string" && project.id, "PROJECT_CREATE", "The real app did not publish a project ID.");
      mapping.project_id = project.id; mapping.creation_status = "completed"; save();
    }
    requireCondition(mapping.creation_status === "completed" && mapping.project_id, "SETUP_UNCERTAIN", "A project creation was issued without a confirmed ID. Reconcile the owned app/checkpoint explicitly; never create a replacement implicitly.");
    if (mapping.ready) {
      assert.deepEqual(await runtime.readProof(fixture, mapping), mapping.proof, "Previously prepared source/analysis evidence changed.");
      continue;
    }
    for (const { document, role, supporting_subtype } of uploadDocumentPlan(fixture)) {
      let uploaded = mapping.documents[document.id];
      if (!uploaded) {
        await runtime.checkJobs(Object.values(checkpoint.projects).map(project => project.project_id));
        await guardBudget();
        uploaded = { status: "issued", original_file_name: document.file_name, transport_file_name: `${document.id}.txt`, original_sha256: sha256(document.raw_text), fixture_role: document.role, requested_role: role, supporting_subtype: role === "supporting_document" ? supporting_subtype : null, request_auto_analysis: false };
        mapping.documents[document.id] = uploaded; save();
        const form = new FormData();
        form.set("file", new File([document.raw_text], uploaded.transport_file_name, { type: "text/plain" }));
        form.set("title", document.title); form.set("role", role); form.set("role_source", "explicit"); form.set("request_auto_analysis", "false");
        if (role === "supporting_document") form.set("supporting_subtype", supporting_subtype);
        const result = await (await runtime.request(runtime.route(mapping.project_id) + "/documents", { method: "POST", body: form }, 201)).json();
        requireCondition(result.document?.id && result.job?.id && result.job.kind === "document_ingestion", "UPLOAD_RESULT", "Actual upload must publish the original document and ingestion job.");
        uploaded.id = result.document.id; uploaded.job_id = result.job.id; uploaded.status = "uploaded"; save();
      }
      requireCondition(uploaded.id && uploaded.job_id, "SETUP_UNCERTAIN", "An upload was issued without a confirmed document/job ID. Reconcile it explicitly; the runner will not reupload.");
      if (uploaded.status !== "ready") {
        await guardBudget();
        await runtime.waitForJob(mapping.project_id, uploaded.job_id, Object.values(checkpoint.projects).map(project => project.project_id));
        uploaded.status = "ready"; save(); await guardBudget();
      }
      const jobs = await (await runtime.request(runtime.route(mapping.project_id) + "/jobs")).json();
      requireCondition(!jobs.jobs.some(job => job.kind !== "document_ingestion") && (!jobs.automatic_analysis || ["not_requested", "cancelled"].includes(jobs.automatic_analysis.status)), "AUTO_ANALYSIS", "Upload opt-out was not preserved: an automatic analysis or unexpected job exists. Stop and inspect the owned workflow.");
    }
    const proof = await runtime.readProof(fixture, mapping, { requireAnalysis: false });
    if (!mapping.analysis) {
      const existing = await runtime.store.getFreshCustomerAnalysis(mapping.project_id);
      requireCondition(existing === null, "UNEXPECTED_ANALYSIS", "The new holdout project already has an analysis. Do not silently overwrite or count paid auto-analysis as a local seed.");
      mapping.analysis = { status: "issued", provenance: "locally seeded synthetic fixture analysis; not model generated", source_revision_at_seed: proof.source_revision }; save();
      const analysis = await runtime.store.saveCustomerAnalysis(mapping.project_id, Object.values(mapping.documents).map(document => document.id), syntheticAnalysis(fixture), { expectedSourceRevision: proof.source_revision, expectedAnalysisRevision: null, previousAnalysis: null, historySource: "manual_edit" });
      requireCondition(typeof analysis.revision === "string", "ANALYSIS_SEED", "Source-fenced analysis seed did not publish a revision.");
      mapping.analysis = { ...mapping.analysis, status: "completed", revision: analysis.revision, content_sha256: sha256(analysis) }; save();
    }
    requireCondition(mapping.analysis.status === "completed", "SETUP_UNCERTAIN", "Analysis seed outcome is uncertain; inspect the existing row and reconcile before resuming. Never regenerate it implicitly.");
    mapping.proof = await runtime.readProof(fixture, mapping);
    mapping.proof_sha256 = sha256(mapping.proof); mapping.ready = true; save();
  }
  requireCondition(Object.keys(checkpoint.projects).length === fixtures.length && new Set(Object.values(checkpoint.projects).map(project => project.project_id)).size === fixtures.length, "PROJECT_MAPPING", "The independent corpora require two distinct owned projects.");
}

function judgePayload(checkpoint, fixture, cases, mapping) {
  // JSON mode requires an explicit JSON instruction in input messages, not only
  // in the separate instructions field. Fixture wording must not decide validity.
  const input = { response_format_instruction: "Return JSON as specified in the instructions.", ...judgeInput(fixture, cases, mapping) };
  return { model: checkpoint.identity.judge_model, store: false, stream: false, instructions: JUDGE_INSTRUCTIONS, input: JSON.stringify(input), reasoning: { effort: "low" }, text: { format: { type: "json_object" } }, max_output_tokens: 6400, prompt_cache_key: `${RUNNER_VERSION}:${fixture.version}` };
}

/** Planning estimate, never a reservation or a substitute for the hard proxy.
 * Begin at $0.03/answer for the mini price tier, scale through the pricing owner,
 * then use the mean observed whole-route cost plus one largest-route allowance. Include outstanding judge
 * reservations with no assumed cache discount and 20% forecast headroom. */
export function projectHoldoutBudget(checkpoint, fixtures, snapshot) {
  const probe = model => prepareRequest("/v1/responses", { model, input: "x".repeat(10_000), max_output_tokens: 1200 }, 1200, snapshot.proxyServiceTier).reservedUsd;
  const initialAnswerEstimate = 0.03 * probe(checkpoint.identity.answer_model) / probe("gpt-5.4-mini");
  const observed = checkpoint.cases.filter(item => item.answer_attempt?.proxy_requests?.length)
    .map(item => item.answer_attempt.proxy_requests.reduce((sum, row) => sum + accountedCostUpperBound(row), 0));
  const observedMean = observed.length ? observed.reduce((sum, cost) => sum + cost, 0) / observed.length : 0;
  const answerEstimate = Math.max(initialAnswerEstimate, observedMean);
  const repairAllowance = observed.length ? Math.max(...observed) : 0;
  const remainingAnswers = checkpoint.cases.filter(item => !item.answer_attempt).length;
  let judgeReservations = 0;
  for (const fixture of fixtures) {
    const pending = checkpoint.cases.filter(item => item.contract.fixture_version === fixture.version && !item.judge_attempt);
    const mapping = checkpoint.projects[fixture.version];
    for (let start = 0; start < pending.length; start += checkpoint.identity.batch_size) {
      // Future text is unknown: use the largest observed serialized answer and
      // citations, or a disclosed 6,000-character initial planning allowance.
      const examples = checkpoint.cases.map(item => item.answer_attempt).filter(item => item?.answer);
      const largest = examples.sort((a,b) => JSON.stringify([b.answer,b.sources]).length - JSON.stringify([a.answer,a.sources]).length)[0];
      const cases = pending.slice(start, start + checkpoint.identity.batch_size).map(item => ({ ...item,
        answer_attempt: item.answer_attempt?.answer ? item.answer_attempt : { answer: largest?.answer ?? "x".repeat(6000), sources: largest?.sources ?? [] },
      }));
      judgeReservations += prepareRequest("/v1/responses", judgePayload(checkpoint, fixture, cases, mapping), 6400, snapshot.proxyServiceTier).reservedUsd;
    }
  }
  const available = validateBudget(snapshot, { phase: checkpoint.identity.proxy_phase, phaseCapUsd: checkpoint.identity.phase_cap_usd, baseline: checkpoint.budget_baseline });
  return { estimate_not_guarantee: true, remaining_answers: remainingAnswers, observed_answers: observed.length,
    answer_estimate_usd: answerEstimate, repair_allowance_usd: repairAllowance, judge_reservations_usd: judgeReservations,
    projected_remaining_usd: (remainingAnswers * answerEstimate + (remainingAnswers ? repairAllowance : 0) + judgeReservations) * 1.2,
    available_usd: Math.min(available.remainingUsd, available.phaseRemainingUsd),
    assumptions: "Mean observed whole-route cost or price-scaled $0.03 initial estimate, plus one largest observed route while answers remain; future judge input uses largest observed answer/citations or 6000 characters; 20% margin; no assumed caching. Hard proxy limits remain authoritative." };
}

export async function answerCases({ checkpoint, fixtures, runtime, save, guardBudget, observeBudget = guardBudget }) {
  requireCondition(fixtures.every(fixture => checkpoint.projects[fixture.version]?.ready), "PROJECT_NOT_READY", "Run and finish --phase setup before answering.");
  for (const item of checkpoint.cases) {
    if (item.answer_attempt) continue; // A paid dispatch is irreversible even without a response.
    const fixture = fixtures.find(fixture => fixture.version === item.contract.fixture_version);
    const mapping = checkpoint.projects[fixture.version];
    assert.deepEqual(await runtime.readProof(fixture, mapping), mapping.proof, "Frozen persisted project inputs changed before answer.");
    await runtime.checkJobs([]);
    const before = await guardBudget();
    checkpoint.budget_projection = projectHoldoutBudget(checkpoint, fixtures, before);
    save();
    requireCondition(checkpoint.budget_projection.projected_remaining_usd <= checkpoint.budget_projection.available_usd,
      "PROJECTED_BUDGET_EXHAUSTED", "Projected remaining answers plus judge reservations exceed the existing phase/cumulative headroom. No answer was issued; revise the plan before spending, without changing the ledger or frozen labels.");
    const attempt = issueAnswer(checkpoint, item, save);
    const started = performance.now();
    try {
      const response = await runtime.request(runtime.route(mapping.project_id) + "/chat", { ...runtime.json({ message: item.contract.question, session_id: attempt.session_id }), headers: { "content-type": "application/json", "x-openai-model": checkpoint.identity.answer_model } });
      attempt.trace_id = response.headers.get("x-workflow-trace-id");
      attempt.http_status = response.status;
      requireCondition(response.headers.get("x-chat-session-id") === attempt.session_id && attempt.trace_id, "CHAT_TRACE", "Chat must expose the actual session and workflow trace ID.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let answer = "", firstVisibleMs = null;
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        if (text.trim() && firstVisibleMs === null) firstVisibleMs = performance.now() - started;
        answer += text;
        attempt.partial_stream = answer; save();
      }
      answer += decoder.decode();
      attempt.streamed_content = answer; delete attempt.partial_stream;
      attempt.stream_finished_at = new Date().toISOString();
      attempt.first_visible_ms = firstVisibleMs; attempt.stream_ms = performance.now() - started; save();
      const saved = await (await runtime.request(`${runtime.route(mapping.project_id)}/chat?session_id=${encodeURIComponent(attempt.session_id)}`)).json();
      const user = saved.messages.filter(message => message.role === "user"), assistants = saved.messages.filter(message => message.role === "assistant");
      requireCondition(user.length === 1 && user[0].content === item.contract.question && assistants.length === 1, "SESSION_ISOLATION", "Each frozen case must have exactly one actual user question and one persisted answer in its independent session.");
      const message = assistants[0];
      attempt.persisted_content = message.content; attempt.message_id = message.id; save();
      requireCondition(message.content === answer && answer.trim(), "STREAM_PERSISTENCE", "Persisted answer must exactly equal the streamed bytes. Boundary whitespace differences are recorded as failure, not silently normalized.");
      attempt.answer = answer; attempt.answer_sha256 = sha256(answer); attempt.sources = message.source_references ?? [];
      attempt.context_snapshot = message.context_snapshot;
      const context = message.context_snapshot;
      const retrieval = context?.retrieval_telemetry;
      requireCondition(context?.customer_analysis_present === true && context.chat_session_id === attempt.session_id && typeof retrieval?.query === "string" && Number.isSafeInteger(retrieval.sourceCount) && ["usedHybridSearch", "usedVectorSearch", "usedMemoryFallback"].every(key => typeof retrieval[key] === "boolean"), "CHAT_RUNTIME_PROOF", "The actual persisted chat context must prove analysis presence and retrieval execution. Missing telemetry cannot establish the large-document path.");
      assert.deepEqual(await runtime.readProof(fixture, mapping), mapping.proof, "Source or analysis changed while answering.");
      const integrity = await runtime.sourceIntegrity(item, mapping);
      attempt.citation_integrity = integrity.valid; attempt.citation_errors = integrity.errors;
      attempt.output_complete = context.source_check_status === "passed";
      attempt.runtime_proof_valid = true;
      attempt.large_document_proof = { selected_raw_characters: mapping.proof.characters, full_document_threshold: checkpoint.identity.full_document_threshold, whole_document_bypass: false, selected_document_ids: mapping.proof.selected_document_ids, analysis_revision: mapping.proof.analysis_revision, retrieval_telemetry: retrieval };
      attempt.total_ms = performance.now() - started; attempt.status = "completed";
      attempt.budget_observation_pending = true;
      attempt.evidence_sha256 = answerEvidenceHash(attempt); save();
    } catch (error) {
      attempt.status = "uncertain"; attempt.error_code = error instanceof HoldoutError ? error.code : "ANSWER_TRANSPORT_OR_PROOF"; save(); throw error;
    }
    // Accounting is a separate observation: a failed read cannot erase the
    // completed answer, and zero remaining balance is not a failed answer.
    try {
      const after = await observeBudget();
      attempt.proxy_requests = after.requests.filter(row => !before.requests.some(old => old.id === row.id));
      requireCondition(attempt.proxy_requests.every(row => typeof row.requestPurpose === "string"), "PROXY_REQUEST_PURPOSE", "The running budget proxy predates operation classification; its records cannot distinguish retrieval from final answers.");
      attempt.model_answer_requests = attempt.proxy_requests.filter(row => row.requestPurpose === "chat_answer");
      attempt.answer_origin = attempt.model_answer_requests.length ? "real_model_via_budget_proxy" : "application_abstention_without_final_model_call";
      // The route's genuine retrieval abstention is evidence too. It cannot
      // masquerade as a factual answer or a successful real-model generation.
      if (!attempt.model_answer_requests.length && item.contract.kind === "factual") attempt.output_complete = false;
      // One attempt means one chat-route dispatch. The application's bounded
      // transport retry / evidence repair remains part of that attempt, with
      // every provider request retained and charged in proxy_requests.
      if (attempt.model_answer_requests.length && (!attempt.model_answer_requests.some(row => row.status === 200 && row.completion?.status === "completed") || attempt.model_answer_requests.some(row => row.model !== checkpoint.identity.answer_model))) attempt.output_complete = false;
      delete attempt.budget_observation_pending;
      attempt.evidence_sha256 = answerEvidenceHash(attempt); save();
      console.error(JSON.stringify({ case: item.contract.id, answer: attempt.status, citation_integrity: attempt.citation_integrity, source_count: attempt.sources.length }));
    } catch (error) {
      attempt.budget_observation_error = error instanceof HoldoutError ? error.code : "BUDGET_OBSERVATION";
      checkpoint.budget_observation_failed = true;
      attempt.evidence_sha256 = answerEvidenceHash(attempt); save(); throw error;
    }
  }
}

export async function judgeCases({ checkpoint, fixtures, runtime, batchSize, save, guardBudget, observeBudget = guardBudget }) {
  for (const fixture of fixtures) {
    const mapping = checkpoint.projects[fixture.version];
    requireCondition(mapping?.ready, "PROJECT_NOT_READY", "Judge resume requires the original owned project mapping and persisted proof.");
    assert.deepEqual(await runtime.readProof(fixture, mapping), mapping.proof, "Judge resume source/analysis mapping changed.");
    const pending = checkpoint.cases.filter(item => item.contract.fixture_version === fixture.version && item.answer_attempt?.status === "completed" && !item.judge_attempt);
    for (let from = 0; from < pending.length; from += batchSize) {
      const cases = pending.slice(from, from + batchSize);
      for (const item of cases) {
        const attempt = item.answer_attempt;
        const saved = await (await runtime.request(`${runtime.route(mapping.project_id)}/chat?session_id=${encodeURIComponent(attempt.session_id)}`)).json();
        const users = saved.messages.filter(message => message.role === "user"), assistants = saved.messages.filter(message => message.role === "assistant");
        requireCondition(users.length === 1 && users[0].content === item.contract.question && assistants.length === 1 && assistants[0].id === attempt.message_id && assistants[0].content === attempt.answer && sha256(assistants[0].source_references ?? []) === sha256(attempt.sources) && sha256(assistants[0].context_snapshot) === sha256(attempt.context_snapshot), "JUDGE_ANSWER_MAPPING", "Judge resume must reuse the exact original persisted question, answer, source references and runtime context; it cannot substitute another session/result.");
      }
      const payload = judgePayload(checkpoint, fixture, cases, mapping);
      const before = await guardBudget();
      const prepared = prepareRequest("/v1/responses", payload, 6400, before.proxyServiceTier);
      requireBudgetHeadroom(before, { phase: checkpoint.identity.proxy_phase, phaseCapUsd: checkpoint.identity.phase_cap_usd, baseline: checkpoint.budget_baseline }, prepared.reservedUsd);
      const batch = { id: `judge-${checkpoint.judge_batches.length + 1}`, case_ids: cases.map(item => item.contract.id), status: "issued", request_sha256: sha256(payload), input_sha256: sha256(payload.input), issued_at: new Date().toISOString() };
      checkpoint.judge_batches.push(batch);
      for (const item of cases) item.judge_attempt = { batch_id: batch.id, status: "issued" };
      save(); // Durable before buying judgement, including uncertain outcomes.
      try {
        const response = await fetch(`${PROXY_ORIGIN}/v1/responses`, { method: "POST", redirect: "manual", headers: { authorization: "Bearer local-budget-proxy-only", "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(240_000) });
        batch.http_status = response.status; batch.raw_response = await response.text(); batch.raw_sha256 = sha256(batch.raw_response); save();
        requireCondition(response.ok, "JUDGE_HTTP", `Owned judge request returned HTTP ${response.status}; raw response is retained and this batch will not be repeated.`);
        const responseBody = JSON.parse(batch.raw_response);
        batch.returned_model = responseBody.model;
        const modelSuffix = typeof responseBody.model === "string" && responseBody.model.startsWith(`${checkpoint.identity.judge_model}-`) ? responseBody.model.slice(checkpoint.identity.judge_model.length + 1) : "";
        requireCondition(responseBody.status === "completed" && (responseBody.model === checkpoint.identity.judge_model || /^\d{4}-\d{2}-\d{2}$/u.test(modelSuffix)), "JUDGE_INCOMPLETE", "Judge response was incomplete or used another model; preserve raw evidence, do not repair/retry it.");
        const output = responseBody.output_text ?? responseBody.output?.flatMap(item => item.type === "message" ? item.content ?? [] : []).filter(part => part.type === "output_text").map(part => part.text).join("");
        requireCondition(typeof output === "string" && output.trim(), "JUDGE_EMPTY", "Judge returned no text.");
        batch.raw_verdict_text = output; save();
        const raw = JSON.parse(output); batch.raw_verdict = raw; save();
        const verdicts = interpretJudge(raw, cases.map(item => item.contract));
        for (const item of cases) item.judge_attempt = { batch_id: batch.id, status: "completed", verdict: verdicts[item.contract.id] };
        batch.status = "completed"; batch.budget_observation_pending = true; save();
      } catch (error) {
        batch.status = "failed_or_uncertain"; batch.error_code = error instanceof HoldoutError ? error.code : "JUDGE_TRANSPORT_OR_SCHEMA";
        for (const item of cases) item.judge_attempt = { batch_id: batch.id, status: "failed_or_uncertain", error_code: batch.error_code };
        save(); throw error;
      }
      try {
        const after = await observeBudget();
        batch.proxy_requests = after.requests.filter(row => !before.requests.some(old => old.id === row.id));
        delete batch.budget_observation_pending; save();
      } catch (error) {
        batch.budget_observation_error = error instanceof HoldoutError ? error.code : "BUDGET_OBSERVATION";
        checkpoint.budget_observation_failed = true; save(); throw error;
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { console.log(HELP); return; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  assertFrozenCode({ commit: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain", "--untracked-files=all"]) }, options.expectedCommit);
  const { manifest, fixtures } = loadFrozenRagHoldout();
  const contracts = caseContracts(fixtures);
  // Classification/uniqueness are validated by the existing metric owner too.
  summarizeModelReleaseResults(contracts, {}, { policy: manifest.metric_policy });
  const status = JSON.parse(readFileSync(systemTestStatusPath(), "utf8"));
  requireCondition(path.isAbsolute(status.directory ?? ""), "OWNED_DIRECTORY", "Owned status must identify an absolute private runtime directory.");
  const runtimeConfig = JSON.parse(readFileSync(path.join(status.directory, "environment.json"), "utf8"));
  validateOwnedEnvironment(status, runtimeConfig);
  requireCondition(path.isAbsolute(options.checkpoint) && path.dirname(options.checkpoint) === realpathSync(status.directory) && !options.checkpoint.endsWith("-report.json"), "CHECKPOINT_PATH", "Checkpoint must be an absolute file directly inside the owned private directory.");
  if (existsSync(options.checkpoint)) requireCondition(!lstatSync(options.checkpoint).isSymbolicLink(), "CHECKPOINT_PATH", "A checkpoint cannot be a symlink.");
  requireCondition(options.resume === existsSync(options.checkpoint), "RESUME", "Use --resume for the existing checkpoint; omit it only for a new checkpoint. Never overwrite an evaluation.");
  const lockPath = `${options.checkpoint}.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, commit: options.expectedCommit }) + "\n", { flush: true });
  let checkpoint, runtime, save;
  try {
    runtime = createOwnedRuntime(root, status, runtimeConfig);
    requireCondition(await runtime.models.resolveOpenAIModelOverride(options.answerModel) === options.answerModel && await runtime.models.resolveOpenAIModelOverride(options.judgeModel) === options.judgeModel, "MODEL_CONFIG", "Both exact models must be accepted unchanged by the application's model-config owner.");
    const source = readFileSync(path.join(root, "apps/frontend/lib/server/ai/project-chat.ts"), "utf8");
    const thresholdText = /const CHAT_FULL_DOCUMENTS_MAX_CHARS\s*=\s*([\d_]+)\s*;/u.exec(source)?.[1];
    requireCondition(thresholdText, "LARGE_PATH_CONTRACT", "Cannot prove the frozen app's whole-document threshold. Expose/confirm this application contract before spending.");
    const threshold = Number(thresholdText.replaceAll("_", ""));
    requireCondition(threshold < manifest.protocol.minimum_project_characters, "LARGE_PATH_CONTRACT", "The frozen corpus no longer exceeds the application's whole-document bypass. Do not claim large-path evidence.");
    const identity = { runner_version: RUNNER_VERSION, code_commit: options.expectedCommit, manifest_sha256: sha256(readFileSync(path.join(root, "test-data/rag-release-holdout/manifest.json"))), fixture_hashes: fixtures.map(fixture => ({ version: fixture.version, sha256: fixture.sha256 })), protocol: manifest.protocol, document_role_protocol: DOCUMENT_ROLE_PROTOCOL, protocol_sha256: sha256({ manifest, document_roles: DOCUMENT_ROLE_PROTOCOL, judge: JUDGE_INSTRUCTIONS, batch_size: options.batchSize }), question_contracts_sha256: sha256(contracts), answer_model: options.answerModel, judge_model: options.judgeModel, batch_size: options.batchSize, proxy_phase: options.proxyPhase, phase_cap_usd: options.phaseCapUsd, full_document_threshold: threshold, chat_owner_sha256: sha256(source), environment_directory: realpathSync(status.directory), environment_created_at: status.createdAt, environment_sha256: sha256(runtimeConfig.env), runner_hashes: Object.fromEntries(["rag_holdout_eval.mjs", "rag_holdout_eval_protocol.mjs", "rag_holdout_eval_runtime.mjs", "rag_holdout_eval_cache.mjs", "rag_holdout_fixtures.mjs", "rag_model_release_metrics.mjs"].map(file => [file, sha256(readFileSync(path.join(root, "scripts", file)))])) };
    const budget = await runtime.budget();
    validateBudget(budget, { phase: options.proxyPhase, phaseCapUsd: options.phaseCapUsd });
    checkpoint = options.resume ? JSON.parse(readFileSync(options.checkpoint, "utf8")) : createCheckpoint(identity, contracts, budget);
    validateCheckpoint(checkpoint, identity, contracts);
    for (const project of Object.values(checkpoint.projects)) if (project.ready) requireCondition(project.proof_sha256 === sha256(project.proof), "PROJECT_MAPPING", "Persisted source/project mapping changed in checkpoint.");
    save = () => saveCheckpoint(options.checkpoint, checkpoint); save();
    const observeBudget = async () => {
      const next = await runtime.budget();
      validateBudget(next, { phase: options.proxyPhase, phaseCapUsd: options.phaseCapUsd, baseline: checkpoint.budget_baseline });
      checkpoint.budget_latest = next; save(); return next;
    };
    const guardBudget = async () => {
      assertFrozenCode({ commit: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain", "--untracked-files=all"]) }, options.expectedCommit);
      const currentStatus = JSON.parse(readFileSync(systemTestStatusPath(), "utf8"));
      requireCondition(currentStatus.running === true && currentStatus.directory === status.directory && sha256(JSON.parse(readFileSync(path.join(status.directory, "environment.json"), "utf8")).env) === identity.environment_sha256, "RUNTIME_CHANGED", "The owned runtime changed after freeze; no further evaluation request is allowed.");
      const next = await observeBudget();
      requireBudgetHeadroom(next, { phase: options.proxyPhase, phaseCapUsd: options.phaseCapUsd, baseline: checkpoint.budget_baseline });
      return next;
    };
    await guardBudget();
    checkpoint.preflight = await runtime.preflight(fixtures); save();
    assertFrozenCode({ commit: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain", "--untracked-files=all"]) }, options.expectedCommit);
    const context = { checkpoint, fixtures, runtime, save, guardBudget, observeBudget, batchSize: options.batchSize };
    if (["setup", "all"].includes(options.phase)) await setupProjects(context);
    if (["answers", "all"].includes(options.phase)) await answerCases(context);
    if (["judge", "all"].includes(options.phase)) await judgeCases(context);
    if (options.vetoes) { applyIndependentVetoes(checkpoint, JSON.parse(readFileSync(options.vetoes, "utf8"))); save(); }
    delete checkpoint.active_failure;
    checkpoint.events.push({ phase: options.phase, status: "finished", at: new Date().toISOString() }); save();
  } catch (error) {
    if (checkpoint && save) { checkpoint.active_failure = { phase: options.phase, code: error instanceof HoldoutError ? error.code : "RUNTIME_OR_CONTRACT_FAILURE" }; checkpoint.events.push({ ...checkpoint.active_failure, status: "stopped", at: new Date().toISOString() }); save(); }
    throw error;
  } finally {
    try {
      if (checkpoint && save) {
        try {
          const latest = await runtime.budget();
          validateBudget(latest, { phase: options.proxyPhase, phaseCapUsd: options.phaseCapUsd, baseline: checkpoint.budget_baseline });
          checkpoint.budget_latest = latest; delete checkpoint.budget_observation_failed;
        } catch { checkpoint.budget_observation_failed = true; }
        save();
        const report = buildReport(checkpoint, manifest);
        const output = `${options.checkpoint}.report.json`;
        saveCheckpoint(output, report);
        console.log(JSON.stringify({ checkpoint: options.checkpoint, report: output, counts: report.actual_counts, metrics: report.metrics, release_passed: report.release_passed, accounted_cost_delta_usd: report.accounted_cost_delta_usd }));
        if ((["judge", "all"].includes(options.phase) && !report.release_passed) || (options.phase === "answers" && report.actual_counts.answers_completed !== contracts.length)) process.exitCode = 1;
      }
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Native provider/backend errors may contain confidential request context.
    console.error(JSON.stringify({ code: error instanceof HoldoutError ? error.code : "RUNTIME_OR_CONTRACT_FAILURE", message: error instanceof HoldoutError ? error.message : "Holdout stopped. Inspect the private checkpoint and owned logs; no automatic retry was issued." }));
    process.exitCode = 1;
  });
}
