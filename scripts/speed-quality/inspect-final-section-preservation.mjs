import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { analysisSectionKinds, frozenInvocation, hashInput } from "./generation-input.mjs";
import { inspectSectionEvidence } from "./section-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const label = process.argv.find((arg) => arg.startsWith("--label="))?.slice(8);
if (!label || !/^[a-z0-9_-]+$/.test(label)) throw new Error("An explicit unique report label is required.");
const output = path.join(dir, `section-preservation-${label}.json`);
if (existsSync(output)) throw new Error("Report already exists.");
const frontend = path.join(root, "apps/frontend");
const directory = mkdtempSync(path.join(tmpdir(), "anbud-section-replay-"));
const fetchBefore = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Network is forbidden in this replay."); };
globalThis.__sectionScopeReplay = {};
try {
  const contextFile = path.join(directory, "context.cjs");
  const completionFile = path.join(directory, "completion.cjs");
  writeFileSync(contextFile, `exports.resolveCustomerAnalysisContexts = async ({documents}) => ({contexts:new Map(documents.map(d=>[d.id,{analysisContext:d.raw_text}]))});`);
  writeFileSync(completionFile, `exports.runStructuredJsonResponse = async () => structuredClone(globalThis.__sectionScopeReplay.patch);`);
  const jiti = createRequire(path.join(frontend, "package.json"))("jiti").createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@/lib/server/document-intelligence/customer-analysis-contexts": contextFile,
    "@/lib/server/ai/json-completion": completionFile,
    "@": frontend, "server-only": "/dev/null",
  } });
  const { regenerateCustomerAnalysisSection } = jiti(path.join(frontend, "lib/server/ai.ts"));
  const { customerAnalysisRegenerationContract } = jiti(path.join(frontend, "lib/server/document-intelligence/customer-analysis-fields.ts"));
  const { getCustomerAnalysisSectionSnapshot } = jiti(path.join(frontend, "lib/customer-analysis-history.ts"));
  const frozen = JSON.parse(readFileSync(path.join(dir, "generation-inputs.json"), "utf8"));
  const report = { at: new Date().toISOString(), label, boundary: "Offline execution of the actual current section regenerator with previously paid normalized target fields substituted at the structured-completion boundary. Not raw-provider replay, fresh AI quality evidence, or an end-to-end timing. Network disabled. Reports hashes/field names only for holdout.", rows: [] };
  for (const fixture of frozen.cases.filter((c) => c.split !== "large-regression")) for (const kind of analysisSectionKinds) {
    const sourceLabel = kind === "section_strategy" ? "quality-final-corrections-v1" : "quality-expanded-v1";
    const sourceFile = path.join(dir, `matrix-${sourceLabel}-${fixture.caseId}-${kind}.json`);
    const source = JSON.parse(readFileSync(sourceFile, "utf8"));
    if (!source.completed || !source.allProviderOutputsComplete || !source.sourceUnchanged) throw new Error("Replay requires a completed paid source.");
    const input = frozenInvocation(fixture, kind);
    const fields = customerAnalysisRegenerationContract(input.section).fields;
    const resultFields = Object.keys(getCustomerAnalysisSectionSnapshot(input.customerAnalysis, input.section));
    globalThis.__sectionScopeReplay.patch = Object.fromEntries(fields.map((field) => [field, source.result[field]]));
    const original = structuredClone(input);
    const result = await regenerateCustomerAnalysisSection(input);
    const inspected = inspectSectionEvidence(input.customerAnalysis, result, fields, resultFields);
    report.rows.push({ caseId: fixture.caseId, kind, sourceFile: path.basename(sourceFile), sourceSha256: hashInput(source), sourceCodeSha256: source.codeSha256, changedOutsideSection: inspected.changedOutsideSection, changedTargetFields: fields.filter((field) => !isDeepStrictEqual(result[field], source.result[field])), callerInputPreserved: isDeepStrictEqual(input, original), sourceResultSha256: hashInput(source.result), replayResultSha256: hashInput(result) });
  }
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ file: output, rows: report.rows.length, outsideFailures: report.rows.filter((r) => r.changedOutsideSection.length || !r.callerInputPreserved), targetChanges: report.rows.filter((r) => r.changedTargetFields.length) }, null, 2));
  if (report.rows.some((r) => r.changedOutsideSection.length || !r.callerInputPreserved)) process.exitCode = 1;
} finally {
  globalThis.fetch = fetchBefore;
  delete globalThis.__sectionScopeReplay;
  rmSync(directory, { recursive: true, force: true });
}
