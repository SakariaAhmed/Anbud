#!/usr/bin/env node
// Retrieval eval over the checked-in complex tender corpus. Every case names
// the requirement passage that answers it:
//   - ID lookups: "Hva krever NORD-IAM-02?" for each of the 60 requirements.
//   - Conceptual questions without IDs from test-data/rag-retrieval.
// All ten documents are searched together, so the other projects' passages
// act as distractors.
//
// Modes (no paid model calls unless --embeddings=live or --rerank=model):
//   default            Chat's retrieval request (buildProjectChatRetrievalRequest)
//                      run in process, as without chunk storage: the app's
//                      chunker, lexical ranking, sections and broader retry.
//   --database-url U   Also measures the keyword half of hybrid search on a
//                      disposable PostgreSQL database created on U: the old
//                      whole-question query against the new keyword query.
//   --embeddings=live  Retrieval as chat runs it with stored chunks: the app
//                      embeds and stores every chunk in a disposable database
//                      on --database-url, and each question runs the deployed
//                      hybrid_match_document_chunks (vector and keyword).
//                      Needs OPENAI_API_KEY; paid (embeddings only, cents).
//   --frontend-root P  Runs another checkout's retrieval code (e.g. main) for
//                      a before/after comparison.
//   --rerank=model     Adds the model reranker (needs OPENAI_API_KEY; paid).
//   --without-structure Drops the parser's structure map, as for a document
//                      whose text has no usable structure; chunk size then
//                      decides what each embedding and passage covers.
//   --output F         Writes the per-case results for scripts/rag_eval.mjs.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreRetrievalCases } from "./rag_eval.mjs";
import { evaluateRetrievalGate } from "./rag_retrieval_gate.mjs";

// Keep stdout machine-readable; application telemetry belongs on stderr.
console.log = (...values) => console.error(...values);
console.info = (...values) => console.error(...values);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const frontendRoot = path.resolve(option("--frontend-root") ?? path.join(repositoryRoot, "apps/frontend"));
const databaseUrl = option("--database-url");
const outputPath = option("--output");
const useModelRerank = option("--rerank") === "model";
const useLiveEmbeddings = option("--embeddings") === "live";
const withoutStructure = args.includes("--without-structure");
if ((useModelRerank || useLiveEmbeddings) && !process.env.OPENAI_API_KEY) {
  throw new Error("--rerank=model and --embeddings=live need OPENAI_API_KEY.");
}
if (useLiveEmbeddings && !databaseUrl) {
  throw new Error("--embeddings=live needs --database-url for a disposable database.");
}

const corpusRoot = path.join(repositoryRoot, "output/pdf/complex-tender-corpus");
const manifest = JSON.parse(readFileSync(path.join(corpusRoot, "manifest.json"), "utf8"));
const conceptual = JSON.parse(readFileSync(path.join(repositoryRoot, "test-data/rag-retrieval/conceptual-questions.json"), "utf8"));
const heldOut = JSON.parse(readFileSync(path.join(repositoryRoot, "test-data/rag-retrieval/held-out-questions.json"), "utf8"));

