import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

// Regressions from the 2026-10-29 production test: AI calls timed out, prose
// solution answers were never bound to requirements, and Bilag 2 page
// context was chosen from the customer document's page numbers.
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(path.join(frontendRoot, "live-test-reliability-tests.cjs"), {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
  interopDefault: true,
});
const load = (file) => jiti.import(path.join(frontendRoot, file));

const {
  bindVerifiedSolutionQuote,
  buildRequirementCoveragePageContext,
  coverageItemFromBatchRow,
  matchCenteredExcerpt,
} = await load("lib/server/ai/requirement-coverage.ts");
const { analyzeRequirementCoverageIntegrity } = await load(
  "lib/server/requirements/evaluation-coverage-integrity.ts",
);
const { boundedByProjectWorkflowDeadline, runWithProjectWorkflowContext } = await load(
  "lib/server/project-workflow-cancellation.ts",
);
const { isAiCallTimeoutError, runJsonCompletion } = await load(
  "lib/server/ai/json-completion.ts",
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
    "Sammendrag: Leverandøren oppfyller alle krav.",
    "[[SIDE:2]]",
    "4.1 Sikkerhetskopi",
    "Alle virksomhetskritiske systemer sikkerhetskopieres hver time til en separat",
    "lokasjon, og gjenoppretting testes kvartalsvis med dokumentert tids-",
    "måling mot avtalt gjenopprettingstid.",
  ].join("\n"),
};

const unansweredRequirement = {
  id: "KD-10",
  text: "For kritiske systemer skal RPO ikke overstige 1 time.",
  heading: "Kontinuitet",
  pages: [1],
  documentId: "customer-doc",
  documentTitle: "Bilag 1",
  sourceExcerpt: "Kravgrunnlag: KD-10 For kritiske systemer skal RPO ikke overstige 1 time.",
  answerExcerpt: "",
};

const verbatimQuote =
  "Alle virksomhetskritiske systemer sikkerhetskopieres hver time til en separat lokasjon, og gjenoppretting testes kvartalsvis med dokumentert tidsmåling mot avtalt gjenopprettingstid.";

test("a verbatim Bilag 2 quote binds a prose answer, including PDF line-break hyphens", () => {
  const bound = bindVerifiedSolutionQuote({
    entry: unansweredRequirement,
    quote: `«${verbatimQuote}»`,
    solutionDocument,
  });
  assert.ok(bound);
  assert.equal(bound.answerDocumentId, "solution-doc");
  assert.equal(bound.answerReference, "Bilag 2 - Løsningsbeskrivelse, side 2");
  assert.match(bound.sourceExcerpt, /^Kravgrunnlag: KD-10 .* \| Svarrad: /u);
});

test("fabricated, elided or restated quotes are not accepted as answers", () => {
  for (const quote of [
    "Alle systemer sikkerhetskopieres hvert kvarter til to datasentre i Norge med full replikering.",
    "Alle virksomhetskritiske systemer sikkerhetskopieres ... testes kvartalsvis.",
    "For kritiske systemer skal RPO ikke overstige 1 time.",
    "kort",
    undefined,
  ]) {
    assert.equal(
      bindVerifiedSolutionQuote({ entry: unansweredRequirement, quote, solutionDocument }),
      null,
      String(quote),
    );
  }
});

test("a requirement with an existing matched answer keeps it", () => {
  assert.equal(
    bindVerifiedSolutionQuote({
      entry: { ...unansweredRequirement, answerExcerpt: "Svar: Vi tar sikkerhetskopi hver time av alle kritiske systemer." },
      quote: verbatimQuote,
      solutionDocument,
    }),
    null,
  );
});

