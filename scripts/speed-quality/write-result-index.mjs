import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { analysisSectionKinds, assertComparableInputs } from "./generation-input.mjs";
import { accountedCostUpperBound } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const output = path.join(root, "docs/speed-quality-2026-09-08-evidence.json");
if (existsSync(output) && !process.argv.includes("--refresh")) throw new Error("Review the existing evidence index before explicitly refreshing this derived report with --refresh.");
const read = (file) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const frozen = read("generation-inputs.json");
const corrected = new Set(["section_strategy", "high_level_design", "chat", "forbedret_kravsvar", "losningsutkast", "gjennomforing_og_risiko"]);
const scoped = new Set(["customer_analysis", "customer_analysis_v3", "high_level_design", "executive_summary", ...analysisSectionKinds]);
const kinds = ["customer_analysis", "customer_analysis_v3", ...analysisSectionKinds, "high_level_design", "solution_evaluation", "executive_summary", "chat", "bilag1_rekonstruksjon", "forbedret_kravsvar", "losningsutkast", "tilbudsstrategi", "verdiargumentasjon", "anbefalt_arkitektur", "gjennomforing_og_risiko"];
const budget = read("api-budget.json");
const costUpperBound = budget.requests.reduce((sum, row) => sum + accountedCostUpperBound(row), 0);
const comparisons = [];
const complete = (run) => {
  const requests = run.budgetAfter.requests.filter((r) => run.requestIds.includes(r.id) && !r.model.startsWith("text-embedding-"));
  return run.completed && run.sourceUnchanged !== false && requests.length > 0 && requests.every((r) => r.status === 200 && (r.completion?.status === "completed" || r.completion?.finishReasons?.length > 0 && r.completion.finishReasons.every((reason) => reason === "stop")));
};
for (const fixture of frozen.cases.filter((c) => c.split !== "large-regression")) for (const kind of kinds) {
  const baselineLabel = kind === "customer_analysis" ? "baseline-function" : kind === "solution_evaluation" ? "baseline16k" : analysisSectionKinds.includes(kind) && kind !== "section_summary" ? "baseline-sections" : "baseline";
  const candidateLabel = corrected.has(kind) ? "quality-final-corrections-v1" : "quality-expanded-v1";
  const beforeFile = `matrix-${baselineLabel}-${fixture.caseId}-${kind}.json`;
  const afterFile = `matrix-${candidateLabel}-${fixture.caseId}-${kind}.json`;
  const before = read(beforeFile); const after = read(afterFile);
  const evaluation = kind === "executive_summary" ? read(`matrix-baseline16k-${fixture.caseId}-solution_evaluation.json`).result : undefined;
  assertComparableInputs({ fixture, kind, before, after, evaluation });
  const judgeFile = `judge-quality-${scoped.has(kind) ? "task-sources-v2-" : ""}mini-${candidateLabel}-${fixture.caseId}-${kind}.json`;
  const judge = read(judgeFile);
  if (judge.finishReason !== "stop") throw new Error("Missing completed comparison.");
  if (!complete(before) || !complete(after)) throw new Error("Incomplete generation evidence.");
  comparisons.push({ caseId: fixture.caseId, split: fixture.split, kind, beforeFile, afterFile, judgeFile, baselineMs: before.totalMs, candidateMs: after.totalMs, candidateFirstTextMs: after.firstTextMs, baselineCodeSha256: before.codeSha256, candidateCodeSha256: after.codeSha256, frozenInputMatched: true, providersCompleted: true, judgeModel: judge.judgeModel, judgeProtocol: judge.protocol ?? "full-fixture-mini-v1 (valid only for owners using both customer and supplier sources)", candidateContentNoninferior: judge.candidateContentNoninferior, candidateWinner: judge.candidateWinner, recordedSectionPreserved: judge.outsideSectionPreserved });
}
// Additional runs with recorded code versions remain separate from the original 44-pair
// matrix. Never silently replace earlier outcomes with a preferred repetition.
const additionalGenerationComparisons = [];
for (const judgeFile of readdirSync(dir).filter((name) => /^judge-quality-task-sources-v2-mini-final-(standard-v[345]|fast-v4|services-v5)-.+\.json$/.test(name)).sort()) {
  const judge = read(judgeFile);
  const inputFixtureFile = judge.inputFixtureFile ?? "generation-inputs.json";
  if (!/^generation-inputs(?:-[a-z0-9-]+)?\.json$/.test(inputFixtureFile)) throw new Error("Invalid supplemental frozen-input file.");
  const fixture = read(inputFixtureFile).cases.find((c) => c.caseId === judge.caseId);
  if (!fixture || judge.finishReason !== "stop") throw new Error("Incomplete final-code comparison.");
  const beforeFile = `matrix-${judge.baselineLabel}-${judge.caseId}-${judge.kind}.json`;
  const afterFile = `matrix-${judge.candidateLabel}-${judge.caseId}-${judge.kind}.json`;
  const before = read(beforeFile); const after = read(afterFile);
  assertComparableInputs({ fixture, kind: judge.kind, before, after });
  if (!complete(before) || !complete(after)) throw new Error("Incomplete final-code generation.");
  additionalGenerationComparisons.push({ caseId: fixture.caseId, split: fixture.split, kind: judge.kind, inputFixtureFile, beforeFile, afterFile, judgeFile, baselineMs: before.totalMs, candidateMs: after.totalMs, candidateRequestedServiceTier: after.requestedServiceTier, candidateCodeSha256: after.codeSha256, frozenInputMatched: true, providersCompleted: true, candidateContentNoninferior: judge.candidateContentNoninferior, candidateWinner: judge.candidateWinner, outsideSectionPreserved: judge.outsideSectionPreserved });
}
const rawFiles = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "local-environment.json" || /\.(?:lock|tmp|tar\.gz)$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) rawFiles.push({ path: path.relative(dir, file), bytes: statSync(file).size, sha256: sha(readFileSync(file)) });
  }
}
walk(dir);
const index = {
  generatedAt: new Date().toISOString(), repositoryCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), applicationCommit: execFileSync("git", ["log", "-1", "--format=%H", "--", "apps/frontend"], { cwd: root, encoding: "utf8" }).trim(), goalCompleted: false,
  budget: { limitUsd: budget.limitUsd, accountingPolicy: budget.accountingPolicy, accountedUpperBoundUsd: costUpperBound, remainingUsd: budget.limitUsd - costUpperBound, requestCount: budget.requests.length, ledgerSha256: sha(readFileSync(path.join(dir, "api-budget.json"))) },
  limitations: ["Single generation per pair is not a p95 or causal latency regression test. Additional repetitions never replace the original 44-pair matrix.", "Single blind Mini judge is advisory. The V5 development V3 adjudication refutes three missing-detail claims without changing the original verdict or establishing an overall winner.", "The original full-fixture judge method gave 26 customer-only/derived-only operations unavailable sources. Those historical judgments are excluded here.", "Eight non-strategy section outputs predate the deterministic scope fix. The separate 18-row owner replay preserved all non-target fields and changed no target fields; it is not fresh provider execution.", "Fresh V5 legacy/V3/HLD runs exercise application commit 07b51e3e. V3/V4 and original matrix outputs retain their actual older code hashes.", "The supplemental populated-service inputs change only serviceCandidates. Both development outputs select the two relevant services; both holdout outputs select none. This is not end-to-end AI integration with persisted service documents or evidence of improved holdout recommendations.", "Historical read/write seeding incorrectly encrypted plaintext content_markdown. Use plaintext-v3 semantic read, write and generation-context evidence for representative plaintext performance. Earlier runs are preserved, not promoted as equivalent evidence.", "Export plaintext-v4 is 30-pair plaintext/list performance; malformed fixture table rows render as pipe text. Table-functional-v6 is separate single-pair functional evidence with a real table, not p95. HTML .doc is not native Word verification.", "All fixtures are fictional and local. Azure storage, Entra, complete perfect_system_solution and broader concurrent production workloads remain unverified. Full-pair conservative output reservations alone exceed the remaining API budget."],
  currentFreeEvidence: { reads: "http-quiet-plaintext-v3-semantic-control-pairs.json", writes: "http-artifact-write-comparison-plaintext-v3.json", context: "generation-context-comparison-plaintext-v3.json", exportPerformance: "verification/browser-exports-plaintext-v4/checks.json", exportTable: "verification/browser-exports-table-functional-v6/checks.json", judgeAdjudication: "verification/development-v3-judge-adjudication-v5.json", perfectWorkflowBudgetPreflight: "verification/perfect-workflow-budget-preflight-v5.json" },
  subsequentReadImprovement: { applicationCommit: "b65a512f", ownerReport: "project-schema-read-only-v2.json", ownerBaseline: "820bb84a", httpReport: "http-quiet-project-schema-v7-control-pairs.json", httpBaseline: "3779e6f2", methodClarification: "verification/project-schema-v7/method-clarification.json", scope: "Metadata reads only; AI-generation evidence keeps its actual earlier code versions. Owner cache is bypassed on both sides. The 120 HTTP pairs verify the new build; the earlier 780-pair series predates this metadata fix." },
  subsequentStorageImprovement: { applicationCommit: "29fb7689", pairedReport: "storage-delete-paired.json", beforeReport: "storage-delete-before.json", verification: "verification/storage-delete-v8/scope.json", scope: "Actual storage adapter with an injected in-memory SDK and simulated 10 ms per delete. Thirty pairs each for 1/24 files; not measured Azure or complete project-deletion latency. No paid calls." },
  subsequentWorkerLeaseVerification: { applicationCommit: "29fb7689", verification: "verification/worker-lease-transport-v3/checks.json", sourceAndScope: "verification/worker-lease-transport-v3/source-and-scope.json", priorRuns: ["verification/worker-lease-transport-v1/checks.json", "verification/worker-lease-transport-v2/checks.json"], scope: "Actual local queue, claim, workflow, normal 30-second heartbeat, PostgREST and OpenAI SDK HTTP transport. Lease takeover stopped the worker and closed the deliberately stalled local response before cleanup; stale renewal matched zero rows and no outputs were persisted. V2 failed only its incorrect expectation of HTTP 200 instead of singular zero-row 406/PGRST116. No application change, new speed claim, paid call, route-authentication test or user-cancel operation." },
  environmentAvailabilityEvidence: { verification: "verification/azure-visible-resource-inventory-v1.json", scope: "Parent task's normalized summary of read-only Azure CLI outputs, not a raw transcript. Two visible subscriptions; case-sensitive anbud/bidsite resource-group filter found only anbud-prod with ten resources. No separate test resource identified in this scope. Logical databases, other group names, access and tenants were not inspected. No production mutations or paid model calls." },
  additionalJudgePreflight: { verification: "verification/judge-preflight-gpt54-v1-total.json", scope: "Offline exact preparation of two GPT-5.4 judges for already stored V5 Fjord V3 and Kyst legacy pairs. Both match the existing Mini payloads except model, cost 0.327356 USD at full conservative reservation and fit the unchanged ledger. Preflight is not paid execution, a verdict, new generation or complete quality acceptance." },
  generationComparisons: comparisons, additionalGenerationComparisons, sectionScopeReplay: read("section-preservation-owner-correction-v1.json"), rawEvidenceRoot: "output/speed-quality-2026-09-08 (local, gitignored)", rawFiles,
};
writeFileSync(output, JSON.stringify(index, null, 2));
console.log(JSON.stringify({ file: output, pairedGenerations: comparisons.length, contentNoninferior: comparisons.filter((r) => r.candidateContentNoninferior).length, winners: comparisons.filter((r) => r.candidateWinner).length, rawFileCount: rawFiles.length, rawBytes: rawFiles.reduce((sum, f) => sum + f.bytes, 0) }));
