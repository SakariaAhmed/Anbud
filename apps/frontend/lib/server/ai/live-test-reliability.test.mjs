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
  requirementGenericStems,
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
  const { entry: bound, uncertain } = bindVerifiedSolutionQuote({
    entry: unansweredRequirement,
    quote: `«${verbatimQuote}»`,
    solutionDocument,
  });
  assert.equal(uncertain, false);
  assert.equal(bound.answerDocumentId, "solution-doc");
  assert.equal(bound.answerReference, "Bilag 2 - Løsningsbeskrivelse, side 2");
  assert.match(bound.sourceExcerpt, /^Kravgrunnlag: KD-10 .* \| Svarrad: /u);
});

test("an elided quote binds to its complete Bilag 2 sentence, never to the elided text", () => {
  const bound = bindVerifiedSolutionQuote({
    entry: unansweredRequirement,
    quote: "Alle virksomhetskritiske systemer sikkerhetskopieres ... testes kvartalsvis.",
    solutionDocument,
  });
  assert.match(bound.entry.answerExcerpt, /hver time til en separat lokasjon, og gjenoppretting testes kvartalsvis/u);
});

test("a table row quoted without cell boundaries, or two stitched sentences, bind verbatim", () => {
  const doc = {
    ...solutionDocument,
    raw_text: [
      "[[SIDE:7]]",
      "7.2 Responstider",
      "| Prioritet | Responstid | Løsningstid | Tilgjengelighet |",
      "| P1 Kritisk | 15 minutter | 4 timer | Hele døgnet |",
      "P1-hendelser meldes på egen vakttelefon som er betjent hele døgnet.",
      "",
      "5.3 Kundeportal",
      "Kundeportalen gir oppdragsgiver mulighet til å bestille tjenester og følge saker. Portalen støtter føderert pålogging. Leveringstid for standardleveranser fremgår av tjenestekatalogen, som avtales i etableringsfasen.",
    ].join("\n"),
  };
  const response = { ...unansweredRequirement, id: "TJN-03", text: "Hendelser med prioritet 1 skal ha responstid på høyst 15 minutter hele døgnet.", heading: "" };
  const row = bindVerifiedSolutionQuote({ entry: response, quote: "P1 Kritisk 15 minutter 4 timer Hele døgnet", assessment: "Godt", solutionDocument: doc });
  assert.ok(row, "the row binds without its cell markers");
  const portal = { ...unansweredRequirement, id: "DRI-03", text: "Standardleveranser fra tjenestekatalogen bør leveres innen 1 virkedag.", heading: "" };
  const stitched = bindVerifiedSolutionQuote({
    entry: portal,
    quote: "Kundeportalen gir oppdragsgiver mulighet til å bestille tjenester og følge saker. Leveringstid for standardleveranser fremgår av tjenestekatalogen, som avtales i etableringsfasen.",
    assessment: "Godt",
    solutionDocument: doc,
  });
  // The part that is verbatim and relevant, as it stands in Bilag 2.
  assert.match(stitched.entry.answerExcerpt, /^Leveringstid for standardleveranser fremgår av tjenestekatalogen/u);
});

