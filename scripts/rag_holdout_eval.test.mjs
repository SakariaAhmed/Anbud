import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { answerCases, applyIndependentVetoes, judgeCases, parseArguments, projectHoldoutBudget, setupProjects } from "./rag_holdout_eval.mjs";
import { ACCOUNTING_POLICY } from "./speed-quality/budget.mjs";
import { loadFrozenRagHoldout } from "./rag_holdout_fixtures.mjs";
import { answerEvidenceHash, assertFrozenCode, buildReport, caseContracts, createCheckpoint, interpretJudge, issueAnswer, judgeInput, requireBudgetHeadroom, saveCheckpoint, sha256, validateBudget, validateCheckpoint, validateSourceReferences } from "./rag_holdout_eval_protocol.mjs";
import { syntheticAnalysis, uploadConstraintConflicts, uploadDocumentPlan, validateOwnedEnvironment } from "./rag_holdout_eval_runtime.mjs";

// Pure/injected deterministic tests only: never read the live status, launch a
// server, install a model stub in the app, or contact the proxy/provider.
const clone = value => structuredClone(value);
function budget() {
  return { version: 1, createdAt: "2026-11-02T09:00:00Z", accountingPolicy: ACCOUNTING_POLICY, limitUsd: 10, accountedUpperBoundUsd: 6.331864, remainingUsd: 3.668136, proxyPhase: "frozen-semantic", proxyPhaseBudgetUsd: 1.6, proxyServiceTier: "default", proxyRequestPurposeVersion: 1, requests: [{ id: "historical", phase: "earlier", status: "uncertain", model: "gpt-5.4-mini", reservedUsd: 6.331864 }] };
}
const guard = { phase: "frozen-semantic", phaseCapUsd: 1.6 };
function contract(id = "factual-1", overrides = {}) { return { id, kind: "factual", question: `Spørsmål ${id}?`, expected: "Optional context", citations_required: true, abstention_required: false, evidence: [], fixture_version: "fixture.v1", ...overrides }; }
function identity() { return { code_commit: "a".repeat(40), manifest_sha256: "frozen", protocol_sha256: "protocol", answer_model: "gpt-5.4-mini", judge_model: "gpt-5.6-luna", batch_size: 2, proxy_phase: guard.phase, phase_cap_usd: guard.phaseCapUsd, full_document_threshold: 90_000 }; }
function checkpoint(contracts = [contract()]) {
  const state = createCheckpoint(identity(), contracts, budget());
  state.projects["fixture.v1"] = { project_id: "project-one", ready: true, documents: {}, proof: { source_revision: 3, characters: 91_000, selected_document_ids: ["document-one"], analysis_revision: "analysis-one" } };
  return state;
}
function goodVerdict(id, overrides = {}) { return { id, core_correct: true, grounded: true, citations_correct: true, abstention_correct: true, reason: "Støttet av originalen", label_disagreement: null, claims: [{ text: "Fakta", supported: true, citation_correct: true, reason: "Kilde" }], ...overrides }; }
function completeAnswer(state, item, answer = "Svar [Kilde 1]") {
  const attempt = issueAnswer(state, item, () => {});
  Object.assign(attempt, { status: "completed", answer, answer_sha256: sha256(answer), persisted_content: answer, streamed_content: answer, sources: [], message_id: `message-${item.contract.id}`, context_snapshot: {}, output_complete: true, citation_integrity: true, runtime_proof_valid: true });
  attempt.evidence_sha256 = answerEvidenceHash(attempt);
  return attempt;
}

test("CLI requires explicit AI, exact different model choices, a phase and bounded batches", () => {
  assert.throws(() => parseArguments([]), /Explicit --ai/u);
  const args = ["--ai", "--phase", "setup", "--expected-commit", "a".repeat(40), "--checkpoint", "/private/holdout.json", "--model", "gpt-5.4-mini", "--judge-model", "gpt-5.6-luna", "--proxy-phase", guard.phase, "--phase-cap-usd", "1.60"];
  assert.equal(parseArguments(args).batchSize, 4);
  assert.throws(() => parseArguments([...args, "--batch-size", "80"]), /one to five/u);
  assert.throws(() => parseArguments([...args, "--ai"]), /Duplicate/u);
  assert.throws(() => parseArguments([...args, "--base-url", "https://production.invalid"]), /Unknown/u);
  const resume = args.filter((value, index) => ![1, 2].includes(index));
  assert.equal(parseArguments([...resume, "--judge-resume"]).phase, "judge");
});

test("freeze rejects dirty or differently pinned code", () => {
  const commit = "a".repeat(40);
  assertFrozenCode({ commit, status: "" }, commit);
  assert.throws(() => assertFrozenCode({ commit, status: "?? scripts/new.mjs" }, commit), /freeze/u);
  assert.throws(() => assertFrozenCode({ commit, status: "" }, "b".repeat(40)), /frozen/u);
  assert.throws(() => assertFrozenCode({ commit, status: "" }, "aaaaaaa"), /40-character/u);
});

