import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-chat-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { buildQuestionRelevantText, inferProjectChatDomains, selectProjectChatArtifacts } = jiti(
  path.join(frontendRoot, "lib/server/ai/project-chat.ts"),
);

test("chat selects a relevant current artifact beyond the first five without crossing projects", () => {
  const artifact = (id, content_markdown, extra = {}) => ({ id, project_id: "project", title: id, content_markdown, is_current: true, source_is_current: true, ...extra });
  const relevant = artifact("exit", "Exit-planen eksporterer data i åpne formater innen 30 dager.");
  const candidates = [
    ...Array.from({ length: 6 }, (_, index) => artifact(`background-${index}`, "Generell innledning om leveransen.")),
    relevant,
    artifact("stale-exit", relevant.content_markdown, { source_is_current: false }),
    artifact("old-exit", relevant.content_markdown, { is_current: false }),
    artifact("unknown-exit", relevant.content_markdown, { is_current: undefined, source_is_current: undefined }),
    artifact("other-project", relevant.content_markdown, { project_id: "other" }),
  ];
  const selected = selectProjectChatArtifacts({ artifacts: candidates, question: "Hva sier exit-planen om eksport av data?", projectId: "PROJECT", limit: 5 });
  assert.equal(selected[0].id, relevant.id);
  assert.ok(selected.length <= 5);
  assert.ok(selected.every(item => !["stale-exit", "old-exit", "unknown-exit", "other-project"].includes(item.id)));
  assert.equal(candidates[0].id, "background-0", "Ranking must not mutate caller ordering.");
});

test("chat domain inference moved behind the project-chat boundary", () => {
  assert.deepEqual(
    inferProjectChatDomains({
      question: "Hvordan bør Azure-arkitektur og integrasjoner utformes?",
    }),
    ["Arkitektur og løsning"],
  );
  assert.deepEqual(
    inferProjectChatDomains({ question: "Kan du utdype?" }),
    ["Kunde og behov"],
  );
});