test("fabricated or restated quotes are not accepted as answers", () => {
  for (const quote of [
    "Alle systemer sikkerhetskopieres hvert kvarter til to datasentre i Norge med full replikering.",
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
  const { entry: bound } = bindVerifiedSolutionQuote({ entry: unansweredRequirement, quote: row.evidence, solutionDocument });
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

const { APIConnectionTimeoutError } = await import("openai/error");

test("a quote is widened to its whole sentence, so a dropped negation still counts", () => {
  const declining = {
    ...solutionDocument,
    raw_text: "[[SIDE:3]]\nOm lagring. Vi kan ikke levere kryptert lagring av alle kundedata i Norge og Sverige. Andre tjenester leveres som beskrevet.",
  };
  const entry = {
    ...unansweredRequirement,
    id: "SIK-07",
    text: "Alle kundedata skal ha kryptert lagring i Norge og Sverige.",
  };
  const { entry: bound } = bindVerifiedSolutionQuote({
    entry,
    quote: "kryptert lagring av alle kundedata i Norge og Sverige.",
    assessment: "Godt",
    solutionDocument: declining,
  });
  assert.equal(bound.answerExcerpt, "Vi kan ikke levere kryptert lagring av alle kundedata i Norge og Sverige.");
  const item = coverageItemFromBatchRow({
    row: { nr: 1, ref: "SIK-07", assessment: "Godt", rationale: "Dekket.", evidence: bound.answerExcerpt, recommendation: "Ingen." },
    entry: bound,
    orderIndex: 0,
  });
  assert.notEqual(item.assessment, "Godt");
});

test("irrelevant, blanket or missing-answer quotes are not bound", () => {
  const document = {
    ...solutionDocument,
    raw_text: `${solutionDocument.raw_text}\n[[SIDE:3]]\nVi har lang erfaring med drift av Microsoft-plattformer for offentlige virksomheter i Norge. Leverandøren oppfyller alle krav i konkurransegrunnlaget.`,
  };
  const bind = (quote, assessment = "Godt") =>
    bindVerifiedSolutionQuote({ entry: unansweredRequirement, quote, assessment, solutionDocument: document });
  assert.equal(bind("Vi har lang erfaring med drift av Microsoft-plattformer for offentlige virksomheter i Norge."), null);
  assert.equal(bind("Leverandøren oppfyller alle krav i konkurransegrunnlaget."), null);
  assert.equal(bind(verbatimQuote, "Mangler"), null);
  assert.ok(bind(verbatimQuote, "Dårlig"));
});

test("an answer may repeat the requirement before saying how it is met", () => {
  const document = {
    ...solutionDocument,
    raw_text: "[[SIDE:4]]\nFor kritiske systemer skal RPO ikke overstige 1 time. Dette oppnås med kontinuerlig replikering til et sekundært datasenter og timesvis sikkerhetskopi.",
  };
  const bound = bindVerifiedSolutionQuote({
    entry: unansweredRequirement,
    quote: "For kritiske systemer skal RPO ikke overstige 1 time. Dette oppnås med kontinuerlig replikering til et sekundært datasenter og timesvis sikkerhetskopi.",
    assessment: "Godt",
    solutionDocument: document,
  });
  assert.ok(bound);
  assert.match(bound.entry.answerExcerpt, /kontinuerlig replikering/u);
});

test("PDF ligatures and typographic apostrophes do not block a verbatim quote", () => {
  const document = {
    ...solutionDocument,
    raw_text: "[[SIDE:2]]\nKritiske systemer har deﬁnert RPO på én time gjennom timesvis sikkerhetskopi til leverandørens sekundære datasenter.",
  };
  const bound = bindVerifiedSolutionQuote({
    entry: unansweredRequirement,
    quote: "Kritiske systemer har definert RPO på én time gjennom timesvis sikkerhetskopi til leverandørens sekundære datasenter.",
    assessment: "Godt",
    solutionDocument: document,
  });
  assert.ok(bound);
});

test("the OpenAI SDK's own timeout error is recognised", () => {
  const sdkTimeout = new APIConnectionTimeoutError();
  // Its name is the plain "Error"; detection must not depend on it.
  assert.equal(sdkTimeout.name, "Error");
  assert.equal(isAiCallTimeoutError(sdkTimeout), true);
});

test("a long matching sentence is windowed around the match", () => {
  const preceding = `${"Innledende tekst om plattformen og dens drift ".repeat(10)}uten punktum`;
  const text = `${preceding}. Hendelser med prioritet 1 har en responstid på høyst 15 minutter og løses innen fire timer hele døgnet. Slutt.`;
  const excerpt = matchCenteredExcerpt(text, "responstid prioritet hendelser", 150);
  assert.ok(excerpt.length <= 150);
  assert.match(excerpt, /responstid på høyst 15 minutter/u);
  const longSentence = `${"Plattformen har mange egenskaper og funksjoner, ".repeat(8)}inkludert responstid på 15 minutter for kritiske hendelser og ${"mer tekst ".repeat(20)}.`;
  assert.match(matchCenteredExcerpt(longSentence, "responstid kritiske hendelser", 160), /responstid på 15 minutter/u);
});

test("relevance tiers: paraphrases bind, generic overlap does not, weak overlap is uncertain", () => {
  const document = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:5]]\n${text}` });
  const requirement = (text) => ({ ...unansweredRequirement, id: "X-1", heading: "", text });
  const bind = (entry, quote, raw = quote) =>
    bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: document(raw) });

  // A paraphrase sharing only one stem is bound, but not as certain.
  const daily = bind(
    requirement("Sikkerhetskopiering skal utføres daglig."),
    "Vi sikkerhetskopierer alle data hver dag til et separat datasenter.",
  );
  assert.ok(daily);
  assert.equal(daily.uncertain, true);
  // Inflection, compounds and acronyms count as shared terms.
  const encrypted = bind(
    requirement("Logging og kryptering skal gjelde alle kundedata."),
    "Alle kundedata logges og krypteres automatisk med AES-256 ved lagring.",
  );
  assert.equal(encrypted?.uncertain, false);
  assert.equal(
    bind(requirement("Administrativ tilgang skal kreve MFA og SSO."), "All administrativ tilgang krever MFA via oppdragsgivers SSO-løsning.")?.uncertain,
    false,
  );
  // Overlap on generic verbs only is not evidence.
  assert.equal(
    bind(
      requirement("Leverandøren skal dokumentere logging av administratorhandlinger."),
      "Vi dokumenterer rutiner for løpende kundedialog og årlige statusmøter.",
    ),
    null,
  );
  // Paraphrased blanket compliance claims are rejected.
  assert.equal(
    bind(requirement("Sikkerhetskopiering skal utføres daglig."), "Løsningen tilfredsstiller samtlige krav til sikkerhetskopiering og drift."),
    null,
  );
});

test("a following qualifying sentence is part of the answer; cut context is uncertain", () => {
  const entry = { ...unansweredRequirement, id: "SIK-07", heading: "", text: "Alle kundedata skal ha kryptert lagring i Norge." };
  const qualified = bindVerifiedSolutionQuote({
    entry,
    quote: "Kryptert lagring av alle kundedata leveres i Norge.",
    assessment: "Godt",
    solutionDocument: { ...solutionDocument, raw_text: "[[SIDE:2]]\nKryptert lagring av alle kundedata leveres i Norge. Dette inngår ikke i fastprisen. Neste tema." },
  });
  assert.match(qualified.entry.answerExcerpt, /Dette inngår ikke i fastprisen\.$/u);

  const filler = "og plattformen driftes med faste rutiner ".repeat(12);
  const cut = bindVerifiedSolutionQuote({
    entry,
    quote: "kryptert lagring av alle kundedata leveres i Norge",
    assessment: "Godt",
    solutionDocument: { ...solutionDocument, raw_text: `[[SIDE:2]]\nVi tilbyr ikke dette ${filler}kryptert lagring av alle kundedata leveres i Norge ${filler}` },
  });
  assert.equal(cut.uncertain, true);
});

test("council round 2 probes: acronyms, cells, abbreviations and bare confirmations", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:6]]\n${text}` });
  const req = (text) => ({ ...unansweredRequirement, id: "Y-1", heading: "", text });
  const bind = (entry, quote, raw) =>
    bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: doc(raw ?? quote) });

  // One shared acronym is enough.
  assert.equal(
    bind(req("Løsningen skal støtte MFA og SSO."), "Pålogging skjer med MFA via oppdragsgivers identitetsplattform.")?.uncertain,
    false,
  );
  // A neighbouring table row cannot supply the relevance or the evidence.
  const table = "KRAV-1 | Overvåking hele døgnet | Ja, vi overvåker alle servere døgnet rundt | KRAV-3 | Månedlig rapportering av SLA | Rapport leveres kvartalsvis";
  assert.equal(bind(req("Leverandøren skal levere månedlig rapportering av SLA-oppnåelse."), "Ja, vi overvåker alle servere døgnet rundt", table), null);
  const reported = bind(req("Leverandøren skal levere månedlig rapportering av SLA-oppnåelse."), "Rapport leveres kvartalsvis", table);
  assert.ok(!reported || !/overvåker/u.test(reported.entry.answerExcerpt));
  // "f.eks." does not end the sentence, so the negation before it is seen.
  const abbreviated = bind(
    req("Alle kundedata skal ha kryptert lagring i Norge."),
    "kryptert lagring av alle kundedata i Norge.",
    "Vi leverer ikke alle tjenester, f.eks. kryptert lagring av alle kundedata i Norge.",
  );
  assert.match(abbreviated.entry.answerExcerpt, /^Vi leverer ikke/u);
  assert.equal(abbreviated.uncertain, true);
  // Restating the requirement and confirming it says nothing about how: it
  // is a real but thin answer, so it binds as uncertain ("Uklart").
  for (const confirmation of [
    "For kritiske systemer skal RPO ikke overstige 1 time. Leverandøren bekrefter at dette kravet er oppfylt.",
    "For kritiske systemer skal RPO ikke overstige 1 time; leverandøren bekrefter at dette kravet er oppfylt.",
  ]) {
    assert.equal(bind(req("For kritiske systemer skal RPO ikke overstige 1 time."), confirmation)?.uncertain, true, confirmation);
  }
});