test("checkpoint binds commit, models, fixture/protocol identity, questions and corpus mappings", () => {
  const state = checkpoint();
  validateCheckpoint(state, identity(), [contract()]);
  for (const field of ["code_commit", "manifest_sha256", "protocol_sha256", "answer_model", "judge_model"]) {
    assert.throws(() => validateCheckpoint(state, { ...identity(), [field]: "changed" }, [contract()]), /Checkpoint/u);
  }
  assert.throws(() => validateCheckpoint(state, identity(), [contract("factual-1", { question: "Changed" })]), /contracts/u);
  const duplicate = clone(state); duplicate.projects.other = clone(duplicate.projects["fixture.v1"]);
  assert.throws(() => validateCheckpoint(duplicate, identity(), [contract()]), /distinct/u);
  const changed = clone(state); changed.identity.answer_model = "other";
  assert.throws(() => validateCheckpoint(changed, identity(), [contract()]), /Checkpoint/u);
});

test("write-ahead answer dispatch is durable and uncertain attempts can never be issued again", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-holdout-unit-"));
  try {
    const file = path.join(directory, "checkpoint.json"), state = checkpoint(), item = state.cases[0];
    const attempt = issueAnswer(state, item, () => saveCheckpoint(file, state));
    assert.equal(JSON.parse(readFileSync(file)).cases[0].answer_attempt.status, "issued");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    attempt.status = "uncertain";
    saveCheckpoint(file, state);
    const resumed = JSON.parse(readFileSync(file));
    assert.throws(() => issueAnswer(resumed, resumed.cases[0], () => assert.fail("must not save")), /One final answer/u);
    assert.equal(resumed.cases[0].answer_attempt.count, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("completed answer byte changes and shared sessions invalidate resume", () => {
  const contracts = [contract("one"), contract("two")], state = checkpoint(contracts);
  completeAnswer(state, state.cases[0]); completeAnswer(state, state.cases[1]);
  validateCheckpoint(state, identity(), contracts);
  state.cases[0].answer_attempt.streamed_content += " ";
  assert.throws(() => validateCheckpoint(state, identity(), contracts), /bytes/u);
  state.cases[0].answer_attempt.streamed_content = state.cases[0].answer_attempt.answer;
  const tampered = clone(state); tampered.cases[0].answer_attempt.sources = [{ source_id: "another-project" }];
  assert.throws(() => validateCheckpoint(tampered, identity(), contracts), /sources/u);
  state.cases[1].answer_attempt.session_id = state.cases[0].answer_attempt.session_id;
  state.cases[1].answer_attempt.evidence_sha256 = answerEvidenceHash(state.cases[1].answer_attempt);
  assert.throws(() => validateCheckpoint(state, identity(), contracts), /share/u);
});

test("malformed, missing, duplicate and foreign judge cases cannot become passes", () => {
  const contracts = [contract("one"), contract("two")];
  for (const raw of [{}, { cases: [] }, { cases: [goodVerdict("one"), goodVerdict("one")] }, { cases: [goodVerdict("one"), goodVerdict("foreign")] }, { cases: [goodVerdict("one"), goodVerdict("two", { grounded: "true" })] }, { cases: [goodVerdict("one"), goodVerdict("two", { claims: [] })] }, { cases: [goodVerdict("one"), goodVerdict("two", { claims: [{ text: "claim", supported: true }] })] }]) {
    assert.throws(() => interpretJudge(raw, contracts));
  }
});

test("individual claims and incorrect core conclusions only lower the untouched raw judge", () => {
  const raw = { cases: [goodVerdict("one", { claims: [{ text: "Unsupported conclusion", supported: false, citation_correct: false, reason: "Wrong" }] })] };
  const before = clone(raw), result = interpretJudge(raw, [contract("one")]).one;
  assert.equal(result.grounded, false); assert.equal(result.citations_correct, false);
  assert.deepEqual(raw, before);
  assert.equal(interpretJudge({ cases: [goodVerdict("one", { core_correct: false })] }, [contract("one")]).one.grounded, false);
});

test("negative conflict cases can require both citations and abstention without relabelling", () => {
  const negative = contract("conflict", { kind: "negative", abstention_required: true });
  assert.equal(interpretJudge({ cases: [goodVerdict("conflict")] }, [negative]).conflict.abstention_correct, true);
  const raw = { cases: [goodVerdict("conflict", { citations_correct: false, label_disagreement: "The frozen rubric is debatable." })] };
  const interpreted = interpretJudge(raw, [negative]).conflict;
  assert.equal(interpreted.abstention_correct, false);
  assert.equal(interpreted.label_disagreement, raw.cases[0].label_disagreement);
  const state = checkpoint([negative]); completeAnswer(state, state.cases[0]);
  state.cases[0].answer_attempt.citation_integrity = false;
  state.cases[0].judge_attempt = { status: "completed", verdict: goodVerdict("conflict") };
  const report = buildReport(state, { thresholds: {}, metric_policy: "distinct-factual" });
  assert.equal(report.metrics.correct_abstention, 0);
  assert.equal(report.negative_cases, 1); assert.equal(report.factual_cases, 0);
  assert.ok(report.results[0].failure_reasons.includes("REQUIRED_CONFLICT_CITATIONS"));
});

test("full frozen denominators retain incomplete and unjudged cases; negatives never inflate factual quality", () => {
  const { fixtures, manifest } = loadFrozenRagHoldout();
  const state = createCheckpoint(identity(), caseContracts(fixtures), budget());
  const empty = buildReport(state, manifest);
  assert.equal(empty.factual_cases, 60); assert.equal(empty.negative_cases, 20); assert.equal(empty.results.length, 80);
  assert.deepEqual(empty.metrics, { groundedness: 0, citation_correctness: 0, correct_abstention: 0 });
  for (const item of state.cases) {
    item.answer_attempt = { status: "completed", output_complete: true, citation_integrity: true, runtime_proof_valid: true };
    item.judge_attempt = { status: "completed", verdict: goodVerdict(item.contract.id) };
  }
  const factual = state.cases.filter(item => item.contract.kind === "factual");
  factual[0].answer_attempt.output_complete = false;
  assert.equal(buildReport(state, manifest).metrics.groundedness, 59 / 60);
  factual[1].judge_attempt = null;
  const report = buildReport(state, manifest);
  assert.equal(report.metrics.groundedness, 58 / 60); assert.equal(report.metrics.correct_abstention, 1);
  assert.equal(report.release_passed, false); assert.equal(report.actual_counts.judged, 79);
  const duplicate = createCheckpoint(identity(), [contract("a"), contract("b", { question: contract("a").question })], budget());
  assert.throws(() => buildReport(duplicate, manifest), /Duplicate factual/u);
});

test("independent vetoes only lower and disagreements remain separate from frozen labels", () => {
  const state = checkpoint(), item = state.cases[0]; completeAnswer(state, item);
  item.judge_attempt = { status: "completed", verdict: goodVerdict(item.contract.id, { label_disagreement: "Rubric disagreement" }) };
  applyIndependentVetoes(state, { identity_sha256: state.identity_sha256, cases: [{ id: item.contract.id, grounded: false, reason: "Verified false claim" }] });
  const report = buildReport(state, { thresholds: {}, metric_policy: "distinct-factual" });
  assert.equal(report.metrics.groundedness, 0); assert.equal(item.judge_attempt.verdict.grounded, true);
  assert.deepEqual(report.disagreements, [{ id: item.contract.id, reason: "Rubric disagreement" }]);
  assert.throws(() => applyIndependentVetoes(state, { identity_sha256: state.identity_sha256, cases: [{ id: item.contract.id, grounded: true, reason: "Upgrade" }] }), /cannot relabel or upgrade/u);
});

test("active finite proxy guard enforces existing $10 history and refuses reset, refill, exhaustion and oversized judge reservation", () => {
  const baseline = budget();
  assert.equal(validateBudget(baseline, guard).phaseRemainingUsd, 1.6);
  for (const changed of [{ ...baseline, limitUsd: 14 }, { ...baseline, proxyPhaseBudgetUsd: Infinity }, { ...baseline, proxyPhaseBudgetUsd: 2 }, { ...baseline, proxyPhase: "new-phase" }, { ...baseline, accountedUpperBoundUsd: 0, remainingUsd: 10, requests: [] }]) assert.throws(() => validateBudget(changed, guard));
  assert.throws(() => validateBudget(baseline, { ...guard, phaseCapUsd: Infinity }));
  const reset = clone(baseline); reset.requests[0].id = "replacement";
  assert.throws(() => validateBudget(reset, { ...guard, baseline }), /history/u);
  const full = clone(baseline); full.requests.push({ id: "current", phase: guard.phase, status: "uncertain", reservedUsd: 1.6 }); full.accountedUpperBoundUsd += 1.6; full.remainingUsd -= 1.6;
  assert.throws(() => requireBudgetHeadroom(full, { ...guard, baseline }), /cannot fund/u);
  assert.throws(() => requireBudgetHeadroom(baseline, guard, 1.600001), /cannot fund/u);
  const pending = clone(baseline); pending.requests[0].status = "reserved";
  assert.throws(() => validateBudget(pending, guard), /outstanding/u);
});

function owned() {
  const status = { running: true, directory: "/private/owned", baseUrl: "http://127.0.0.1:4338", aiMode: "budgeted loopback model proxy", ports: { postgres: 55448, postgrest: 55449, blob: 55450 } };
  const runtime = { databaseUrl: "postgresql://postgres:private-password@127.0.0.1:55448/postgres", sessions: { adminCookie: "bidsite_session=private-cookie" }, env: { DATA_API_URL: "http://127.0.0.1:55449", DATA_API_SERVICE_ROLE_KEY: "private-token", PROJECT_JOB_WORKER_TOKEN: "private-worker", PROJECT_JOB_WORKER_PROCESS: "1", OPENAI_BASE_URL: "http://127.0.0.1:4340/v1", OPENAI_API_KEY: "local-budget-proxy-only", RAG_MODEL_RERANK: "on", APP_PUBLIC_ORIGIN: status.baseUrl, AZURE_STORAGE_CONTAINER: "anbud-system-test", AZURE_STORAGE_EMULATOR_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=anbudtest;AccountKey=private-key;BlobEndpoint=http://127.0.0.1:55450/anbudtest" } };
  return { status, runtime };
}

test("preflight refuses remote/prod services, stubs, wrong worker mode and alternate model endpoints without leaking secrets", () => {
  const pair = owned(); validateOwnedEnvironment(pair.status, pair.runtime);
  for (const mutate of [pair => pair.status.baseUrl = "https://prod.invalid", pair => pair.runtime.env.DATA_API_URL = "https://prod.invalid", pair => pair.runtime.databaseUrl = "postgresql://u:secret@prod.invalid/postgres", pair => pair.runtime.env.OPENAI_BASE_URL = "https://api.openai.com/v1", pair => pair.status.aiMode = "stub", pair => pair.runtime.env.OPENAI_API_KEY = "sk-private-key", pair => pair.runtime.env.PROJECT_JOB_WORKER_PROCESS = "0", pair => pair.runtime.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = "https://prod.invalid", pair => pair.runtime.env.OPENAI_EMBEDDING_BASE_URL = "https://prod.invalid", pair => pair.runtime.env.AZURE_STORAGE_ACCOUNT_URL = "https://prod.invalid"]) {
    const changed = clone(pair); mutate(changed);
    assert.throws(() => validateOwnedEnvironment(changed.status, changed.runtime), error => !/private-cookie|private-token|private-password|sk-private-key/u.test(error.message));
  }
});

test("registered role plan preserves the frozen corpus while using the existing requirement-attachment contract", () => {
  const { fixtures } = loadFrozenRagHoldout();
  const original = clone(fixtures);
  assert.equal(fixtures[0].documents.filter(document => document.role === "primary_customer_document").length, 2);
  const indexes = [{ indexname: "documents_one_primary_customer_per_project_idx", indexdef: "CREATE UNIQUE INDEX documents_one_primary_customer_per_project_idx ON public.documents USING btree (project_id) WHERE (role = 'primary_customer_document'::text)" }];
  const issues = uploadConstraintConflicts(fixtures, indexes);
  assert.equal(issues.length, 0);
  assert.equal(uploadConstraintConflicts(fixtures, []).length, 0);
  const plan=uploadDocumentPlan(fixtures[0]);
  assert.equal(plan.filter(item=>item.role==="primary_customer_document").length,1);
  const attachment=plan.find(item=>item.document.role==="primary_customer_document"&&item.role==="supporting_document");
  assert.equal(attachment.supporting_subtype,"kravdokument");
  assert.deepEqual(plan.map(item=>item.document),fixtures[0].documents);
  assert.deepEqual(fixtures,original);
});

test("sparse citation identities and quotations must match authorized persisted originals", () => {
  const document = { id: "doc", title: "Original", chunk_source_revision: 4, raw_text: "Originalens hele tekst med 42 brukere." };
  const source = { citation_number: 7, source_type: "project_document", source_id: "doc", document_title: "Original", source_revision: 4, source_fingerprint: "fingerprint", evidence_id: "E-original", original_quote: "42 brukere" };
  const options = { fingerprint: () => "fingerprint", validateEvidence: (_answer, available) => assert.equal(available[6].source_id, "doc"), question: "Hvor mange?", citationsRequired: true };
  const verify = sources => validateSourceReferences("42 brukere [Kilde 7]", sources, [document], options);
  assert.equal(verify([source]).valid, true);
  for (const changed of [{ ...source, source_id: "foreign" }, { ...source, source_revision: 5 }, { ...source, source_fingerprint: "wrong" }, { ...source, original_quote: "43 brukere" }, { ...source, quotation_excerpts: ["invented excerpt"] }, { ...source, source_type: "generated_artifact" }]) assert.equal(verify([changed]).valid, false);
  assert.equal(verify([source, source]).valid, false);
  assert.equal(verify([]).valid, false);
});

test("full-source judge payload preserves frozen context and marks saved analysis as synthetic", () => {
  const fixture = { version: "fixture.v1", documents: [{ id: "original", role: "primary_customer_document", raw_text: "Full source, including later contradictory text." }], saved_analysis: { customer_profile_summary: "Fixture summary", executive_summary: "Fixture conclusion" } };
  const state = checkpoint(); completeAnswer(state, state.cases[0]);
  const input = judgeInput(fixture, state.cases, { documents: { original: { id: "persisted-original" } } });
  assert.equal(input.full_sources[0].raw_text, fixture.documents[0].raw_text);
  assert.equal(input.full_sources[0].persisted_source_id, "persisted-original");
  const nextState=checkpoint([contract("next-batch")]);completeAnswer(nextState,nextState.cases[0]);
  const nextInput=judgeInput(fixture,nextState.cases,{documents:{original:{id:"persisted-original"}}});
  const prefix=value=>JSON.stringify(value).split(',"expected_case_ids":')[0];
  assert.equal(prefix(input),prefix(nextInput),"Different cases retain the complete immutable source prefix.");
  assert.ok(prefix(input).includes(fixture.documents[0].raw_text));
  assert.match(input.saved_analysis.provenance, /not model generated/u);
  const analysis = syntheticAnalysis(fixture);
  assert.match(analysis.executive_summary, /IKKE MODELLGENERERT/u);
  assert.equal(analysis.customer_profile_summary, fixture.saved_analysis.customer_profile_summary);
});

test("answer transport interruption remains issued in durable state and resume only dispatches remaining independent cases", async () => {
  const state = checkpoint([contract("one"), contract("two")]), snapshots = [];
  let requests = 0;
  const runtime = { readProof: async () => clone(state.projects["fixture.v1"].proof), checkJobs: async () => {}, json: body => ({ method: "POST", body: JSON.stringify(body) }), route: id => `/api/projects/${id}`, request: async () => { requests++; assert.equal(snapshots.at(-1).cases[requests - 1].answer_attempt.status, "issued"); throw new Error("unobserved transport outcome"); } };
  const context = { checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime, save: () => snapshots.push(clone(state)), guardBudget: async () => budget() };
  await assert.rejects(answerCases(context), /transport/u);
  assert.equal(state.cases[0].answer_attempt.status, "uncertain");
  const session = state.cases[0].answer_attempt.session_id;
  await assert.rejects(answerCases(context), /transport/u);
  assert.equal(requests, 2); assert.equal(state.cases[0].answer_attempt.session_id, session);
  assert.notEqual(state.cases[0].answer_attempt.session_id, state.cases[1].answer_attempt.session_id);
  await answerCases(context); assert.equal(requests, 2);
});

test("budget refusal before dispatch preserves unattempted cases", async () => {
  const state = checkpoint(), runtime = { readProof: async () => clone(state.projects["fixture.v1"].proof), checkJobs: async () => {}, request: async () => assert.fail("must not issue") };
  await assert.rejects(answerCases({ checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime, save: () => {}, guardBudget: async () => { throw new Error("budget exhausted"); } }), /budget/u);
  assert.equal(state.cases[0].answer_attempt, null);
});
test("projected answer and judge costs stop before issuing an unaffordable final attempt",async()=>{
  const state=checkpoint(Array.from({length:80},(_,index)=>contract(`case-${index}`)));
  const fixtures=[{version:"fixture.v1",documents:[],saved_analysis:{}}];
  const runtime={readProof:async()=>clone(state.projects["fixture.v1"].proof),checkJobs:async()=>{},request:async()=>assert.fail("No paid request may be sent")};
  const before=clone(budget());
  await assert.rejects(answerCases({checkpoint:state,fixtures,runtime,save:()=>{},guardBudget:async()=>before}),error=>error.code==="PROJECTED_BUDGET_EXHAUSTED");
  assert.ok(state.cases.every(item=>item.answer_attempt===null));
  assert.ok(state.budget_projection.judge_reservations_usd>0);
  assert.ok(state.budget_projection.projected_remaining_usd>1.6);
  assert.deepEqual(before,budget(),"Planning neither reserves nor changes the ledger.");
  state.cases[0].answer_attempt={proxy_requests:[{reservedUsd:0.2,status:"uncertain"}],answer:"Saved answer",sources:[]};
  const higher=projectHoldoutBudget(state,fixtures,before);
  assert.equal(higher.answer_estimate_usd,0.2);assert.equal(higher.remaining_answers,79);
  assert.ok(higher.projected_remaining_usd>state.budget_projection.projected_remaining_usd);
});

test("judge is bounded, durably issued before HTTP, preserves malformed raw output and never retries it on judge-only resume", async () => {
  const contracts = [contract("one"), contract("two"), contract("three")], state = checkpoint(contracts);
  state.projects["fixture.v1"].documents = { original: { id: "document-one" } };
  for (const item of state.cases) completeAnswer(state, item);
  const fixtures = [{ version: "fixture.v1", saved_analysis: {}, documents: [{ id: "original", raw_text: "All full source text" }] }];
  let calls = 0; const snapshots = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls++; const payload = JSON.parse(options.body), input = JSON.parse(payload.input);
    assert.equal(snapshots.at(-1).judge_batches.at(-1).status, "issued");
    assert.ok(input.cases.length <= 2); assert.equal(input.full_sources[0].raw_text, "All full source text");
    const verdicts = input.expected_case_ids.map(id => goodVerdict(id));
    if (calls === 1) verdicts[1].id = verdicts[0].id;
    return new Response(JSON.stringify({ status: "completed", model: state.identity.judge_model, output_text: JSON.stringify({ cases: verdicts }) }), { status: 200 });
  };
  try {
    const runtime = { readProof: async () => clone(state.projects["fixture.v1"].proof), route: id => `/api/projects/${id}`, request: async route => {
      const session = new URL(route, "http://unit.invalid").searchParams.get("session_id");
      const item = state.cases.find(item => item.answer_attempt.session_id === session), attempt = item.answer_attempt;
      return Response.json({ messages: [{ role: "user", content: item.contract.question }, { role: "assistant", id: attempt.message_id, content: attempt.answer, source_references: attempt.sources, context_snapshot: attempt.context_snapshot }] });
    } };
    const context = { checkpoint: state, fixtures, runtime, batchSize: 2, save: () => snapshots.push(clone(state)), guardBudget: async () => budget() };
    await assert.rejects(judgeCases(context), /duplicate/u);
    assert.equal(state.judge_batches[0].status, "failed_or_uncertain");
    assert.match(state.judge_batches[0].raw_response, /output_text/u);
    assert.equal(state.cases[0].judge_attempt.status, "failed_or_uncertain");
    await judgeCases(context);
    assert.equal(calls, 2); assert.deepEqual(state.judge_batches[1].case_ids, ["three"]);
    assert.equal(state.cases[2].judge_attempt.status, "completed");
    validateCheckpoint(state, identity(), contracts);
    const tampered = clone(state); tampered.judge_batches[1].raw_response += " ";
    assert.throws(() => validateCheckpoint(tampered, identity(), contracts), /Raw judge/u);
    const verdictChanged = clone(state); verdictChanged.cases[2].judge_attempt.verdict.grounded = false;
    assert.throws(() => validateCheckpoint(verdictChanged, identity(), contracts), /Interpreted/u);
    await judgeCases(context); assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

function answerRuntime(state, { streamed = "42 brukere [Kilde 1]", persisted = streamed } = {}) {
  let session;
  const context = () => ({ customer_analysis_present: true, chat_session_id: session, source_check_status: "passed", retrieval_telemetry: { query: state.cases[0].contract.question, sourceCount: 1, usedHybridSearch: true, usedVectorSearch: false, usedMemoryFallback: false } });
  return { readProof: async () => clone(state.projects["fixture.v1"].proof), checkJobs: async () => {}, sourceIntegrity: async () => ({ valid: true, errors: [] }), json: body => ({ method: "POST", body: JSON.stringify(body) }), route: id => `/api/projects/${id}`, request: async (_route, options = {}) => {
    if (options.method === "POST") {
      session = JSON.parse(options.body).session_id;
      return new Response(streamed, { headers: { "x-chat-session-id": session, "x-workflow-trace-id": "trace-one" } });
    }
    return Response.json({ messages: [{ role: "user", content: state.cases[0].contract.question }, { id: "persisted-answer", role: "assistant", content: persisted, source_references: [], context_snapshot: context() }] });
  } };
}

test("one route attempt retains retrieval and bounded provider retry costs without miscounting either as a second answer", async () => {
  const state = checkpoint(); let reads = 0;
  const context = { checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime: answerRuntime(state), save: () => {}, guardBudget: async () => {
    const snapshot = budget();
    if (++reads > 1) snapshot.requests.push(
      { id: "retrieval-call", model: state.identity.answer_model, endpoint: "/v1/responses", requestPurpose: "structured_json", status: 200, completion: { status: "completed" } },
      { id: "answer-retry", model: state.identity.answer_model, endpoint: "/v1/responses", requestPurpose: "chat_answer", status: 429 },
      { id: "answer-call", model: state.identity.answer_model, endpoint: "/v1/responses", requestPurpose: "chat_answer", status: 200, completion: { status: "completed" } },
    );
    return snapshot;
  } };
  await answerCases(context);
  const attempt = state.cases[0].answer_attempt;
  assert.equal(attempt.answer, attempt.streamed_content); assert.equal(attempt.answer, attempt.persisted_content);
  assert.equal(attempt.trace_id, "trace-one"); assert.equal(attempt.runtime_proof_valid, true);
  assert.equal(attempt.large_document_proof.whole_document_bypass, false);
  assert.equal(attempt.answer_origin, "real_model_via_budget_proxy");
  assert.equal(attempt.proxy_requests.length,3);
  assert.equal(attempt.count,1);
  assert.equal(attempt.model_answer_requests.length, 2); assert.equal(attempt.output_complete, true);
});

test("stream/persistence whitespace mismatch fails honestly and cannot trigger another answer", async () => {
  const state = checkpoint();
  const context = { checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime: answerRuntime(state, { streamed: " 42 brukere [Kilde 1]", persisted: "42 brukere [Kilde 1]" }), save: () => {}, guardBudget: async () => budget() };
  await assert.rejects(answerCases(context), /exactly equal/u);
  assert.equal(state.cases[0].answer_attempt.error_code, "STREAM_PERSISTENCE");
  assert.equal(state.cases[0].answer_attempt.status, "uncertain");
  await answerCases(context);
  assert.equal(state.cases[0].answer_attempt.count, 1);
});

test("setup uses registered roles and opts out before seeding source-fenced analysis", async () => {
  const state = createCheckpoint(identity(), [], budget());
  const fixture = { version: "setup.v1", saved_analysis: { executive_summary: "Frozen" }, documents: [{ id: "a", title: "A", role: "primary_customer_document", raw_text: "Original A", file_name: "original.pdf" }, { id: "b", title: "B", role: "primary_customer_document", raw_text: "Original B", file_name: "original-b.txt" }] };
  const uploads = [], seeds = []; let currentAnalysis = null;
  const runtime = { checkJobs: async () => {}, json: body => ({ method: "POST", body: JSON.stringify(body) }), route: id => `/api/projects/${id}`, waitForJob: async () => {},
    request: async (route, options = {}) => {
      if (route === "/api/projects") return Response.json({ id: "owned-project" });
      if (route.endsWith("/documents")) {
        assert.equal(options.body.get("request_auto_analysis"), "false");
        assert.equal(options.body.get("role_source"), "explicit");
        uploads.push({ role: options.body.get("role"), subtype: options.body.get("supporting_subtype"), raw: await options.body.get("file").text() });
        return Response.json({ document: { id: `document-${uploads.length}` }, job: { id: `job-${uploads.length}`, kind: "document_ingestion" } });
      }
      if (route.endsWith("/jobs")) return Response.json({ jobs: [], automatic_analysis: null });
      assert.fail(`Unexpected route ${route}`);
    }, readProof: async (_fixture, _mapping, options) => ({ source_revision: 7, analysis_present: options?.requireAnalysis !== false }),
    store: { getFreshCustomerAnalysis: async () => currentAnalysis, saveCustomerAnalysis: async (...args) => { seeds.push(args); currentAnalysis = { ...args[2], revision: "persisted-analysis" }; return currentAnalysis; } },
  };
  await setupProjects({ checkpoint: state, fixtures: [fixture], runtime, save: () => {}, guardBudget: async () => budget() });
  assert.deepEqual(uploads, [{ role: "primary_customer_document", subtype: null, raw: "Original A" }, { role: "supporting_document", subtype: "kravdokument", raw: "Original B" }]);
  assert.equal(state.projects[fixture.version].documents.b.fixture_role,"primary_customer_document");
  assert.equal(state.projects[fixture.version].documents.b.requested_role,"supporting_document");
  assert.deepEqual(seeds[0][1], ["document-1", "document-2"]);
  assert.equal(seeds[0][3].expectedSourceRevision, 7); assert.equal(seeds[0][3].expectedAnalysisRevision, null);
  assert.equal(state.projects[fixture.version].ready, true);
  await setupProjects({ checkpoint: state, fixtures: [fixture], runtime, save: () => {}, guardBudget: async () => budget() });
  assert.equal(uploads.length, 2); assert.equal(seeds.length, 1);
});

test("occasional repair calls add one allowance rather than multiplying the spike across every remaining answer", () => {
  const fixtures = [{version:"fixture.v1",documents:[],saved_analysis:{}}];
  for (const [completed, spike] of [[10, 0.06], [30, 0.12]]) {
    const state = checkpoint(Array.from({length:80}, (_, index) => contract(`spike-${index}`)));
    for (let index = 0; index < completed; index++) state.cases[index].answer_attempt = {
      proxy_requests: [{reservedUsd:index === 0 ? spike : 0.015,status:"uncertain"}], answer:"Saved answer",sources:[],
    };
    const projection = projectHoldoutBudget(state, fixtures, budget());
    assert.equal(projection.answer_estimate_usd, 0.03);
    assert.equal(projection.repair_allowance_usd, spike);
    assert.equal(projection.projected_remaining_usd, ((80-completed)*0.03 + spike + projection.judge_reservations_usd)*1.2);
    assert.ok(projection.projected_remaining_usd < ((80-completed)*spike + projection.judge_reservations_usd)*1.2);
  }
});

test("post-answer accounting at zero balance or unavailable preserves completed evidence and never redispatches", async () => {
  for (const unavailable of [false, true]) {
    const state = checkpoint(); let dispatched = 0, guarded = 0;
    const runtime = answerRuntime(state), request = runtime.request;
    runtime.request = async (...args) => { if (args[1]?.method === "POST") dispatched++; return request(...args); };
    const context = { checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime, save: () => {}, guardBudget: async () => { guarded++; return budget(); }, observeBudget: async () => {
      assert.equal(state.cases[0].answer_attempt.status, "completed", "Evidence is saved before observing accounting.");
      assert.equal(state.cases[0].answer_attempt.budget_observation_pending, true);
      if (unavailable) throw new Error("Accounting read unavailable");
      return { ...budget(), remainingUsd: 0, requests: [...budget().requests, { id: "answer", model: state.identity.answer_model, requestPurpose: "chat_answer", status: 200, completion: { status: "completed" } }] };
    } };
    if (unavailable) await assert.rejects(answerCases(context), /Accounting read/u); else await answerCases(context);
    const attempt = state.cases[0].answer_attempt;
    assert.equal(attempt.status, "completed"); assert.equal(attempt.answer, "42 brukere [Kilde 1]");
    assert.equal(attempt.evidence_sha256, answerEvidenceHash(attempt));
    assert.equal(attempt.budget_observation_error, unavailable ? "BUDGET_OBSERVATION" : undefined);
    assert.equal(Boolean(attempt.budget_observation_pending), unavailable);
    validateCheckpoint(state, identity(), [contract()]);
    await answerCases(context); assert.equal(dispatched, 1); assert.equal(guarded, 1);
  }
});

test("post-judge accounting does not replace a completed verdict with an uncertain attempt", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const unavailable of [false, true]) {
      const state = checkpoint(), item = state.cases[0]; completeAnswer(state, item);
      let dispatched = 0, guarded = 0;
      globalThis.fetch = async () => { dispatched++; return Response.json({ status: "completed", model: state.identity.judge_model, output_text: JSON.stringify({ cases: [goodVerdict(item.contract.id)] }) }); };
      const runtime = { readProof: async () => clone(state.projects["fixture.v1"].proof), route: id => `/api/projects/${id}`, request: async () => Response.json({ messages: [
        { role: "user", content: item.contract.question }, { role: "assistant", id: item.answer_attempt.message_id, content: item.answer_attempt.answer, source_references: item.answer_attempt.sources, context_snapshot: item.answer_attempt.context_snapshot },
      ] }) };
      const context = { checkpoint: state, fixtures: [{ version: "fixture.v1", documents: [], saved_analysis: {} }], runtime, batchSize: 2, save: () => {}, guardBudget: async () => { guarded++; return budget(); }, observeBudget: async () => {
        assert.equal(item.judge_attempt.status, "completed");
        assert.equal(state.judge_batches[0].budget_observation_pending, true);
        if (unavailable) throw new Error("Accounting read unavailable");
        return { ...budget(), remainingUsd: 0 };
      } };
      if (unavailable) await assert.rejects(judgeCases(context), /Accounting read/u); else await judgeCases(context);
      assert.equal(item.judge_attempt.status, "completed"); assert.equal(item.judge_attempt.verdict.grounded, true);
      assert.equal(state.judge_batches[0].status, "completed");
      assert.ok(state.judge_batches[0].raw_response);
      assert.equal(state.judge_batches[0].budget_observation_error, unavailable ? "BUDGET_OBSERVATION" : undefined);
      validateCheckpoint(state, identity(), [contract()]);
      await judgeCases(context); assert.equal(dispatched, 1); assert.equal(guarded, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a crash between result persistence and accounting cannot produce a passing report", () => {
  const state = checkpoint([contract(), contract("negative", { kind: "negative", abstention_required: true })]);
  for (const item of state.cases) {
    completeAnswer(state, item);
    item.judge_attempt = { status: "completed", verdict: goodVerdict(item.contract.id) };
  }
  const manifest = { thresholds: {}, metric_policy: "distinct-factual" };
  assert.equal(buildReport(state, manifest).release_passed, true);
  for (const target of [state.cases[0].answer_attempt, { status: "completed" }]) {
    if (target !== state.cases[0].answer_attempt) state.judge_batches.push(target);
    target.budget_observation_pending = true;
    const report = buildReport(state, manifest);
    assert.equal(report.release_passed, false); assert.equal(report.accounted_cost_delta_usd, null);
    assert.ok(report.failures.some(item => item.includes("accounting observation incomplete")));
    assert.equal(report.actual_counts.answers_completed, 2); assert.equal(report.actual_counts.judged, 2);
    delete target.budget_observation_pending;
  }
});
