import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

function loadReranker(answer) {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-rerank-"));
  const state = { requests: [] };
  globalThis.__retrievalRerankTest = { state, answer };
  const completion = path.join(directory, "completion.cjs");
  writeFileSync(completion, `exports.createJsonCompletion = async input => {
    globalThis.__retrievalRerankTest.state.requests.push(input);
    return globalThis.__retrievalRerankTest.answer();
  };`);
  const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@/lib/server/ai/completion": completion, "@": frontendRoot, "server-only": "/dev/null",
  } });
  const reranker = load(path.join(frontendRoot, "lib/server/ai/retrieval-rerank.ts"));
  const { ProjectJobLeaseLostError } = load(path.join(frontendRoot, "lib/server/project-job-heartbeat.ts"));
  return { ...reranker, ProjectJobLeaseLostError, state, cleanup: () => { delete globalThis.__retrievalRerankTest; rmSync(directory, { recursive: true, force: true }); } };
}

const candidate = (text) => ({ documentTitle: "Bilag 1", reference: "Kapittel 2", text });

test("the model's 1-based ranking becomes candidate indexes and long passages are capped", async () => {
  const reranker = loadReranker(() => ({ ranking: [2, "1", 3] }));
  try {
    const long = `Innledning ${"utfyllende tekst ".repeat(80)}SLUTTMARKØR`;
    const order = await reranker.rerankRetrievalCandidates({
      query: "Hvor lenge lagres temperaturhistorikken?",
      candidates: [candidate("Ruteplanlegging"), candidate("Temperaturhistorikk lagres i ti år."), candidate(long)],
    });
    assert.deepEqual(order, [1, 0, 2], "numeric strings count as passage numbers");
    const [request] = reranker.state.requests;
    assert.match(request.user, /Utdrag 2[\s\S]*Temperaturhistorikk lagres i ti år/u);
    assert.ok(request.user.length < 4000, "each passage is cut to its rerank budget");
    assert.equal(request.maxRetries, 0);
  } finally {
    reranker.cleanup();
  }
});

test("the model sees the part of a long passage that matches the query", async () => {
  const reranker = loadReranker(() => ({ ranking: [1] }));
  try {
    const filler = "Leverandøren beskriver generelle rutiner for drift og forvaltning. ".repeat(60);
    await reranker.rerankRetrievalCandidates({
      query: "Hvor lenge lagres temperaturhistorikken?",
      candidates: [candidate(`${filler}Temperaturhistorikken lagres i ti år etter levering. ${filler}`)],
    });
    assert.match(reranker.state.requests[0].user, /Temperaturhistorikken lagres i ti år/u);
  } finally {
    reranker.cleanup();
  }
});

test("a failed or malformed rerank answer keeps the heuristic order", async () => {
  for (const answer of [() => { throw new Error("timeout"); }, () => ({ order: [1] })]) {
    const reranker = loadReranker(answer);
    const warn = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(line);
    try {
      assert.equal(await reranker.rerankRetrievalCandidates({ query: "Spørsmål", candidates: [candidate("A"), candidate("B")] }), null);
      assert.match(warnings[0], /retrieval_rerank_fallback/u);
      assert.doesNotMatch(warnings[0], /Spørsmål/u, "the warning carries no query text");
    } finally {
      console.warn = warn;
      reranker.cleanup();
    }
  }
});

test("model rerank is on unless RAG_MODEL_RERANK=off", () => {
  const previous = process.env.RAG_MODEL_RERANK;
  const reranker = loadReranker(() => ({ ranking: [] }));
  try {
    for (const [value, enabled] of [[undefined, true], ["on", true], [" OFF ", false], ["off", false]]) {
      if (value === undefined) delete process.env.RAG_MODEL_RERANK; else process.env.RAG_MODEL_RERANK = value;
      assert.equal(reranker.modelRetrievalRerankEnabled(), enabled, String(value));
    }
  } finally {
    if (previous === undefined) delete process.env.RAG_MODEL_RERANK; else process.env.RAG_MODEL_RERANK = previous;
    reranker.cleanup();
  }
});

test("reranking propagates cancellation and lease loss instead of falling back", async () => {
  for (const kind of ["AbortError", "APIUserAbortError", "ProjectJobLeaseLostError"]) {
    let failure;
    const reranker = loadReranker(() => { throw failure; });
    failure = kind === "ProjectJobLeaseLostError"
      ? new reranker.ProjectJobLeaseLostError("synthetic-job")
      : Object.assign(new Error("Synthetic cancellation"), { name: kind });
    try {
      await assert.rejects(reranker.rerankRetrievalCandidates({ query: "K-1", candidates: [candidate("K-1")] }), error => error === failure);
    } finally { reranker.cleanup(); }
  }
});
