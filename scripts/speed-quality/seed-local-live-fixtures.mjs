#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { validatedBudgetLimit } from "./budget.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const frontend = path.join(root, "apps/frontend");
const output = path.join(root, "output/speed-quality-2026-09-08/live-fixtures.json");
const addPdf = process.argv.includes("--add-pdf");
const addLarge = process.argv.includes("--add-large") || process.argv.includes("--add-large-explicit");
const largeFile = process.argv.includes("--add-large-explicit") ? "fixtures/large-explicit-tender-case.json" : "fixtures/large-tender-case.json";
if (addPdf && addLarge) throw new Error("Select one fixture addition.");
const append = addPdf || addLarge;
if (existsSync(output) && !append) throw new Error("Live fixtures already exist. Reuse their IDs; do not silently spend on reindexing.");
const env = JSON.parse(readFileSync(path.join(root, "output/speed-quality-2026-09-08/local-environment.json"), "utf8"));
if (env.DATA_API_URL !== "http://127.0.0.1:55440" || env.OPENAI_BASE_URL !== "http://127.0.0.1:4319/v1" || env.OPENAI_API_KEY !== "local-evaluation-proxy-only") throw new Error("Only the disposable local database and budget proxy are allowed.");
const budget = await fetch("http://127.0.0.1:4319/budget").then((r) => r.json());
validatedBudgetLimit(budget);
if (budget.remainingUsd < 5) throw new Error("Budget proxy unavailable or insufficient reserved headroom.");
Object.assign(process.env, env);
const require = createRequire(path.join(frontend, "package.json"));
const jiti = require("jiti").createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { encryptJson, encryptString } = jiti(path.join(frontend, "lib/server/crypto.ts"));
const { extractTextFromBuffer } = jiti(path.join(frontend, "lib/server/documents.ts"));
const { replaceProjectDocumentChunks } = jiti(path.join(frontend, "lib/server/document-chunks.ts"));
const { compileDocumentIntelligenceArtifact } = jiti(path.join(frontend, "lib/server/document-intelligence/evidence-compiler.ts"));
const { storeDocumentIntelligenceArtifact } = jiti(path.join(frontend, "lib/server/document-intelligence/repository.ts"));
async function db(route, method = "GET", body) {
  const response = await fetch(`${env.DATA_API_URL}/${route}`, { method, headers: { authorization: `Bearer ${env.DATA_API_SERVICE_ROLE_KEY}`, "content-type": "application/json", prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local fixture operation failed (${response.status}).`);
  return response.json();
}
const sourceFile = path.join(import.meta.dirname, "fixtures/tender-cases.json");
const fixture = JSON.parse(readFileSync(sourceFile, "utf8"));
const prepared = append ? JSON.parse(readFileSync(output, "utf8")) : { at: new Date().toISOString(), sourceSha256: createHash("sha256").update(readFileSync(sourceFile)).digest("hex"), seeding: "Direct local fixture publication, real parser/index/compiler/readiness RPC. Blob upload and metadata-inference pipeline are not exercised.", projects: [] };
const scenarios = addLarge ? JSON.parse(readFileSync(path.join(import.meta.dirname, largeFile), "utf8")).cases : addPdf ? [{ id: "nordic-pdf-large", split: "large-regression", customerName: "Fiktiv Nordic Retail Logistics AS", pdfPath: path.join(root, "test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf") }] : fixture.cases;
if (scenarios.some((scenario) => prepared.projects.some((p) => p.caseId === scenario.id))) throw new Error("Requested fixture already exists.");
// Freeze all source material before any baseline generation. Do not inspect the
// holdout's generated answers while tuning development prompts.
for (const scenario of scenarios) {
  const id = randomUUID();
  await db("projects", "POST", { id, owner_id: env.APP_ADMIN_PRINCIPAL_ID, client_name: scenario.customerName, title: scenario.customerName });
  const project = { caseId: scenario.id, split: scenario.split, id, scenarioSha256: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"), documents: [] };
  prepared.projects.push(project);
  writeFileSync(output, JSON.stringify(prepared, null, 2));
  for (const [role, text] of [["primary_customer_document", scenario.customerText], ["primary_solution_document", scenario.solutionText]]) {
    if (!text && (role !== "primary_customer_document" || !scenario.pdfPath)) continue;
    const documentId = randomUUID();
    const name = scenario.pdfPath ? path.basename(scenario.pdfPath) : `${scenario.id}-${role}.md`;
    const buffer = scenario.pdfPath ? readFileSync(scenario.pdfPath) : Buffer.from(text);
    const parseStarted = performance.now();
    const parsed = await extractTextFromBuffer({ buffer, fileName: name, role, useDocling: false });
    const parseMs = performance.now() - parseStarted;
    const row = (await db("documents", "POST", { id: documentId, project_id: id, role, title: role === "primary_customer_document" ? `${scenario.customerName} – konkurransegrunnlag` : `${scenario.customerName} – løsningsbeskrivelse`, display_name: name, file_name: name, file_format: parsed.fileFormat, content_type: parsed.contentType, file_size_bytes: buffer.length, file_base64: encryptString(buffer.toString("base64")), raw_text: encryptString(parsed.rawText), structure_map: encryptJson(parsed.sourceMap), processing_status: "processing", parser_used: parsed.parserUsed }))[0];
    const indexStarted = performance.now();
    await replaceProjectDocumentChunks({ documentId, projectId: id, role, title: row.title, fileName: name, fileFormat: parsed.fileFormat, rawText: parsed.rawText, structureMap: parsed.sourceMap, sourceRevision: row.chunk_source_revision });
    const indexMs = performance.now() - indexStarted;
    const compilationStarted = performance.now();
    const compiled = compileDocumentIntelligenceArtifact({ documentId, projectId: id, title: row.title, fileName: name, fileFormat: parsed.fileFormat, fileSizeBytes: buffer.length, sourceRevision: row.chunk_source_revision, parserUsed: parsed.parserUsed, rawText: parsed.rawText, structureMap: parsed.sourceMap, isHighImpactDocument: true, compiledAt: new Date().toISOString() });
    if (!await storeDocumentIntelligenceArtifact(compiled)) throw new Error("Compiled fixture context was not persisted.");
    const compileAndSaveMs = performance.now() - compilationStarted;
    await db("rpc/publish_document_readiness", "POST", { p_project_id: id, p_document_id: documentId, p_source_revision: row.chunk_source_revision, p_status: "enhanced_ready", p_message: "Lokalt frosset evalueringsgrunnlag", p_parser_used: parsed.parserUsed });
    project.documents.push({ id: documentId, role, sourceSha256: createHash("sha256").update(buffer).digest("hex"), sourceRevision: row.chunk_source_revision, parseMs, indexMs, compileAndSaveMs, chars: parsed.rawText.length });
    writeFileSync(output, JSON.stringify(prepared, null, 2));
  }
}
console.log(JSON.stringify(prepared.projects.map(({ caseId, id, documents }) => ({ caseId, id, documents: documents.map(({ role, parseMs, indexMs, compileAndSaveMs }) => ({ role, parseMs, indexMs, compileAndSaveMs })) })), null, 2));