test("a verified quote lets the model's assessment stand and passes the integrity check", () => {
  const row = {
    nr: 1,
    ref: "KD-10",
    assessment: "Godt",
    rationale: "Timesvis sikkerhetskopi dekker RPO-kravet.",
    evidence: verbatimQuote,
    recommendation: "Bekreft RPO eksplisitt i avtalen.",
  };
  const bound = bindVerifiedSolutionQuote({ entry: unansweredRequirement, quote: row.evidence, solutionDocument });
  const item = coverageItemFromBatchRow({ row, entry: bound, orderIndex: 0 });
  assert.equal(item.assessment, "Godt");
  assert.equal(item.answer_document_id, "solution-doc");
  assert.ok(item.evidence.includes("sikkerhetskopieres hver time"));

  const coverage = {
    total_requirements: 1,
    assessed_requirements: 1,
    coverage_summary: { godt: 1, darlig: 0, mangler: 0, uklart: 0 },
    items: [item],
  };
  const report = analyzeRequirementCoverageIntegrity({ sourceLedger: [bound], coverage });
  assert.deepEqual(
    report.issues.filter((issue) => issue.code === "good_evidence_not_answer_bound"),
    [],
  );

  // Without a verified quote the authoritative requirement stays Mangler.
  const unbound = coverageItemFromBatchRow({
    row: { ...row, evidence: "Fritt formulert påstand om dekning." },
    entry: unansweredRequirement,
    orderIndex: 0,
  });
  assert.equal(unbound.assessment, "Mangler");
});

test("excerpts centre on the matching sentence and keep its neighbours", () => {
  const filler = "Plattformen driftes etter ITIL-prosesser med faste rutiner. ".repeat(12);
  const text = `${filler}Leverandøren tilbyr ikke døgnbemanning i helger. Hendelser med prioritet 1 har responstid på 30 minutter. ${filler}`;
  const excerpt = matchCenteredExcerpt(text, "responstid prioritet hendelser 15 minutter", 300);
  assert.ok(excerpt.length <= 300);
  assert.match(excerpt, /responstid på 30 minutter/u);
  // The qualification right before the match must survive.
  assert.match(excerpt, /ikke døgnbemanning i helger/u);
});

test("AI call timeouts are capped by the job deadline and skipped near it", () => {
  const now = 1_000_000;
  const within = (deadlineAt, run) =>
    runWithProjectWorkflowContext({ signal: new AbortController().signal, deadlineAt }, run);

  assert.equal(
    within(now + 900_000, () => boundedByProjectWorkflowDeadline(180_000, { reserveMs: 300_000, now })),
    180_000,
  );
  assert.equal(
    within(now + 400_000, () => boundedByProjectWorkflowDeadline(180_000, { reserveMs: 300_000, now })),
    100_000,
  );
  assert.equal(
    within(now + 310_000, () => boundedByProjectWorkflowDeadline(180_000, { reserveMs: 300_000, now })),
    null,
  );
  // Outside a job there is no deadline to respect.
  assert.equal(boundedByProjectWorkflowDeadline(180_000, { reserveMs: 300_000, now }), 180_000);
});

test("an AI call that never answers fails with a recognisable timeout", async () => {
  const error = await runJsonCompletion({
    system: "system",
    user: "user",
    timeoutMs: 20,
    maxRetries: 0,
    getClient: async () => ({
      chat: { completions: { create: () => new Promise(() => {}) } },
      responses: { create: async () => ({}) },
    }),
    defaultModel: "gpt-test",
    defaultReasoningEffort: "low",
    supportsCustomTemperature: () => true,
  }).catch((caught) => caught);
  assert.equal(isAiCallTimeoutError(error), true);
  assert.equal(isAiCallTimeoutError(new Error("ugyldig JSON")), false);
  assert.equal(isAiCallTimeoutError(new Error("wrapped", { cause: error })), true);
});

test("Bilag 2 page context never uses the customer document's page numbers", () => {
  // A DOCX requirement reports page 1; that used to select Bilag 2's summary.
  assert.equal(
    buildRequirementCoveragePageContext({ document: solutionDocument, entries: [unansweredRequirement] }),
    "",
  );
  const answered = {
    ...unansweredRequirement,
    answerExcerpt: "Alle virksomhetskritiske systemer sikkerhetskopieres hver time til en separat lokasjon",
  };
  const context = buildRequirementCoveragePageContext({ document: solutionDocument, entries: [answered] });
  assert.match(context, /side 2/u);
  assert.match(context, /sikkerhetskopieres hver time/u);
});
