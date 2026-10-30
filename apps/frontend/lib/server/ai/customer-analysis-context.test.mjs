import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

// The live test's customer analysis saw only the first 12,000 characters of
// the customer document and missed budgets, options and a corrections
// chapter near the end. This drives the real legacy analysis through the
// OpenAI SDK against a local stand-in and inspects the prompt it sends.
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion", created: 0, model: "gpt-test",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ customer_profile_summary: "Testkunde." }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENAI_API_KEY = "customer-analysis-context-test";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
delete process.env.DOCUMENT_ANALYSIS_VERSION;

const directory = mkdtempSync(path.join(tmpdir(), "anbud-analysis-context-"));
const dataApi = path.join(directory, "data-api.cjs");
writeFileSync(dataApi, `exports.createServiceClient = () => ({ from: () => ({ insert: async () => ({ error: null }) }) });`);
const retrieval = path.join(directory, "retrieval.cjs");
writeFileSync(retrieval, `exports.retrieveDocumentSnippetsWithMetadata = async (input) => {
  globalThis.__analysisRetrievalCalls = (globalThis.__analysisRetrievalCalls ?? 0) + 1;
  return { snippets: [], telemetry: { durationMs: 0, usedHybridSearch: false, quality: { sufficient: false } } };
};`);
const jiti = createJiti(path.join(frontendRoot, "customer-analysis-context-tests.cjs"), {
  alias: {
    "@/lib/server/data-api": dataApi,
    "@/lib/server/document-chunks": retrieval,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
  interopDefault: true,
});
const { analyzeCustomerDocuments } = await jiti.import(path.join(frontendRoot, "lib/server/ai.ts"));

test.after(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

const document = (id, role, raw_text, file_format = "docx") => ({
  id, project_id: "project-1", role, title: id, file_name: `${id}.${file_format}`, file_format, raw_text,
  structure_map: [], chunk_source_revision: 1,
});

test("a customer document that fits is analysed whole, without duplicate retrieval", async () => {
  requests.length = 0;
  globalThis.__analysisRetrievalCalls = 0;
  const lateChapter = "9 Rettelser: Den økonomiske rammen for grunnleveransen er 42 MNOK eksklusive opsjoner.";
  const customerText = `1 Innledning\n${"Kunden beskriver dagens situasjon og behov. ".repeat(700)}\n${lateChapter}`;
  assert.ok(customerText.length > 12_000 && customerText.length < 60_000);
  await analyzeCustomerDocuments({
    projectName: "Fiktiv",
    customerDocument: document("Bilag 1", "primary_customer_document", customerText),
    supportingDocuments: [document("Kravdokument", "supporting_document", "Ark: Tildelingskriterier\nRad 2: A2: K1 | B2: Pris | C2: 40 %", "xlsx")],
  });
  const user = requests.at(-1).messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  assert.ok(user.includes(lateChapter), "the end of the customer document must reach the model");
  assert.ok(user.includes("Rad 2: A2: K1 | B2: Pris | C2: 40 %"), "a small supporting document is included whole");
  assert.equal(globalThis.__analysisRetrievalCalls, 0, "nothing is left for retrieval to add");
  assert.match(user, /påpeke motstriden eksplisitt/u);
});

test("a customer document that does not fit keeps the head and adds retrieval", async () => {
  requests.length = 0;
  globalThis.__analysisRetrievalCalls = 0;
  const customerText = "Kunden beskriver behov. ".repeat(4000);
  assert.ok(customerText.length > 60_000);
  await analyzeCustomerDocuments({
    projectName: "Fiktiv",
    customerDocument: document("Bilag 1", "primary_customer_document", customerText),
    supportingDocuments: [],
  });
  assert.equal(globalThis.__analysisRetrievalCalls, 1);
});
