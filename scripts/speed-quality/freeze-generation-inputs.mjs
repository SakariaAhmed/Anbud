#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const dir = path.join(root, "output/speed-quality-2026-09-08");
const file = path.join(dir, "generation-inputs.json");
const appendLarge = process.argv.includes("--append-large") || process.argv.includes("--append-large-explicit");
const largeCase = process.argv.includes("--append-large-explicit") ? "sundvik-32-explicit-ids" : "sundvik-32-requirements";
if (existsSync(file) && !appendLarge) throw new Error("Frozen generation inputs already exist.");
const env = JSON.parse(readFileSync(path.join(dir, "local-environment.json"), "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_BASE_URL !== "http://127.0.0.1:4319/v1") throw new Error("Only local fixtures are allowed.");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null", "next/cache": path.join(import.meta.dirname, "next-cache-fixture.cjs") } });
const { getProjectDetail, listProjectDocumentsForAnalysis, listProjectServiceDescriptions, getProjectSourceRevision } = jiti(path.join(frontend, "lib/server/repositories/data-store.ts"));
const { selectProjectDocuments } = jiti(path.join(frontend, "lib/server/domain/project-documents.ts"));
const fixtures = JSON.parse(readFileSync(path.join(dir, "live-fixtures.json"), "utf8"));
const existing = appendLarge ? JSON.parse(readFileSync(file, "utf8")) : null;
const cases = existing?.cases ?? [];
for (const fixture of fixtures.projects.filter((p) => appendLarge ? p.caseId === largeCase : p.split !== "large-regression")) {
  if (cases.some((c) => c.caseId === fixture.caseId)) throw new Error("Case already frozen.");
  const sourceRevision = await getProjectSourceRevision(fixture.id);
  const [project, documents, serviceCandidates] = await Promise.all([getProjectDetail(fixture.id), listProjectDocumentsForAnalysis(fixture.id), listProjectServiceDescriptions(fixture.id, { includeDocumentAiSummaries: true })]);
  if (sourceRevision !== await getProjectSourceRevision(fixture.id)) throw new Error("Source changed while freezing.");
  const { customerDocument, solutionDocument, supportingDocuments } = selectProjectDocuments(documents);
  const input = { projectName: customerDocument.title, customerDocument, solutionDocument, supportingDocuments, customerAnalysis: project.customer_analysis, solutionEvaluation: project.solution_evaluation, serviceCandidates, knowledgeArtifacts: [], requirementDocuments: [customerDocument], sourceRevision };
  if (!input.customerAnalysis) throw new Error("A persisted baseline analysis is required.");
  cases.push({ caseId: fixture.caseId, split: fixture.split, projectId: fixture.id, sourceRevision, input, inputSha256: createHash("sha256").update(JSON.stringify(input)).digest("hex") });
}
writeFileSync(file, JSON.stringify({ at: existing?.at ?? new Date().toISOString(), appendedAt: existing ? new Date().toISOString() : undefined, sourceSha256: fixtures.sourceSha256, note: "Complete function arguments frozen from local persisted baseline. Supporting documents, analysis, service candidates, optional evaluation and knowledge choices are identical across variants. No generated holdout answers inspected while tuning.", cases }, null, 2));
console.log(JSON.stringify(cases.map(({ caseId, inputSha256, sourceRevision }) => ({ caseId, inputSha256, sourceRevision })), null, 2));
