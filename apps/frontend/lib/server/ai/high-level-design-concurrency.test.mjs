import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const frontend = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("HLD overlaps digest and retrieval, waits for both, and stops on evidence failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-hld-concurrency-"));
  const state = { digest: deferred(), retrieval: deferred(), started: [], prompts: [] };
  globalThis.__hldConcurrencyTest = state;
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createJsonCompletion = async (input) => {
      const state = globalThis.__hldConcurrencyTest;
      if (input.promptCacheKey === "document-insight-digest") { state.started.push("digest"); return state.digest.promise; }
      state.prompts.push(input); return { high_level_solution_design: "Foreslått segmentert løsning.", high_level_architecture_mermaid: "flowchart LR\\n A[Bruker] --> B[Tjeneste]" };
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async (input) => {
      const state = globalThis.__hldConcurrencyTest; state.started.push("retrieval"); state.retrievalInput = input; return state.retrieval.promise;
    };`);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion,
      "@/lib/server/document-chunks": retrieval,
      "@": frontend, "server-only": "/dev/null",
    } });
    const { generateHighLevelDesign } = jiti(path.join(frontend, "lib/server/ai.ts"));
    const customerAnalysis = { customer_profile_summary: "", customer_goals_summary: "", high_level_solution_design: "", high_level_architecture_mermaid: "", customer_profile: [], customer_goals: [], implicit_requirements: [], prioritized_requirements: [], ambiguities: [], risks: [], risks_for_us: [], risks_for_customer: [], likely_evaluation_criteria: [], signal_words: [], signal_word_counts: {}, expected_solution_direction: [], recommended_services: [], value_opportunities: [], positioning_recommendations: [], executive_summary: "", section_histories: {} };
    const document = { id: "hld-test-one", project_id: "hld-project", title: "Konkurransegrunnlag", role: "primary_customer_document", file_name: "krav.md", file_format: "md", raw_text: "Dokumenterte krav og føringer. ".repeat(700), structure_map: [], updated_at: "2026-01-01T00:00:00Z" };
    const input = { projectName: "Test", customerDocument: document, supportingDocuments: [], customerAnalysis };
    const run = generateHighLevelDesign(input);
    await tick();
    assert.ok(state.started.includes("digest"));
    assert.ok(state.started.includes("retrieval"), "retrieval must start before digest resolves");
    assert.equal(state.prompts.length, 0);
    state.retrieval.resolve({ snippets: [], telemetry: { sourceCount: 0, quality: { sufficient: false, confidence: "low", reason: "Ingen treff" } } });
    await tick();
    assert.equal(state.prompts.length, 0, "generation must await the digest too");
    state.digest.resolve({ document_summary: "Unikt dokumentfunn for test", important_requirements: ["Bevar dette funnet"] });
    await run;
    assert.equal(state.prompts.length, 1);
    assert.match(state.prompts[0].user, /Unikt dokumentfunn for test/);
    assert.deepEqual(state.retrievalInput.documents, [document]);

    state.digest = deferred(); state.retrieval = deferred(); state.started = [];
    const failed = generateHighLevelDesign({ ...input, customerDocument: { ...document, id: "hld-test-two" } });
    const rejected = assert.rejects(failed, /retrieval unavailable/);
    state.retrieval.reject(new Error("retrieval unavailable"));
    await rejected;
    state.digest.resolve({ document_summary: "unused" });
    await tick();
    assert.equal(state.prompts.length, 1, "failed evidence must not launch final generation");

    state.retrieval = deferred();
    state.retrieval.resolve({ snippets: [], telemetry: { sourceCount: 0, quality: { sufficient: false, confidence: "low", reason: "Ingen treff" } } });
    const scoped = await generateHighLevelDesign({ ...input, customerDocument: {
      ...document, id: "hld-continuity", raw_text: "Krav til gjenoppretting: Maksimal gjenopprettingstid er 90 minutter for journalintegrasjonen. Andre systemer kan ha inntil 8 timer.",
    } });
    assert.match(scoped.high_level_solution_design, /90 minutter for journalintegrasjonen/);
    assert.match(scoped.high_level_solution_design, /Andre systemer kan ha inntil 8 timer/);
    assert.doesNotMatch(scoped.high_level_solution_design, /RTO\/RPO-verdier må avklares/);
  } finally { delete globalThis.__hldConcurrencyTest; rmSync(directory, { recursive: true, force: true }); }
});