test("stems common to many requirements in a tender are treated as generic", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    id: `M-${index}`,
    text: index < 5 ? `Migreringen av plattformen skal dokumenteres for system ${index}.` : `Rapportering nummer ${index} leveres månedlig.`,
    pages: [],
    heading: "",
  }));
  const generic = requirementGenericStems(entries);
  assert.ok(generic.has("plattform"));
  assert.ok(!generic.has("rapportering"));
});

test("council round 3 probes", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:7]]\n${text}` });
  const req = (text) => ({ ...unansweredRequirement, id: "Z-1", heading: "", text });
  const bind = (entry, quote, raw, genericStems) =>
    bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: doc(raw ?? quote), genericStems });
  const storage = req("Alle kundedata skal ha kryptert lagring i Norge.");

  // A following qualification without final punctuation or with "f.eks." counts.
  for (const raw of [
    "Kryptert lagring av alle kundedata leveres i Norge. Dette inngår ikke i leveransen",
    "Kryptert lagring av alle kundedata leveres i Norge. Dette gjelder f.eks. ikke kundedata fra testmiljøet.",
  ]) {
    const bound = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge.", raw);
    assert.match(bound.entry.answerExcerpt, /Dette/u, raw);
  }
  // An unrelated refusal in the same sentence or the next one is not this
  // requirement's answer, but it does make the link uncertain.
  const unrelated = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge", "Kryptert lagring av alle kundedata leveres i Norge, men telefonstøtte tilbys ikke.");
  assert.doesNotMatch(unrelated.entry.answerExcerpt, /telefonstøtte/u);
  assert.equal(unrelated.uncertain, true);
  const separate = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge.", "Kryptert lagring av alle kundedata leveres i Norge. Telefonstøtte tilbys ikke i helger.");
  assert.doesNotMatch(separate.entry.answerExcerpt, /Telefonstøtte/u);
  // Generic actor and solution words do not bind an unrelated sentence.
  assert.equal(
    bind(req("Tilbyderen skal beskrive hvordan løsningen logger alle administratorhandlinger."), "Tilbyderen har utviklet løsningen for enkel registrering av fravær og ferie."),
    null,
  );
  // Upper-case function words are not acronyms; an acronym must match whole.
  assert.equal(
    bind(req("Leverandøren SKAL varsle kunden om sikkerhetsbrudd innen 24 timer."), "Leverandøren skal sørge for opplæring av superbrukere hos kunden."),
    null,
  );
  assert.equal(bind(req("Løsningen skal støtte SSO."), "Vi benytter SSD-disker og SSOT som prinsipp for datamodellen."), null);
  // A topic word frequent in the tender lowers certainty but still binds.
  const generic = new Set(["sikkerhetskopi"]);
  const backup = bind(req("Leverandøren skal beskrive løsningen for sikkerhetskopiering."), "Sikkerhetskopiering skjer hver natt til et separat datasenter.", undefined, generic);
  assert.ok(backup);
  assert.equal(backup.uncertain, true);
  // A table row that restates the requirement and only says "Oppfylt".
  const row = bind(req("Løsningen skal støtte SSO via Entra ID."), "Løsningen skal støtte SSO via Entra ID", "Løsningen skal støtte SSO via Entra ID | Oppfylt, standard i plattformen |");
  assert.equal(row?.uncertain, true);
});

test("council round 4 probes: referring clauses stay, cell answers survive a full stop", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:8]]\n${text}` });
  const req = (text) => ({ ...unansweredRequirement, id: "W-1", heading: "", text });
  const referring = bindVerifiedSolutionQuote({
    entry: req("Alle kundedata skal ha kryptert lagring i Norge."),
    quote: "Kryptert lagring av alle kundedata leveres i Norge",
    assessment: "Godt",
    solutionDocument: doc("Kryptert lagring av alle kundedata leveres i Norge, men dette inngår ikke i leveransen."),
  });
  assert.match(referring.entry.answerExcerpt, /men dette inngår ikke i leveransen/u);
  const row = bindVerifiedSolutionQuote({
    entry: req("Løsningen skal støtte SSO via Entra ID."),
    quote: "Løsningen skal støtte SSO via Entra ID.",
    assessment: "Godt",
    solutionDocument: doc("Løsningen skal støtte SSO via Entra ID. | Oppfylt, standard i plattformen |"),
  });
  assert.equal(row?.uncertain, true);
  assert.match(row.entry.answerExcerpt, /Oppfylt/u);
});

