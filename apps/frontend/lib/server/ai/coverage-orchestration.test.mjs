import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

// Drives the real solution-coverage workflow through the real OpenAI SDK
// against a local stand-in server, to cover what helper tests cannot: failed
// batches, parallel retries, ordered merging and verified quote binding.
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const batches = [];
let behaviour = () => "ok";
let inFlight = 0;
let maxRetryInFlight = 0;
const server = createServer(async (request, response) => {
  let body = "";
  let payload;
  try {
    for await (const chunk of request) body += chunk;
    payload = JSON.parse(body);
  } catch {
    // Aborted request (e.g. a cancelled SDK retry).
    response.destroy();
    return;
  }
  const user = payload.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const registry = /### Krav som skal vurderes\n"""\n([\s\S]*?)\n"""/u.exec(user);
  if (!registry) {
    response.writeHead(400).end("{}");
    return;
  }
  const rows = JSON.parse(registry[1]);
  const key = rows.map((row) => row.nr).join(",");
  batches.push(key);
  const attempt = batches.filter((seen) => seen === key).length;
  inFlight += 1;
  if (attempt > 2) maxRetryInFlight = Math.max(maxRetryInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 40));
  inFlight -= 1;
  if (behaviour(key, attempt) === "fail") {
    response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream" } }));
    return;
  }
  const text = (row) => JSON.stringify(row);
  const answered = (row) => /RPO/u.test(text(row));
  const sso = (row) => /SSO/u.test(text(row));
  const content = JSON.stringify({
    rows: rows.map((row) =>
      sso(row)
        ? {
            nr: row.nr,
            ref: row.ref,
            assessment: "Godt",
            rationale: "MFA via SSO er beskrevet.",
            evidence: "All administrativ pålogging krever MFA via oppdragsgivers SSO.",
            recommendation: "Ingen.",
          }
        : answered(row)
        ? {
            nr: row.nr,
            ref: row.ref,
            assessment: "Godt",
            rationale: "Timesvis sikkerhetskopi dekker RPO-kravet.",
            // A truncated quote: the full sentence must be what is stored.
            evidence: "virksomhetskritiske systemer sikkerhetskopieres hver time til en separat lokasjon",
            recommendation: "Bekreft RPO i avtalen.",
          }
        : {
            nr: row.nr,
            ref: row.ref,
            assessment: "Mangler",
            rationale: "Bilag 2 beskriver ikke dette.",
            evidence: "Sammendrag: Leverandøren oppfyller alle krav i konkurransegrunnlaget.",
            recommendation: "Beskriv løsningen for kravet.",
          },
    ),
  });
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: payload.model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENAI_API_KEY = "coverage-orchestration-test";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;

const jiti = createJiti(path.join(frontendRoot, "coverage-orchestration-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));
const { buildSolutionRequirementCoverage } = await load("lib/server/ai.ts");
const { normalizeCustomerAnalysisResult } = await load(
  "lib/server/document-intelligence/customer-analysis-postprocess.ts",
);

const solutionDocument = {
  id: "solution-doc",
  project_id: "project-1",
  role: "primary_solution_document",
  title: "Bilag 2 - Løsningsbeskrivelse",
  file_name: "bilag2.pdf",
  file_format: "pdf",
  raw_text: [
    "[[SIDE:1]]",
    "Sammendrag: Leverandøren oppfyller alle krav i konkurransegrunnlaget.",
    "[[SIDE:2]]",
    "Kontinuitet. Vi har lang erfaring med drift. Alle virksomhetskritiske systemer sikkerhetskopieres hver time til en separat lokasjon, og gjenoppretting testes kvartalsvis.",
    "Tilgang. All administrativ pålogging krever MFA via oppdragsgivers SSO.",
  ].join("\n"),
  structure_map: [],
};
const topics = ["tilgangsstyring", "logging", "patching", "overvåking", "endringer", "kapasitet", "rapportering", "opplæring", "dokumentasjon", "beredskap", "lisenser"];
const ledger = [
  ...topics.map((topic, index) => ({
    id: `DRI-${String(index + 1).padStart(2, "0")}`,
    text: `Leverandøren skal beskrive rutiner for ${topic} for alle produksjonsmiljøer og dokumentere ansvar.`,
    pages: [1],
    heading: "6.4 Drift og forvaltning",
    documentId: "customer-doc",
    documentTitle: "Bilag 1",
    sourceExcerpt: `Kravgrunnlag: DRI-${String(index + 1).padStart(2, "0")} Leverandøren skal beskrive rutiner for ${topic}.`,
  })),
  {
    id: "SIK-02",
    text: "Administrativ tilgang skal kreve MFA og SSO.",
    pages: [1],
    heading: "6.3 Sikkerhet",
    documentId: "customer-doc",
    documentTitle: "Bilag 1",
    sourceExcerpt: "Kravgrunnlag: SIK-02 Administrativ tilgang skal kreve MFA og SSO.",
  },
  {
    id: "DAT-02",
    text: "For kritiske systemer skal RPO ikke overstige 1 time.",
    pages: [1],
    heading: "6.6 Sikkerhetskopi",
    documentId: "customer-doc",
    documentTitle: "Bilag 1",
    sourceExcerpt: "Kravgrunnlag: DAT-02 For kritiske systemer skal RPO ikke overstige 1 time.",
  },
];
const coverageInput = () => ({
  projectName: "Test",
  solutionDocument,
  solutionRequirementLedger: [],
  sourceRequirementLedger: ledger,
  requirementDocuments: [],
  customerAnalysis: normalizeCustomerAnalysisResult({}),
});

test.after(() => server.close());

test("failed coverage batches are retried in parallel and merged in requirement order", async () => {
  batches.length = 0;
  // Every batch fails on its first request (and the SDK's own retry), then succeeds.
  behaviour = (_key, attempt) => (attempt <= 2 ? "fail" : "ok");
  const coverage = await buildSolutionRequirementCoverage(coverageInput());
  assert.equal(coverage.items.length, ledger.length);
  assert.deepEqual(
    coverage.items.map((item) => item.order_index),
    ledger.map((_, index) => index),
  );
  assert.ok(new Set(batches).size >= 2, "the ledger should span several batches");

  // Failed batches are retried concurrently, not one after another.
  assert.ok(maxRetryInFlight >= 2, `retries in flight: ${maxRetryInFlight}`);
  const byRef = (ref) => coverage.items.find((item) => item.reference.startsWith(ref));
  const sso = byRef("SIK-02");
  assert.equal(sso.assessment, "Godt");
  assert.equal(sso.answer_document_id, "solution-doc");

  const rpo = byRef("DAT-02");
  assert.equal(rpo.assessment, "Godt");
  assert.equal(rpo.answer_document_id, "solution-doc");
  // The stored evidence is the whole source sentence, not the model's excerpt.
  assert.match(rpo.evidence, /^Alle virksomhetskritiske systemer .* testes kvartalsvis\./u);

  // "Mangler" stays "Mangler" even though a verbatim (blanket) quote was given.
  for (const item of coverage.items.filter((candidate) => candidate !== sso && candidate !== rpo)) {
    assert.equal(item.assessment, "Mangler", item.reference);
    assert.equal(item.answer_document_id, null);
  }
});

test("a batch that keeps failing stops the evaluation with a user-facing message", async () => {
  batches.length = 0;
  behaviour = (key) => (key.split(",").includes("13") ? "fail" : "ok");
  await assert.rejects(buildSolutionRequirementCoverage(coverageInput()), (error) => {
    assert.equal(error.name, "WorkflowIncompleteError");
    assert.match(error.publicMessage, /1 av \d+ AI-batcher \(\d+ krav\) ikke ble fullført/u);
    assert.doesNotMatch(error.publicMessage, /upstream|500/u);
    return true;
  });
});