test("adaptive first questions skip rewriting while prior context and forced rewriting still reach the model", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-rewrite-"));
  const previousMode = process.env.RAG_QUERY_REWRITE;
  const previousRerank = process.env.RAG_MODEL_RERANK;
  delete process.env.RAG_MODEL_RERANK;
  const state = { rewrites: [], retrieval: [], answers: [] };
  globalThis.__projectChatRewriteTest = state;
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createJsonCompletion = async input => {
      globalThis.__projectChatRewriteTest.rewrites.push(input);
      return { standalone_query: "Omskrevet K-42 med tidligere kontekst", exact_terms: ["K-42"], subqueries: [] };
    };
    exports.createTextCompletionStream = async input => {
      globalThis.__projectChatRewriteTest.answers.push(input);
      return (async function* () { yield "Et lokalt svar."; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => {
      globalThis.__projectChatRewriteTest.retrieval.push(input);
      return { snippets: [], telemetry: { durationMs: 0, sourceCount: 0, quality: { sufficient: false, confidence: "low", reason: "Ingen testkilder", sourceCount: 0 } } };
    };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const question = "Hva krever K-42 om RTO?";
    const message = (role, content, id = "earlier-message") => ({ id, project_id: "test", role, content, context_snapshot: {}, created_at: "2026-01-01T00:00:00Z" });
    const current = message("user", question, "pending-user");
    const cases = [
      { name: "empty frozen input", messages: [], rewrites: 0 },
      { name: "actual route's first user message", messages: [current], rewrites: 0 },
      { name: "whitespace around current question", messages: [{ ...current, content: ` ${question} ` }], rewrites: 0 },
      { name: "blank prior content", messages: [message("assistant", " \n "), current], summary: " ", rewrites: 0 },
      { name: "previous user context", messages: [message("user", "Vi diskuterer K-41."), current], rewrites: 1 },
      { name: "assistant-only prior context", messages: [message("assistant", "RTO gjelder ordrebehandling."), current], rewrites: 1 },
      { name: "history excluding current message", messages: [message("user", "K-41 er kritisk.")], rewrites: 1 },
      { name: "repeated question is still real history", messages: [message("user", question), current], rewrites: 1 },
      { name: "assistant only", messages: [message("assistant", "Et tidligere svar.")], rewrites: 1 },
      { name: "nonempty session memory", messages: [current], summary: "Ordrebehandling i Azure.", rewrites: 1 },
      { name: "forced on with empty history", mode: "on", messages: [], rewrites: 1 },
      { name: "forced on with current message", mode: "on", messages: [current], rewrites: 1 },
      { name: "off still wins over history", mode: "off", messages: [message("user", "Tidligere spørsmål"), current], rewrites: 0 },
    ];
    for (const item of cases) {
      if (item.mode) process.env.RAG_QUERY_REWRITE = item.mode; else delete process.env.RAG_QUERY_REWRITE;
      state.rewrites = []; state.retrieval = []; state.answers = [];
      const history = structuredClone(item.messages);
      const result = await streamProjectChat({ projectName: "Fiktiv chat", question, customerAnalysis: null, solutionEvaluation: null, customerDocument: null, solutionDocument: null, recentMessages: history, sessionSummary: item.summary });
      let answer = ""; for await (const chunk of result.stream) answer += chunk;
      assert.equal(answer, "Et lokalt svar.");
      assert.equal(state.rewrites.length, item.rewrites, item.name);
      assert.equal(state.retrieval.length, item.rewrites ? 2 : 1, item.name);
      assert.equal(state.answers.length, 1, item.name);
      assert.ok(state.retrieval[0].exactTerms.includes("K-42"), item.name);
      assert.match(state.retrieval[0].query, /K-42/);
      assert.ok(state.retrieval[0].broaderQuery.startsWith(question), item.name);
      assert.ok(state.retrieval[0].broaderExactTerms.includes("K-42"), item.name);
      assert.equal(typeof state.retrieval[0].rerank, "function", "reranking is deferred until the plan is known and reuses the first candidate pool");
      assert.deepEqual(history, item.messages, "The history sent to the final answer must not be mutated.");
      assert.doesNotMatch(state.answers[0].user, /### Dokumentregel|Hele\s+står nedenfor/u,
        "A chat without documents must not claim whole documents are included.");
      if (item.rewrites) assert.match(result.retrievalPlan.standalone_query, /^Omskrevet/);
      else assert.ok(result.retrievalPlan.standalone_query.includes(question), item.name);
      if (item.summary?.trim()) assert.ok(state.answers[0].user.includes(item.summary));
      if (item.messages.some((m) => m.role === "assistant" && m.content.trim())) assert.ok(state.answers[0].user.includes(item.messages.find((m) => m.role === "assistant").content));
    }
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    if (previousRerank === undefined) delete process.env.RAG_MODEL_RERANK; else process.env.RAG_MODEL_RERANK = previousRerank;
    delete globalThis.__projectChatRewriteTest; rmSync(directory, { recursive: true, force: true });
  }
});

test("chat keeps question-specific evidence, complete late qualifications and all supplied source locators without inventing platform requirements", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-evidence-"));
  const state = { prompts: [], retrieval: [], snippets: [] };
  globalThis.__projectChatEvidenceTest = state;
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatEvidenceTest.prompts.push(input);
      return (async function* () { yield "Lokalt testsvar."; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => {
      const state = globalThis.__projectChatEvidenceTest; state.retrieval.push(input);
      return { snippets: state.snippets, telemetry: { durationMs: 0, usedHybridSearch: true, quality: { sufficient: true, sourceCount: state.snippets.length, topScore: 200 } } };
    };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const qualification = "Tilgjengelighetsprøver godkjennes bare etter kundens signatur. Unntak: ingen godkjenning ved tap av revisjonsspor.";
    const training = "Minst 75 deltakere skal bestå individuell praktisk prøve før produksjonssetting.";
    const exception = "Eksterne konsulenter er unntatt og bruker bare passord.";
    const late = `# Bakgrunn\n${"Generell historikk uten relevans. ".repeat(45)}\n# Tilgjengelighetsprøver\n${qualification}\n# Opplæring\n${training}\n# Forbehold\n${exception}`;
    state.snippets = Array.from({ length: 16 }, (_, index) => ({
      sourceType: "project_document", sourceId: index % 2 ? "supplier" : "customer",
      documentTitle: index % 2 ? "Leverandør" : "Kunde", reference: `Unik kilde ${index + 1}`,
      text: index === 15 ? late : "Generell bakgrunn.", headingPath: [], pageStart: index + 1, pageEnd: index + 1,
      lexicalScore: 1, score: 100, similarity: 0.8,
    }));
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    for (const customerText of ["Kunden stiller ingen krav til plattformleverandør.", "Microsoft Azure skal ikke brukes. Plattformen skal driftes lokalt."]) {
      const result = await streamProjectChat({
        projectName: "Fiktiv kildekontroll", question: "Hva kreves om tilgjengelighetsprøver og opplæring? Skill krav og avvik.",
        customerAnalysis: null, solutionEvaluation: null, recentMessages: [],
        customerDocument: document("customer", "primary_customer_document", customerText),
        solutionDocument: document("supplier", "primary_solution_document", "Leverandøren foreslår Microsoft Azure."),
      });
      for await (const chunk of result.stream) assert.equal(chunk, "Lokalt testsvar.");
      const prompt = state.prompts.at(-1).user;
      assert.ok(prompt.includes(qualification), "The complete late condition and its exception must reach the answer model.");
      assert.ok(prompt.includes(exception), "A separate exception section must survive even without repeating the question term.");
      assert.ok(prompt.includes(training), "Another requested topic must retain its complete acceptance criterion.");
      assert.ok(prompt.includes(customerText));
      assert.ok(!prompt.includes("Kildene inneholder en Microsoft-relatert føring"), "Supplier choice or a negated platform mention must not become an asserted customer requirement.");
      assert.ok(state.retrieval.at(-1).exactTerms.includes("tilgjengelighetsprøver"));
      assert.ok(state.retrieval.at(-1).exactTerms.includes("opplæring"));
      assert.equal(result.sourceReferences.length, 18);
      for (const reference of result.sourceReferences.slice(2)) assert.ok(prompt.includes(`Referanse: ${reference.reference}`));
      assert.deepEqual(result.sourceReferences.slice(0, 2).map(source => source.citation_number), [1, 2], "complete-document references retain a stable prefix before query-specific snippets");
      assert.equal(state.snippets[15].text, late, "Original source text remains intact.");
    }
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatEvidenceTest;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated artifacts are excerpted by question relevance and model rerank follows its switch", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-artifacts-"));
  const state = { retrieval: [], answers: [] };
  globalThis.__projectChatArtifactTest = state;
  const previous = { rewrite: process.env.RAG_QUERY_REWRITE, rerank: process.env.RAG_MODEL_RERANK };
  process.env.RAG_QUERY_REWRITE = "off";
  process.env.RAG_MODEL_RERANK = "off";
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatArtifactTest.answers.push(input);
      return (async function* () { yield "ok"; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => {
      globalThis.__projectChatArtifactTest.retrieval.push(input);
      return { snippets: [], telemetry: { durationMs: 0, sourceCount: 0, quality: { sufficient: false, sourceCount: 0 } } };
    };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const filler = "Generell innledning om leveransen og prosjektets bakgrunn. ".repeat(12);
    const late = "Exit-plan: data eksporteres i åpne formater innen 30 dager etter avslutning.";
    const artifact = { id: "a1", title: "Løsningsnotat", content_markdown: [...Array(12).fill(filler), late].join("\n\n"), is_current: true, source_is_current: true };
    const result = await streamProjectChat({ projectName: "Fiktiv", question: "Hva sier vi om exit-plan og eksport av data?",
      customerAnalysis: null, solutionEvaluation: null, customerDocument: null, solutionDocument: null,
      recentMessages: [], generatedArtifacts: [artifact] });
    for await (const _ of result.stream) { /* drain */ }
    assert.equal(state.retrieval[0].rerank, undefined, "RAG_MODEL_RERANK=off disables model rerank");
    assert.match(state.answers[0].user, /Exit-plan: data eksporteres i åpne formater/u,
      "a relevant passage late in a long artifact reaches the prompt");
  } finally {
    for (const [key, name] of [["rewrite", "RAG_QUERY_REWRITE"], ["rerank", "RAG_MODEL_RERANK"]]) {
      if (previous[key] === undefined) delete process.env[name]; else process.env[name] = previous[key];
    }
    delete globalThis.__projectChatArtifactTest; rmSync(directory, { recursive: true, force: true });
  }
});

test("model rerank is skipped when the whole documents are in the prompt", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-rerank-skip-"));
  const state = { retrieval: [] };
  globalThis.__projectChatRerankSkipTest = state;
  const previous = { rewrite: process.env.RAG_QUERY_REWRITE, rerank: process.env.RAG_MODEL_RERANK };
  process.env.RAG_QUERY_REWRITE = "off";
  delete process.env.RAG_MODEL_RERANK;
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async () => (async function* () { yield "ok"; })();`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => {
      globalThis.__projectChatRerankSkipTest.retrieval.push(input);
      return { snippets: [1, 2].map(index => ({ sourceType: "project_document", sourceId: "kunde", documentTitle: "kunde", reference: "del " + index, text: "Oppetid skal være 99,9 prosent.", headingPath: [], pageStart: null, pageEnd: null, lexicalScore: 2, score: 100, similarity: 0.8 })), telemetry: { durationMs: 0, sourceCount: 2, quality: { sufficient: true, sourceCount: 2 } } };
    };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    const ask = async (text, supportingDocuments = []) => {
      state.retrieval = [];
      const result = await streamProjectChat({ projectName: "Fiktiv", question: "Hva er kravet til oppetid?",
        customerAnalysis: null, solutionEvaluation: null, recentMessages: [], supportingDocuments,
        customerDocument: document("kunde", "primary_customer_document", text), solutionDocument: null });
      for await (const _ of result.stream) { /* drain */ }
      return state.retrieval.at(-1).rerank;
    };
    assert.equal(await ask("Oppetid skal være 99,9 prosent."), undefined, "a document sent whole needs no rerank");
    assert.equal(state.retrieval[0].surroundingSections, false, "an anchor keeps the matched part");
    assert.equal(typeof await ask("Oppetid skal være 99,9 prosent. ".repeat(4000)), "function", "a document sent as excerpts is reranked");
    assert.equal(state.retrieval[0].surroundingSections, true);
    const supporting = [1, 2, 3, 4].map((index) => document(`bilag-${index}`, "supporting_document", "Kort bilag."));
    supporting.push(document("bilag-5", "supporting_document", "Oppetid i bilag 5. ".repeat(8000)));
    assert.equal(typeof await ask("Oppetid skal være 99,9 prosent.", supporting), "function",
      "an oversized collection uses excerpts and one final model rerank");
  } finally {
    for (const [key, name] of [["rewrite", "RAG_QUERY_REWRITE"], ["rerank", "RAG_MODEL_RERANK"]]) {
      if (previous[key] === undefined) delete process.env[name]; else process.env[name] = previous[key];
    }
    delete globalThis.__projectChatRerankSkipTest; rmSync(directory, { recursive: true, force: true });
  }
});

test("an anchor into a document sent whole keeps the matched part of a section", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-anchor-"));
  const state = { answers: [] };
  globalThis.__projectChatAnchorTest = state;
  const previous = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  try {
    const filler = "Leverandøren beskriver generelle rutiner for drift og forvaltning. ".repeat(40);
    const section = `${filler}Oppetid skal være 99,95 prosent målt per måned. ${filler}`;
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatAnchorTest.answers.push(input);
      return (async function* () { yield "ok"; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async () => ({
      snippets: [{ sourceType: "project_document", sourceId: "kunde", documentTitle: "kunde", reference: "Kapittel 3",
        headingPath: [], pageStart: null, pageEnd: null, text: ${JSON.stringify(section)}, lexicalScore: 3, similarity: null, score: 3 }],
      telemetry: { durationMs: 0, sourceCount: 1, quality: { sufficient: true, sourceCount: 1 } },
    });`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    const result = await streamProjectChat({ projectName: "Fiktiv", question: "Hva er kravet til oppetid?",
      customerAnalysis: null, solutionEvaluation: null, recentMessages: [],
      customerDocument: document("kunde", "primary_customer_document", section), solutionDocument: null });
    for await (const _ of result.stream) { /* drain */ }
    const anchors = state.answers[0].user.slice(state.answers[0].user.indexOf("Kildehenvisninger"));
    assert.match(anchors, /Oppetid skal være 99,95 prosent/u);
  } finally {
    if (previous === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previous;
    delete globalThis.__projectChatAnchorTest; rmSync(directory, { recursive: true, force: true });
  }
});