test("council round 4 (second member): verbatim spans, limiting follow-ups, empty cells", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:9]]\n${text}` });
  const req = (text) => ({ ...unansweredRequirement, id: "V-1", heading: "", text });
  const storage = req("Alle kundedata skal ha kryptert lagring i Norge.");
  const bind = (entry, quote, raw) =>
    bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: doc(raw) });

  // Never stitched across a skipped clause: the stored answer is verbatim.
  const raw = "Kryptert lagring av alle kundedata leveres i Norge; telefonstøtte tilbys ikke; kundedata krypteres med AES-256.";
  const stitched = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge", raw);
  assert.ok(raw.includes(stitched.entry.answerExcerpt), stitched.entry.answerExcerpt);
  // A same-sentence qualification about the requirement stays.
  const limited = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge", "Kryptert lagring av alle kundedata leveres i Norge, men dette gjelder ikke arkivdata.");
  assert.match(limited.entry.answerExcerpt, /gjelder ikke arkivdata/u);
  // A referring follow-up that limits scope is attached and makes it uncertain.
  const scoped = bind(storage, "Kryptert lagring av alle kundedata leveres i Norge.", "Kryptert lagring av alle kundedata leveres i Norge. Dette gjelder kun produksjonsmiljøet.");
  assert.match(scoped.entry.answerExcerpt, /kun produksjonsmiljøet/u);
  assert.equal(scoped.uncertain, true);
  // An empty answer cell does not borrow the next row.
  assert.equal(
    bind(req("Løsningen skal støtte SSO via Entra ID."), "Løsningen skal støtte SSO via Entra ID", "Løsningen skal støtte SSO via Entra ID | | K-2 | Løsningen skal ha logging av alle administratorhandlinger |"),
    null,
  );
});

test("council round 5 probes: subjectless restrictions and multi-sentence answer cells", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:10]]\n${text}` });
  const storage = { ...unansweredRequirement, id: "U-1", heading: "", text: "Alle kundedata skal ha kryptert lagring i Norge." };
  for (const follow of ["Leveres som opsjon mot tillegg.", "Gjelder kun produksjonsmiljøet.", "Disse tjenestene tilbys bare som opsjon.", "Denne leveransen omfatter kun produksjonsmiljøet."]) {
    const bound = bindVerifiedSolutionQuote({
      entry: storage, quote: "Kryptert lagring av alle kundedata leveres i Norge.", assessment: "Godt",
      solutionDocument: doc(`Kryptert lagring av alle kundedata leveres i Norge. ${follow}`),
    });
    assert.equal(bound.uncertain, true, follow);
  }
  const cell = bindVerifiedSolutionQuote({
    entry: { ...storage, text: "Løsningen skal støtte SSO via Entra ID." },
    quote: "Løsningen skal støtte SSO via Entra ID.", assessment: "Godt",
    solutionDocument: doc("Løsningen skal støtte SSO via Entra ID. | Ja. Vi bruker Entra ID med SAML 2.0 for alle brukere. |"),
  });
  assert.match(cell.entry.answerExcerpt, /SAML 2\.0 for alle brukere/u);
});

