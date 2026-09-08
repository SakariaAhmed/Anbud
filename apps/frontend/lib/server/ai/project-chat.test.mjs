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
const { inferProjectChatDomains } = jiti(
  path.join(frontendRoot, "lib/server/ai/project-chat.ts"),
);

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
      assert.equal(state.retrieval.length, 1, item.name);
      assert.equal(state.answers.length, 1, item.name);
      assert.ok(state.retrieval[0].exactTerms.includes("K-42"), item.name);
      assert.match(state.retrieval[0].query, /K-42/);
      assert.deepEqual(history, item.messages, "The history sent to the final answer must not be mutated.");
      if (item.rewrites) assert.match(result.retrievalPlan.standalone_query, /^Omskrevet/);
      else assert.ok(result.retrievalPlan.standalone_query.includes(question), item.name);
      if (item.summary?.trim()) assert.ok(state.answers[0].user.includes(item.summary));
      if (item.messages.some((m) => m.role === "assistant" && m.content.trim())) assert.ok(state.answers[0].user.includes(item.messages.find((m) => m.role === "assistant").content));
    }
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
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
      assert.equal(result.sourceReferences.length, 16);
      for (const reference of result.sourceReferences) assert.ok(prompt.includes(`Referanse: ${reference.reference}`));
      assert.equal(state.snippets[15].text, late, "Original source text remains intact.");
    }
  } finally {
    if (previousMode === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousMode;
    delete globalThis.__projectChatEvidenceTest;
    rmSync(directory, { recursive: true, force: true });
  }
});
