import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
import { scoreRetrievalCases } from "../../../../../scripts/rag_eval.mjs";

const frontend = path.resolve(import.meta.dirname, "../../..");
const bytes = readFileSync(new URL("./fixtures/deterministic-contract-v2/contract.json", import.meta.url));
const fixture = JSON.parse(bytes);
const support = path.join(frontend, "lib/server/document-chunks.test-support.ts");
const load = createJiti(import.meta.url, { alias: {
  "@": frontend, "server-only": "/dev/null", "@/lib/server/data-api": support, openai: support,
} });
const { resetDocumentChunksTestRuntime, setDocumentChunksTestRequirementRegister } = load(support);
const { encryptJson } = load("../crypto.ts");
const { retrieveDocumentSnippetsWithMetadata } = load("../document-chunks.ts");
const { lookupRequirementSnippets } = load("./retrieval-lookup.ts");
const { buildIngestionRequirementRegister } = load("./ingestion-register.ts");
const chatLoad = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { selectProjectChatArtifactSections } = chatLoad("../ai/project-chat.ts");
process.env.OPENAI_API_KEY = "frozen-contract-test-transport-only";
process.env.APP_ENCRYPTION_KEY = "frozen-contract-test-encryption-key";

function seed() {
  resetDocumentChunksTestRuntime();
  for (const source of fixture.documents) {
    setDocumentChunksTestRequirementRegister(source.id, encryptJson({
      documentId: source.id, projectId: source.project_id, sourceRevision: source.chunk_source_revision,
      requirementRegister: { version: 1, rows: fixture.registers[source.id] },
    }));
  }
}
function scored(snippets) {
  return snippets.map(row => ({ source_id: row.sourceId, text: row.text,
    page_start: row.pageStart, page_end: row.pageEnd, heading_path: row.headingPath }));
}
function assertOccurrences(snippets, labels) {
  assert.equal(snippets.length, labels.length);
  for (const label of labels) {
    const matches = snippets.filter(row => label.expected_source_ids.includes(row.sourceId) &&
      row.text === label.expected_texts[0] && row.pageStart === (label.expected_page ?? null) && row.pageEnd === (label.expected_page ?? null));
    assert.equal(matches.length, 1, JSON.stringify(label));
    assert.deepEqual(matches[0].headingPath, label.expected_heading ? [label.expected_heading] : []);
    assert.ok(fixture.documents.find(source => source.id === matches[0].sourceId).raw_text.includes(matches[0].text));
  }
}

test("v2 frozen lookup contract resolves every within-source and across-source occurrence with original or unknown locators", async () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "eb67671df740f0e8b520a41333b8f833716d688af1ed5e2fcfabcc684aec03ac");
  seed();
  const row = fixture.cases[0];
  const literal = await lookupRequirementSnippets({ ids: [row.expected_requirement_id], documents: fixture.documents,
    fingerprints: new Map(fixture.documents.map(source => [`project_document:${source.id}`, `frozen-v2:${source.id}`])) });
  assertOccurrences(literal, row.required_evidence);
  const result = await retrieveDocumentSnippetsWithMetadata({ query: row.question, exactTerms: [row.expected_requirement_id], documents: fixture.documents, limit: 10 });
  const authoritative = result.snippets.filter(snippet => snippet.kind === "requirement_row");
  assertOccurrences(authoritative, row.required_evidence);
  assert.equal(result.telemetry.requirementLookupTruncated, false);
  const report = scoreRetrievalCases([{ ...row, retrieved: scored(result.snippets) }]);
  assert.equal(report.all_evidence_cases, 1, "Frozen labels exercise the real root all-occurrence scorer in CI.");
  assert.equal(report.all_evidence_recall_at_10, 1);
  // A correct first occurrence cannot hide a lost second page or second source.
  for (const omitted of authoritative) {
    const incomplete = result.snippets.filter(snippet => snippet !== omitted);
    assert.equal(scoreRetrievalCases([{ ...row, retrieved: scored(incomplete) }]).all_evidence_recall_at_10, 0);
  }
});

test("v2 repeated occurrences exceeding the result budget remain explicitly ambiguous", async () => {
  seed();
  const row = fixture.cases[1];
  const result = await retrieveDocumentSnippetsWithMetadata({ query: row.question, exactTerms: [row.expected_requirement_id], documents: fixture.documents, limit: row.limit });
  assert.equal(result.snippets.length, row.limit);
  assert.equal(result.telemetry.requirementLookupTruncated, row.expected_truncated);
  assert.equal(result.telemetry.quality.sufficient, false);
  assert.equal(scoreRetrievalCases([{ ...row, retrieved: scored(result.snippets) }]).all_evidence_recall_at_10, 0);
});


