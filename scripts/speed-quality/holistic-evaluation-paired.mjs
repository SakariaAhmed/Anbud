import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { frozenInvocation } from "./generation-input.mjs";
import { prepareRequest, validatedBudgetLimit } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const reasoningExperiment = process.argv.includes("--reasoning");
const compactExperiment = process.argv.includes("--compact") || reasoningExperiment;
const reverseOrder = process.argv.includes("--reverse");
const compactLabel = process.argv.find(arg => arg.startsWith("--label="))?.slice(8) ?? "v1";
assert.match(compactLabel, /^v[0-9]+$/);
const out = path.join(dir, reasoningExperiment ? `verification/holistic-reasoning-${compactLabel}` : compactExperiment ? `verification/compact-findings-${compactLabel}` : "verification/holistic-artifact-v1");
const mode = process.argv[2];
const run = process.argv[3];
assert.ok(["prepare", "run", "replay"].includes(mode));
const runs = reasoningExperiment
  ? { "real-before": { scenario: "real", code: "after", model: "gpt-5.4", reasoningEffort: "medium" }, "real-after": { scenario: "real", code: "after", model: "gpt-5.4", reasoningEffort: "low" } }
  : compactExperiment
  ? { "real-before": { scenario: "real", code: "before", model: "gpt-5.4" }, "real-after": { scenario: "real", code: "after", model: "gpt-5.4" } }
  : { "tail-before": { scenario: "tail", code: "before", model: "gpt-5.4" }, "tail-after": { scenario: "tail", code: "after", model: "gpt-5.4" }, "real-after": { scenario: "real", code: "after", model: "gpt-5.4" }, "real-terra": { scenario: "real", code: "after", model: "gpt-5.6-terra" } };
