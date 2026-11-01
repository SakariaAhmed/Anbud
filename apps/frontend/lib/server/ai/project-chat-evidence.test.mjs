import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root = path.resolve(import.meta.dirname, "../../..");
const directory = mkdtempSync(path.join(tmpdir(), "anbud-chat-evidence-contract-"));
const completion = path.join(directory, "completion.cjs"), retrieval = path.join(directory, "retrieval.cjs");
writeFileSync(completion, `exports.createTextCompletionStream = async input => {
  const state = globalThis.__chatEvidenceContract; state.prompts.push(input);
  return (async function* () { for (const chunk of state.chunks) { if (chunk instanceof Error) throw chunk; yield chunk; } })();
}; exports.createJsonCompletion = async () => { throw new Error("No model rewriting is enabled in this test"); };`);
writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async input => {
  const state = globalThis.__chatEvidenceContract; state.reads.push(input);
  return { snippets: [], telemetry: { missingRequirementIds: state.missingIds, usedBroadenedSearch: false,
    quality: { sufficient: false, sourceCount: 0, topScore: 0 } } };
};`);
const load = createJiti(import.meta.url, { alias: { "@/lib/server/ai/completion": completion, "@/lib/server/document-chunks": retrieval, "@": root, "server-only": "/dev/null" } });
const { streamProjectChat } = load("./project-chat.ts");
const { parseChatSourceReferences } = load(path.join(root, "lib/chat-source-references.ts"));
const previous = { rewrite: process.env.RAG_QUERY_REWRITE, rerank: process.env.RAG_MODEL_RERANK };
test.before(() => { process.env.RAG_QUERY_REWRITE = "off"; process.env.RAG_MODEL_RERANK = "off"; });
test.after(() => {
  for (const [key, value] of [["RAG_QUERY_REWRITE", previous.rewrite], ["RAG_MODEL_RERANK", previous.rerank]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  delete globalThis.__chatEvidenceContract; rmSync(directory, { recursive: true, force: true });
});
const document = (id, text, role = "primary_customer_document") => ({ id, project_id: "project", role, title: id, file_name: `${id}.txt`, file_format: "txt", raw_text: text, structure_map: [], chunk_source_revision: 2 });
const input = extra => ({ projectId: "project", projectName: "Fiktiv", question: "Hva kreves?", customerAnalysis: null, solutionEvaluation: null, recentMessages: [], customerDocument: null, solutionDocument: null, ...extra });
const scenario = (chunks, missingIds = []) => globalThis.__chatEvidenceContract = { chunks, missingIds, prompts: [], reads: [] };
const collect = async stream => { let text = ""; for await (const chunk of stream) text += chunk; return text; };

test("attachment-only and complete-document answers outside retrieval remain citable and reloadable", async () => {
  const wording = "Leverandøren skal tilby eksport i åpne formater.";
  const answer = `K42 krever «${wording}» [Kilde 1]`;
  const raw = `${"Bakgrunn. ".repeat(4000)}K42 ${wording}`;
  for (const extra of [
    { promptAttachments: [{ title: "Chatgrunnlag", fileName: "vedlegg.txt", fileFormat: "txt", rawText: raw }] },
    { customerDocument: document("customer", raw) },
  ]) {
    scenario([answer]);
    const result = await streamProjectChat(input(extra));
    assert.equal(await collect(result.stream), answer);
    assert.equal(result.sourceValidationFailed, false);
    const sources = result.validateAnswer(answer);
    assert.equal(sources.length, 1); assert.equal(sources[0].citation_number, 1);
    assert.ok(sources[0].original_quote.length < 1000);
    assert.match(sources[0].original_quote, /K42/u);
    assert.deepEqual(parseChatSourceReferences(JSON.parse(JSON.stringify(sources))), JSON.parse(JSON.stringify(sources)));
  }
});

test("invalid paragraphs never become visible, while a previously validated paragraph remains saved with its source", async () => {
  scenario(["K42 krever eksport. [Kilde 1]\n\n", "K99 krever Sverige. [Kilde 1]"]);
  const result = await streamProjectChat(input({ customerDocument: document("customer", "K42 Leverandøren skal tilby eksport.") }));
  const visible = await collect(result.stream);
  assert.match(visible, /K42/u); assert.doesNotMatch(visible, /K99|Sverige/u);
  assert.match(visible, /kunne ikke kildebekreftes/u);
  assert.equal(result.sourceValidationFailed, true);
  assert.equal(result.validateAnswer(visible)[0].citation_number, 1);
});

test("sparse source numbers persist, and prior-turn citation markers cannot be reused as current evidence", async () => {
  const answer = "K3 krever logger. [Kilde 3]\n\nK1 krever eksport. [Kilde 1]";
  const state = scenario([answer]);
  const result = await streamProjectChat(input({
    customerDocument: document("customer", "K1 Kunden skal få eksport."),
    solutionDocument: document("solution", "K2 Leverandøren skal tilby drift.", "primary_solution_document"),
    supportingDocuments: [document("support", "K3 Logger skal oppbevares.", "supporting_document")],
    sessionSummary: "Tidligere beslutning. [Kilde 98]",
    recentMessages: [{ id: "previous", role: "assistant", content: "Tidligere råd. [Kilde 99]", source_references: [{ citation_number: 99, source_type: "project_document", source_id: "old", document_title: "Tidligere dokument", reference: "Side 7" }] }],
  }));
  assert.equal(await collect(result.stream), answer);
  const saved = result.validateAnswer(answer);
  assert.deepEqual(saved.map(source => source.citation_number), [3, 1]);
  assert.doesNotMatch(state.prompts[0].user, /\[Kilde (?:98|99)\]/u);
  assert.match(state.prompts[0].user, /tidligere kilde: Tidligere dokument/u);
});

test("weak evidence abstains for document questions but permits greetings, drafting and existing analysis", async () => {
  const customerDocument = document("customer", "Lang bakgrunn uten et relevant svar. ".repeat(4000));
  let state = scenario(["Dette skal ikke kalles."]);
  let result = await streamProjectChat(input({ customerDocument, question: "Hva er fristen for migrering?" }));
  const refusal = await collect(result.stream);
  assert.match(refusal, /ikke nok kildegrunnlag/u); assert.doesNotMatch(refusal, /etter et nytt søk/u);
  assert.equal(state.prompts.length, 0); assert.deepEqual(result.validateAnswer(refusal), []);
  for (const extra of [{ question: "Hei!" }, { question: "Skriv en e-post til kunden" }, { question: "Oppsummer kundeanalysen", customerAnalysis: {
    customer_profile_summary: "Kommunen trenger trygg drift.", customer_goals_summary: "", high_level_solution_design: "", executive_summary: "", customer_goals: [], customer_profile: [],
    prioritized_requirements: [], implicit_requirements: [], likely_evaluation_criteria: [], expected_solution_direction: [],
    signal_words: [], risks: [], ambiguities: [], value_opportunities: [], positioning_recommendations: [],
  } }]) {
    state = scenario(["Her er et forslag."]);
    result = await streamProjectChat(input({ customerDocument, ...extra }));
    assert.equal(await collect(result.stream), "Her er et forslag.");
    assert.equal(state.prompts.length, 1);
  }
  state = scenario(["Dette skal ikke kalles."], ["K99"]);
  result = await streamProjectChat(input({ customerDocument: document("customer", "K1 Kunden skal få eksport."), question: "Hva sier K99?" }));
  assert.match(await collect(result.stream), /kunne ikke knyttes sikkert/u); assert.equal(state.prompts.length, 0);
});