test("document clarification resolves the same over-budget ID without losing occurrences in that source", async () => {
  seed();
  const row = fixture.cases[1];
  const documents = fixture.documents.filter(source => source.id === "contract-v2-b");
  const result = await retrieveDocumentSnippetsWithMetadata({ query: row.question, exactTerms: [row.expected_requirement_id], documents, limit: row.limit });
  assert.equal(result.telemetry.requirementLookupTruncated, false);
  assert.deepEqual(result.telemetry.missingRequirementIds, []);
  const authoritative = result.snippets.filter(snippet => snippet.kind === "requirement_row");
  assert.equal(authoritative.length, 1);
  assert.equal(authoritative[0].sourceId, "contract-v2-b");
});

for (const row of fixture.artifact_cases) test(`v2 explicit alias ${row.alias} selects the original competing section and denies stale/foreign versions`, () => {
  const artifact = (id, artifact_type, content_markdown, extra = {}) => ({ id, project_id: "contract-v2", artifact_type,
    title: `Utkast ${id}`, content_markdown, artifact_version: 2, is_current: true, source_is_current: true, ...extra });
  const desired = artifact("desired", row.artifact_type, "# Innledning\n\nBakgrunn.\n\n" + "Bakgrunn.\n\n".repeat(100) + `## ${row.expected_heading}\n\n${row.expected_text}`);
  const competingType = row.artifact_type === "losningsutkast" ? "bilag1_rekonstruksjon" : "losningsutkast";
  const bad = `## Eksport ved avslutning\n\nFEIL: Eksport ved avslutning tar 9 dager.`;
  const denied = [artifact("foreign", row.artifact_type, bad, { project_id: "other" }),
    artifact("stale-source", row.artifact_type, bad, { source_is_current: false }),
    artifact("historical", row.artifact_type, bad, { is_current: false })];
  const sections = selectProjectChatArtifactSections({ artifacts: [
    ...Array.from({ length: 9 }, (_, i) => artifact(`competitor-${i}`, competingType, bad)), ...denied, desired,
  ], projectId: "contract-v2", question: `Hva sier ${row.alias} om eksport ved avslutning?`, limit: 1, characterBudget: 800 });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].artifact.id, desired.id);
  assert.equal(sections[0].explicitlyNamed, true);
  assert.equal(sections[0].heading, row.expected_heading);
  assert.equal(sections[0].text.trim(), row.expected_text);
  assert.ok(desired.content_markdown.includes(sections[0].text));
  assert.deepEqual(selectProjectChatArtifactSections({ artifacts: denied, projectId: "contract-v2", question: `${row.alias} eksport ved avslutning` }), []);
});

test("a document/chapter clarification resolves budget ambiguity through the retrieval owner", async () => {
  seed();
  const row = fixture.cases[0];
  const request = { query: row.question, exactTerms: [row.expected_requirement_id], documents: fixture.documents, limit: 3 };
  assert.equal((await retrieveDocumentSnippetsWithMetadata(request)).telemetry.requirementLookupTruncated, true);
  const chapter = await retrieveDocumentSnippetsWithMetadata({ ...request, requirementHeading: "Beredskap" });
  assert.equal(chapter.telemetry.requirementLookupTruncated, false);
  assertOccurrences(chapter.snippets.filter(item => item.kind === "requirement_row"), row.required_evidence.slice(0, 3));
  const source = await retrieveDocumentSnippetsWithMetadata({ ...request, documents: fixture.documents.filter(document => document.id === "contract-v2-b"), limit: 1 });
  assert.equal(source.telemetry.requirementLookupTruncated, false);
  assertOccurrences(source.snippets.filter(item => item.kind === "requirement_row"), row.required_evidence.slice(3));
});