test("a selected table row keeps its header and is not cut", () => {
  const header = "| Krav | Tiltak | Frist |\n| --- | --- | --- |";
  const rows = Array.from({ length: 80 }, (_, index) => `| K-${index + 1} | Ordinær drift og forvaltning av tjenesten | 30 dager |`);
  rows[70] = "| K-71 | Exit-plan med eksport av data i åpne formater | 14 dager |";
  const selected = buildQuestionRelevantText({ rawText: `Innledning.\n\n${header}\n${rows.join("\n")}`, question: "Hva er fristen for exit-plan?", limit: 1500 });
  assert.match(selected, /\| Krav \| Tiltak \| Frist \|\n\| --- \| --- \| --- \|\n(?:\|[^\n]*\n)*\| K-71 \| Exit-plan med eksport av data i åpne formater \| 14 dager \|/u);
  const longRow = `| K-90 | ${"Ordinær beskrivelse av driften. ".repeat(80)}Exit-plan leveres innen 14 dager. |`;
  const withLongRow = buildQuestionRelevantText({ rawText: `Innledning.\n\n${header}\n${rows.join("\n")}\n${longRow}`, question: "Når leveres exit-plan?", limit: 1500 });
  assert.match(withLongRow, /\| Krav \| Tiltak \| Frist \|[^]*Exit-plan leveres innen 14 dager/u, "a row longer than a piece is cut, not dropped");
  const byId = buildQuestionRelevantText({ rawText: `Innledning.\n\n${header}\n${rows.join("\n")}\n${longRow}`, question: "Hva sier K-90?", limit: 3500 });
  assert.match(byId, /Exit-plan leveres innen 14 dager/u, "a question about a long row's ID gets the end of the row");
  // A first cell longer than a piece is not repeated, and splitting still ends.
  const hugeCell = `| ${"K".repeat(3000)} | Sluttrapporten leveres innen 14 dager. |`;
  const withHugeCell = buildQuestionRelevantText({ rawText: `${header}\n${hugeCell}`, question: "Sluttrapporten?", limit: 1500 });
  assert.match(withHugeCell, /Sluttrapporten leveres/u);
  // Every piece ends at a word boundary, wherever the answer falls in the row.
  for (let shift = 0; shift < 80; shift += 1) {
    const row = `| K-91 | ${"x".repeat(shift)} ${"Ordinær beskrivelse av driften. ".repeat(84)}Sluttrapporten leveres innen 14 dager. ${"Ordinær beskrivelse av driften. ".repeat(10)}|`;
    const excerpt = buildQuestionRelevantText({ rawText: `${header}\n${row}`, question: "Sluttrapporten?", limit: 1500 });
    assert.match(excerpt, /Sluttrapporten/u, String(shift));
  }
});

test("attachment segments with å match question terms after the same normalization", () => {
  const filler = "Generell bakgrunnstekst om prosjektet. ".repeat(40);
  const relevant = "Påminnelse sendes automatisk før fristen for hver søknad.";
  const rawText = `${filler}\n\n${relevant}\n\n${filler}`;
  const selected = buildQuestionRelevantText({
    rawText,
    question: "Hvordan fungerer påminnelse?",
    limit: 400,
  });
  assert.match(selected, /Påminnelse sendes automatisk/u);
});

test("an attachment that fits the limit is kept whole even when one paragraph matches", () => {
  const selected = buildQuestionRelevantText({
    rawText: "Påminnelse: se nedenfor.\n\n7 dager før fristen.",
    question: "Påminnelse?",
    limit: 4000,
  });
  assert.match(selected, /Påminnelse: se nedenfor\./u);
  assert.match(selected, /7 dager før fristen\./u);
});