test("a restriction that ends at a cell boundary still makes the link uncertain", () => {
  const storage = { ...unansweredRequirement, id: "T-1", heading: "", text: "Alle kundedata skal ha kryptert lagring i Norge." };
  for (const raw of [
    "Kryptert lagring av alle kundedata leveres i Norge. Gjelder kun produksjonsmiljøet |",
    "Kryptert lagring av alle kundedata leveres i Norge. Leveres som opsjon | Neste rad |",
  ]) {
    const bound = bindVerifiedSolutionQuote({
      entry: storage, quote: "Kryptert lagring av alle kundedata leveres i Norge.", assessment: "Godt",
      solutionDocument: { ...solutionDocument, raw_text: `[[SIDE:11]]\n${raw}` },
    });
    assert.equal(bound.uncertain, true, raw);
  }
});

test("a restriction later in the same paragraph still makes the link uncertain", () => {
  const bound = bindVerifiedSolutionQuote({
    entry: { ...unansweredRequirement, id: "S-1", heading: "", text: "Alle kundedata skal ha kryptert lagring i Norge." },
    quote: "Kryptert lagring av alle kundedata leveres i Norge.",
    assessment: "Godt",
    solutionDocument: { ...solutionDocument, raw_text: "[[SIDE:12]]\nKryptert lagring av alle kundedata leveres i Norge. Dette er standardfunksjonalitet. Gjelder kun produksjonsmiljøet." },
  });
  assert.equal(bound.uncertain, true);
});

