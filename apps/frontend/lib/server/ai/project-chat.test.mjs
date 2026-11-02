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