if (mode !== "prepare") assert.ok(runs[run]);
const sha = value => createHash("sha256").update(value).digest("hex");
const hash = value => sha(JSON.stringify(value));
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json")));
assert.equal(env.DATA_API_URL, "http://127.0.0.1:55440");
assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4319/v1");
assert.equal(env.OPENAI_API_KEY, "local-evaluation-proxy-only");
Object.assign(process.env, env);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url);
  assert.ok(mode === "run" && url.origin === "http://127.0.0.1:4319", "Only explicitly metered holistic calls are allowed; preparation is offline.");
  return originalFetch(...args);
};
const require = createRequire(path.join(frontend, "package.json"));
const { createJiti } = require("jiti");
const beforeCommit = compactExperiment ? "6bbb2179" : "83921062";
const beforeFrontend = `/tmp/anbud-speed-quality-baseline-${beforeCommit}/apps/frontend`;
if (!existsSync(beforeFrontend)) {
  const archive = `/tmp/anbud-speed-quality-baseline-${beforeCommit}`;
  mkdirSync(archive, { recursive: true });
  execFileSync("tar", ["-xf", "-", "-C", archive], { input: execFileSync("git", ["archive", beforeCommit, "apps/frontend/lib"], { cwd: root, maxBuffer: 30e6 }) });
  symlinkSync(path.join(frontend, "node_modules"), path.join(beforeFrontend, "node_modules"));
}
const realLoader = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const realCompletion = realLoader(path.join(frontend, "lib/server/ai/completion.ts")).createJsonCompletion;
function codeHashes(directory) {
  return Object.fromEntries(["lib/server/ai.ts", "lib/server/prompts.ts", "lib/server/ai/context.ts", "lib/server/ai/completion.ts", "lib/server/ai/json-completion.ts"].map(file => [file, sha(readFileSync(path.join(directory, file)))]));
}
async function invoke(fixture, spec, captureOnly, expected, replayResult) {
  const directory = spec.code === "before" ? beforeFrontend : frontend;
  const temporary = mkdtempSync(path.join(tmpdir(), "anbud-holistic-"));
  const state = { coverageCalls: 0, holisticCalls: 0, captured: null, realCompletion, fixture, spec, captureOnly, expected, replayResult };
  globalThis.__holisticPaired = state;
  try {
    const completion = path.join(temporary, "completion.cjs");
    const retrieval = path.join(temporary, "retrieval.cjs");
    writeFileSync(completion, `exports.createJsonCompletion = async input => {
      const s = globalThis.__holisticPaired;
      if(input.promptCacheKey === "requirement-coverage-batch") { s.coverageCalls++; return {rows: structuredClone(s.fixture.coverageRows)}; }
      if(input.promptCacheKey !== "solution-evaluation-holistic") throw Error("Unexpected model operation.");
      s.holisticCalls++; if(s.holisticCalls !== 1) throw Error("Only one holistic operation allowed.");
      s.captured = {...input, model:s.spec.model, ...(s.spec.reasoningEffort ? {reasoningEffort:s.spec.reasoningEffort} : {})};
      if(s.captureOnly) throw Error("Captured holistic boundary.");
      if(JSON.stringify(s.captured) !== JSON.stringify(s.expected)) throw Error("Prepared prompt changed.");
      if(s.replayResult) { s.rawModelResult = structuredClone(s.replayResult); return s.rawModelResult; }
      const started = performance.now();
      try { const result = await s.realCompletion(s.captured); s.rawModelResult = structuredClone(result); return result; }
      finally { s.holisticMs = performance.now() - started; }
    }; exports.getClient = () => null; exports.supportsCustomTemperature = () => false;`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippets = async () => []; exports.retrieveDocumentSnippetsWithMetadata = async () => ({snippets:[],telemetry:{quality:{sufficient:false},durationMs:0}});`);
    const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": directory, "server-only": "/dev/null" } });
    const { evaluateSolutionDocument } = loader(path.join(directory, "lib/server/ai.ts"));
    let result;
    try { result = await evaluateSolutionDocument(fixture.scenarios[spec.scenario]); }
    catch (error) {
      if (!captureOnly || !state.captured || !String(error.message).includes("Captured holistic boundary")) {
        const failure = error instanceof Error ? error : new Error("Evaluation owner failed.");
        Object.assign(failure, { rawModelResult: state.rawModelResult, holisticMs: state.holisticMs, captured: state.captured });
        throw failure;
      }
    }
    assert.equal(state.coverageCalls, 1);
    assert.equal(state.holisticCalls, 1);
    return { result, rawModelResult: state.rawModelResult, captured: state.captured, coverageCalls: state.coverageCalls, holisticCalls: state.holisticCalls, holisticMs: state.holisticMs };
  } finally { delete globalThis.__holisticPaired; rmSync(temporary, { recursive: true, force: true }); }
}
mkdirSync(out, { recursive: true });
const fixtureFile = path.join(out, "fixture.json");
if (mode === "replay") {
  const fixtureBytes = readFileSync(fixtureFile), fixture = JSON.parse(fixtureBytes);
  const originalBytes = readFileSync(path.join(out, `${run}.json`)), original = JSON.parse(originalBytes);
  assert.equal(original.completed, false);
  assert.ok(original.rawModelResult && original.providersComplete);
  const outcome = await invoke(fixture, fixture.runs[run], false, fixture.runs[run].captured, original.rawModelResult);
  const report = { at: new Date().toISOString(), scope: "Offline replay of exact failed provider result through current actual evaluation owner; network forbidden. Does not change original failed run or establish new live completion/latency.", originalRunSha256: sha(originalBytes), fixtureSha256: sha(fixtureBytes), currentCode: codeHashes(frontend), result: outcome.result, rawModelResultUnchanged: hash(outcome.rawModelResult) === hash(original.rawModelResult), paidCalls: 0 };
  assert.ok(report.rawModelResultUnchanged);
  const file = path.join(out, `${run}-offline-replay.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ file, findings: outcome.result.document_findings.length, paidCalls: 0 }));
} else if (mode === "prepare") {
  assert.ok(!existsSync(fixtureFile));
  const inputs = JSON.parse(readFileSync(path.join(dir, "generation-inputs.json")));
  const source = inputs.cases.find(c => c.caseId === "fjord-drift-development");
  const perfectBytes = readFileSync(path.join(dir, "verification/perfect-workflow-v1/candidate.json"));
  const perfect = JSON.parse(perfectBytes);
  const artifact = perfect.result.artifact;
  const invocation = frozenInvocation(source, "solution_evaluation");
  const tail = { ...artifact, title: "Fiktiv regresjon – sent tilgangsforbehold", content_markdown: artifact.content_markdown + "\n\n## Dokumentasjonsrutiner\n" + "Driftsdokumentasjon versjoneres og gjennomgås i leveranseteamet. ".repeat(65) + "\n\n## Avgrensning som gjelder dette utkastet\nEksterne konsulenter er unntatt MFA og skal bare bruke passord. Dette forbeholdet avgrenser også den tidligere formuleringen om MFA i dette utkastet.\n" };
  assert.ok(tail.content_markdown.indexOf("## Avgrensning") > 4500);
  const fixture = { at: new Date().toISOString(), sourceCase: source.caseId, split: "development", sourceInputSha256: source.inputSha256, perfectSourceSha256: sha(perfectBytes), scope: "Actual evaluation owner with imported requirement-coverage model rows replayed from the completed perfect development job. Retrieval is stubbed because coverage rows are fixed. Only holistic completion is paid and timed. Not complete workflow latency or fresh coverage-quality evidence.", scenarios: { real: { ...invocation, systemSolutionArtifact: artifact }, tail: { ...invocation, systemSolutionArtifact: tail } }, coverageRows: perfect.result.evaluation.requirement_coverage.items.map(item => ({ nr: item.order_index + 1, ref: item.reference, assessment: item.assessment, rationale: item.rationale, evidence: item.evidence, recommendation: item.recommendation })), runs: {}, code: { before: codeHashes(beforeFrontend), after: codeHashes(frontend) } };
  for (const [name, spec] of Object.entries(runs)) {
    const captured = (await invoke(fixture, spec, true)).captured;
    fixture.runs[name] = { ...spec, captured, captureSha256: hash(captured) };
  }
  if (!compactExperiment) assert.deepEqual({ ...fixture.runs["real-after"].captured, model: "gpt-5.6-terra" }, fixture.runs["real-terra"].captured);
  else {
    const prior = JSON.parse(readFileSync(path.join(dir, "verification/holistic-artifact-v1/fixture.json")));
    assert.deepEqual(fixture.scenarios.real, prior.scenarios.real);
    if (reasoningExperiment) {
      const compactPrior = JSON.parse(readFileSync(path.join(dir, "verification/compact-findings-v2/fixture.json")));
      assert.deepEqual(fixture.runs["real-before"].captured, compactPrior.runs["real-after"].captured);
      assert.deepEqual({ ...fixture.runs["real-before"].captured, reasoningEffort: "low" }, fixture.runs["real-after"].captured);
    } else assert.deepEqual(fixture.runs["real-before"].captured, prior.runs["real-after"].captured);
    assert.deepEqual(fixture.coverageRows, prior.coverageRows);
  }
  const plans = Object.fromEntries(Object.entries(fixture.runs).map(([name, value]) => [name, prepareRequest("/v1/chat/completions", { model: value.model, reasoning_effort: value.captured.reasoningEffort, max_completion_tokens: 16000, response_format: { type: "json_object" }, messages: [{ role: "system", content: value.captured.system }, { role: "user", content: value.captured.user }] }, 16000, "default")]));
  // This estimate excludes the completion owner's short stable system prefix.
  // The live budget proxy reserves the exact request independently.
  writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), { flag: "wx" });
  writeFileSync(path.join(out, "plan.json"), JSON.stringify({ at: new Date().toISOString(), fixtureSha256: sha(readFileSync(fixtureFile)), order: reverseOrder ? Object.keys(runs).reverse() : Object.keys(runs), phase: "refill-v1-development", phaseBudgetUsd: 4, generationCount: Object.keys(runs).length, judgeCount: compactExperiment ? 1 : 2, judgeProtocol: "Full exact scored artifact + older analysis as support + customer/supplier documents + same imported coverage; blind per pair. Never reuse source-only judge protocol.", requests: plans, caveat: reasoningExperiment ? "Separate reasoning-effort control. Both sides use the same current compact evaluation owner, source, artifact, imported coverage, GPT-5.4, default tier, output cap and byte-identical system/user prompts. Only medium versus low differs at the completion boundary; no application setting change. Single development pair, not p95, fresh coverage, complete workflow or holdout acceptance." : compactExperiment ? "One compact-finding development pair, baseline6bbb2179. Same exact functional input, imported coverage, GPT-5.4, medium reasoning and16000 output cap. Changes only internal finding representation and corresponding prompt/normalization. Public result contract preserved. Raw model fields recorded before normalization. Not p95, fresh coverage generation or whole workflow latency; no holdout tuning." : "Single pairs are not p95. Tail scenario is a synthetic counterexample, not representative latency. Real scenario is the exact persisted generated artifact from the completed perfect development job. Terra changes only the holistic model; medium reasoning/output contract preserved. No application model change or holdout tuning." }, null, 2));
  console.log(JSON.stringify({ fixtureFile, fixtureSha256: sha(readFileSync(fixtureFile)), plannedCalls: Object.keys(runs).length }));
} else {
  const bytes = readFileSync(fixtureFile), fixture = JSON.parse(bytes), spec = fixture.runs[run];
  assert.deepEqual(codeHashes(spec.code === "before" ? beforeFrontend : frontend), fixture.code[spec.code]);
  const reportFile = path.join(out, `${run}.json`);
  assert.ok(!existsSync(reportFile));
  const plan = JSON.parse(readFileSync(path.join(out, "plan.json")));
  const runOrder = plan.order;
  for (const prior of runOrder.slice(0, runOrder.indexOf(run))) {
    assert.ok(existsSync(path.join(out, `${prior}.json`)), "Follow the frozen run order.");
    assert.ok(JSON.parse(readFileSync(path.join(out, `${prior}.json`))).completed, "Do not continue past a failed planned run.");
  }
  const budget = () => fetch("http://127.0.0.1:4319/budget").then(r => r.json());
  const before = await budget(); validatedBudgetLimit(before);
  assert.equal(before.proxyPhase, "refill-v1-development"); assert.equal(before.proxyPhaseBudgetUsd, 4);
  const report = { at: new Date().toISOString(), run, fixtureSha256: sha(bytes), scope: fixture.scope, model: spec.model, captureSha256: spec.captureSha256, budgetBefore: before, completed: false };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const start = performance.now();
  try { const outcome = await invoke(fixture, spec, false, spec.captured); report.result = outcome.result; report.rawModelResult = outcome.rawModelResult; report.holisticMs = outcome.holisticMs; report.completed = true; }
  catch (error) { report.error = error.message; report.rawModelResult = error.rawModelResult; report.holisticMs = error.holisticMs; report.failedCapturedPrompt = error.captured; }
  report.totalMs = performance.now() - start;
  report.budgetAfter = await budget();
  report.requests = report.budgetAfter.requests.filter(row => !before.requests.some(previous => previous.id === row.id));
  report.providersComplete = report.requests.length === 1 && report.requests.every(row => row.status === 200 && row.completion?.finishReasons?.every(reason => reason === "stop"));
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, completed: report.completed, totalMs: report.totalMs, requests: report.requests.length, providersComplete: report.providersComplete }));
  assert.ok(report.completed && report.providersComplete);
}