test("a decline names the delivery, not an option the requirement may forbid", async () => {
  const { answerExplicitlyDeclinesRequirement: declines } = await load(
    "lib/server/requirements/answer-quality.ts",
  );
  const positive = "Leverandøren skal levere dokumentasjon og telefonstøtte.";
  // Matrix answer cells declining the delivery itself.
  for (const declined of [
    "Dette leveres ikke som opsjon.",
    "Kravet inngår ikke i leveransen.",
    "Støttes ikke.",
    "Leveres ikke. Kunden må selv anskaffe lisensene.",
    "Nei, dette støttes ikke i dagens versjon av plattformen vår.",
  ]) {
    assert.equal(declines(declined), true, declined);
    assert.equal(declines(declined, positive), true, declined);
  }
  // A noun subject may be the requested thing or an excluded option: the
  // model judges it, the deterministic override does not.
  for (const [answer, requirement] of [
    ["TLS 1.0 og 1.1 støttes ikke.", positive],
    ["Data leveres ikke utenfor EU/EØS.", positive],
    ["Kravet dekkes ikke bare av X, men også av Y.", positive],
    ["Løsningen støtter Chrome, Edge, Firefox og Safari. Internet Explorer støttes ikke.", "Løsningen skal støtte moderne nettlesere."],
    ["Varsling på SMS støttes ikke. Varsler sendes automatisk på e-post ved alle hendelser.", "Løsningen skal støtte varsling på e-post."],
    ["Usikre protokoller støttes ikke.", "Løsningen skal ikke støtte usikre protokoller."],
  ]) {
    assert.equal(declines(answer, requirement), false, answer);
  }
  // A bare decline of a requirement that only forbids complies.
  assert.equal(declines("Støttes ikke.", "Løsningen skal ikke støtte usikre protokoller."), false);
  // "ikke" in a relative or later clause does not make it a prohibition.
  assert.equal(declines("Støttes ikke.", "Løsningen skal varsle om lisenser som ikke brukes."), true);
  assert.equal(declines("Leveres ikke.", "Leverandøren skal levere 24/7 support. Planlagt vedlikehold skal ikke skje i kontortid."), true);
  assert.equal(declines("Nei, dette støttes ikke.", "Løsningen skal kunne integreres med ID-porten og skal ikke kreve lokal klientinstallasjon."), true);
  for (const declined of ["Dette kravet støttes ikke.", "Denne funksjonaliteten leveres ikke.", "Slik funksjonalitet tilbys ikke."]) {
    assert.equal(declines(declined, positive), true, declined);
  }
  // A placeholder "Det", a later pronoun or "som standard" names an option.
  for (const [answer, requirement] of [
    ["Det støttes ikke lokale kontoer; all pålogging går via Entra ID med MFA.", "Løsningen skal håndheve MFA for alle brukere."],
    ["Det leveres ikke egen mobilapp. Løsningen er responsiv og fungerer på mobil.", "Løsningen skal kunne brukes på mobil."],
    ["Dette støttes ikke som standard, men leveres som tilpasning inkludert i fastprisen.", positive],
    ["Dette støttes ikke i standardløsningen, men kan leveres som tilpasning inkludert i fastprisen.", positive],
    ["Dette leveres ikke i standardproduktet, men tilbys som tilpasning.", positive],
    ["Dette støttes ikke som en del av standardleveransen, men kan leveres som tilleggstjeneste.", positive],
    ["Løsningen krever MFA for alle brukere. SMS som andrefaktor er deaktivert. Dette støttes ikke av sikkerhetshensyn.", "Løsningen skal håndheve MFA for alle brukere."],
  ]) {
    assert.equal(declines(answer, requirement), false, answer);
  }
  for (const declined of ["Det støttes ikke.", "Det støttes ikke i vår plattform.", "Nei, det støttes ikke i vår plattform."]) {
    assert.equal(declines(declined, "Løsningen skal støtte SSO via Entra ID."), true, declined);
  }
  const mixed = "Løsningen skal støtte SSO via Entra ID og skal ikke tillate lokale kontoer.";
  assert.equal(declines("Dette støttes ikke i vår plattform. Vi bruker lokale brukerkontoer.", mixed), true);
});

