#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { frozenInvocation, analysisSectionKinds } from "./generation-input.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const installedFrontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const code = option("code", "candidate");
if (!["candidate", "baseline"].includes(code)) throw new Error("Unknown implementation.");
let frontend = installedFrontend;
if (code === "baseline") {
  const baselineRoot = "/tmp/anbud-speed-quality-baseline-3779e6f2";
  frontend = path.join(baselineRoot, "apps/frontend");
  if (!existsSync(frontend)) {
    mkdirSync(baselineRoot, { recursive: true });
    execFileSync("tar", ["-xf", "-", "-C", baselineRoot], { input: execFileSync("git", ["archive", "3779e6f2", "apps/frontend/lib"], { cwd: root, maxBuffer: 30e6 }) });
    symlinkSync(path.join(installedFrontend, "node_modules"), path.join(frontend, "node_modules"));
  }
}
const label = option("label", "baseline");
const split = option("split", "development");
const selectedCase = option("case", "");
const model = option("model", "");
const batchSize = option("batch-size", "");
const minimumReserve = Number(option("min-reserve", "0.8"));
if (!Number.isFinite(minimumReserve) || minimumReserve < 0.1 || minimumReserve > 2.5) throw new Error("Invalid final evaluation reserve.");
if (batchSize && (!/^\d+$/.test(batchSize) || Number(batchSize) < 1 || Number(batchSize) > 48)) throw new Error("Invalid bounded batch-size experiment.");
if (model && !["gpt-5.4", "gpt-5.4-mini", "gpt-5.6-terra", "gpt-5.6-luna"].includes(model)) throw new Error("Unpriced model trial.");
const evaluationLabel = option("evaluation-label", "baseline16k");
if (!/^[a-z0-9_-]+$/.test(evaluationLabel)) throw new Error("Invalid baseline evaluation label.");
const kinds = option("kinds", "high_level_design,losningsutkast,tilbudsstrategi,verdiargumentasjon,anbefalt_arkitektur,gjennomforing_og_risiko").split(",");
const allowed = ["customer_analysis", "customer_analysis_v3", ...analysisSectionKinds, "high_level_design", "solution_evaluation", "executive_summary", "chat", "bilag1_rekonstruksjon", "forbedret_kravsvar", "losningsutkast", "tilbudsstrategi", "verdiargumentasjon", "anbefalt_arkitektur", "gjennomforing_og_risiko"];
if (!/^[a-z0-9_-]+$/.test(label) || kinds.some((k) => !allowed.includes(k))) throw new Error("Invalid matrix configuration.");
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json"), "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_BASE_URL !== "http://127.0.0.1:4319/v1" || env.OPENAI_API_KEY !== "local-evaluation-proxy-only") throw new Error("Only local fixtures and the budget proxy are allowed.");
Object.assign(process.env, env);
if (batchSize) process.env.REQUIREMENT_RESPONSE_BATCH_SIZE = batchSize;
const require = createRequire(path.join(installedFrontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const ai = jiti(path.join(frontend, "lib/server/ai.ts"));
const { generateExecutiveSummary } = jiti(path.join(frontend, "lib/server/ai/executive-summary.ts"));
const { streamProjectChat } = jiti(path.join(frontend, "lib/server/ai/project-chat.ts"));
const { getProjectSourceRevision } = jiti(path.join(frontend, "lib/server/repositories/data-store.ts"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sources = execFileSync("rg", ["--files", "lib/server/ai", "lib/server/prompts", "lib/server/requirements", "lib/server/document-intelligence"], { cwd: frontend, encoding: "utf8" }).trim().split("\n").filter((f) => /\.ts$/.test(f)).concat(["lib/server/ai.ts", "lib/server/prompts.ts", "lib/server/document-chunks.ts"]).sort();
const codeSha256 = sha(JSON.stringify(sources.map((f) => [f, sha(readFileSync(path.join(frontend, f)))])));
const frozen = JSON.parse(readFileSync(path.join(dir, "generation-inputs.json"), "utf8"));
const cases = frozen.cases.filter((c) => (!selectedCase || c.caseId === selectedCase) && (split === "all" || c.split === split || (split === "small" && c.split !== "large-regression")));
if (!cases.length) throw new Error("No frozen cases selected.");
// Sequential runs isolate per-generation latency. Separate autorun experiments
// measure concurrency. Each provider retry still reserves its own cost.
for (const fixture of cases) for (const kind of kinds) {
  const file = path.join(dir, `matrix-${label}-${fixture.caseId}-${kind}.json`);
  if (existsSync(file)) throw new Error("Output exists: choose an explicit new run label.");
  if (sha(JSON.stringify(fixture.input)) !== fixture.inputSha256) throw new Error("Frozen input was modified.");
  if (await getProjectSourceRevision(fixture.projectId) !== fixture.sourceRevision) throw new Error("Persisted retrieval source changed.");
  const budgetBefore = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
  // Baseline trials are finished. Retain a bounded final judge reserve while
  // the proxy independently enforces the unchanged USD 14 aggregate ceiling.
  if (budgetBefore.remainingUsd < minimumReserve) throw new Error("Preserve final-evaluation budget headroom.");
  process.env.DOCUMENT_ANALYSIS_VERSION = kind === "customer_analysis_v3" ? "v3" : "off";
  const evaluation = kind === "executive_summary" ? JSON.parse(readFileSync(path.join(dir, `matrix-${evaluationLabel}-${fixture.caseId}-solution_evaluation.json`), "utf8")).result : undefined;
  const invocation = frozenInvocation(fixture, kind, { model, evaluation });
  const evidenceInput = { ...invocation }; delete evidenceInput.model;
  const report = { evidenceInputSha256: sha(JSON.stringify(evidenceInput)), modelOverride: model || undefined, evaluationLabel: kind === "executive_summary" ? evaluationLabel : undefined, at: new Date().toISOString(), label, caseId: fixture.caseId, split: fixture.split, kind, code, baselineRevision: code === "baseline" ? "3779e6f2" : undefined, codeSha256, fullInputSha256: sha(JSON.stringify(invocation)), effectiveConfig: { DOCUMENT_ANALYSIS_VERSION: process.env.DOCUMENT_ANALYSIS_VERSION, OPENAI_MODEL: process.env.OPENAI_MODEL, OPENAI_DOCUMENT_ANALYSIS_MODEL: process.env.OPENAI_DOCUMENT_ANALYSIS_MODEL, OPENAI_REQUIREMENT_RESPONSE_MODEL: process.env.OPENAI_REQUIREMENT_RESPONSE_MODEL ?? (code === "baseline" ? "not-supported" : "gpt-5.6-luna (single-batch default)"), REQUIREMENT_RESPONSE_BATCH_SIZE: process.env.REQUIREMENT_RESPONSE_BATCH_SIZE ?? (code === "baseline" ? "24 (default)" : "12 (default)"), LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE: process.env.LARGE_REQUIREMENT_RESPONSE_BATCH_SIZE ?? "28 (default)", REQUIREMENT_RESPONSE_BATCH_CONCURRENCY: process.env.REQUIREMENT_RESPONSE_BATCH_CONCURRENCY ?? "4 (default)", RAG_QUERY_REWRITE: process.env.RAG_QUERY_REWRITE ?? "adaptive (default)" }, budgetBefore, boundary: "Actual generation function, frozen full inputs and real local retrieval/index. Excludes job queue, route auth, persistence and browser rendering." };
  writeFileSync(file, JSON.stringify(report, null, 2));
  report.requestedServiceTier = budgetBefore.proxyServiceTier ?? "default";
  report.batchSizeOverride = batchSize ? Number(batchSize) : undefined;
  const started = performance.now();
  try {
    if (kind === "customer_analysis" || kind === "customer_analysis_v3") {
      report.result = await ai.analyzeCustomerDocuments(invocation);
    } else if (analysisSectionKinds.includes(kind)) report.result = await ai.regenerateCustomerAnalysisSection(invocation);
    else if (kind === "high_level_design") report.result = await ai.generateHighLevelDesign(invocation);
    else if (kind === "solution_evaluation") report.result = await ai.evaluateSolutionDocument(invocation);
    else if (kind === "executive_summary") report.result = await generateExecutiveSummary(invocation);
    else if (kind === "chat") {
      const stream = await streamProjectChat(invocation);
      report.result = "";
      // streamProjectChat returns a Web stream of text plus its source references.
      report.sources = stream.sourceReferences;
      report.retrievalPlan = stream.retrievalPlan;
      report.retrievalTelemetry = stream.retrievalTelemetry;
      for await (const chunk of stream.stream) { if (chunk) report.firstTextMs ??= performance.now() - started; report.result += chunk; }
    } else report.result = await ai.generateProjectArtifact(invocation);
    report.completed = true;
  } catch (error) {
    report.completed = false;
    report.error = error instanceof Error ? error.message : "Generation failed";
  }
  report.totalMs = performance.now() - started;
  report.budgetAfter = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
  const previous = new Set(report.budgetBefore.requests.map((r) => r.id));
  report.requestIds = report.budgetAfter.requests.filter((r) => !previous.has(r.id)).map((r) => r.id);
  const requests = report.budgetAfter.requests.filter((r) => report.requestIds.includes(r.id) && !r.model.startsWith("text-embedding-"));
  report.providerOutcomes = requests.map(({ id, model, status, completion, requestedServiceTier, returnedServiceTier }) => ({ id, model, status, completion, requestedServiceTier, returnedServiceTier }));
  report.allProviderOutputsComplete = requests.every((r) => r.status === 200 && (r.completion?.status === "completed" || (r.completion?.finishReasons?.length && r.completion.finishReasons.every((reason) => reason === "stop"))));
  report.providerFailureOrIncomplete = requests.some((r) => r.status !== 200 || r.completion?.status === "incomplete" || r.completion?.finishReasons?.includes("length"));
  // Provider stop does not rule out schema/coverage retries inside the app.
  // Keep the generation owner's repair metadata, and preserve function errors.
  const requirementMetadata = report.result?.generation_metadata?.requirement_response;
  if (requirementMetadata) report.requirementResponseRepairs = Object.fromEntries(
    Object.entries(requirementMetadata).filter(([key, value]) => /failed|fallback|repair|manual_review/.test(key) && (typeof value === "number" || typeof value === "boolean")),
  );
  report.sourceUnchanged = await getProjectSourceRevision(fixture.projectId) === fixture.sourceRevision;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ caseId: fixture.caseId, kind, completed: report.completed, totalMs: report.totalMs, requestCount: report.requestIds.length, reservedUsd: report.budgetAfter.reservedUsd - report.budgetBefore.reservedUsd, error: report.error }));
  if (!report.completed || !report.sourceUnchanged || !report.allProviderOutputsComplete) process.exit(1);
}