test("chat answers from the whole documents when they fit, with a compact per-requirement evaluation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-full-"));
  const state = { prompts: [] };
  globalThis.__projectChatFullTest = state;
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  try {
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatFullTest.prompts.push(input);
      return (async function* () { yield "ok"; })();
    };`);
    // Retrieval only finds the summary page, as in the production test.
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async () => ({
      snippets: [{ sourceType: "project_document", sourceId: "supplier", documentTitle: "Bilag 2", reference: "Bilag 2, side 1",
        text: "Sammendrag: Leverandøren oppfyller alle krav.", headingPath: [], pageStart: 1, pageEnd: 1, lexicalScore: 1, score: 100, similarity: 0.8 }],
      telemetry: { durationMs: 0, usedHybridSearch: true, quality: { sufficient: true, sourceCount: 1, topScore: 200 } },
    });`);
    const { createJiti: createLoader } = require("jiti");
    const load = createLoader(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const lateAnswer = "Kapittel 7: Hendelser med prioritet 1 har responstid på 30 minutter.";
    const solutionText = `Sammendrag: Leverandøren oppfyller alle krav.\n${"Generell beskrivelse av plattformen. ".repeat(400)}\n${lateAnswer}`;
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    const items = Array.from({ length: 60 }, (_, index) => ({
      reference: `KRAV-${index + 1}`, assessment: index === 59 ? "Mangler" : "Godt",
      rationale: `Vurdering ${index + 1}.`, evidence: "Sitat fra Bilag 2.",
    }));
    // Two documents share the short reference R-005.
    items.push(
      { reference: "R-005", source_document_title: "Bilag 1", assessment: "Godt", rationale: "Dekket.", evidence: "Sitat A." },
      { reference: "R-005", source_document_title: "Tilleggskrav", assessment: "Mangler", rationale: "Ikke dekket.", evidence: "" },
    );
    const result = await streamProjectChat({
      projectName: "Fiktiv", question: "Hvilke krav dekker Bilag 2 ikke?",
      customerAnalysis: null,
      solutionEvaluation: {
        fit_to_customer_needs: "Delvis.", weaknesses: ["Responstid"],
        strengths: ["Kundeeid IaC-repository"], trust_signals: ["Navngitte nøkkelpersoner"], improvement_recommendations: ["Lukk avviket på responstid"],
        requirement_coverage: { coverage_summary: "59 gode, 1 mangler.", items },
      },
      recentMessages: [],
      customerDocument: document("customer", "primary_customer_document", "KRAV-60 Hendelser med prioritet 1 skal ha responstid på høyst 15 minutter."),
      solutionDocument: document("supplier", "primary_solution_document", solutionText),
    });
    for await (const chunk of result.stream) assert.equal(chunk, "ok");
    const prompt = state.prompts.at(-1).user;
    // The whole documents come before the per-turn sections (prompt cache).
    assert.ok(prompt.indexOf(lateAnswer) < prompt.indexOf("### Løsningsvurdering"));
    // The late chapter (beyond the former 2,800/9,000-character head) is in.
    assert.ok(prompt.includes(lateAnswer));
    // Every requirement row, including the last, survives in compact form.
    assert.match(prompt, /KRAV-60 \| Mangler \| Vurdering 60\./u);
    // Rows sharing a reference keep their own document.
    assert.match(prompt, /R-005 \[Bilag 1\] \| Godt/u);
    assert.match(prompt, /R-005 \[Tilleggskrav\] \| Mangler/u);
    // The saved judgments beyond the requirement rows survive too.
    for (const finding of ["Kundeeid IaC-repository", "Navngitte nøkkelpersoner", "Lukk avviket på responstid"]) {
      assert.ok(prompt.includes(finding), finding);
    }
    assert.ok(prompt.includes("Referanse: Bilag 2, side 1"));
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatFullTest;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the chat route selects each fallback document once before building the real prompt", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-route-scope-"));
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  const state = { documents: [], prompts: [], retrieval: [], saved: [], abortOnEnd: null, chunks: ["Lokalt testsvar."] };
  globalThis.__projectChatRouteScopeTest = state;
  try {
    const dependencies = path.join(directory, "dependencies.cjs");
    writeFileSync(dependencies, `
      exports.requireProjectPermission = async () => {};
      exports.checkRateLimit = async () => ({ allowed: true });
      exports.getProjectGenerationContext = async () => ({ name: "Fiktiv", solutionEvaluationSnapshot: null });
      exports.listProjectDocumentsForAnalysis = async () => globalThis.__projectChatRouteScopeTest.documents;
      exports.getFreshCustomerAnalysis = async () => null;
      for (const name of ["listCurrentGeneratedArtifactsFresh", "listChatMessages", "listChatSessions"]) exports[name] = async () => [];
      exports.appendChatMessage = async (...args) => { globalThis.__projectChatRouteScopeTest.saved.push(args); };
      for (const name of ["upsertChatSession", "updateChatSessionMemory"]) exports[name] = async () => {};
      exports.createTextCompletionStream = async input => {
        globalThis.__projectChatRouteScopeTest.prompts.push(input);
        return (async function* () { for (const chunk of globalThis.__projectChatRouteScopeTest.chunks) yield chunk; globalThis.__projectChatRouteScopeTest.abortOnEnd?.abort(); })();
      };
      exports.retrieveDocumentSnippetsWithMetadata = async input => {
        globalThis.__projectChatRouteScopeTest.retrieval.push(input);
        return { snippets: [], telemetry: { durationMs: 0, quality: { sufficient: false, sourceCount: 0 } } };
      };
    `);
    const aliases = Object.fromEntries([
      "authorization", "observability", "repositories/data-store", "repositories/analyses", "repositories/artifacts", "repositories/chat", "ai/completion", "document-chunks",
    ].map((name) => [`@/lib/server/${name}`, dependencies]));
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false,
      alias: { ...aliases, "@": frontendRoot, "server-only": "/dev/null" } });
    const { POST } = await load.import(path.join(frontendRoot, "app/api/projects/[id]/chat/route.ts"));
    const document = (id, role, text) => ({ id, project_id: "fictional", role, title: id,
      file_name: `${id}.txt`, file_format: "txt", supporting_subtype: null, raw_text: text, structure_map: [] });
    for (const [source, marker] of [
      [document("solution", "primary_solution_document", `${"x".repeat(45001)}SENT_KAPITTEL_SVAR`), "SENT_KAPITTEL_SVAR"],
      [document("note", "supporting_document", "UNIKT_KUNDENOTAT"), "UNIKT_KUNDENOTAT"],
    ]) {
      state.documents = [source]; state.prompts = []; state.retrieval = [];
      const response = await POST(new Request("http://localhost/api/projects/fictional/chat", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hva er beskrevet?" }),
      }), { params: Promise.resolve({ id: "fictional" }) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("x-workflow-trace-id"), /^[a-f0-9-]{36}$/u);
      assert.equal(await response.text(), "Lokalt testsvar.");
      assert.equal(state.prompts[0].user.split(marker).length - 1, 1, "the complete source is sent once");
      assert.deepEqual(state.retrieval[0].documents.map((item) => item.id), [source.id]);
    }
    state.chunks=["  \n", "Lokalt testsvar.", "\n\n", "Andre avsnitt.", "\n\n \t"];
    state.saved=[];
    const whitespaceResponse=await POST(new Request("http://localhost/api/projects/fictional/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Hei!"})}),{params:Promise.resolve({id:"fictional"})});
    const visible=await whitespaceResponse.text();
    assert.equal(visible,"Lokalt testsvar.\n\nAndre avsnitt.","Keep paragraph spacing, discard only outer whitespace.");
    assert.equal(state.saved.find(args=>args[1]==="assistant")[2],visible,"Published stream and persisted transcript are identical.");
    state.chunks=["Lokalt testsvar."];
    const cancellation = new AbortController(); state.abortOnEnd = cancellation; state.saved = [];
    const canceled = await POST(new Request("http://localhost/api/projects/fictional/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hei!" }), signal: cancellation.signal }), { params: Promise.resolve({ id: "fictional" }) });
    assert.equal(canceled.status, 200);
    await assert.rejects(() => canceled.text(), /Chatstrømmen|abort/iu);
    assert.equal(state.saved.filter(args => args[1] === "assistant").length, 0, "request cancellation immediately after provider EOF must prevent assistant publication");

  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatRouteScopeTest;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an excerpt shortens against its whole document despite folded dashes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-dash-"));
  const state = { prompts: [] };
  globalThis.__projectChatDashTest = state;
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  try {
    const tail = "Siste ledd: beredskapen dekker også helligdager.";
    const source = `Kapittel 4 – Beredskap\u0000: ${"vakten svarer innen avtalt tid og eskalerer ved behov, ".repeat(8)}${tail}`;
    // Stored chunks fold dashes and drop NUL characters.
    const chunk = source.replace(/\u0000/gu, "").replace(/[‐‑‒–—]/gu, "-");
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatDashTest.prompts.push(input);
      return (async function* () { yield "ok"; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async () => ({
      snippets: [{ sourceType: "project_document", sourceId: "supplier", documentTitle: "Bilag 2", reference: "Bilag 2, side 4",
        text: ${JSON.stringify(chunk)}, headingPath: [], pageStart: 4, pageEnd: 4, lexicalScore: 1, score: 100, similarity: 0.8 }],
      telemetry: { durationMs: 0, usedHybridSearch: true, quality: { sufficient: true, sourceCount: 1, topScore: 200 } },
    });`);
    const { createJiti: createLoader } = require("jiti");
    const load = createLoader(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    const result = await streamProjectChat({
      projectName: "Fiktiv", question: "Hva gjelder for beredskap?",
      customerAnalysis: null, solutionEvaluation: null, recentMessages: [],
      customerDocument: document("customer", "primary_customer_document", "Kunden krever beredskap."),
      solutionDocument: document("supplier", "primary_solution_document", source),
    });
    for await (const part of result.stream) assert.equal(part, "ok");
    const user = state.prompts.at(-1).user;
    assert.equal(user.split(tail).length - 1, 1, "the passage appears once, in the whole document");
    assert.ok(user.includes("Referanse: Bilag 2, side 4"));
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatDashTest;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("chat keeps the full text of excerpts from documents the prompt does not carry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-fifth-"));
  const state = { prompts: [] };
  globalThis.__projectChatFifthTest = state;
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  try {
    const exception = `Unntak for tilgjengelighet: ${"vedlikeholdsvinduer avtales skriftlig og varsles i forkant, ".repeat(8)}ellers gjelder full tilgjengelighet.`;
    const completion = path.join(directory, "completion.cjs");
    const retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async input => {
      globalThis.__projectChatFifthTest.prompts.push(input);
      return (async function* () { yield "ok"; })();
    };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async () => ({
      snippets: [{ sourceType: "project_document", sourceId: "s5", documentTitle: "Støtte 5", reference: "Støtte 5, side 2",
        text: ${JSON.stringify(exception)}, headingPath: [], pageStart: 2, pageEnd: 2, lexicalScore: 1, score: 100, similarity: 0.8 }],
      telemetry: { durationMs: 0, usedHybridSearch: true, quality: { sufficient: true, sourceCount: 1, topScore: 200 } },
    });`);
    const { createJiti: createLoader } = require("jiti");
    const load = createLoader(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval,
      "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const document = (id, role, raw_text) => ({ id, project_id: "fictional", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text, structure_map: [] });
    const supports = Array.from({ length: 5 }, (_, index) =>
      // The first, included document repeats the fifth document's passage.
      document(`s${index + 1}`, "supporting_document", index === 4 ? `${"Lang bakgrunn. ".repeat(8000)}\n${exception}` : index === 0 ? `Støtte 1.\n${exception}` : `Støtte ${index + 1}.`),
    );
    const result = await streamProjectChat({
      projectName: "Fiktiv", question: "Hvilke unntak gjelder for tilgjengelighet?",
      customerAnalysis: null, solutionEvaluation: null, recentMessages: [],
      customerDocument: document("customer", "primary_customer_document", "Kunden krever høy tilgjengelighet."),
      solutionDocument: document("supplier", "primary_solution_document", "Leverandøren tilbyr drift."),
      supportingDocuments: supports,
    });
    for await (const chunk of result.stream) assert.equal(chunk, "ok");
    const user = state.prompts.at(-1).user;
    const excerpt = user.slice(user.indexOf("Støtte 5, side 2"), user.indexOf("Støtte 5, side 2") + exception.length + 400);
    assert.ok(excerpt.includes(exception), "the fifth document's own excerpt keeps its full text, even when an included document repeats it");
    assert.doesNotMatch(user, /Lang bakgrunn\. Lang bakgrunn/u, "large documents use retrieval without raw prefix duplication");
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatFifthTest;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("section discovery searches the whole current artifact collection and honors explicit type aliases", () => {
  const { selectProjectChatArtifactSections } = jiti(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
  const artifact = (id, artifact_type, content_markdown, extra = {}) => ({ id, project_id: "p", artifact_type, title: `Utkast ${id}`, content_markdown, artifact_version: 3, is_current: true, source_is_current: true, ...extra });
  const desired = artifact("late", "bilag1_rekonstruksjon", "# Innledning\n\nGenerell bakgrunn.\n\n" + "Generell bakgrunn.\n\n".repeat(300) + "## Tilbakeføring\n\nEksport ved avslutning tar 30 dager.");
  const candidates = [...Array.from({ length: 8 }, (_, i) => artifact(`other-${i}`, "losningsutkast", "## Eksport\n\nAndre forslag til eksport.")), desired, artifact("foreign", "bilag1_rekonstruksjon", "Eksport tar 9 dager", { project_id: "foreign" }), artifact("stale", "bilag1_rekonstruksjon", "Eksport tar 8 dager", { source_is_current: false })];
  const sections = selectProjectChatArtifactSections({ artifacts: candidates, projectId: "p", question: "Hva sier Bilag 1 om eksport ved avslutning?", characterBudget: 1500, limit: 4 });
  assert.equal(sections[0].artifact.id, "late");
  assert.match(sections[0].text, /30 dager/u);
  assert.equal(sections[0].heading, "Tilbakeføring");
  assert.ok(sections.every(section => section.artifact.project_id === "p" && section.artifact.source_is_current && section.artifact.content_markdown.includes(section.text)));
  assert.ok(sections.reduce((sum, section) => sum + section.text.length, 0) <= 1500);
});

test("chat repairs citation format once, validates before display and retains an honest terminal failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "chat-format-bound-"));
  const state = { calls: 0 }; globalThis.__chatFormatBound = state;
  try {
    const completion = path.join(directory, "completion.cjs"), retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createTextCompletionStream = async () => { const state=globalThis.__chatFormatBound; state.calls++; const text=state.calls===1 ? "K-1.3 krever eksport.\\n\\nK-1.3 krever eksport." : "K-1.3 krever eksport. [Kilde 1]"; return (async function*(){yield text;})(); };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata=async()=>({snippets:[],telemetry:{durationMs:0,quality:{sufficient:false,sourceCount:0}}});`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": frontendRoot, "server-only": "/dev/null" } });
    const { streamProjectChat } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const output = await streamProjectChat({ projectName: "Fiktiv", question: "Hva krever K-1.3?", customerAnalysis: null, solutionEvaluation: null, recentMessages: [], customerDocument: { id: "customer", project_id: "p", role: "primary_customer_document", title: "Krav", raw_text: "K-1.3 krever eksport.", structure_map: [] }, solutionDocument: null });
    let answer = ""; for await (const text of output.stream) answer += text;
    assert.equal(state.calls, 2, "Only the initial answer and one format repair are allowed.");
    assert.match(answer, /^K-1\.3 krever eksport\. \[Kilde 1\]/u);
    assert.match(answer, /kunne ikke kildebekreftes/u);
    assert.equal(output.sourceValidationFailed, true);
    assert.equal(output.validateAnswer(answer).length, 1);
  } finally { delete globalThis.__chatFormatBound; rmSync(directory, { recursive: true, force: true }); }
});

test("current question controls evidence gates and named source scope, independently of the rewrite", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-gates-"));
  const previousMode = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "on";
  const state = { calls: 0, retrieval: [], telemetry: {}, prompts: [] };
  globalThis.__chatGateTest = state;
  try {
    const completion = path.join(directory, "completion.cjs"), retrieval = path.join(directory, "retrieval.cjs");
    writeFileSync(completion, `exports.createJsonCompletion = async () => ({ standalone_query: globalThis.__chatGateTest.rewrittenQuery ?? "Bilag 1: tidligere kontekst", exact_terms: [], subqueries: [] });
      exports.createTextCompletionStream = async input => { globalThis.__chatGateTest.calls++; globalThis.__chatGateTest.prompts.push(input); return (async function* () { yield "Lokalt testsvar."; })(); };`);
    writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => { const s=globalThis.__chatGateTest; s.retrieval.push(input); return { snippets: [], telemetry: { quality: { sufficient: false, sourceCount: 0 }, ...s.telemetry } }; };`);
    const load = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": frontendRoot, "server-only": "/dev/null",
    } });
    const { streamProjectChat, buildProjectChatRetrievalRequest } = load(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
    const document = (id, title) => ({ id, title, file_name: `${title}.pdf`, project_id: "project", role: "primary_customer_document", raw_text: "Fiktiv bakgrunn uten svaret. ".repeat(4000), structure_map: [], chunk_source_revision: 1 });
    const first = document("one", "Bilag 1 Krav"), second = document("two", "Bilag 2 Drift");
    const input = { projectId: "project", projectName: "Fiktiv", customerDocument: first, solutionDocument: null, supportingDocuments: [second], customerAnalysis: null, solutionEvaluation: null,
      recentMessages: [{ role: "assistant", content: "Vi snakket om Bilag 1.", context_snapshot: {} }],
      generatedArtifacts: [{ id: "artifact", project_id: "project", title: "Bilag 1", artifact_type: "bilag1_rekonstruksjon", content_markdown: "# Exit\nEt generert forslag.", is_current: true, source_is_current: true }],
    };
    const run = async (question, extra = {}) => {
      state.calls = 0; const result = await streamProjectChat({ ...input, question, ...extra });
      let answer = ""; for await (const part of result.stream) answer += part; return answer;
    };
    for (const mode of ["on", "off"]) {
      process.env.RAG_QUERY_REWRITE = mode;
      assert.match(await run("Hva er kundens bindende exit-frist?"), /ikke nok kildegrunnlag/u);
      assert.equal(state.calls, 0, "An artifact inherited only through rewriting/history cannot unlock the model.");
    }
    process.env.RAG_QUERY_REWRITE = "on";
    assert.match(await run("Hva er den bindende exit-fristen i Bilag 1?"), /ikke nok kildegrunnlag/u);
    assert.equal(state.calls, 0, "A named generated draft is not evidence for a binding source fact.");
    for (const question of [
      "Hva er den bindende exit-fristen i Bilag 1? Jeg vil ikke ha forslag eller tolkning.",
      "Hva er sidegrensen for kravsvar i Bilag 1?", "Hva er fristen for forslag til endringer i Bilag 1?",
      "Hva sier Bilag 1 om verdiargumentasjon?", "Oppsummer Bilag 12 som et forslag.",
      "Vis innleveringsfristen for utkast i Bilag 1.", "Forklar kravene til tolkning i Bilag 1.",
      "Vis fristen i Bilag 1, ingen tolkning.", "Forklar fristen i Bilag 1 og unngå tolkning.",
      "Forklar fristen for utkast til kontrakt i Bilag 1.", "Beskriv kravene til tolkning av kontrakten i Bilag 1.",
      "Vurder sidegrensen for utkast i Bilag 1.",
      "Hva er exit-fristen i Bilag 1, ikke i utkastet?",
      "Svar fra Bilag 1 og ikke fra det genererte utkastet.",
      "Hva er den bindende exit-fristen i utkast til kontrakt i Bilag 1?",
      "Hva sier utkast til kontrakt i Bilag 1 om exit?", "Forklar utkast til kontrakt i Bilag 1.",
      "Hva er fristen i tolkning av kontrakten i Bilag 1?",
      "Ikke oppsummer Bilag 1 som et forslag. Hva er fristen?",
      "Oppsummer Bilag 1 som et forslag. Hva er kundens bindende exit-frist?",
    ]) {
      assert.match(await run(question), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    for (const [artifact_type, title, question] of [
      ["gjennomforing_og_risiko", "Risikoplan", "Hva sier risikoplanen om eksport ved avslutning?"],
      ["gjennomforing_og_risiko", "Gjennomføring", "Hva sier gjennomføringen om eksport ved avslutning?"],
      ["losningsutkast", "Systemløsning", "Hva sier systemløsningen om eksport ved avslutning?"],
      ["forbedret_kravsvar", "Kravbesvarelse", "Oppsummer kravbesvarelsen."],
    ]) {
      assert.equal(await run(question, { generatedArtifacts: [{ ...input.generatedArtifacts[0], artifact_type, title }] }), "Lokalt testsvar.");
    }
    const riskArtifact = { ...input.generatedArtifacts[0], artifact_type: "gjennomforing_og_risiko", title: "Risikoplan" };
    for (const question of ["Hva sier risikoplanen om risikoer som ikke er håndtert?", "Oppsummer risikoplanen uten å endre teksten.", "Hvilke risikoer er ikke dekket i risikoplanen?", "Oppsummer risikoplanen uten priser.", "Oppsummer risikoplanen om risikoer uten forslag til tiltak.", "Hva er ikke dokumentert i risikoplanen?", "Oppsummer risikoplanen for meg.", "Oppsummer risikoplanen for oss.", "Hva sier risikoplanen for migrering?", "Hva står i risikoplanen for migrering?"]) {
      assert.equal(await run(question, { generatedArtifacts: [riskArtifact] }), "Lokalt testsvar.", question);
    }
    for (const question of ["Ikke bruk innholdet i risikoplanen. Hva er kundens bindende exit-frist?", "Hva er exit-fristen, ikke i risikoplanen?", "Oppsummer risikoplanen, men ikke bruk innholdet i risikoplanen."]) {
      assert.match(await run(question, { generatedArtifacts: [riskArtifact] }), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    for (const [artifact_type, question] of [
      ["gjennomforing_og_risiko", "Hva er fristen for gjennomføring av opplæring?"],
      ["gjennomforing_og_risiko", "Hvilken gjennomføring krever kunden ved migrering?"],
      ["forbedret_kravsvar", "Hva er sidegrensen for kravsvar?"],
      ["verdiargumentasjon", "Hvilke krav gjelder for verdiargumentasjon?"],
      ["forbedret_kravsvar", "Hva er sidegrensen i kravsvaret?"],
      ["gjennomforing_og_risiko", "Hva er fristen for opplæring i gjennomføringen?"],
      ["gjennomforing_og_risiko", "Hva krever kunden i gjennomføring av migrering?"],
      ["verdiargumentasjon", "Hvilke krav gjelder i verdiargumentasjonen?"],
    ]) {
      assert.match(await run(question, { generatedArtifacts: [{ ...riskArtifact, artifact_type }] }), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    for (const question of ["Hvordan vektes vurderingen av pris i Bilag 1?", "Hva er fristen for vurderingen i Bilag 1?", "Hva er fristen, ikke ifølge vurderingen?",
      "Hvordan vektes pris i vurderingen av tilbudet?", "Hva er kriteriene i vurderingen av tilbud?", "Beskriv vurderingen av pris i Bilag 1.", "Beskriv vurderingen i Bilag 1.", "Hva sier vurderingen i Bilag 1 om pris?"]) {
      assert.match(await run(question, { solutionEvaluation: {} }), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    for (const question of ["Hvilke krav er ikke oppfylt i løsningsvurderingen?", "Hva er ikke dekket ifølge vurderingen?", "Hva sier den siste løsningsvurderingen?", "Hva sier vurderingen om Bilag 1?"]) {
      assert.equal(await run(question, { solutionEvaluation: {} }), "Lokalt testsvar.", question);
    }
    const customerAnalysis = { customer_profile_summary: "Fiktiv kunde", customer_goals_summary: "", high_level_solution_design: "", executive_summary: "", customer_goals: [], customer_profile: [], prioritized_requirements: [], implicit_requirements: [], likely_evaluation_criteria: [], expected_solution_direction: [], signal_words: [], risks: [], ambiguities: [], value_opportunities: [], positioning_recommendations: [] };
    for (const question of ["Basert på kundeanalysen, hva er risikoen?", "Gi en oppsummering av kundeanalysen.", "Hva viser kundeanalysen om risiko?", "Hva sier kundeanalysen om krav uten forslag?", "Hva sier analysen om Bilag 1?", "Basert på analysen, hva sier Bilag 1 om exit?", "Oppsummer kundeanalysen for meg.", "Forklar analysen for meg.", "Forklar analysen for oss."]) {
      assert.equal(await run(question, { customerAnalysis }), "Lokalt testsvar.", question);
    }
    assert.match(await run("Hva sier analysen i Bilag 1 om exit?", { customerAnalysis }), /ikke nok kildegrunnlag/u);
    assert.equal(state.calls, 0);
    assert.match(await run("Hva er fristen, ikke i kundeanalysen?", { customerAnalysis }), /ikke nok kildegrunnlag/u);
    assert.equal(state.calls, 0);
    assert.equal(await run("Oppsummer Bilag 1 som et forslag."), "Lokalt testsvar.");
    assert.equal(state.calls, 1, "Explicit current artifact questions remain available.");
    state.rewrittenQuery = "Annet tema";
    const competingArtifacts = Array.from({length: 9}, (_, index) => ({ ...input.generatedArtifacts[0], id: `other-${index}`, title: "Annet tema", artifact_type: "verdiargumentasjon", content_markdown: "Annet tema uten det etterspurte utkastet." }));
    await run("Oppsummer Bilag 1 som et forslag.", { generatedArtifacts: [...competingArtifacts, ...input.generatedArtifacts] });
    assert.match(state.prompts.at(-1).user, /Et generert forslag\./u, "The explicit current artifact must enter the prompt even when rewriting drops its name.");
    const topicalArtifact = { ...input.generatedArtifacts[0], title: "Verdiargumentasjon", artifact_type: "verdiargumentasjon",
      content_markdown: Array.from({length: 12}, (_, index) => `# Tema ${index}\nAnnet innhold uten temaet.`).join("\n\n") + "\n\n# Exit\nAvslutning med eksport og tilbakelevering." };
    state.rewrittenQuery = "Hva sier verdiargumentasjonen om exit, eksport og tilbakelevering?";
    assert.equal(await run("Hva sier verdiargumentasjonen om det?", { generatedArtifacts: [topicalArtifact] }), "Lokalt testsvar.");
    assert.match(state.prompts.at(-1).user, /Avslutning med eksport og tilbakelevering/u, "A named follow-up retains the rewritten topic when ranking late sections.");
    delete state.rewrittenQuery;
    state.telemetry = { requirementLookupTruncated: true, missingRequirementIds: ["K-42"] };
    assert.equal(await run("Skriv en e-post om K-42."), "Lokalt testsvar.");
    assert.equal(await run("Hva sier K-42 i vedlegget?", { promptAttachments: [{ title: "Mitt vedlegg", rawText: "K-42 Leverandøren skal holde fire kurs.", fileName: "vedlegg.txt" }] }), "Lokalt testsvar.");
    assert.match(await run("Hva sier K-42 i prosjektet?", { promptAttachments: [{ title: "Mitt vedlegg", rawText: "K-42 Leverandøren skal holde fire kurs.", fileName: "vedlegg.txt" }] }), /finnes flere steder/u);
    assert.equal(state.calls, 0, "An unrelated attachment does not bypass the repeated-ID guard.");
    const attachment = [{ title: "Mitt vedlegg", rawText: "K-42 Leverandøren skal holde fire kurs.", fileName: "vedlegg.txt" }];
    // Round 13: exercise request roles with real gate dispatch, including every
    // project telemetry failure. Positive controls keep attachment subject matter.
    const sourceFrameFailures = [];
    const checkFrame = async (question, extra, shouldAnswer) => {
      const answer = await run(question, extra);
      if ((state.calls === 1) !== shouldAnswer) sourceFrameFailures.push({ question, telemetry: state.telemetry, shouldAnswer, answer });
    };
    for (const telemetry of [{ requirementLookupFailed: true }, { requirementLookupTruncated: true }, { missingRequirementIds: ["K-42"] }, {}]) {
      state.telemetry = telemetry;
      for (const question of [
        "Vurder vedlegget mot de gjeldende kravene.", "Hva sier K-42 i vedlegget i forhold til de gjeldende kravene?",
        "Vurder vedlegget mot kundens behov.", "Vurder vedlegget mot våre krav.", "Vurder vedlegget mot alle kravene.",
        "Vurder vedlegget mot løsningen.", "Vurder vedlegget mot kontrakten.", "Vurder vedlegget mot K‑42.",
        "Hva sier vedlegget i forhold til løsningen?", "Hva sier vedlegget kontra tilbudet?",
        "Hva sier vedlegget, kravene og kunden om K-42?",
      ]) await checkFrame(question, { promptAttachments: attachment }, false);
      for (const question of ["Hva sier Leverandørnotat og kravene om K-42?", "Oppsummer leverandørnotat og kravene."])
        await checkFrame(question, { promptAttachments: [{ ...attachment[0], title: "Leverandørnotat" }] }, false);
      for (const question of ["Hva er fristen i vedlagte fil?", "Hva er fristen i vedlagte dokument?", "Se på vedlagte fil og list opp fristene.",
        "Hva sier vedlegget om leverandørens plikter mot kunden?"])
        await checkFrame(question, { promptAttachments: attachment }, true);
    }
    state.telemetry = {};
    for (const question of ["Oppsummer analysen på side 12 i Bilag 1.", "Hva sier analysen og Bilag 1 om exit?", "Hva sier analysen fra Bilag 1 om exit?",
      "Basert på analysen og Bilag 1, hva er den bindende exit-fristen?", "Vurder analysen mot Bilag 1."])
      await checkFrame(question, { customerAnalysis }, false);
    for (const question of ["Hva sier vurderingen på side 12 i Bilag 1 om pris?", "Hva sier vurderingen og Bilag 1 om pris?"])
      await checkFrame(question, { solutionEvaluation: {} }, false);
    for (const question of ["Oppsummer analysen i punktform.", "Forklar analysen i korte trekk.", "Oppsummer analysen i korte trekk."])
      await checkFrame(question, { customerAnalysis }, true);
    for (const question of ["Oppsummer vurderingen i tre punkter.", "Hva viser vurderingen i praksis?"])
      await checkFrame(question, { solutionEvaluation: {} }, true);
    for (const title of ["Mitt vedlegg", "Vedlegg"]) for (const question of ["Hva sier vedlegg 3 om exit-fristen?", "Hva står i vedlegg 3?", "Ifølge vedlegg 3, hva er fristen?", "Oppsummer vedlegg 3."])
      await checkFrame(question, { promptAttachments: [{ ...attachment[0], title }] }, false);
    for (const question of ["Oppsummer kundeanalysen og gi meg kundens bindende exit-frist", "Oppsummer analysen og oppgi kundens exit-frist."])
      await checkFrame(question, { customerAnalysis }, false);
    await checkFrame("Oppsummer løsningsvurderingen og gi meg kundens bindende exit-frist.", { solutionEvaluation: {} }, false);
    await checkFrame("Oppsummer risikoplanen og gi meg kundens bindende exit-frist.", { generatedArtifacts: [riskArtifact] }, false);
    await checkFrame("Oppsummer kundeanalysen og gi en oppsummering av kundeanalysen.", { customerAnalysis }, true);
    await checkFrame("Oppsummer vedlegget og gi meg kundens bindende exit-frist.", { promptAttachments: attachment }, false);
    for (const question of ["Hva sier analysen i kravdokumentet om exit-fristen?", "Hva sier analysen i kravspesifikasjonen om exit?", "Basert på analysen i konkurransegrunnlaget, hva er exit-fristen?", "Hva sier analysen i Bilag 9 om exit-fristen?"])
      await checkFrame(question, { customerAnalysis }, false);
    for (const question of ["Hva sier vurderingen i konkurransegrunnlaget om exit-fristen?", "Hva sier vurderingen i konkurransegrunnlaget om pris?"])
      await checkFrame(question, { solutionEvaluation: {} }, false);
    for (const telemetry of [{ requirementLookupFailed: true }, { requirementLookupTruncated: true }, { missingRequirementIds: ["K-42"] }, {}]) {
      state.telemetry = telemetry;
      for (const question of ["Vurder K-42 i vedlegget mot kunden sine krav.", "Vurder vedlegget mot kunden.", "Hva sier vedlegget mot kunden?"])
        await checkFrame(question, { promptAttachments: attachment }, false);
      for (const question of ["Forklar vedlegget om tiltak mot datatap.", "Forklar vedlegget om vern mot angrep.", "Beskriv tiltakene mot phishing i vedlegget.", "Forklar beskyttelsen mot nedetid i vedlegget.", "Vurder sikringen mot datatap i vedlegget.", "Hva sier vedlegget om kostnad i forhold til løsningen?", "Hva sier vedlegget om ansvar i forhold til kontrakten?", "Oppsummer siste vedlegg.", "Hva sier siste vedlegg om fristene?", "Oppsummer nyeste fil.", "Les vedlegget og gi meg en oppsummering.", "Se på vedlegget og gi meg hovedpunktene.", "Oppsummer vedlegget og oppgi fristene."])
        await checkFrame(question, { promptAttachments: attachment }, true);
    }
    state.telemetry = {};
    await checkFrame("Oppsummer kundeanalysen og gi meg en oppsummering av kundeanalysen.", { customerAnalysis }, true);
    await checkFrame("Oppsummer løsningsvurderingen og gi en kort oppsummering av løsningsvurderingen.", { solutionEvaluation: {} }, true);
    await checkFrame("Oppsummer kundeanalysen og gi meg tre anbefalinger.", { customerAnalysis }, true);
    await checkFrame("Oppsummer risikoplanen og gi meg tre tiltak.", { generatedArtifacts: [riskArtifact] }, true);
    await checkFrame("Oppsummer kundeanalysen og unngå å nevne frister.", { customerAnalysis }, true);
    await checkFrame("Oppsummer kundeanalysen og unngå å nevne frister, svar på hva kundens bindende exit-frist er.", { customerAnalysis }, false);
    assert.deepEqual(sourceFrameFailures, []);
    for (const [telemetry, refusal] of [
      [{ requirementLookupFailed: true }, /Kravregisteret/u],
      [{ requirementLookupTruncated: true }, /finnes flere steder/u],
      [{ missingRequirementIds: ["K-42"] }, /kunne ikke knyttes/u],
      [{}, /ikke nok kildegrunnlag/u],
    ]) {
      state.telemetry = telemetry;
      for (const question of ["Hva sier K-42 i prosjektet og vedlegget?", "Sammenlign K-42 i vedlegget med Bilag 1.",
        "Sammenlign K-42 i vedlegget og prosjektets krav.", "Hva sier prosjektets krav om K-42?",
        "Sammenlign vedlegget med kundens krav K-42.", "Er vedlegget i strid med K-42?",
        "Vurder vedlegget opp mot kundens krav K-42.", "Hva sier K-42 i løsningsdokumentet?",
        "Hva sier K-42 i kravdokumentet?", "Hva sier K-42 i dette prosjektet?", "Hva sier K-42?", "Oppfyller vedlegget K-42?",
        "Ikke bruk vedlegget. Hva sier K-42?",
        "Hva sier kundens krav om K-42, og hva står i vedlegget?",
        "Hva sier kravdokumentet om K-42, og hva står i vedlegget?", "Stemmer vedlegget med K-42?",
        "Hva sier K-42 i vedlegget og prosjektet?", "Hva sier K-42 i vedlegget og kravspesifikasjonen?",
        "Hva sier K-42 i vedlegget og kundedokumentet?", "Hva sier K-42 i filen og konkurransegrunnlaget?",
        "Vurder vedlegget mot K-42.", "Dekker vedlegget K-42?", "Er vedlegget i samsvar med K-42?",
        "Er vedlegget i tråd med K-42?", "Avviker vedlegget fra K-42?", "Samsvarer vedlegget med K-42?",
        "Tilfredsstiller vedlegget K-42?", "Svarer vedlegget på K-42?", "Stemmer vedlegget overens med K-42?",
        "Sammenlikn vedlegget med K-42.", "Hva sier K-42 om opplasting?", "Hva sier K-42 om vedlegg?",
        "Hva sier K-42 om levering av dokumentet?",
        "Oppsummer vedlegget og sammenlign det med K-42.", "Hva sier vedlegget, sammenlignet med K-42?",
        "Hva sier vedlegget om K-42 sammenlignet med kravene?", "Oppsummer vedlegget og vurder om det oppfyller K-42.",
        "Hva sier vedlegget og kravene om K-42?", "Hva sier vedlegget og kunden om K-42?",
        "Hva sier vedlegget i forhold til kravene om K-42?", "Hva sier vedlegget kontra prosjektet om K-42?",
        "Vurder vedlegget i lys av K-42.", "Hva sier K-42 unntatt i vedlegget?",
        "Oppsummer vedlegget og vurder det mot K-42.", "Oppsummer vedlegget og vurder det i lys av K-42.",
        "Oppsummer vedlegget og sjekk om det dekker K-42.", "Oppsummer vedlegget og si om det stemmer med K-42.",
        "Oppsummer vedlegget og si om det tilfredsstiller K-42.", "Hva sier vedlegget mot K-42?",
        "Kan du oppsummere vedlegget mot K-42?", "Hva sier vedlegget, og avviker det fra K-42?",
        "Hva sier K-42 andre steder enn i vedlegget?",
      ]) {
        assert.match(await run(question, { promptAttachments: attachment }), refusal, question);
        assert.equal(state.calls, 0, "The attachment must not fill the project side of a mixed question.");
      }
      for (const question of ["Hva sier K-42 i vedlegget?", "Hva sier K-42 i vedlegget om kundens ansvar?", "Oppsummer dette dokumentet.", "Svar på spørsmålene i filen.", "Hva sier vedlegget om prosjektet?", "Hva sier K-42 i filen?", "Hva sier vedlegget om leveranser i prosjektperioden?", "Hva sier vedlegget om samarbeid med prosjektleder?", "Hva sier vedlegget om forskjellige leveranser?", "Oppsummer fila.", "Oppsummer vedlegget om avvik og samsvar.",
        "Oppsummer vedlegget for meg.", "Oppsummer vedlegget for oss.", "Forklar filen for meg.",
        "Hva handler vedlegget om?", "Hva er fristen i vedlegget?", "Hvilke krav står i vedlegget?",
        "Hva inneholder vedlegget?", "Hva er hovedpunktene i dokumentet?", "Kan du oppsummere vedlegget?",
        "Gi meg en oppsummering av vedlegget.", "Lag en oppsummering av vedlegget.", "Se på vedlegget og list opp fristene.",
        "Kan du svare på spørsmålene i filen?", "Hva krever K-42 i vedlegget?", "Hva står det om K-42 i vedlegget?",
        "Hva sier vedlegget om sammenligningsgrunnlaget?", "Oppsummer vedlegget om sammenligning av tilbud.",
        "Hva sier vedlegget om oppfyllelse av krav?", "Hva sier vedlegget om krav som må oppfylles?",
        "Hva sier vedlegget i forhold til sikkerhet?", "Oppsummer vedlegget i forhold til sikkerhet.",
        "Hva sier K-42 i vedlegget i forhold til opplæring?", "Hva sier vedlegget om pris kontra kvalitet?",
        "Hva sier vedlegget om frister og krav?", "Hva sier vedlegget om leverandøren og kunden?",
        "Oppsummer vedlegget om roller og krav.", "Oppsummer fristene og kravene i vedlegget.",
        "List opp frister og krav i vedlegget."]) {
        assert.equal(await run(question, { promptAttachments: attachment }), "Lokalt testsvar.", question);
      }
    }
    state.telemetry = {};
    for (const question of ["Hva er kundens bindende exit-frist?", "Hva er den bindende exit-fristen i konkurransen?", "Sammenlign vedlegget med kundens krav.", "Hva er kundens frist for opplasting av tilbudet?", "Hvilke vedlegg krever kunden i tilbudet?",
      "Oppsummer vedlegget og sammenlign det med kravene.", "Hva sier vedlegget sammenlignet med kravene?",
      "Hva sier vedlegget i forhold til prosjektet?", "Hva sier vedlegget kontra prosjektet?",
      "Se bort fra vedlegget og svar på hva exit-fristen er.", "Hva er exit-fristen, se bort fra vedlegget?",
      "Hva er exit-fristen, bortsett fra i vedlegget?", "Hva er exit-fristen andre steder enn i vedlegget?",
      "Hva er den bindende exit-fristen i vedlegg 3?", "Hva krever kunden i vedlegg 3 til kontrakten?",
      "Hva krever kunden i vedlegget til kontrakten?", "Hvilke opplysninger skal leveres i vedlegg til tilbudet?",
      "Hva krever kunden om import fra fil?", "Hva er kravet til lagring i fil?"]) {
      assert.match(await run(question, { promptAttachments: attachment }), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    for (const [title, question] of [["Exit", "Hva er kundens bindende exit-frist?"], ["Krav", "Hva er kundens krav til drift?"], ["", "Hva sier K-42?"]]) {
      assert.match(await run(question, { promptAttachments: [{ ...attachment[0], title }] }), /ikke nok kildegrunnlag/u, question);
      assert.equal(state.calls, 0);
    }
    assert.match(await run("Hva er den bindende exit-fristen i vedlegg 3?", { supportingDocuments: [...input.supportingDocuments, document("prices", "Vedlegg 3 Priser")], promptAttachments: attachment }), /ikke nok kildegrunnlag/u);
    assert.equal(state.calls, 0);
    // Missing project IDs must not block a question explicitly scoped to the
    // attachment, including when the project fits the whole-document path.
    state.telemetry = { missingRequirementIds: ["K-42"] };
    for (const question of ["Hva krever K-42 i vedlegget?", "Hva står det om K-42 i vedlegget?"]) {
      assert.equal(await run(question, { customerDocument: { ...first, raw_text: "Ingen krav i prosjektet." }, supportingDocuments: [], promptAttachments: attachment }), "Lokalt testsvar.", question);
      assert.equal(state.calls, 1);
    }
    state.telemetry = {};
    const scoped = await buildProjectChatRetrievalRequest({ ...input, question: "Hva sier K-42 i Bilag 2, kapittel 3.2?" });
    assert.deepEqual(scoped.request.documents.map(item => item.id), ["two"]);
    assert.equal(scoped.request.requirementHeading, "3.2");
    const quoted = await buildProjectChatRetrievalRequest({ ...input, question: 'Hva sier K-42 i Bilag 2, kapittel «Drift og sikkerhet»?' });
    assert.equal(quoted.request.requirementHeading, "Drift og sikkerhet");
    const unscoped = await buildProjectChatRetrievalRequest({ ...input, question: "Hva sier K-42?" });
    assert.deepEqual(unscoped.request.documents.map(item => item.id), ["one", "two"], "Prior rewritten names cannot restrict the source collection.");
    for (const question of ["Hva sier K-42 i Bilag 1 og 2?", "Hvordan henger K-42 sammen med Bilag 2?", "Er K-42 i strid med Bilag 2?", "K-42 viser til Bilag 2, hva betyr det?", "Sammenlign K-42 i Bilag 2 med Bilag 1.", "K-42 i Bilag 2 viser til Bilag 1, hva betyr det?", "K-42 står ikke i Bilag 2, hvor står det?", "K-42 viser til kravene i Bilag 2, hva betyr det?", "Står K-42 bare i Bilag 2?", "Finnes K-42 kun i Bilag 2?", "Hvor ellers enn i Bilag 2 står K-42?", "Er K-42 i Bilag 2 i konflikt med tidligere krav?", "Vurder om K-42 finnes utelukkende i Bilag 2."]) {
      const result = await buildProjectChatRetrievalRequest({ ...input, question });
      assert.deepEqual(result.request.documents.map(item => item.id), ["one", "two"], question);
    }
    for (const question of ['Hva sier K-42 i Bilag 2 (kapittel 3)?', 'Hva sier K-42 i dokumentet Bilag 2, kap 3?', '«K-42 i Bilag 2, kapittel 3»', 'K-42 i Bilag 2, kapittel 3:']) {
      const result = await buildProjectChatRetrievalRequest({ ...input, question });
      assert.deepEqual(result.request.documents.map(item => item.id), ["two"]);
      assert.equal(result.request.requirementHeading, "3");
    }
    for (const quote of ['“Drift og sikkerhet”', "'Drift og sikkerhet'"]) {
      const result = await buildProjectChatRetrievalRequest({ ...input, question: `K-42 i Bilag 2, kapittel ${quote}` });
      assert.equal(result.request.requirementHeading, "Drift og sikkerhet");
    }
    const namedDocuments = [document("spec", "Kravspesifikasjon"), document("ops", "Driftsavtale")];
    for (const question of ["Hva sier K-42 i Kravspesifikasjon og Driftsavtale?", "Hva sier K-42 i Kravspesifikasjon eller Driftsavtale?"]) {
      const result = await buildProjectChatRetrievalRequest({ ...input, customerDocument: namedDocuments[0], supportingDocuments: [namedDocuments[1]], question });
      assert.equal(result.request.documents.length, 2);
    }
    const solution = { ...document("solution-only", "Løsningsbeskrivelse"), role: "primary_solution_document" };
    const solutionScope = await buildProjectChatRetrievalRequest({ ...input, solutionDocument: solution, question: "Hva sier K-42 i Løsningsbeskrivelse?" });
    assert.equal(solutionScope.request.documents.length, 3, "Solution references retain their authoritative requirement source.");
    const topical = await buildProjectChatRetrievalRequest({ ...input, supportingDocuments: [document("ops", "Drift")], question: "Hva krever K-42 under drift?" });
    assert.equal(topical.request.documents.length, 2);
    const security = await buildProjectChatRetrievalRequest({ ...input, supportingDocuments: [second, document("security", "Sikkerhet")], question: "Hva sier K-42 om sikkerhet?" });
    assert.equal(security.request.documents.length, 3);
    const underscore = await buildProjectChatRetrievalRequest({ ...input, supportingDocuments: [document("underscored", "03_Bilag_2_Drift")], question: "Hva sier K-42 fra Bilag 2?" });
    assert.deepEqual(underscore.request.documents.map(item => item.id), ["underscored"]);
    state.telemetry = {};
    const small = { ...input, recentMessages: [], generatedArtifacts: [], customerDocument: { ...first, raw_text: "K-42 Kunden skal ha fire kurs. UTENFOR_SCOPE_KUNDE" },
      solutionDocument: { ...document("solution", "Leverandør"), role: "primary_solution_document", raw_text: "UTENFOR_SCOPE_LOSNING" },
      supportingDocuments: [{ ...second, role: "supporting_document", raw_text: "K-42 Leverandøren skal levere driftsrapport. INNENFOR_SCOPE" }, { ...document("third", "Bilag 3"), raw_text: "UTENFOR_SCOPE_STOTTE" }] };
    await run("Hva sier K-42 i Bilag 2?", small);
    const prompt = state.prompts.at(-1).user;
    assert.match(prompt, /INNENFOR_SCOPE/u);
    assert.doesNotMatch(prompt, /UTENFOR_SCOPE|\[Kilde 0\]/u);
    const result = await streamProjectChat({ ...small, question: "Hva sier K-42 i Bilag 2?" });
    assert.deepEqual(result.sourceReferences.filter(source => source.source_type === "project_document").map(source => [source.source_id, source.citation_number]), [["two", 1]]);
    for await (const _chunk of result.stream) { /* Complete the real validation path. */ }
    await run("Sammenlign K-42 i Bilag 1 med Bilag 2.", small);
    assert.match(state.prompts.at(-1).user, /UTENFOR_SCOPE_KUNDE/u);
    assert.match(state.prompts.at(-1).user, /INNENFOR_SCOPE/u);
    assert.doesNotMatch(state.prompts.at(-1).user, /\[Kilde 0\]/u);
    const amendment = { ...document("amendment", "Rettelser"), role: "supporting_document", raw_text: "# Rettelser\nK-42 i Bilag 2 endres til «Leverandøren skal levere rapport hver uke»." };
    await run("Hva sier K-42 i Bilag 2?", { ...small, supportingDocuments: [...small.supportingDocuments, amendment] });
    assert.match(state.prompts.at(-1).user, /rapport hver uke/u, "An explicit source scope retains the source parser's relevant amendment.");


  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__chatGateTest; rmSync(directory, { recursive: true, force: true });
  }
});


test("artifact aliases match whole Unicode names and supported definite forms", () => {
  const { selectProjectChatArtifactSections } = jiti(path.join(frontendRoot, "lib/server/ai/project-chat.ts"));
  const artifact = { id: "a", project_id: "p", artifact_type: "bilag1_rekonstruksjon", title: "Bilag 1", content_markdown: "# Kilde\nEt forslag.", is_current: true, source_is_current: true };
  for (const question of ["Bilag 12", "Bilag 10", "Bilag 1a", "æBilag 1", "Bilag 1ø"]) {
    assert.equal(selectProjectChatArtifactSections({ artifacts: [artifact], question, projectId: "p" })[0].explicitlyNamed, false, question);
  }
  for (const question of ["Bilag 1", "(Bilag 1)", "BILAG 1", "Bilag1"]) {
    assert.equal(selectProjectChatArtifactSections({ artifacts: [artifact], question, projectId: "p" })[0].explicitlyNamed, true, question);
  }
});