test("a restriction in a later section does not qualify the answer", () => {
  const doc = (text) => ({ ...solutionDocument, raw_text: `[[SIDE:4]]\n${text}` });
  const storage = { ...unansweredRequirement, id: "LAG-01", heading: "", text: "Alle kundedata skal ha kryptert lagring i Norge." };
  const bind = (raw) =>
    bindVerifiedSolutionQuote({
      entry: storage,
      quote: "Kryptert lagring av alle kundedata leveres i Norge.",
      assessment: "Godt",
      solutionDocument: doc(raw),
    });
  const answer = "Kryptert lagring av alle kundedata leveres i Norge. Dette er standardfunksjonalitet.";
  const separate = bind(`## 4 Lagring\n\n${answer}\n\n## 5 Tilleggstjenester\n\nTelefonstøtte tilbys ikke.`);
  assert.ok(separate);
  assert.notEqual(separate.uncertain, true);
  // A bare "Det"/"Dette" paragraph is a new statement.
  assert.notEqual(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nDet tilbys ikke telefonstøtte.`)?.uncertain, true);
  assert.notEqual(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nDette kapittelet beskriver supportmodellen. Telefonstøtte tilbys ikke i helger.`)?.uncertain, true);
  // An accepted back-reference paragraph is read to its end.
  assert.equal(
    bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nDette gjelder leverandørens standardplattform. Kundedata i testmiljøet krypteres ikke.`)?.uncertain,
    true,
  );
  // A paragraph restricting the requirement itself still qualifies it.
  assert.equal(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nKundedata i testmiljøet krypteres ikke.`)?.uncertain, true);
  // A new paragraph that refers back still qualifies the answer.
  assert.equal(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nDette gjelder kun produksjonsmiljøet.`)?.uncertain, true);
  // Nor right after a blank line or a heading.
  assert.notEqual(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\nTelefonstøtte tilbys ikke.`)?.uncertain, true);
  assert.notEqual(bind(`Kryptert lagring av alle kundedata leveres i Norge.\n\n## 5 Support\n\nTelefonstøtte tilbys ikke.`)?.uncertain, true);
  // A list introduced by ":" continues the answer, as Docling writes it.
  const listed = bindVerifiedSolutionQuote({
    entry: storage,
    quote: "Kryptert lagring av alle kundedata leveres i Norge",
    assessment: "Godt",
    solutionDocument: doc("Kryptert lagring av alle kundedata leveres i Norge:\n\n- Gjelder kun produksjonsmiljøet."),
  });
  assert.equal(listed?.uncertain, true);
  // The same restriction within the paragraph still qualifies the answer.
  const same = bind(`## 4 Lagring\n\n${answer} Telefonstøtte tilbys ikke.`);
  assert.equal(same?.uncertain, true);
});

test("a quote matches Docling Markdown text across a heading marker", async () => {
  const { solutionDocumentContainsQuote } = await load("lib/server/ai/requirement-coverage.ts");
  const document = {
    id: "solution",
    file_format: "pdf",
    title: "Bilag 2",
    raw_text: "## 6 Informasjonssikkerhet\n\n## 6.1 Styringssystem (SIK-01)\n\nSkarvhavn Digital AS er sertifisert etter ISO/IEC 27001.",
  };
  assert.equal(
    solutionDocumentContainsQuote("6 Informasjonssikkerhet 6.1 Styringssystem (SIK-01) Skarvhavn Digital AS er sertifisert etter ISO/IEC 27001.", document),
    true,
  );
  assert.equal(solutionDocumentContainsQuote("Skarvhavn Digital AS er sertifisert etter ISO/IEC 27001.", document), true);
});