test("coordinated and comparative source mentions retain real retrieval ambiguity on large projects", async () => {
  seed();
  const { buildProjectChatRetrievalRequest } = chatLoad("../ai/project-chat.ts");
  const documents = fixture.documents.map((document, index) => ({ ...document, title: `Bilag ${index + 1} Drift`, file_name: `0${index + 1}_Bilag_${index + 1}_Drift.pdf`, raw_text: `${document.raw_text}\n${"Fiktiv bakgrunn. ".repeat(6500)}` }));
  const id = fixture.cases[0].expected_requirement_id;
  for (const question of [`Hva sier ${id} i Bilag 1 og 2?`, `Hvordan henger ${id} sammen med Bilag 2?`, `Er ${id} i strid med Bilag 2?`, `${id} viser til Bilag 2, hva betyr det?`, `Sammenlign ${id} i Bilag 2 med Bilag 1.`, `${id} i Bilag 2 viser til Bilag 1, hva betyr det?`, `${id} står ikke i Bilag 2, hvor står det?`, `${id} viser til kravene i Bilag 2, hva betyr det?`, `Står ${id} bare i Bilag 2?`, `Står ${id} andre steder enn i Bilag 2?`, `Hvor ellers enn i Bilag 2 står ${id}?`, `Er ${id} i Bilag 2 i konflikt med tidligere krav?`]) {
    const { request } = await buildProjectChatRetrievalRequest({ question, recentMessages: [], customerDocument: documents[0], solutionDocument: null, supportingDocuments: [documents[1]] }, { skipRewrite: true });
    const result = await retrieveDocumentSnippetsWithMetadata({ ...request, limit: 3, rerank: undefined });
    assert.equal(result.telemetry.requirementLookupTruncated, true, question);
    assert.equal(result.telemetry.quality.sufficient, false, question);
  }
  const { request } = await buildProjectChatRetrievalRequest({ question: `Hva sier ${id} ifølge Bilag 2?`, recentMessages: [], customerDocument: documents[0], solutionDocument: null, supportingDocuments: [documents[1]] }, { skipRewrite: true });
  const result = await retrieveDocumentSnippetsWithMetadata({ ...request, limit: 3, rerank: undefined });
  assert.equal(result.telemetry.requirementLookupTruncated, false);
  assert.deepEqual(result.snippets.filter(row => row.kind === "requirement_row").map(row => row.sourceId), [documents[1].id]);
});


test("parenthesized chapter scope reaches the real authoritative lookup", async () => {
  seed();
  const { buildProjectChatRetrievalRequest } = chatLoad("../ai/project-chat.ts");
  const id = fixture.cases[0].expected_requirement_id;
  const documents = fixture.documents.map((document, index) => ({ ...document, title: `Bilag ${index + 1} Drift` }));
  const source = documents[0];
  setDocumentChunksTestRequirementRegister(source.id, encryptJson({ documentId: source.id, projectId: source.project_id, sourceRevision: source.chunk_source_revision,
    requirementRegister: { version: 1, rows: fixture.registers[source.id].map((row, index) => ({ ...row, heading: `${index + 1} Beredskap` })) } }));
  for (const question of [`Hva sier ${id} i Bilag 1 (kapittel 3)?`, `Hva sier ${id} i Bilag 1, kapittel 3?`]) {
    const { request } = await buildProjectChatRetrievalRequest({ question, recentMessages: [], customerDocument: source, solutionDocument: null, supportingDocuments: [documents[1]] }, { skipRewrite: true });
    assert.equal(request.requirementHeading, "3");
    const result = await retrieveDocumentSnippetsWithMetadata({ ...request, limit: 2, rerank: undefined });
    assert.equal(result.telemetry.requirementLookupTruncated, false);
    const rows = result.snippets.filter(item => item.kind === "requirement_row");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].headingPath, ["3 Beredskap"]);
  }
});