const scratch = mkdtempSync(path.join(tmpdir(), "anbud-rag-eval-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// Chunk storage is reported missing so retrieval runs in process, as it does
// for a source whose stored chunks are stale.
const unavailableDataApi = path.join(scratch, "data-api.cjs");
writeFileSync(unavailableDataApi, `
const missing = { message: "Could not find the table 'public.document_chunks' in the schema cache" };
exports.createServiceClient = () => ({
  from: () => ({ select: () => ({ limit: async () => ({ data: null, error: missing }), in: async () => ({ data: null, error: missing }) }) }),
  rpc: async () => ({ data: null, error: missing }),
});`);
process.env.APP_ENCRYPTION_KEY ??= "rag-retrieval-eval-encryption-key";
if (!useModelRerank && !useLiveEmbeddings) delete process.env.OPENAI_API_KEY;

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const load = (aliases = {}, moduleCache = false) => createJiti(path.join(scratch, "eval.cjs"), {
  interopDefault: true,
  fsCache: false,
  moduleCache,
  alias: { ...aliases, "@": frontendRoot, "server-only": "/dev/null" },
});
const app = load({ "@/lib/server/data-api": useLiveEmbeddings
  ? path.join(repositoryRoot, "scripts/rag_retrieval_eval_store.cjs")
  : unavailableDataApi });
const { retrieveDocumentSnippetsWithMetadata, buildKeywordSearchQuery, replaceProjectDocumentChunks } = app(path.join(frontendRoot, "lib/server/document-chunks.ts"));
const { extractTextFromBuffer } = app(path.join(frontendRoot, "lib/server/documents.ts"));
const { extractExactRetrievalTerms } = app(path.join(frontendRoot, "lib/server/ai/retrieval-query.ts"));
// Chat's own request (query plan, exact terms, broader retry, sections and
// reranker). The plan is built without a model call: a first question with
// no history is not rewritten. A checkout without the builder gets the
// question as its query. Chat skips the reranker when the whole documents fit
// in its prompt; the eval measures the case where they do not.
process.env.RAG_QUERY_REWRITE = "off";
process.env.RAG_MODEL_RERANK = useModelRerank ? "on" : "off";
const { buildProjectChatRetrievalRequest } = app(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
const retrievalRequest = async (question) => buildProjectChatRetrievalRequest
  ? (await buildProjectChatRetrievalRequest({
      question, recentMessages: [], customerDocument: documents[0], solutionDocument: documents[1],
      supportingDocuments: documents.slice(2),
    })).request
  : { query: question, projectId, documents, exactTerms: extractExactRetrievalTerms(question), limit: 12 };

// Stored chunk rows need UUIDs for the document and project filters.
const projectId = "00000000-0000-4000-8000-000000000001";
const documentUuid = (index) => `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
const documents = [];
for (const [index, entry] of manifest.documents.entries()) {
  const parsed = await extractTextFromBuffer({
    buffer: readFileSync(path.join(corpusRoot, entry.text_filename)),
    fileName: entry.text_filename,
    contentType: "text/plain",
    role: entry.role,
  });
  documents.push({
    id: documentUuid(index),
    project_id: projectId,
    role: entry.role,
    supporting_subtype: null,
    title: `${entry.project_name} - ${entry.role === "primary_customer_document" ? "Bilag 1" : "Bilag 2"}`,
    file_name: entry.text_filename,
    file_format: "txt",
    raw_text: parsed.rawText,
    structure_map: withoutStructure ? [] : parsed.sourceMap,
    chunk_source_revision: 0,
  });
}

const requirements = new Map();
for (const scenario of new Set(manifest.documents.map((entry) => entry.scenario_id))) {
  const fasit = JSON.parse(readFileSync(path.join(corpusRoot, `${scenario}_fasit.json`), "utf8"));
  for (const requirement of fasit.requirements) requirements.set(requirement.id, { ...requirement, scenario });
}
// The passage must contain the requirement text itself, not only its ID.
const expectation = (requirementId) => {
  const requirement = requirements.get(requirementId);
  if (!requirement) throw new Error(`Ukjent krav i eval: ${requirementId}`);
  return { expected_requirement_id: requirementId, expected_texts: [requirement.text.slice(0, 70)] };
};
const cases = [
  ...[...requirements.keys()].map((id) => ({ kind: "id_lookup", question: `Hva krever ${id}?`, ...expectation(id) })),
  ...conceptual.questions.map((item) => ({ kind: "conceptual", question: item.question, ...expectation(item.expected_requirement_id) })),
  ...heldOut.questions.map((item) => ({ kind: "held_out", question: item.question, ...expectation(item.expected_requirement_id) })),
];

// Result count of the keyword-search measurement; chat sets its own.
const limit = 12;
const live = useLiveEmbeddings ? await storeChunksWithLiveEmbeddings() : null;
const results = [];
// The disposable database goes even when a case throws.
try {
  for (const item of cases) await runCase(item);
} finally {
  live?.drop();
}

async function runCase(item) {
  const startedAt = Date.now();
  const request = await retrievalRequest(item.question);
  const retrieval = await retrieveDocumentSnippetsWithMetadata(request);
  results.push({
    ...item,
    retrieval_latency_ms: Date.now() - startedAt,
    used_hybrid_search: retrieval.telemetry.usedHybridSearch,
    used_broadened_search: retrieval.telemetry.usedBroadenedSearch ?? false,
    used_model_rerank: retrieval.telemetry.usedModelRerank ?? false,
    context_chars_top5: retrieval.snippets.slice(0, 5).reduce((sum, snippet) => sum + snippet.text.length, 0),
    retrieved: retrieval.snippets.map((snippet) => ({
      source_id: snippet.sourceId,
      document_title: snippet.documentTitle,
      reference: snippet.reference,
      heading_path: snippet.headingPath,
      text: snippet.text,
    })),
  });
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => typeof value === "number").sort((left, right) => left - right);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : 0;
}

function summary(rows) {
  const report = scoreRetrievalCases(rows);
  return {
    cases: report.cases,
    recall_at_1: rows.filter((row) => scoreRetrievalCases([{ ...row, retrieved: row.retrieved.slice(0, 1) }]).recall_at_5 === 1).length / (rows.length || 1),
    recall_at_5: report.recall_at_5,
    recall_at_10: report.recall_at_10,
    mrr: Number(report.mrr.toFixed(3)),
    latency_ms_p50: percentile(rows.map((row) => row.retrieval_latency_ms), 0.5),
    latency_ms_p95: percentile(rows.map((row) => row.retrieval_latency_ms), 0.95),
    avg_context_chars_top5: Math.round(rows.reduce((sum, row) => sum + row.context_chars_top5, 0) / (rows.length || 1)),
    failed: report.failed_cases.map((failure) => rows[failure.index].expected_requirement_id),
  };
}

const report = {
  frontend_root: path.relative(repositoryRoot, frontendRoot) || ".",
  documents: documents.length,
  limit,
  model_rerank: useModelRerank,
  structure_map: withoutStructure ? "removed" : "parser",
  retrieval: useLiveEmbeddings ? "stored_hybrid_live_embeddings" : "in_process",
  request: buildProjectChatRetrievalRequest ? "project_chat" : "question_only",
  cases_using_broadened_search: results.filter((row) => row.used_broadened_search).length,
  ...(live ? {
    stored_chunks: live.chunks,
    embedded_chunks: live.embeddedChunks,
    cases_using_hybrid_search: results.filter((row) => row.used_hybrid_search).length,
    cases_using_model_rerank: results.filter((row) => row.used_model_rerank).length,
  } : {}),
  results: {
    all: summary(results),
    id_lookup: summary(results.filter((row) => row.kind === "id_lookup")),
    conceptual: summary(results.filter((row) => row.kind === "conceptual")),
    held_out: summary(results.filter((row) => row.kind === "held_out")),
  },
};

if (databaseUrl && !useLiveEmbeddings) {
  report.keyword_search = await measureKeywordSearch();
}
if (outputPath) writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
if (args.includes("--gate")) {
  report.gate = evaluateRetrievalGate(results, useLiveEmbeddings ? "live" : "offline");
  if (!report.gate.passed) process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function psql(url, sql) {
  const result = spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-Atq"], { input: sql, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function retrievalFunctions() {
  const migration = readFileSync(path.join(repositoryRoot, "database/migrations/20260711124500_selected_service_document_retrieval.sql"), "utf8");
  const definition = (name) => {
    const sql = migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"))?.[0];
    if (!sql) throw new Error(`${name} definition is missing`);
    return sql;
  };
  return { match: definition("match_document_chunks"), hybrid: definition("hybrid_match_document_chunks") };
}

function createDisposableDatabase() {
  const name = `anbud_rag_eval_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  const drop = () => psql(databaseUrl, `drop database if exists "${name}" with (force);`);
  const { match, hybrid } = retrievalFunctions();
  psql(databaseUrl, `create database "${name}";`);
  try {
    psql(target.toString(), `
      create schema extensions;
      create extension vector with schema extensions;
      create table public.document_chunks (id uuid primary key, source_type text not null, source_id uuid not null,
        project_id uuid, chunk_index integer not null, fts tsvector not null, embedding extensions.vector(1536));
      ${match}
      ${hybrid}`);
  } catch (error) {
    drop();
    throw error;
  }
  return { url: target.toString(), drop };
}

/** Chunks and embeds every document with the app's own code, as artifact generation does. */
async function storeChunksWithLiveEmbeddings() {
  const database = createDisposableDatabase();
  process.env.RAG_EVAL_STORE_URL = database.url;
  try {
    for (const document of documents) {
      await replaceProjectDocumentChunks({
        documentId: document.id, projectId: document.project_id, role: document.role,
        supportingSubtype: null, title: document.title, fileName: document.file_name,
        fileFormat: document.file_format, rawText: document.raw_text,
        structureMap: document.structure_map, sourceRevision: 0,
      });
    }
    const [chunks, embeddedChunks] = psql(database.url,
      "select count(*), count(embedding) from public.document_chunks;").split("|").map(Number);
    if (!embeddedChunks) throw new Error("No chunk was embedded; check OPENAI_API_KEY and the embedding logs.");
    return { chunks, embeddedChunks, drop: database.drop };
  } catch (error) {
    database.drop();
    throw error;
  }
}

/**
 * Stores the app's own chunk rows (search text included) in a disposable
 * database and runs the deployed hybrid_match_document_chunks function with
 * no embeddings, so only its keyword half ranks.
 */
function measureKeywordSearch() {
  const support = path.join(frontendRoot, "lib/server/document-chunks.test-support.ts");
  // One module instance, so the manifest read below is the one written to.
  const storing = load({ "@/lib/server/data-api": support, openai: support }, true);
  const chunksModule = storing(path.join(frontendRoot, "lib/server/document-chunks.ts"));
  const { getDocumentChunksTestManifest, resetDocumentChunksTestRuntime } = storing(support);
  const { decryptString } = storing(path.join(frontendRoot, "lib/server/crypto.ts"));
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

  return (async () => {
    resetDocumentChunksTestRuntime();
    const rows = [];
    for (const document of documents) {
      await chunksModule.replaceProjectDocumentChunks({
        documentId: document.id, projectId: document.project_id, role: document.role,
        supportingSubtype: null, title: document.title, fileName: document.file_name,
        fileFormat: document.file_format, rawText: document.raw_text,
        structureMap: document.structure_map, sourceRevision: 0,
      });
      for (const row of getDocumentChunksTestManifest("project_document", document.id).rows) {
        rows.push({ id: randomUUID(), text: decryptString(row.text_encrypted), search: row.search_text, index: row.chunk_index });
      }
    }
    const database = createDisposableDatabase();
    try {
      psql(database.url, `
        insert into public.document_chunks (id, source_type, source_id, project_id, chunk_index, fts) values
        ${rows.map((row) => `(${literal(row.id)}, 'project_document', ${literal(row.id)}, ${literal(projectId)}, ${row.index}, to_tsvector('simple', left(${literal(row.search)}, 200000)))`).join(",\n")};`);
      const textById = new Map(rows.map((row) => [row.id, row.text]));
      const run = (queryText) => results.map((item) => {
        const ids = psql(database.url, `select coalesce(string_agg(id::text, ',' order by keyword_rank), '')
          from public.hybrid_match_document_chunks(array_fill(0.01, array[1536])::extensions.vector, ${literal(queryText(item))},
            ${limit}, 0.15, ${literal(projectId)}::uuid) where keyword_rank is not null;`);
        return { ...item, context_chars_top5: 0, retrieved: (ids ? ids.split(",") : []).map((id) => ({ source_id: id, text: textById.get(id) })) };
      });
      const byKind = (rows) => ({
        id_lookup: summary(rows.filter((row) => row.kind === "id_lookup")),
        conceptual: summary(rows.filter((row) => row.kind === "conceptual")),
      });
      return {
        chunks: rows.length,
        whole_question: byKind(run((item) => item.question)),
        keyword_query: buildKeywordSearchQuery
          ? byKind(run((item) => buildKeywordSearchQuery(item.question, extractExactRetrievalTerms(item.question))))
          : "buildKeywordSearchQuery is not in this checkout",
      };
    } finally {
      database.drop();
    }
  })();
}