test("PDF-parser headings and table rows are boundaries, wrapped prose is not", () => {
  // As the PDF parser writes it: headings and table rows as short lines.
  const doc = {
    ...solutionDocument,
    raw_text: [
      "[[SIDE:7]]",
      "Tilgjengeligheten måles 24/7 og rapporteres månedlig.",
      "7.2 Respons- og løsningstider (TJN-03)",
      "Prioritet Responstid Løsning Tilgjengelighet",
      "P1 Kritisk 15 minutter 4 timer Hele døgnet",
      "P2 Høy 1 time 12 timer Hele døgnet",
      "9.5 Revisjon",
      "Oppdragsgiver gis rett til å gjennomføre én årlig revisjon hos leverandøren og underleverandører, med 30 dagers",
      "varsel. Alle kundedata og sikkerhetskopier lagres i",
      "Norge.",
      "9.6 Kontraktsforhold",
      "Leverandøren aksepterer avtalen med følgende forbehold: ansvaret begrenses.",
    ].join("\n"),
  };
  const req = (id, text) => ({ ...unansweredRequirement, id, text, heading: "" });
  const bind = (entry, quote) => bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: doc });
  // A table row is its own answer.
  const p2 = bind(req("TJN-03.2", "Hendelser med prioritet 2 skal ha responstid på høyst 1 time."), "P2 Høy 1 time 12 timer Hele døgnet");
  assert.equal(p2.entry.answerExcerpt, "P2 Høy 1 time 12 timer Hele døgnet");
  // A parent requirement is tied to its table by the heading naming it.
  const parent = bind(req("TJN-03", "Leverandøren skal overholde følgende respons- og løsningstider for hendelser:"), "Prioritet Responstid Løsning Tilgjengelighet P1 Kritisk 15 minutter 4 timer Hele døgnet");
  assert.ok(parent, "the heading ties the table to TJN-03");
  // The next section's "forbehold" does not qualify the answer before it.
  const audit = bind(req("SIK-09", "Oppdragsgiver skal ha rett til årlig revisjon hos leverandøren og underleverandører."), "Oppdragsgiver gis rett til å gjennomføre én årlig revisjon hos leverandøren og underleverandører, med 30 dagers varsel.");
  assert.equal(audit.uncertain, false);
  assert.doesNotMatch(audit.entry.answerExcerpt, /^9\.5/u);
  // A line ending in "i" continues onto "Norge.".
  const storage = bind(req("ARK-01", "Data skal lagres innenfor EØS, fortrinnsvis i Norge."), "Alle kundedata og sikkerhetskopier lagres i Norge.");
  assert.equal(storage.entry.answerExcerpt, "Alle kundedata og sikkerhetskopier lagres i Norge.");
});

test("council: a wrapped refusal, a neighbouring row and an invented quote never bind as certain", () => {
  const doc = (lines) => ({ ...solutionDocument, raw_text: ["[[SIDE:3]]", ...lines].join("\n") });
  const bind = (entry, quote, lines) => bindVerifiedSolutionQuote({ entry, quote, assessment: "Godt", solutionDocument: doc(lines) });
  const req = (id, text) => ({ ...unansweredRequirement, id, text, heading: "" });
  const prose = "Leverandøren beskriver her hvordan tjenestene leveres, driftes og følges opp gjennom hele avtaleperioden med";
  // A single short line wraps a sentence: the refusal stays with it.
  const sso = req("SIK-02", "Løsningen skal støtte integrasjon mellom Microsoft Entra ID og SSO-portalen for administratorer.");
  const wrapped = bind(sso, "Microsoft Entra ID og SSO-portalen for administratorer.", [prose, "oppdragsgiver.", "Vi tilbyr ikke integrasjon mellom", "Microsoft Entra ID og SSO-portalen for administratorer."]);
  assert.notEqual(wrapped?.uncertain, false);
  // Another row's subject does not tie an answer to the requirement.
  const login = req("SIK-03", "Løsningen skal støtte SSO via Entra ID.");
  const neighbour = bind(login, "Vi svarer på henvendelser på telefon hele døgnet.", [prose, "oppdragsgiver.", "| SSO via Entra ID | Støttes ikke |", "| Telefonstøtte | Vi svarer på henvendelser på telefon hele døgnet. |"]);
  assert.equal(neighbour, null);
  // Only part of the quote exists: at most "Uklart".
  const storage = req("ARK-01", "Kundedata skal lagres kryptert i Norge.");
  const invented = bind(storage, "Kundedata lagres kryptert i vårt datasenter i Norge med garantert norsk datalagring.", [prose, "oppdragsgiver.", "Kundedata lagres kryptert i vårt datasenter. Datasenteret ligger i USA."]);
  assert.notEqual(invented?.uncertain, false);
});