test("an original-source scope retains valid persisted amendment evidence without lookup failure", async () => {
  seed();
  const { buildProjectChatRetrievalRequest } = chatLoad("../ai/project-chat.ts");
  const id = fixture.cases[0].expected_requirement_id;
  const source = { ...fixture.documents[0], title: "Bilag 1 Drift", chunk_source_revision: 3 };
  const amendment = { ...fixture.documents[1], id: "contract-v2-amendment-valid", title: "Rettelser", raw_text: `# Rettelser\n${id} endres til «Leverandøren skal holde fire kurs».`, structure_map: [] };
  const rows = await buildIngestionRequirementRegister(amendment);
  assert.ok(rows?.some(row => row.id === id), "The actual ingestion owner must produce the amendment row.");
  for (const [document, documentRows] of [[source, fixture.registers[source.id].map(row => ({ ...row, heading: "3 Drift" }))], [amendment, rows]]) {
    setDocumentChunksTestRequirementRegister(document.id, encryptJson({ documentId: document.id, projectId: document.project_id, sourceRevision: document.chunk_source_revision,
      requirementRegister: { version: 2, rows: documentRows } }));
  }
  const input = { projectId: source.project_id, projectName: "Fiktiv", question: `Hva sier ${id} i Bilag 1?`, recentMessages: [], customerDocument: source, solutionDocument: null, supportingDocuments: [amendment] };
  const { request } = await buildProjectChatRetrievalRequest(input, { skipRewrite: true });
  assert.deepEqual(request.documents.map(document => document.id), [source.id, amendment.id]);
  const result = await retrieveDocumentSnippetsWithMetadata({ ...request, limit: 10, rerank: undefined });
  assert.equal(result.telemetry.requirementLookupFailed, false);
  assert.equal(result.telemetry.requirementLookupTruncated, false);
  assert.equal(result.telemetry.quality.sufficient, true);
  assert.deepEqual(result.telemetry.missingRequirementIds, []);
  const authoritative = result.snippets.filter(item => item.kind === "requirement_row");
  assert.ok(authoritative.some(row => row.sourceId === amendment.id && row.text.includes("holde fire kurs")));
  const chapterRequest = await buildProjectChatRetrievalRequest({ ...input, question: `Hva sier ${id} i Bilag 1, kapittel 3?` }, { skipRewrite: true });
  const chapterResult = await retrieveDocumentSnippetsWithMetadata({ ...chapterRequest.request, limit: 10, rerank: undefined });
  assert.equal(chapterResult.telemetry.requirementLookupFailed, false);
  assert.equal(chapterResult.telemetry.requirementLookupTruncated, false);
  assert.equal(chapterResult.telemetry.quality.sufficient, true);
  assert.ok(chapterResult.snippets.some(row => row.kind === "requirement_row" && row.sourceId === amendment.id && row.text.includes("holde fire kurs")), "The amendment's own heading cannot remove it from an original-chapter lookup.");
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-amendment-chat-"));
  const previousRewrite = process.env.RAG_QUERY_REWRITE;
  process.env.RAG_QUERY_REWRITE = "off";
  globalThis.__amendmentChatResult = result;
  try {
    const retrieval = path.join(directory, "retrieval.cjs"), completion = path.join(directory, "completion.cjs");
    writeFileSync(retrieval, "exports.retrieveDocumentSnippetsWithMetadata=async()=>globalThis.__amendmentChatResult;");
    writeFileSync(completion, 'exports.createTextCompletionStream=async()=> (async function*(){yield "Lokalt testsvar.";})();');
    const run = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@": frontend, "server-only": "/dev/null", "@/lib/server/document-chunks": retrieval, "@/lib/server/ai/completion": completion } });
    const { streamProjectChat } = run("../ai/project-chat.ts");
    const output = await streamProjectChat(input);
    let answer = ""; for await (const piece of output.stream) answer += piece;
    assert.equal(answer, "Lokalt testsvar.", "Real lookup telemetry must allow the chat completion path.");
  } finally {
    if (previousRewrite === undefined) delete process.env.RAG_QUERY_REWRITE; else process.env.RAG_QUERY_REWRITE = previousRewrite;
    delete globalThis.__amendmentChatResult; rmSync(directory, {recursive: true, force: true});
  }
});

test("ambiguous document scope cannot apply one document's chapter to all occurrences", async () => {
  seed();
  const { buildProjectChatRetrievalRequest } = chatLoad("../ai/project-chat.ts");
  const id = fixture.cases[0].expected_requirement_id;
  const documents = fixture.documents.map((document, index) => ({ ...document, title: `Bilag ${index + 1} Drift`, chunk_source_revision: 40,
    raw_text: document.raw_text + "\n" + "Bakgrunn. ".repeat(10000) }));
  for (const [index, document] of documents.entries()) {
    setDocumentChunksTestRequirementRegister(document.id, encryptJson({ documentId: document.id, projectId: document.project_id, sourceRevision: document.chunk_source_revision,
      requirementRegister: { version: 1, rows: fixture.registers[document.id].map(row => ({ ...row, heading: `${index === 0 ? 5 : 3} Drift` })) } }));
  }
  for (const question of [
    `Hvordan henger ${id} sammen med Bilag 2, kapittel 3?`,
    `Hva sier ${id} i Bilag 1 og Bilag 2, kapittel 3?`,
    `Hva sier ${id} i Bilag 1 og 2 (kapittel 3)?`,
  ]) {
    const { request } = await buildProjectChatRetrievalRequest({ question, recentMessages: [], customerDocument: documents[0], solutionDocument: null, supportingDocuments: [documents[1]] }, { skipRewrite: true });
    assert.equal(request.requirementHeading, undefined);
    const result = await retrieveDocumentSnippetsWithMetadata({ ...request, limit: 3, rerank: undefined });
    assert.equal(result.telemetry.requirementLookupTruncated, true, question);
    assert.equal(result.telemetry.quality.sufficient, false, question);
  }
});
