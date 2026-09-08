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
  const complete = (run) => {
    const requests = run.budgetAfter.requests.filter((r) => run.requestIds.includes(r.id) && !r.model.startsWith("text-embedding-"));
    return run.completed && run.sourceUnchanged !== false && requests.length > 0 && requests.every((r) => r.status === 200 && (r.completion?.status === "completed" || r.completion?.finishReasons?.length > 0 && r.completion.finishReasons.every((reason) => reason === "stop")));
  };
  if (!complete(before) || !complete(after)) throw new Error("Incomplete generation evidence.");
  comparisons.push({ caseId: fixture.caseId, split: fixture.split, kind, beforeFile, afterFile, judgeFile, baselineMs: before.totalMs, candidateMs: after.totalMs, candidateFirstTextMs: after.firstTextMs, baselineCodeSha256: before.codeSha256, candidateCodeSha256: after.codeSha256, frozenInputMatched: true, providersCompleted: true, judgeModel: judge.judgeModel, judgeProtocol: judge.protocol ?? "full-fixture-mini-v1 (valid only for owners using both customer and supplier sources)", candidateContentNoninferior: judge.candidateContentNoninferior, candidateWinner: judge.candidateWinner, recordedSectionPreserved: judge.outsideSectionPreserved });
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
  generatedAt: new Date().toISOString(), applicationCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), goalCompleted: false,
  budget: { limitUsd: budget.limitUsd, accountingPolicy: budget.accountingPolicy, accountedUpperBoundUsd: costUpperBound, remainingUsd: budget.limitUsd - costUpperBound, requestCount: budget.requests.length, ledgerSha256: sha(readFileSync(path.join(dir, "api-budget.json"))) },
  limitations: ["Single generation per pair is not a p95 or causal latency regression test.", "Single blind Mini judge is advisory; source reviews have identified judge mistakes. Identical empty keyword/service lists do not demonstrate an improvement.", "The original full-fixture judge method gave 26 customer-only/derived-only operations unavailable sources. Those historical judgments are excluded here.", "Eight non-strategy section outputs predate the deterministic scope fix. The separate 18-row owner replay preserved all non-target fields and changed no target fields; it is not fresh provider execution.", "Full customer-analysis generation outputs predate the final removal of a 220-character postprocessing cut. Its regression is deterministic; no fresh full-analysis model run proves final end-to-end quality.", "All fixtures are fictional and local. Azure storage, Entra, populated service recommendations and broader concurrent production workloads are not verified by these runs."],
  generationComparisons: comparisons, sectionScopeReplay: read("section-preservation-owner-correction-v1.json"), rawEvidenceRoot: "output/speed-quality-2026-09-08 (local, gitignored)", rawFiles,
};
writeFileSync(output, JSON.stringify(index, null, 2));
console.log(JSON.stringify({ file: output, pairedGenerations: comparisons.length, contentNoninferior: comparisons.filter((r) => r.candidateContentNoninferior).length, winners: comparisons.filter((r) => r.candidateWinner).length, rawFileCount: rawFiles.length, rawBytes: rawFiles.reduce((sum, f) => sum + f.bytes, 0) }));
