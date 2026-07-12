import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "requirement-coverage-guards.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});

const {
  answerFromBatchRows,
  assertSubstantiveSolutionEvaluationResult,
  assertRequirementCoverageBatchesSucceeded,
  assertRequirementArtifactSourceLedgersComplete,
  assertVerifiedRequirementLedgerGeneration,
  buildRequirementCoverageBatchRegistry,
  buildRequirementCoverageLedgerFromDocuments,
  buildRequirementCoverageEvaluationContext,
  buildRequirementCoverageEvaluationPayload,
  buildRequirementCoverageRegistry,
  buildDeterministicControlRepairMetadata,
  buildProposalInputRequiredMetadata,
  buildDeterministicFinalRequirementControlRepair,
  buildDeterministicFinalRequirementTemplateRepair,
  buildDeterministicTemplateRepairMetadata,
  applyVerifiedDeterministicControlRepairs,
  buildRequirementFallbackStageMetadata,
  buildRequirementRepairDirective,
  buildRequirementResponseBatchRegistry,
  buildStrictRequirementHandoffUserPrompt,
  chunkRequirementCoverage,
  collectArtifactFoundationFacts,
  correctCoverageAssessmentWithSourceEvidence,
  createRequirementResponseHandoffProgressTracker,
  createRequirementResponseStrictHandoffGovernor,
  coverageItemFromBatchRow,
  coverageBatchHasCompleteExactEvidence,
  dedupeRequirementLedger,
  exactCoverageEvidenceExcerpt,
  formatUnresolvedRequirementResponseSummary,
  hasExplicitlyCompleteSmallRequirementLedger,
  limitRequirementHandoffStyleExamples,
  mergeRequirementCoverageLedgerWithSolutionAnswers,
  isDeterministicTemplateRepairAnswer,
  normalizeMandatoryRequirementCommitment,
  normalizeDocumentFindingsAgainstCoverage,
  normalizeRequirementAnswerResult,
  normalizeSolutionEvaluationResult,
  requirementAnswerQualityIssues,
  requirementAnswerForRepair,
  resolveRequirementResponseStrictHandoffLimits,
  reuseExactDuplicateRequirementAnswers,
  resolveRequirementAnswerAfterStrictHandoff,
  resolveRequirementAnswerBeforeStrictHandoff,
  selectDocumentStructureEntries,
  selectDistributedGoodCoverageExamples,
  selectDistributedNonGoodCoverageDetails,
  selectRequirementsForSolutionCoverage,
  selectRequirementDocumentsForGeneration,
  serializeUnresolvedRequirementFallbackAnswers,
  solutionDocumentAnswerBearingText,
  suppressDuplicatedDocumentLedgerContext,
  validateRequirementCoverageBatchRows,
  validateRequirementResponseBatchRows,
} = jiti(path.join(frontendRoot, "lib/server/ai.ts"));
const { analyzeRequirementCoverageIntegrity } = jiti(
  path.join(
    frontendRoot,
    "lib/server/requirements/evaluation-coverage-integrity.ts",
  ),
);
const {
  requirementBatchSystemPrompt,
  requirementCoverageSystemPrompt,
  requirementHandoffSystemPrompt,
} = jiti(
  path.join(frontendRoot, "lib/server/prompts/requirements.ts"),
);
const { buildSolutionEvaluationPrompt } = jiti(
  path.join(frontendRoot, "lib/server/prompts.ts"),
);
const { buildEvaluationLedgerContext } = jiti(
  path.join(frontendRoot, "lib/server/use-cases/project-workflows.ts"),
);
const { assertRequirementLedgerQualityForEvaluation } = jiti(
  path.join(frontendRoot, "lib/server/requirements/ledger-quality.ts"),
);

function document(id) {
  return {
    id,
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: `Krav ${id}`,
    file_name: `${id}.md`,
    file_format: "md",
    raw_text: `| Krav-ID | Krav |\n|---|---|\n| K-1 | Krav fra ${id} |`,
    structure_map: [],
  };
}

function requirement(overrides = {}) {
  return {
    id: "K-1",
    text: "Leverandøren skal dokumentere tilgangsstyring.",
    pages: [1],
    heading: "Sikkerhet",
    sourceExcerpt: "Kravgrunnlag",
    ...overrides,
  };
}

test("source-ledger quality rejects a requirement tail omitted before a relative clause", () => {
  const sourceDocument = {
    ...document("038"),
    raw_text:
      "| Krav-ID | Krav |\n|---|---|\n| 038/11 | Kunden skal kunne se hvilke brukere som har hatt tilgang til en sak, post eller ressurs i en valgt periode. |",
  };
  const truncated = requirement({
    id: "038/11",
    documentId: sourceDocument.id,
    documentTitle: sourceDocument.title,
    text: "Kunden skal kunne se hvilke brukere",
    sourceExcerpt:
      "Krav: Kunden skal kunne se hvilke brukere som har hatt tilgang til en sak, post eller ressurs i en valgt periode. | Prioritet: Må",
  });
  assert.throws(
    () =>
      assertRequirementLedgerQualityForEvaluation([truncated], {
        stage: "solution_evaluation_source_ledger",
      }),
    /requirement_source_tail_omitted/u,
  );
  assert.throws(
    () =>
      assertRequirementArtifactSourceLedgersComplete({
        artifactType: "forbedret_kravsvar",
        requirementDocuments: [sourceDocument],
        requirementLedgerResults: [
          { document: sourceDocument, ledger: [truncated] },
        ],
      }),
    /requirement_source_tail_omitted/u,
  );

  const complete = {
    ...truncated,
    text:
      "Kunden skal kunne se hvilke brukere som har hatt tilgang til en sak, post eller ressurs i en valgt periode.",
  };
  assert.doesNotThrow(() =>
    assertRequirementLedgerQualityForEvaluation([complete]),
  );
});

test("ledger quality fails closed on a flattened table header masquerading as a requirement", () => {
  assert.throws(
    () =>
      assertRequirementLedgerQualityForEvaluation([
        requirement({
          id: "Tabell 3 Rad 1",
          text:
            "Tabell 3 Rad 1: ID/markering | Prioritet | Kravtekst | leverandørens svar | Rad 2: 001/01 | Må | Kunden skal kunne eksportere data |",
          sourceExcerpt:
            "Tabell 3 Rad 1: ID/markering | Prioritet | Kravtekst | leverandørens svar",
        }),
      ]),
    /flattened_table_header_dump/u,
  );
});

test("foundation facts distribute a bounded budget across 100 documents", () => {
  const documents = Array.from({ length: 100 }, (_, index) => ({
    ...document(`doc-${index + 1}`),
    raw_text: `Risiko RISK-${index + 1}: kritisk dependency må avklares før produksjonssetting.`,
  }));

  const facts = collectArtifactFoundationFacts({
    documents,
    serviceDocuments: [],
  });

  assert.ok(facts.length <= 28);
  assert.ok(
    facts.some(
      (fact) =>
        fact.source === "Krav doc-100" && fact.text.includes("RISK-100"),
    ),
    "the last document must contribute its unique late risk",
  );
});

test("8-19 character explicit source rows prevent false 100 percent coverage", () => {
  const sourceLedger = [
    requirement({ id: "K-1" }),
    requirement({ id: "K-2", text: "Systemet må logge" }),
  ];
  assert.ok(sourceLedger[1].text.length >= 8 && sourceLedger[1].text.length < 20);

  const selected = selectRequirementsForSolutionCoverage({
    ledger: sourceLedger,
    hasExplicitSourceLedger: true,
  });
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["K-1", "K-2"],
  );

  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: selected,
    coverage: {
      total_requirements: 1,
      assessed_requirements: 1,
      good: 1,
      weak: 0,
      missing: 0,
      unclear: 0,
      items: [
        {
          order_index: 0,
          reference: "K-1",
          full_reference: "K-1",
          source_reference: "K-1",
          requirement: selected[0].text,
          assessment: "Godt",
          rationale: "Kravet er vurdert.",
          evidence: "Kravet er dekket.",
          recommendation: "Behold løsningen.",
        },
      ],
    },
  });

  assert.equal(report.sourceCount, 2);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "total_mismatch"));
  assert.ok(report.issues.some((issue) => issue.code === "item_count_mismatch"));
});

test("detail-like prefixes do not remove explicit source requirements", () => {
  const selected = selectRequirementsForSolutionCoverage({
    hasExplicitSourceLedger: true,
    ledger: [
      requirement({
        id: "K-3",
        text: "Status skal rapporteres månedlig",
      }),
    ],
  });

  assert.deepEqual(
    selected.map((entry) => [entry.id, entry.text]),
    [["K-3", "Status skal rapporteres månedlig"]],
  );
});

test("explicit source preserves equal IDs and text in distinct source sections", () => {
  const selected = selectRequirementsForSolutionCoverage({
    hasExplicitSourceLedger: true,
    ledger: [
      requirement({
        id: "K-7",
        text: "Systemet skal logge alle sikkerhetshendelser.",
        heading: "Drift",
        documentEntryOrder: 4,
      }),
      requirement({
        id: "K-7",
        text: "Systemet skal logge alle sikkerhetshendelser.",
        heading: "Revisjon",
        documentEntryOrder: 19,
      }),
    ],
  });

  assert.deepEqual(
    selected.map((entry) => [entry.heading, entry.documentEntryOrder]),
    [
      ["Drift", 4],
      ["Revisjon", 19],
    ],
  );
});

test("explicit source keeps an unnumbered requirement and integrity rejects its omission", () => {
  const sourceLedger = [
    ...Array.from({ length: 5 }, (_, index) =>
      requirement({
        id: `K-${index + 1}`,
        text: `Leverandøren skal oppfylle nummerert krav ${index + 1}.`,
      }),
    ),
    requirement({
      id: "Side 2 krav 1",
      text: "Tjenesten skal ha en separat beredskapsordning.",
      pages: [2],
    }),
  ];
  const selected = selectRequirementsForSolutionCoverage({
    ledger: sourceLedger,
    hasExplicitSourceLedger: true,
  });

  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["K-1", "K-2", "K-3", "K-4", "K-5", "Side 2 krav 1"],
  );

  const omittedCoverageItems = selected.slice(0, 5).map((entry, index) => ({
    order_index: index,
    reference: entry.id,
    full_reference: entry.id,
    source_reference: entry.id,
    requirement: entry.text,
    assessment: "Godt",
    rationale: "Kravet er vurdert.",
    evidence: "Kravet er dekket.",
    recommendation: "Behold løsningen.",
  }));
  const report = analyzeRequirementCoverageIntegrity({
    sourceLedger: selected,
    coverage: {
      total_requirements: omittedCoverageItems.length,
      assessed_requirements: omittedCoverageItems.length,
      good: omittedCoverageItems.length,
      weak: 0,
      missing: 0,
      unclear: 0,
      items: omittedCoverageItems,
    },
  });

  assert.equal(report.sourceCount, 6);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "total_mismatch"));
  assert.ok(report.issues.some((issue) => issue.code === "assessed_mismatch"));
  assert.ok(report.issues.some((issue) => issue.code === "item_count_mismatch"));
});

test("explicit source ledger fails closed when a row has no requirement text", () => {
  assert.throws(
    () =>
      selectRequirementsForSolutionCoverage({
        ledger: [requirement({ id: "K-empty", text: "   " })],
        hasExplicitSourceLedger: true,
      }),
    /eksplisitt kravgrunnlag.*uten kravtekst.*K-empty/i,
  );
});

test("architecture winner is reconciled deterministically from normalized scores", () => {
  const normalized = normalizeSolutionEvaluationResult({
    fit_to_customer_needs: "",
    strengths: [],
    weaknesses: [],
    generic_sections: [],
    missing_elements: [],
    risks_to_customer: [],
    trust_signals: [],
    likely_score_assessment: {
      quality: "",
      delivery_confidence: "",
      risk: "",
      competitiveness: "",
    },
    improvement_recommendations: [],
    value_assessment: [],
    rewrite_suggestions: [],
    document_findings: [],
    architecture_comparison: {
      winner: "Arkitektløsning",
      architect_solution_score: 41.4,
      system_solution_score: 82.1,
      verdict: "Modellen rapporterte en selvmotsigende vinner.",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    },
    executive_summary: "",
  });

  assert.equal(normalized.architecture_comparison?.architect_solution_score, 41);
  assert.equal(normalized.architecture_comparison?.system_solution_score, 82);
  assert.equal(normalized.architecture_comparison?.winner, "Systemløsning");

  const tied = normalizeSolutionEvaluationResult({
    ...normalized,
    architecture_comparison: {
      ...normalized.architecture_comparison,
      winner: "Systemløsning",
      architect_solution_score: 75,
      system_solution_score: 75,
    },
  });
  assert.equal(tied.architecture_comparison?.winner, "Uavgjort");
});

test("holistic evaluation fails closed on partial JSON and caps score by exact coverage", () => {
  const missingCoverage = coverageFixture(1);
  missingCoverage.items[0].assessment = "Mangler";
  missingCoverage.items[0].rationale = "Svar mangler.";
  missingCoverage.items[0].evidence = "";
  missingCoverage.good = 0;
  missingCoverage.missing = 1;

  const partial = normalizeSolutionEvaluationResult({
    requirement_coverage: missingCoverage,
    architecture_comparison: {
      winner: "Arkitektløsning",
      architect_solution_score: 100,
      system_solution_score: 40,
      verdict: "",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    },
  });
  assert.deepEqual(partial.rewrite_suggestions, []);
  assert.deepEqual(partial.likely_score_assessment, {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  });
  assert.equal(partial.architecture_comparison?.architect_solution_score, 0);
  assert.equal(partial.architecture_comparison?.winner, "Systemløsning");
  assert.throws(
    () => assertSubstantiveSolutionEvaluationResult(partial),
    /mangler obligatorisk, substansielt innhold/u,
  );

  const complete = normalizeSolutionEvaluationResult({
    fit_to_customer_needs:
      "Løsningen treffer de dokumenterte behovene gjennom tydelig styring, sporbarhet og testbare kontroller.",
    strengths: ["Tydelig ansvar og dokumentert kontroll gir høy etterprøvbarhet."],
    weaknesses: ["Overgangsplanen mangler fortsatt en presis beslutningsport."],
    generic_sections: [],
    missing_elements: [],
    risks_to_customer: ["Uavklart overgang kan forsinke produksjonssettingen."],
    trust_signals: ["Testprotokoll og navngitt kontrolleier er dokumentert."],
    likely_score_assessment: {
      quality: "Høy kvalitet med konkrete og sporbare kontroller.",
      delivery_confidence: "God leveransetrygghet med tydelig ansvar.",
      risk: "Moderat risiko knyttet til overgangsbeslutningen.",
      competitiveness: "Sterk konkurransekraft når overgangsplanen presiseres.",
    },
    improvement_recommendations: [
      "Legg inn beslutningsport, ansvarlig rolle og akseptansekriterium for overgang.",
    ],
    value_assessment: [],
    rewrite_suggestions: [
      {
        target: "Overgangsplan",
        suggestion:
          "Beskriv beslutningsporten med ansvar, dokumentert testbevis og eksplisitt godkjenning før produksjon.",
      },
    ],
    document_findings: [],
    requirement_coverage: coverageFixture(1),
    architecture_comparison: {
      winner: "Arkitektløsning",
      architect_solution_score: 88,
      system_solution_score: 82,
      verdict:
        "Arkitektløsningen er sterkest fordi den binder ansvar, kontroll og verifikasjon til det dokumenterte behovet.",
      strong_critique: [
        "Manglende beslutningsport kan koste tillit og gjennomføringsevne.",
      ],
      pragmatic_reflections: [
        "En ekstra beslutningsport gir litt mer styring, men reduserer overgangsrisikoen vesentlig.",
      ],
      strategy_improvement_advice: [
        "Gjør overgangsbeviset til et eksplisitt evalueringspunkt i tilbudsstrategien.",
      ],
    },
    executive_summary:
      "Tilbudet har en sterk og etterprøvbar løsning med tydelig ansvar og gode kontroller. Overgangsplanen bør kompletteres med en konkret beslutningsport før innlevering.",
  });
  assert.doesNotThrow(() =>
    assertSubstantiveSolutionEvaluationResult(complete),
  );
});

test("coverage normalization rewrites one-based model indexes to zero-based ledger positions", () => {
  const sourceCoverage = coverageFixture(3);
  const normalized = normalizeSolutionEvaluationResult({
    fit_to_customer_needs: "Kravene er dekket med konkrete og testbare svar.",
    strengths: [],
    weaknesses: [],
    generic_sections: [],
    missing_elements: [],
    risks_to_customer: [],
    trust_signals: [],
    likely_score_assessment: {
      quality: "Høy",
      delivery_confidence: "Høy",
      risk: "Lav",
      competitiveness: "Høy",
    },
    improvement_recommendations: [],
    value_assessment: [],
    rewrite_suggestions: [],
    document_findings: [],
    requirement_coverage: {
      ...sourceCoverage,
      items: sourceCoverage.items.map((item, index) => ({
        ...item,
        order_index: index + 1,
      })),
    },
    architecture_comparison: {
      winner: "Uavgjort",
      architect_solution_score: 80,
      system_solution_score: 80,
      verdict: "Løsningene er like sterke.",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    },
    executive_summary: "Tre krav er vurdert.",
  });

  assert.deepEqual(
    normalized.requirement_coverage.items.map((item) => item.order_index),
    [0, 1, 2],
  );
  assert.deepEqual(
    buildRequirementCoverageRegistry(normalized.requirement_coverage).map(
      (row) => row.nr,
    ),
    [1, 2, 3],
  );
});

test("coverage items ignore model evidence and persist an exact answer-cell prefix", () => {
  const longAnswer = [
    "Atea leverer sentral logging med navngitt eier, revisjonsspor, hendelsesidentitet, tidspunkt, gammel verdi og ny verdi.",
    "Kontrollen verifiseres med testprotokoll, avvikslogg og månedlig rapportering til sikkerhetsansvarlig.",
    "Alle endringer kan spores til ansvarlig bruker eller tjenesteidentitet og følges opp til lukking.",
    "Dokumentasjonen inngår i akseptansetesten og beholdes som revisjonsbevis for kunden.",
    "Den samme kontrollkjeden brukes ved feilretting, retest og formell godkjenning før produksjonssetting.",
  ].join(" ");
  assert.ok(longAnswer.length > 420);
  const entry = requirement({
    id: "K-LOG-1",
    tableId: "Tabell ID 1-1",
    service: "Logging",
    text: "Leverandøren skal levere sentral logging med revisjonsspor.",
    documentId: "requirements-document",
    documentTitle: "Kravspesifikasjon",
    answerDocumentId: "solution-document",
    answerDocumentTitle: "Leverandørens svar",
    answerExcerpt: longAnswer,
    answerEvidenceExcerpt:
      "Kravgrunnlaget sier at sentral logging og revisjonsspor er obligatorisk.",
    sourceExcerpt: `Kravgrunnlag: Leverandøren skal levere sentral logging med revisjonsspor. | Svarrad: ${longAnswer}`,
  });
  const fabricatedModelEvidence =
    "En annen kravrad lover full autonom overvåking uten behov for kontroll.";

  const item = coverageItemFromBatchRow({
    entry,
    orderIndex: 0,
    row: {
      nr: 1,
      ref: "Tabell ID 1-1",
      assessment: "Godt",
      rationale:
        "Svaret beskriver en konkret, testbar og sporbar kontrollkjede.",
      evidence: fabricatedModelEvidence,
      recommendation:
        "Behold eier, testprotokoll, avvikslogg og revisjonsbevis.",
    },
  });
  const expectedEvidence = exactCoverageEvidenceExcerpt(longAnswer);

  assert.equal(item.assessment, "Godt");
  assert.equal(item.evidence, expectedEvidence);
  assert.notEqual(item.evidence, fabricatedModelEvidence);
  assert.equal(item.evidence.includes("…"), false);
  assert.ok(longAnswer.includes(item.evidence));
  assert.ok(item.evidence.length <= 420);

  const integrity = analyzeRequirementCoverageIntegrity({
    sourceLedger: [entry],
    coverage: {
      total_requirements: 1,
      assessed_requirements: 1,
      good: 1,
      weak: 0,
      missing: 0,
      unclear: 0,
      items: [item],
    },
  });
  assert.equal(integrity.ok, true, JSON.stringify(integrity.issues));
});

test("exact coverage evidence never splits a Unicode surrogate pair", () => {
  const longAnswerWithoutWordBoundary = `a${"🧪".repeat(300)}`;
  const evidence = exactCoverageEvidenceExcerpt(longAnswerWithoutWordBoundary);

  assert.ok(evidence.length <= 420);
  assert.ok(longAnswerWithoutWordBoundary.includes(evidence));
  const finalCodeUnit = evidence.charCodeAt(evidence.length - 1);
  assert.equal(
    finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff,
    false,
    "evidence must not end with an unpaired high surrogate",
  );
  assert.equal([...evidence].at(-1), "🧪");
});

const deterministicDimensioningTemplate =
  "I løsningsforslaget dimensjonerer og forplikter Atea ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og korrelert logging, for de navngitte brukertransaksjonene registrere innmelding, oppdatere status og avslutte saken, etter en kapasitetsmodell og ytelsesbaseline som verifiseres med last- og ytelsestest samt provisjonert kapasitet med eksplisitt reservekapasitet. Ateas tilbudte responstidsmål er p95 under 2 sekunder for de samme transaksjonene ved en antatt lastprofil på 200 samtidige brukere; både målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og brukes som bindende akseptansekriterium før produksjonssetting.";

const highConfidenceCoverageFixtures = [
  {
    id: "Dokumenttekst krav 2",
    text: "Løsningen skal støtte tidsstyrte påminnelser for å gjennomføre koordinere frivillige, oppdrag, samtykker og varsler på en kontrollert og sporbar måte.",
    observedAnswer:
      "Atea etablerer tidsstyrte påminnelser knyttet til oppdrag, samtykker og varsler, slik at aktiviteter utløses og følges opp til rett tid. Utsendelser og status logges på saken slik at gjennomføring og avvik er sporbare.",
    completeAnswer:
      "Atea konfigurerer påminnelsesregler for oppdrag og samtykker med hendelsesbasert trigger, tidspunkt, frist og intervall, og sender dem til ansvarlig koordinator eller frivillig. Utsendelsen og status for leveringen logges, og manglende respons eller avvik eskaleres til ansvarlig rolle.",
    issue: "incomplete_timed_reminder_control",
    checklist: /regel og trigger.*tidspunkt.*roller\/mottakere.*logget utsendelse.*eskalering/i,
    repair: /regel og trigger.*tidspunkt.*roller\/mottakere.*logget utsendelse.*eskalering/i,
    rationale: /regel\/trigger.*mottakere.*eskalering/i,
  },
  {
    id: "R-032",
    text: "Historiske oppdrag, frivillige, samtykker, meldinger skal kunne migreres til løsningen med validering og avviksrapport før produksjonssetting.",
    observedAnswer:
      "Atea migrerer historiske oppdrag, frivillige, samtykker og meldinger til løsningen gjennom en styrt migreringsprosess med feltmapping, testlast, validering og avviksrapport før produksjonssetting. Endelig mapping og håndtering av eventuelle datakvalitetsavvik avklares mot tilgjengelige kilder, men selve migreringskontrollen inngår i leveransen.",
    completeAnswer:
      "Atea migrerer historiske oppdrag, frivillige, samtykker og meldinger med feltmapping og testlast før produksjonssetting, der validering dokumenteres i en avviksrapport. Avvik korrigeres, retestes og godkjennes i en go/no-go før produksjonssetting.",
    issue: "incomplete_historical_migration_control",
    checklist: /feltmapping.*testmigrering eller testlast.*avviksrapport.*korrigering.*retest.*godkjenning/i,
    repair: /feltmapping.*testmigrering eller testlast.*avviksrapport.*korrigering.*retest.*godkjenning/i,
    rationale: /feltmapping.*testlast.*avviksrapport.*retest.*godkjenning/i,
  },
  {
    id: "R-022",
    text: "Alle endringer i oppdrag, frivillige, samtykker, meldinger skal logges med bruker, tidspunkt, gammel verdi og ny verdi.",
    observedAnswer:
      "Atea fører auditlogg for alle endringer med identitet, tidspunkt og verdiendringer, og gjør loggen tilgjengelig for autoriserte administratorer ved kontroll og oppfølging. Innsyn i loggen styres rollebasert.",
    completeAnswer:
      "Atea logger hver endring i oppdrag, frivillige, samtykker og meldinger med bruker- eller tjenesteidentitet, tidspunkt, gammel verdi og ny verdi i auditloggen.",
    issue: "incomplete_audit_change_log",
    checklist: /bruker- eller tjenesteidentitet.*tidspunkt.*gammel verdi.*ny verdi/i,
    repair: /bruker- eller tjenesteidentitet.*tidspunkt.*gammel verdi.*ny verdi/i,
    rationale: /bruker- eller tjenesteidentitet.*gammel verdi.*ny verdi/i,
  },
  {
    id: "R-011",
    text: "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av oppdrag, frivillige, samtykker, meldinger.",
    observedAnswer:
      "Atea etablerer dokumenterte rutiner og runbooks for backup av oppdrag, frivillige, samtykker og meldinger, samt kontrollert gjenoppretting med verifikasjon av dataintegritet. Restore-tester, avvik og korrigerende tiltak loggføres, mens eksakte frekvenser og lagringstider avklares i designfasen. Eksakte RTO/RPO-mål eller bindende nedetidsmål er ikke tallfestet i bilaget og avklares som foreslåtte tjenestenivåer før forpliktelse.",
    completeAnswer:
      "Løsningen etablerer og drifter en dokumentert backup-rutine for produksjonsdata om oppdrag, frivillige, samtykker og meldinger, med driftsansvarlig rolle, jobbkontroll og avviksvarsling; frekvens, oppbevaringstid, RTO, RPO og testkalender fastsettes per dataklasse i en backupmatrise som godkjennes før produksjonssetting og gjelder som bindende driftsparametere. Kontrollert gjenoppretting følger dokumentert runbook; dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.",
    issue: "incomplete_backup_restore_verification",
    checklist: /backup-rutine.*kontrollert restore\/gjenoppretting.*integritetsverifikasjon.*restore-test.*loggede avvik.*korrigerende tiltak/i,
    repair: /backup-rutine.*kontrollert restore\/gjenoppretting.*integritetsverifikasjon.*restore-test.*loggede avvik.*korrigerende tiltak/i,
    rationale: /dokumentert rutine.*kontrollert restore.*integritetsverifikasjon.*korrigerende tiltak/i,
  },
  {
    id: "R-024",
    text: "Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer.",
    observedAnswer:
      "Atea gjennomfører akseptansetest som omfatter brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer, med tydelig forventet resultat for hver testaktivitet. Avvik loggføres med ansvarlig tiltak og retest før endelig testoppsummering legges frem for kunden.",
    completeAnswer:
      "Atea gjennomfører akseptansetest som omfatter brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer, med tydelig forventet resultat for hver testaktivitet. Avvik loggføres med ansvarlig tiltak og retest før endelig testoppsummering legges frem for kunden.",
    issue: "incomplete_acceptance_test_coverage",
    checklist: /brukerroller.*integrasjoner.*rapporter.*feilscenarier.*tilgangsendringer.*forventede resultater.*avvikslogg.*retest/i,
    repair: /brukerroller.*integrasjoner.*rapporter.*feilscenarier.*tilgangsendringer.*forventede resultater.*avvikslogg.*retest/i,
    rationale: /fem obligatoriske akseptansetestområder.*forventede resultater.*retest/i,
  },
];

test("timed reminder quality binds controls to source-domain objects", () => {
  const entry = requirement({
    id: "Dokumenttekst krav 13",
    text: "Løsningen skal støtte tidsstyrte påminnelser for å gjennomføre sanntids koordinering av lossekøer, porttilgang og avvikslogg på en kontrollert og sporbar måte.",
  });
  const complete =
    "Løsningen bruker en påminnelsesregel som utløses ved planlagt tidspunkt, frist eller intervall for lossekøer, porttilgang og avvikslogg til terminaloperatør og havnevakt; hver utsendelse og status logges. Manglende respons eller avvik eskaleres til ansvarlig havnevakt.";
  const wrongDomain =
    "Løsningen bruker en påminnelsesregel som utløses ved planlagt tidspunkt, frist eller intervall for oppdrag og samtykker til koordinator; hver utsendelse og status logges. Manglende respons eller avvik eskaleres til ansvarlig rolle.";

  assert.deepEqual(requirementAnswerQualityIssues(complete, entry), []);
  assert.ok(
    requirementAnswerQualityIssues(wrongDomain, entry).includes(
      "incomplete_timed_reminder_control",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(complete, entry, entry.text).source,
    "batch",
  );
});

test("100-folder-002 row 15 gets a source-bound reminder repair before handoff", () => {
  const text =
    "Løsningen skal støtte tidsstyrte påminnelser for å gjennomføre sanntids koordinering av lossekøer, porttilgang og avvikslogg på en kontrollert og sporbar måte.";
  const entry = requirement({
    id: "Dokumenttekst krav 13",
    text,
    pages: [1],
    heading: "Tabell som må ryddes",
    tableId: "Dokumenttekst",
    sourceExcerpt: text,
    documentEntryOrder: 2473,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const current = normalizeRequirementAnswerResult(
    "Atea støtter tidsstyrte påminnelser. Regler, tidsplan, mottakere og oppfølging avklares senere.",
    entry,
    entry.sourceExcerpt,
  );

  assert.equal(current.source, "deterministic_fallback");
  assert.match(current.reason, /deferred_core_scope/);
  assert.match(current.reason, /incomplete_timed_reminder_control/);

  const repair = buildDeterministicFinalRequirementControlRepair({
    entry,
    evidence: current.evidence,
  });
  assert.ok(repair);
  assert.equal(repair.source, "deterministic_control_repair");
  assert.match(repair.answer, /lossekøer, porttilgang og avvikslogg/i);
  assert.doesNotMatch(repair.answer, /oppdrag|samtykke|kundens/i);
  assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(
      repair.answer,
      entry,
      entry.sourceExcerpt,
    ).source,
    "batch",
  );
  assert.deepEqual(
    resolveRequirementAnswerBeforeStrictHandoff({ entry, current }),
    repair,
  );
});

test("source-bound reminder repair rejects compound, optional and parameterized variants", () => {
  const base =
    "Løsningen skal støtte tidsstyrte påminnelser for å gjennomføre sanntids koordinering av lossekøer, porttilgang og avvikslogg på en kontrollert og sporbar måte.";
  const rejected = [
    requirement({
      text: `${base} Løsningen skal også eksportere rapporter som CSV.`,
      sourceExcerpt: `${base} Løsningen skal også eksportere rapporter som CSV.`,
    }),
    requirement({
      text: base,
      sourceExcerpt: `${base} | Bør`,
    }),
    requirement({
      text: base,
      sourceExcerpt: base,
      heading: "Opsjoner og tilvalg",
    }),
    requirement({
      text: base.replace(
        "lossekøer, porttilgang og avvikslogg",
        "lossekøer hvert 5. minutt, porttilgang og avvikslogg",
      ),
      sourceExcerpt: base.replace(
        "lossekøer, porttilgang og avvikslogg",
        "lossekøer hvert 5. minutt, porttilgang og avvikslogg",
      ),
    }),
    requirement({
      text: base.replace(
        "lossekøer, porttilgang og avvikslogg",
        "lossekøer",
      ),
      sourceExcerpt: base.replace(
        "lossekøer, porttilgang og avvikslogg",
        "lossekøer",
      ),
    }),
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      entry.sourceExcerpt,
    );
  }
});

test("100-folder-002 realtime coordination answers must bind every source object", () => {
  const deviationText =
    "Løsningen skal støtte avviksbehandling for å gjennomføre sanntids koordinering av lossekøer, porttilgang og avvikslogg på en kontrollert og sporbar måte.";
  const deviationEntry = requirement({
    id: "Dokumenttekst krav 16",
    text: deviationText,
    heading: "Kommentarer fra drift",
    tableId: "Dokumenttekst",
    sourceExcerpt: deviationText,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const observedDeviationAnswer =
    "Atea leverer avviksbehandling med registrering, klassifisering, tildeling, frist, tiltak og lukking i samme løsning som den operative oppfølgingen. Hvert avvik får unikt saksforløp med ansvarlig, tidsstempler, vedlegg og endringshistorikk, slik at behandling og oppfølging er kontrollert og sporbar.";
  const strongDeviationAnswer =
    "Atea kobler hvert avvik til lossekøer, porttilgang og avvikslogg og lar berørte brukere registrere, klassifisere, tildele ansvar og oppdatere status i sanntid. Statusendringer varsles til ansvarlig rolle og lagres med tidsstemplet hendelses- og statushistorikk, slik at avvikene kan ses og håndteres operativt.";

  assert.ok(
    requirementAnswerQualityIssues(
      observedDeviationAnswer,
      deviationEntry,
    ).includes("missing_realtime_coordination_source_binding"),
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(strongDeviationAnswer, deviationEntry),
    [],
  );
  assert.match(
    buildRequirementRepairDirective(
      deviationEntry,
      "quality_gate: missing_realtime_coordination_source_binding",
    ),
    /registrering.*statusendring.*varsling.*lossekøer, porttilgang og avvikslogg/i,
  );

  const selfServiceText =
    "Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte selvbetjening for å gjennomføre sanntids koordinering av lossekøer, porttilgang og avvikslogg på en kontrollert og sporbar måte.";
  const selfServiceEntry = requirement({
    id: "Avklaringskrav-07",
    text: selfServiceText,
    heading: "Uavklarte, men viktige punkter",
    tableId: "Dokumenttekst",
    sourceExcerpt: selfServiceText,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const observedSelfServiceAnswer =
    "Atea leverer rollebasert selvbetjening der relevante brukere kan registrere, oppdatere og følge egne oppgaver, status og avvik i løsningen uten mellomledd. Selvbetjeningen avgrenses med rolle- og tilgangsstyring, validering av registrerte data og full sporbarhet på hvem som har utført hvilke endringer.";
  const strongSelfServiceAnswer =
    "Som leverandørens konkrete avklaring tilbyr Atea rollebasert selvbetjening der ansvarlige brukergrupper registrerer, oppdaterer og følger lossekøer, porttilgang og avvikslogg i sanntid. Handlingene avgrenses med rollebasert tilgang, datavalidering og sporbar logging av bruker, tidspunkt, status og endring.";

  assert.ok(
    requirementAnswerQualityIssues(
      observedSelfServiceAnswer,
      selfServiceEntry,
    ).includes("missing_realtime_coordination_source_binding"),
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(strongSelfServiceAnswer, selfServiceEntry),
    [],
  );
  assert.equal(
    normalizeRequirementAnswerResult(
      strongSelfServiceAnswer,
      selfServiceEntry,
      selfServiceEntry.sourceExcerpt,
    ).source,
    "batch",
  );
});

test("100-folder-002 spreadsheet repair binds named users and remains review-marked", () => {
  const text =
    "Brukere som terminaloperatører, transportører og havnevakt skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.";
  const entry = requirement({
    id: "K019",
    text,
    heading: "Løse krav fra behovsmøte",
    sourceExcerpt: text,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const observed = normalizeRequirementAnswerResult(
    "Brukere utfører oppgaver, registrering og oppfølging direkte i løsningen, og data registreres én gang i et felles datagrunnlag og gjenbrukes. Manuelle regneark brukes ikke.",
    entry,
    entry.sourceExcerpt,
  );
  assert.equal(observed.source, "deterministic_fallback");
  assert.match(observed.reason, /missing_no_manual_spreadsheet_user_binding/);

  const repair = buildDeterministicFinalRequirementControlRepair({ entry });

  assert.ok(repair);
  assert.match(
    repair.answer,
    /^Atea tilbyr en arbeidsflyt der terminaloperatører, transportører og havnevakt utfører oppgaver, registrering og oppfølging direkte i løsningen\./,
  );
  assert.match(repair.answer, /oppgaver opprettes og oppdateres/i);
  assert.match(repair.answer, /deles mellom brukergruppenes arbeidsflyter/i);
  assert.doesNotMatch(repair.answer, /TOS|AIS|ERP|integrasjon/i);
  assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);

  const metadata = buildDeterministicControlRepairMetadata({
    answers: [repair],
    ledger: [entry],
  });
  assert.equal(metadata.manual_review_required, true);
  assert.match(metadata.manual_review_note, /manuell gjennomgang/i);
});

test("100-folder-002 qualified spreadsheet parser rows preserve exact source semantics", () => {
  const text =
    "Brukere som terminaloperatører, transportører og havnevakt skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.";
  const documentFields = {
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  };
  const needsNote = requirement({
    ...documentFields,
    id: "Notatkrav-01",
    text,
    pages: [1],
    heading: "Løse krav fra behovsmøte",
    tableId: "Dokumenttekst",
    sourceExcerpt: `Notat - Notat fra behovsarbeidet: ${text}`,
    documentEntryOrder: 1104,
  });
  const qualified = requirement({
    ...documentFields,
    id: "Støttedokument - tabell 3, rad 2",
    text,
    pages: [],
    heading: "Ting som ikke må glemmes",
    tableId: "DOCX tabell 3",
    sourceExcerpt: `Hva er sagt / ønsket: ${text} | Må/Bør?: Kan | Kommentar: Gjelder produksjonsløsning`,
    documentEntryOrder: 4308,
  });
  const clarifiedText =
    `Leverandøren må avklare og beskrive hvordan følgende løses: ${text[0].toLocaleLowerCase("nb")}${text.slice(1)}`;
  const clarified = requirement({
    ...documentFields,
    id: "K023",
    text: clarifiedText,
    pages: [1],
    heading: "Uavklarte, men viktige punkter",
    tableId: undefined,
    sourceExcerpt: `K023: ${clarifiedText}`,
    documentEntryOrder: 6735,
  });

  const repairs = [needsNote, qualified, clarified].map((entry) => {
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.ok(repair, entry.id);
    assert.equal(repair.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
    assert.match(
      repair.answer,
      /terminaloperatører, transportører og havnevakt.*oppgaver.*registrering.*oppfølging.*direkte i løsningen/i,
    );
    assert.doesNotMatch(repair.answer, /TOS|AIS|ERP|kundens system/i);
    return repair;
  });

  assert.match(repairs[0].answer, /kravraden fra behovsarbeidet/i);
  assert.match(repairs[1].answer, /produksjonsløsningen/i);
  assert.match(repairs[1].answer, /prioritet «Kan»/i);
  assert.match(repairs[2].answer, /leverandørens konkrete avklaring/i);
  assert.equal(
    buildDeterministicControlRepairMetadata({
      answers: repairs,
      ledger: [needsNote, qualified, clarified],
    }).manual_review_required,
    true,
  );

  const rejected = [
    { ...needsNote, id: "Notatkrav-99" },
    { ...needsNote, heading: "Annet behovsmøte" },
    { ...needsNote, tableId: "Annen tabell" },
    { ...qualified, id: "Støttedokument - tabell 3, rad 9" },
    { ...qualified, heading: "Annen seksjon" },
    { ...qualified, tableId: "DOCX tabell 9" },
    {
      ...qualified,
      sourceExcerpt: `${qualified.sourceExcerpt} | Kommentar: Krever særskilt kundetilpasning`,
    },
    {
      ...qualified,
      sourceExcerpt: qualified.sourceExcerpt.replace(
        "Gjelder produksjonsløsning",
        "Kan prises som opsjon",
      ),
    },
    { ...clarified, id: "K999" },
    { ...clarified, heading: "Andre avklaringer" },
    { ...clarified, tableId: "Dokumenttekst" },
    {
      ...clarified,
      text: `${clarified.text} Løsningen skal også eksportere rapporter.`,
      sourceExcerpt: `K023: ${clarified.text} Løsningen skal også eksportere rapporter.`,
    },
  ];
  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.heading}: ${entry.tableId}: ${entry.sourceExcerpt}`,
    );
  }
});

test("100-folder-008 spreadsheet repairs preserve exact clarification and needs-note semantics", () => {
  const text =
    "Brukere som prosjektledere, montører, innkjøpere og kunder skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.";
  const documentFields = {
    documentId: "project-008-requirements",
    documentTitle: "008_Bilag_2_Krav_NordTak_Prosjekt_AS",
  };
  const clarifiedText =
    `Leverandøren må avklare og beskrive hvordan følgende løses: ${text[0].toLocaleLowerCase("nb")}${text.slice(1)}`;
  const clarified = requirement({
    ...documentFields,
    id: "KR-059",
    text: clarifiedText,
    pages: [1],
    heading: "Uavklarte, men viktige punkter",
    tableId: undefined,
    sourceExcerpt: `KR-059: ${clarifiedText}`,
    documentEntryOrder: 11578,
  });
  const needsNote = requirement({
    ...documentFields,
    id: "Notatkrav-11",
    text,
    pages: [1],
    heading: "Tekstutdrag fra bestiller",
    tableId: "Dokumenttekst",
    sourceExcerpt: `Notat - Notat fra behovsarbeidet: ${text}`,
    documentEntryOrder: 13289,
  });

  const observedClarification = normalizeRequirementAnswerResult(
    "Atea reduserer behovet for regneark ved at prosjektdata deles i en felles arbeidsflate.",
    clarified,
    clarified.sourceExcerpt,
  );
  assert.equal(observedClarification.source, "deterministic_fallback");
  assert.match(
    observedClarification.reason,
    /missing_direct_in_solution_workflow/,
  );
  assert.match(
    observedClarification.reason,
    /does_not_eliminate_manual_spreadsheets/,
  );

  const repairs = [clarified, needsNote].map((entry) => {
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.ok(repair, entry.id);
    assert.equal(repair.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
    assert.match(
      repair.answer,
      /prosjektledere, montører, innkjøpere og kunder.*oppgaver.*registrering.*oppfølging.*direkte i løsningen/i,
    );
    assert.match(repair.answer, /manuelle regneark brukes ikke/i);
    assert.doesNotMatch(
      repair.answer,
      /ERP|CRM|SharePoint|Procore|Power BI|kundens system|integrasjon/i,
    );
    return repair;
  });

  assert.match(repairs[0].answer, /leverandørens konkrete avklaring/i);
  assert.match(repairs[1].answer, /kravraden fra behovsarbeidet/i);
  const metadata = buildDeterministicControlRepairMetadata({
    answers: repairs,
    ledger: [clarified, needsNote],
  });
  assert.equal(metadata.manual_review_required, true);
  assert.match(metadata.manual_review_note, /manuell gjennomgang/i);

  const rejected = [
    { ...clarified, documentTitle: "008_Bilag_2_Krav_Annen_Kunde" },
    { ...clarified, id: "KR-999" },
    { ...clarified, heading: "Andre avklaringer" },
    { ...clarified, tableId: "Dokumenttekst" },
    {
      ...clarified,
      sourceExcerpt: `${clarified.sourceExcerpt} | Kommentar: Kan prises som opsjon`,
    },
    { ...needsNote, documentTitle: "008_Bilag_2_Krav_Annen_Kunde" },
    { ...needsNote, id: "Notatkrav-12" },
    { ...needsNote, heading: "Annet tekstutdrag" },
    { ...needsNote, tableId: "DOCX tabell 4" },
    {
      ...needsNote,
      sourceExcerpt: `${needsNote.sourceExcerpt} | Kommentar: Krever særskilt kundetilpasning`,
    },
    {
      ...needsNote,
      text: `${needsNote.text} Løsningen skal også støtte lønnskjøring.`,
      sourceExcerpt: `${needsNote.sourceExcerpt} Løsningen skal også støtte lønnskjøring.`,
    },
  ];
  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.heading}: ${entry.tableId}: ${entry.sourceExcerpt}`,
    );
  }
});

test("100-folder-002 operational case attachments are not mistaken for external answer evidence", () => {
  const text =
    "Teksten forutsetter at leverandøren skal beskrive hvordan løsningen ivaretar sporbarhet fra innmelding til avslutning for havneterminal og lasteoperasjoner.";
  const entry = requirement({
    id: "Avklaringskrav-04",
    text,
    pages: [1],
    heading: "Ting som ikke må glemmes",
    tableId: "Dokumenttekst",
    sourceExcerpt: `Implisitt: ${text}`,
    documentEntryOrder: 5711,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    answerDocumentId: "solution-document",
    answerReference: "Avklaringskrav-04",
  });
  const observedAnswer =
    "Løsningen oppretter et komplett hendelses- og revisjonsspor fra innmelding til avslutning, med bruker, rolle, tidspunkt, statusendring, kommentar og eventuelle vedlegg per sak eller driftsobjekt. Sporbarheten er søkbar og rapporterbar for anløp, containere, portpasseringer og avvik, og endringer kan ikke overskrive historikken.";

  assert.deepEqual(requirementAnswerQualityIssues(observedAnswer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(
      observedAnswer,
      entry,
      entry.sourceExcerpt,
    ).source,
    "batch",
  );
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: { ...entry, answerExcerpt: observedAnswer },
      assessment: "Godt",
      rationale: "Svaret er selvstendig og operasjonelt.",
      evidence: observedAnswer,
      recommendation: "Bevar vurderingen.",
    }).assessment,
    "Godt",
  );

  const attachmentOnly =
    "Se vedlegg 4 for komplett dokumentasjon og testbevis.";
  assert.ok(
    requirementAnswerQualityIssues(attachmentOnly, entry).includes(
      "attachment_only_requirement_answer",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(
      attachmentOnly,
      entry,
      entry.sourceExcerpt,
    ).source,
    "deterministic_fallback",
  );

  const selfContainedWithSupplement =
    `${observedAnswer} Se vedlegg 4 for supplerende kontrollmatrise.`;
  assert.deepEqual(
    requirementAnswerQualityIssues(selfContainedWithSupplement, entry),
    [],
  );
  assert.equal(
    normalizeRequirementAnswerResult(
      selfContainedWithSupplement,
      entry,
      entry.sourceExcerpt,
    ).source,
    "batch",
  );
});

test("100-folder-002 seasonal clarification commits a supplier baseline and stays review-marked", () => {
  const text =
    "Leverandøren må avklare og beskrive hvordan følgende løses: leverandøren skal beskrive hvordan løsningen ivaretar skalerbarhet ved sesongtopper for havneterminal og lasteoperasjoner.";
  const entry = requirement({
    id: "Avklaringskrav-06",
    text,
    pages: [1],
    heading: "Uavklarte, men viktige punkter",
    tableId: "Dokumenttekst",
    sourceExcerpt: `Avklaring: ${text}`,
    documentEntryOrder: 6945,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const observedAnswer =
    "Atea leverer løsningen som en skybasert tjeneste med elastisk kapasitet, separate applikasjons- og integrasjonskomponenter og købasert behandling av hendelser, slik at last kan håndteres uten at brukerflytene stopper ved sesongtopper. Overvåking av kapasitet, responstid og integrasjonskøer brukes til å varsle avvik og justere kapasitet før og under topper; eksakte terskler fastsettes i design og driftsetablering.";
  const observedIssues = requirementAnswerQualityIssues(observedAnswer, entry);
  for (const issue of [
    "missing_dimensioning_source_focus_binding",
    "missing_capacity_baseline",
    "missing_load_performance_test",
    "missing_scaling_capacity_margin",
    "missing_proposed_performance_acceptance",
    "missing_supplier_proposed_numeric_performance_target",
    "missing_dimensioning_clarification_qualifier",
  ]) {
    assert.ok(observedIssues.includes(issue), issue);
  }
  assert.equal(
    normalizeRequirementAnswerResult(
      observedAnswer,
      entry,
      entry.sourceExcerpt,
    ).source,
    "deterministic_fallback",
  );

  const directive = buildRequirementRepairDirective(
    entry,
    `quality_gate: ${observedIssues.join(", ")}`,
  );
  assert.match(directive, /leverandørens konkrete avklaring/i);
  assert.match(directive, /logge inn, åpne arbeidsliste og lagre endring/i);
  assert.match(directive, /p95 under 2 sekunder/i);
  assert.match(directive, /200 samtidige brukere/i);
  assert.match(directive, /last- og ytelsestest/i);
  assert.match(directive, /reservekapasitet/i);

  const repair = buildDeterministicFinalRequirementControlRepair({ entry });
  assert.ok(repair);
  assert.equal(repair.source, "deterministic_control_repair");
  assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
  assert.match(repair.answer, /leverandørens konkrete avklaring/i);
  assert.match(repair.answer, /havneterminal og lasteoperasjoner/i);
  assert.match(repair.answer, /logge inn, åpne arbeidsliste og lagre endring/i);
  assert.match(repair.answer, /p95 under 2 sekunder/i);
  assert.match(repair.answer, /200 samtidige brukere/i);
  assert.match(repair.answer, /lasttest og ytelsestest/i);
  assert.match(repair.answer, /autoskalering og reservekapasitet/i);
  assert.match(repair.answer, /kapasitetsmargin/i);
  assert.match(repair.answer, /leverandørforutsetning, ikke kundekrav/i);

  const metadata = buildDeterministicControlRepairMetadata({
    answers: [repair],
    ledger: [entry],
  });
  assert.equal(metadata.manual_review_required, true);
  assert.equal(metadata.deterministic_control_repair_answers, 1);
  assert.equal(
    metadata.deterministic_control_repair_rows[0]?.pattern,
    "seasonal_scalability",
  );

  const falselyCustomerAttributed = repair.answer.replace(
    "Ateas leverandørforutsetning, ikke kundekrav fra kilden",
    "kundens fastsatte krav i bilaget",
  );
  assert.ok(
    requirementAnswerQualityIssues(falselyCustomerAttributed, entry).includes(
      "missing_supplier_proposed_numeric_performance_target",
    ),
  );
});

test("100-folder-002 seasonal deterministic repair fails closed outside the exact source row", () => {
  const text =
    "Leverandøren må avklare og beskrive hvordan følgende løses: leverandøren skal beskrive hvordan løsningen ivaretar skalerbarhet ved sesongtopper for havneterminal og lasteoperasjoner.";
  const base = requirement({
    id: "Avklaringskrav-06",
    text,
    pages: [1],
    heading: "Uavklarte, men viktige punkter",
    tableId: "Dokumenttekst",
    sourceExcerpt: `Avklaring: ${text}`,
    documentId: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
    documentTitle: "002_Bilag_2_Krav_HavneBlikk_Terminaldrift_IKS.docx",
  });
  const changedText = `${text} Løsningen skal også eksportere kapasitetsrapporter.`;
  const rejected = [
    { ...base, id: "Avklaringskrav-60" },
    { ...base, heading: "Andre avklaringer" },
    { ...base, tableId: "DOCX tabell 6" },
    { ...base, text: changedText, sourceExcerpt: `Avklaring: ${changedText}` },
    {
      ...base,
      sourceExcerpt: `${base.sourceExcerpt} | Prioritet: Bør`,
    },
    {
      ...base,
      sourceExcerpt: `${base.sourceExcerpt} | Kan prises som opsjon`,
    },
    {
      ...base,
      sourceExcerpt: `${base.sourceExcerpt} | Krever særskilt kundetilpasning`,
    },
    { ...base, documentTitle: "Opsjoner og tilvalg" },
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.heading}: ${entry.tableId}: ${entry.sourceExcerpt}`,
    );
  }
});

function highConfidenceCoverageEntry(fixture, answer = fixture.completeAnswer, sourceText = fixture.text) {
  return requirement({
    id: fixture.id,
    text: fixture.text,
    sourceExcerpt: `Kravgrunnlag: ${sourceText} | Svarrad: ${answer}`,
    answerExcerpt: answer,
    answerDocumentId: "solution",
    answerReference: fixture.id,
  });
}

function requirementFixture(count = 44) {
  return Array.from({ length: count }, (_, index) => {
    const nr = index + 1;
    return requirement({
      id: `K-${String(nr).padStart(3, "0")}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar, testprotokoll og månedlig rapportering.`,
      pages: [nr],
      heading: `Område ${Math.ceil(nr / 5)}`,
      headingPath: ["Kravspesifikasjon", `Område ${Math.ceil(nr / 5)}`],
      documentId: "requirements-document",
      documentTitle: "Kravspesifikasjon",
      answerDocumentId: "solution-document",
      answerDocumentTitle: "Leverandørens svar",
      sourceExcerpt: `K-${nr} | Kravgrunnlag med kontroll ${nr}, ansvar og testbar dokumentasjon.`,
      answerExcerpt: `Atea leverer kontroll ${nr} med navngitt eier, testprotokoll, avvikslogg og månedlig rapportering.`,
    });
  });
}

function coverageFixture(count = 44) {
  const items = Array.from({ length: count }, (_, index) => {
    const nr = index + 1;
    return {
      order_index: index,
      reference: `K-${String(nr).padStart(3, "0")}`,
      full_reference: `Kravspesifikasjon > Område ${Math.ceil(nr / 5)} > K-${nr}`,
      source_reference: `Kravspesifikasjon, side ${nr}`,
      source_document_id: "requirements-document",
      source_document_title: "Kravspesifikasjon",
      answer_document_id: "solution-document",
      answer_document_title: "Leverandørens svar",
      requirement_subtitle: `Område ${Math.ceil(nr / 5)}`,
      heading_path: ["Kravspesifikasjon", `Område ${Math.ceil(nr / 5)}`],
      page_range: `side ${nr}`,
      table_id: `K-${nr}`,
      requirement: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar og testbevis.`,
      assessment: "Godt",
      rationale: `Kontroll ${nr} er konkret og testbar.`,
      evidence: `Atea leverer kontroll ${nr} med eier, testprotokoll og rapportering.`,
      recommendation: `Behold sporbarheten for kontroll ${nr}.`,
    };
  });

  return {
    total_requirements: count,
    assessed_requirements: count,
    good: count,
    weak: 0,
    missing: 0,
    unclear: 0,
    confidence: "Høy",
    coverage_summary: `${count} av ${count} krav vurdert.`,
    items,
  };
}

function distributedCoverageFixture(count) {
  const base = coverageFixture(count);
  const assessments = ["Mangler", "Dårlig", "Uklart", "Dårlig"];
  const items = base.items.map((item, index) => {
    const documentIndex = index % 7;
    const sectionIndex = index % 13;
    const nonGood = index % 5 === 0;
    const assessment = nonGood
      ? assessments[Math.floor(index / 5) % assessments.length]
      : "Godt";
    const detail = (label, limit) =>
      `${label} ${"detaljert kontrollgrunnlag ".repeat(40)}`.slice(0, limit);

    return {
      ...item,
      reference: `K-${String((index % 25) + 1).padStart(3, "0")}`,
      full_reference: `Dokument ${documentIndex} > Seksjon ${sectionIndex} > Rad ${index + 1}`,
      source_reference: detail(
        `Dokument ${documentIndex}, side ${index + 1}, tabell T-${sectionIndex}`,
        360,
      ),
      source_document_id: `requirements-document-${documentIndex}`,
      source_document_title: `Kravspesifikasjon ${documentIndex}`,
      answer_document_id: `solution-document-${documentIndex}`,
      answer_document_title: `Leverandørens svar ${documentIndex}`,
      requirement_subtitle: `Seksjon ${sectionIndex}`,
      heading_path: [`Dokument ${documentIndex}`, `Seksjon ${sectionIndex}`],
      page_range: `Side ${index + 1}`,
      table_id: `T-${sectionIndex}`,
      requirement: detail(`Kravtekst ${index + 1}`, 680),
      assessment,
      rationale: detail(`Begrunnelse ${index + 1}`, 440),
      evidence: detail(`Svarbevis ${index + 1}`, 400),
      recommendation: detail(`Anbefaling ${index + 1}`, 500),
    };
  });
  const countAssessment = (assessment) =>
    items.filter((item) => item.assessment === assessment).length;

  return {
    ...base,
    good: countAssessment("Godt"),
    weak: countAssessment("Dårlig"),
    missing: countAssessment("Mangler"),
    unclear: countAssessment("Uklart"),
    items,
  };
}

function evidenceRelinkingCoverageFixture() {
  const evidenceRows = [
    {
      reference: "R-001",
      evidence:
        "Atea leverer en felles arbeidsflate for oppgaver, registrering og oppfølging uten manuelle regneark.",
    },
    {
      reference: "R-003",
      evidence:
        "Atea integrerer kalender og identitet gjennom et kontrollert integrasjonslag der hver hendelse behandles med idempotensnøkkel eller duplikatkontroll og lagres i varig kø med outbox/inbox, slik at data kan gjenopptas uten tap.",
    },
    {
      reference: "R-010",
      evidence:
        "Atea logger alle endringer i oppdrag, frivillige, samtykker og meldinger i en revisjonssporlogg med bruker eller tjenesteidentitet, tidspunkt, gammel verdi og ny verdi. Loggen er søkbar for kontroll og revisjon.",
    },
    {
      reference: "R-005",
      evidence:
        "Overvåking av tilgjengelighet, integrasjonsstatus, køer, feilrater og sentrale brukertransaksjoner varsles til ansvarlige driftsroller.",
    },
    {
      reference: "R-002",
      evidence:
        "Atea leverer uttrekk av oppdrag, frivillige, samtykker og meldinger i et strukturert format fra produksjonsløsningen ved revisjon eller leverandørbytte. Uttrekket følger definerte dataobjekter og felt.",
    },
  ];
  const base = coverageFixture(evidenceRows.length);
  const items = evidenceRows.map((row, index) => ({
    ...base.items[index],
    order_index: index,
    reference: row.reference,
    full_reference: `Kravdokument > Kontrollområde > ${row.reference}`,
    source_reference: `Kravdokument, side ${index + 1}, ${row.reference}`,
    evidence: row.evidence,
  }));

  return {
    ...base,
    items,
  };
}

function legacyExpandedCoveragePayload(coverage) {
  return {
    total_requirements: coverage.total_requirements,
    assessed_requirements: coverage.assessed_requirements,
    good: coverage.good,
    weak: coverage.weak,
    missing: coverage.missing,
    unclear: coverage.unclear,
    confidence: coverage.confidence,
    coverage_summary: coverage.coverage_summary,
    coverage_registry: coverage.items.map((item, index) => ({
      nr: item.order_index + 1 || index + 1,
      reference: item.reference,
      full_reference: item.full_reference,
      source_reference: item.source_reference,
      source_document_id: item.source_document_id,
      source_document_title: item.source_document_title,
      answer_document_id: item.answer_document_id,
      answer_document_title: item.answer_document_title,
      requirement_subtitle: item.requirement_subtitle,
      heading_path: item.heading_path,
      page_range: item.page_range,
      table_id: item.table_id,
      assessment: item.assessment,
      source_excerpt: item.requirement,
      answer_excerpt: item.evidence,
    })),
    prioritized_non_good_requirements: coverage.items
      .filter((item) => item.assessment !== "Godt")
      .slice(0, 10)
      .map((item) => ({
        reference: item.reference,
        source_reference: item.source_reference,
        assessment: item.assessment,
        rationale: item.rationale.slice(0, 240),
        recommendation: item.recommendation.slice(0, 260),
      })),
    good_examples: coverage.items
      .filter((item) => item.assessment === "Godt")
      .slice(0, 3)
      .map((item) => ({
        reference: item.reference,
        source_reference: item.source_reference,
        rationale: item.rationale.slice(0, 220),
      })),
  };
}

test("forbedret kravsvar keeps every explicit requirement document", () => {
  const requirementDocuments = Array.from({ length: 12 }, (_, index) =>
    document(`document-${index + 1}`),
  );
  const selected = selectRequirementDocumentsForGeneration({
    artifactType: "forbedret_kravsvar",
    projectName: "Test",
    customerAnalysis: null,
    solutionEvaluation: null,
    customerDocument: null,
    solutionDocument: null,
    supportingDocuments: [],
    requirementDocuments,
    knowledgeArtifacts: [],
  });

  assert.deepEqual(
    selected.requirementDocuments.map((item) => item.id),
    requirementDocuments.map((item) => item.id),
  );
});

test("forbedret kravsvar prepends the primary customer even when formal documents are explicit", () => {
  const customer = {
    ...document("customer"),
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "054_Bilag_1_NaboOmsorg_Koordinering_SA",
    file_name: "054_Bilag_1_NaboOmsorg_Koordinering_SA.pdf",
  };
  const formal = document("formal");
  const selected = selectRequirementDocumentsForGeneration({
    artifactType: "forbedret_kravsvar",
    projectName: "Test",
    customerAnalysis: null,
    solutionEvaluation: null,
    customerDocument: customer,
    solutionDocument: null,
    supportingDocuments: [],
    requirementDocuments: [formal],
    knowledgeArtifacts: [],
  });

  assert.deepEqual(
    selected.requirementDocuments.map((item) => item.id),
    [customer.id, formal.id],
  );
});

test("small explicit ledgers are accepted only when every detected ID is accounted for", () => {
  const requirementDocument = {
    ...document("small-ledger"),
    raw_text: [
      "| Krav-ID | Krav |",
      "|---|---|",
      "| K-1 | Leverandøren skal dokumentere logging. |",
      "| K-2 | Leverandøren skal dokumentere backup. |",
    ].join("\n"),
  };
  const completeLedger = [
    requirement({
      id: "K-1",
      documentId: requirementDocument.id,
      documentTitle: requirementDocument.title,
      text: "Leverandøren skal dokumentere logging.",
    }),
    requirement({
      id: "K-2",
      documentId: requirementDocument.id,
      documentTitle: requirementDocument.title,
      text: "Leverandøren skal dokumentere backup.",
    }),
  ];

  assert.equal(
    hasExplicitlyCompleteSmallRequirementLedger({
      ledger: completeLedger,
      requirementDocuments: [requirementDocument],
    }),
    true,
  );
  assert.equal(
    hasExplicitlyCompleteSmallRequirementLedger({
      ledger: completeLedger.slice(0, 1),
      requirementDocuments: [requirementDocument],
    }),
    false,
  );
  assert.equal(
    hasExplicitlyCompleteSmallRequirementLedger({
      ledger: [{ ...completeLedger[0], id: "Ustrukturert krav 1" }],
      requirementDocuments: [
        { ...requirementDocument, raw_text: "Ustrukturert krav uten eksplisitt ID" },
      ],
    }),
    false,
  );
});

test("forbedret kravsvar fails closed without a verified requirement ledger", () => {
  assert.throws(
    () =>
      assertVerifiedRequirementLedgerGeneration({
        artifactType: "forbedret_kravsvar",
        requirementDocumentCount: 1,
        requirementCount: 2,
        confidence: { score: 0.48, level: "low" },
        verified: false,
      }),
    /Full-dokumentgenerering kan ikke lagres uten en verifisert kravledger/i,
  );
  assert.doesNotThrow(() =>
    assertVerifiedRequirementLedgerGeneration({
      artifactType: "forbedret_kravsvar",
      requirementDocumentCount: 1,
      requirementCount: 2,
      confidence: { score: 0.74, level: "medium" },
      verified: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertVerifiedRequirementLedgerGeneration({
      artifactType: "losningsutkast",
      requirementDocumentCount: 0,
      requirementCount: 0,
      confidence: { score: 0, level: "low" },
      verified: false,
    }),
  );
});

test("forbedret kravsvar fails closed when one ready formal source has zero extracted rows", () => {
  const populated = document("formal-populated");
  const empty = document("formal-empty");
  const populatedLedger = Array.from({ length: 40 }, (_, index) =>
    requirement({
      id: `K-${index + 1}`,
      documentId: populated.id,
      documentTitle: populated.title,
    }),
  );

  assert.throws(
    () =>
      assertRequirementArtifactSourceLedgersComplete({
        artifactType: "forbedret_kravsvar",
        requirementDocuments: [populated, empty],
        requirementLedgerResults: [
          { document: populated, ledger: populatedLedger },
          { document: empty, ledger: [] },
        ],
      }),
    /Kravledgeren er tom for kravdokument: Krav formal-empty/i,
  );
});

test("solution evaluation ledger keeps every readable document", async () => {
  const documents = Array.from({ length: 12 }, (_, index) =>
    document(`evaluation-document-${index + 1}`),
  );
  const bundle = await buildEvaluationLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    documents,
  });

  assert.equal(bundle.requirementLedgerResults.length, documents.length);
  assert.deepEqual(
    bundle.requirementLedgerResults.map((entry) => entry.document.id),
    documents.map((item) => item.id),
  );
  assert.ok(bundle.requirementLedgerResults.every((entry) => entry.ledger.length === 1));
});

test("solution evaluation ledger keeps a structure-only formal requirement document", async () => {
  const structured = {
    ...document("structure-only-formal"),
    file_format: "pdf",
    raw_text: "",
    structure_map: [
      {
        reference: "Side 1, rad 1",
        text: "",
        kind: "docling_table_row",
        parser: "docling",
        page: 1,
        table_index: 1,
        row_index: 1,
        cells: {
          "ID / markering": "K-STRUCT-1",
          Krav: "Leverandøren skal dokumentere strukturert tilgangsstyring.",
          Prioritet: "Må",
        },
      },
    ],
  };

  const bundle = await buildEvaluationLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    documents: [structured],
  });

  assert.equal(bundle.requirementLedgerResults.length, 1);
  assert.equal(bundle.requirementLedgerResults[0].document.id, structured.id);
  assert.equal(bundle.requirementLedgerResults[0].ledger.length, 1);
  assert.match(
    bundle.requirementLedgerResults[0].ledger[0].text,
    /strukturert tilgangsstyring/u,
  );
});

test("solution coverage fallback canonicalizes customer and formal source ledgers", async () => {
  const requirementText = "Leverandøren skal dokumentere tilgangsstyring.";
  const customer = {
    ...document("customer"),
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundehoveddokument",
    raw_text: `| Krav-ID | Krav |\n|---|---|\n| K-1 | ${requirementText} |`,
  };
  const formal = {
    ...document("formal"),
    raw_text: `| Krav-ID | Krav |\n|---|---|\n| K-1 | ${requirementText} |`,
  };

  const ledger = await buildRequirementCoverageLedgerFromDocuments([
    customer,
    formal,
  ]);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].documentId, formal.id);
});

test("equal requirement IDs remain distinct across documents", () => {
  const entries = [
    requirement({ documentId: "document-a", documentTitle: "A" }),
    requirement({ documentId: "document-b", documentTitle: "B" }),
  ];

  assert.equal(dedupeRequirementLedger(entries).length, 2);
  assert.equal(
    dedupeRequirementLedger([...entries, { ...entries[0] }]).length,
    2,
  );
});

test("reused explicit IDs preserve distinct ordered source rows and collapse true duplicates", () => {
  const accessControl = requirement({
    id: "K-1",
    documentId: "document-a",
    documentEntryOrder: 3,
    pages: [1],
    heading: "Sikkerhet",
    sourceExcerpt: "Rad 3",
    text: "Leverandøren skal dokumentere tilgangsstyring.",
  });
  const backup = requirement({
    id: "K-1",
    documentId: "document-a",
    documentEntryOrder: 7,
    pages: [2],
    heading: "Kontinuitet",
    sourceExcerpt: "Rad 7",
    text: "Leverandøren skal dokumentere sikkerhetskopiering.",
  });

  assert.deepEqual(
    dedupeRequirementLedger([accessControl, backup]).map(
      (entry) => entry.text,
    ),
    [accessControl.text, backup.text],
  );
  assert.equal(
    dedupeRequirementLedger([accessControl, backup, { ...accessControl }])
      .length,
    2,
  );

  const repeatedAccessControl = {
    ...accessControl,
    documentEntryOrder: 7,
    pages: [2],
    sourceExcerpt: "Rad 7",
  };
  assert.equal(
    dedupeRequirementLedger([
      accessControl,
      repeatedAccessControl,
      { ...accessControl },
    ]).length,
    2,
  );

  const duplicateExtractorProjection = {
    ...accessControl,
    documentEntryOrder: undefined,
    sourceExcerpt:
      "Kravtekst før svarfelt: Leverandøren skal dokumentere tilgangsstyring.",
    text: "Leverandøren skal dokumentere tilgangsstyring",
  };
  assert.equal(
    dedupeRequirementLedger([accessControl, duplicateExtractorProjection])
      .length,
    1,
  );
});

test("explicit base ID matches a generated display reference with a heading suffix", () => {
  const requirementText =
    "Leverandøren skal dokumentere roller, ansvar og grensesnitt mot øvrige leverandører.";
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "ID 2-01",
        text: requirementText,
        heading: "Generelle krav til tilbudet",
        documentId: "requirements",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "ID 2-01 - Generelle krav til tilbudet",
        text: requirementText,
        heading: "Kravbesvarelse",
        documentId: "solution",
        answerExcerpt:
          "Roller, ansvar og grensesnitt mot øvrige leverandører dokumenteres og verifiseres før oppstart.",
      }),
    ],
  });

  assert.match(merged.answerExcerpt, /øvrige leverandører dokumenteres/u);
  assert.equal(merged.answerDocumentId, "solution");
});

test("a heading suffix cannot hide a conflicting explicit base ID", () => {
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "ID 2-01",
        text: "Leverandøren skal dokumentere roller og ansvar.",
        documentId: "requirements",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "ID 2-02 - Generelle krav til tilbudet",
        text: "Leverandøren skal dokumentere roller og ansvar.",
        documentId: "solution",
        answerExcerpt: "Dette svaret tilhører en annen eksplisitt krav-ID.",
      }),
    ],
  });

  assert.equal(merged.answerExcerpt, "");
  assert.equal(merged.answerDocumentId, undefined);
});

test("equal explicit base IDs across documents remain text-bound", () => {
  const sourceRequirements = [
    requirement({
      id: "ID 2-01",
      text: "Dokument A krever dokumentert tilgangsstyring og sporbar kontroll.",
      documentId: "requirements-a",
    }),
    requirement({
      id: "ID 2-01",
      text: "Dokument B krever dokumentert backup og verifisert gjenoppretting.",
      documentId: "requirements-b",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "ID 2-01 - Backup",
      text: sourceRequirements[1].text,
      documentId: "solution",
      answerExcerpt: "B-SVAR med verifisert gjenoppretting.",
    }),
    requirement({
      id: "ID 2-01 - Tilgangsstyring",
      text: sourceRequirements[0].text,
      documentId: "solution",
      answerExcerpt: "A-SVAR med sporbar tilgangskontroll.",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });

  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    [
      "A-SVAR med sporbar tilgangskontroll.",
      "B-SVAR med verifisert gjenoppretting.",
    ],
  );
});

test("source-bound synthetic customer requirement receives its exact solution answer", () => {
  const requirementText =
    "Løsningen skal tilbys som en moderne skytjeneste med sikker autentisering og rollebasert tilgang.";
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "Side 1 krav 1",
        text: requirementText,
        pages: [],
        heading: "",
        documentId: "customer-a",
        documentTitle: "Kundedokument A",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "SIDE 1 KRAV 1",
        text: requirementText,
        pages: [1],
        heading: "Kravbesvarelse",
        tableId: "Markdown kravbesvarelse",
        answerExcerpt:
          "Atea leverer en sikker skytjeneste med rollebasert tilgang, navngitt ansvar og dokumentert verifikasjon.",
        answerReference: "Kundedokument A, Side 1 krav 1",
        documentId: "solution",
        documentTitle: "Generert kravbesvarelse",
      }),
    ],
  });

  assert.match(merged.answerExcerpt, /sikker skytjeneste/u);
  assert.equal(merged.answerDocumentId, "solution");
  assert.equal(merged.answerReference, "Kundedokument A, Side 1 krav 1");
});

test("equal synthetic refs from separate documents bind by exact source reference", () => {
  const requirementText =
    "Løsningen skal dokumentere en sikker kontroll med navngitt ansvar og verifikasjon.";
  const sourceRequirements = [
    requirement({
      id: "Side 1 krav 1",
      text: requirementText,
      pages: [],
      heading: "",
      documentId: "customer-a",
      documentTitle: "Kundedokument A",
    }),
    requirement({
      id: "Side 1 krav 1",
      text: requirementText,
      pages: [],
      heading: "",
      documentId: "customer-b",
      documentTitle: "Kundedokument B",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "SIDE 1 KRAV 1",
      text: requirementText,
      tableId: "Markdown kravbesvarelse",
      answerExcerpt: "B-SVAR med unik dokumentbinding og kontroll.",
      answerReference: "Kundedokument B, Side 1 krav 1",
      documentId: "solution",
    }),
    requirement({
      id: "SIDE 1 KRAV 1",
      text: requirementText,
      tableId: "Markdown kravbesvarelse",
      answerExcerpt: "A-SVAR med unik dokumentbinding og kontroll.",
      answerReference: "Kundedokument A, Side 1 krav 1",
      documentId: "solution",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });

  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    [
      "A-SVAR med unik dokumentbinding og kontroll.",
      "B-SVAR med unik dokumentbinding og kontroll.",
    ],
  );
  assert.deepEqual(
    merged.map((entry) => entry.answerReference),
    [
      "Kundedokument A, Side 1 krav 1",
      "Kundedokument B, Side 1 krav 1",
    ],
  );
});

test("invented synthetic solution row cannot add source coverage or match by position", () => {
  const sourceText =
    "Kunden skal få en dokumentert skytjeneste med sikker autentisering og rollebasert tilgang.";
  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "Side 1 krav 1",
        text: sourceText,
        pages: [],
        heading: "",
        documentId: "customer-a",
        documentTitle: "Kundedokument A",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "Side 9 krav 99",
        text: sourceText,
        tableId: "Markdown kravbesvarelse",
        answerExcerpt: "OPPDIKTET SVAR som står først i løsningsdokumentet.",
        // Even a copied source binding and exact requirement text cannot make
        // a different synthetic row reference match by position.
        answerReference: "Kundedokument A, Side 1 krav 1",
        documentId: "solution",
      }),
      requirement({
        id: "SIDE 1 KRAV 1",
        text: sourceText,
        tableId: "Markdown kravbesvarelse",
        answerExcerpt: "KORREKT SVAR med eksakt kildebinding og verifikasjon.",
        answerReference: "Kundedokument A, Side 1 krav 1",
        documentId: "solution",
      }),
      requirement({
        id: "Side 7 krav 7",
        text: "Et oppdiktet tilleggskrav skal aldri utvide kundens kravledger.",
        tableId: "Markdown kravbesvarelse",
        answerExcerpt: "Ekstra svar som ikke finnes i kundens kravgrunnlag.",
        answerReference: "Oppdiktet dokument, Side 7 krav 7",
        documentId: "solution",
      }),
    ],
  });

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0].answerExcerpt,
    "KORREKT SVAR med eksakt kildebinding og verifikasjon.",
  );
  assert.equal(merged[0].answerDocumentId, "solution");
});

test("synthetic ID and source binding cannot override mismatched requirement text", () => {
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "Side 1 krav 1",
        text: "Kunden skal få sikker autentisering med rollebasert tilgang og sporbar kontroll.",
        pages: [],
        heading: "",
        documentId: "customer-a",
        documentTitle: "Kundedokument A",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "SIDE 1 KRAV 1",
        text: "Løsningen skal i stedet levere en rapportfunksjon uten tilgangskontroll.",
        tableId: "Markdown kravbesvarelse",
        answerExcerpt:
          "Dette svaret må ikke kobles selv om ID og kildebinding er kopiert.",
        answerReference: "Kundedokument A, Side 1 krav 1",
        documentId: "solution",
      }),
    ],
  });

  assert.equal(merged.answerExcerpt, "");
  assert.equal(merged.answerDocumentId, undefined);
  assert.doesNotMatch(merged.sourceExcerpt, /Svarrad:/u);
});

test("unbound synthetic solution row remains unanswered", () => {
  const requirementText =
    "Kunden skal få sikker autentisering med rollebasert tilgang og sporbar kontroll.";
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [
      requirement({
        id: "Side 1 krav 1",
        text: requirementText,
        pages: [],
        heading: "",
        documentId: "customer-a",
        documentTitle: "Kundedokument A",
      }),
    ],
    solutionEntries: [
      requirement({
        id: "SIDE 1 KRAV 1",
        text: requirementText,
        tableId: "Markdown kravbesvarelse",
        answerExcerpt:
          "Atea leverer sikker autentisering med rollebasert og sporbar kontroll.",
        answerReference: undefined,
        documentId: "solution",
      }),
    ],
  });

  assert.equal(merged.answerExcerpt, "");
  assert.equal(merged.answerDocumentId, undefined);
  assert.doesNotMatch(merged.sourceExcerpt, /Svarrad:/u);
});

test("matched row without answer stays unanswered", () => {
  const [merged] = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements: [requirement({ documentId: "requirements" })],
    solutionEntries: [
      requirement({
        documentId: "solution",
        sourceExcerpt: "Kravref: K-1 | Krav: Leverandøren skal dokumentere tilgangsstyring. | Svar:",
        answerExcerpt: null,
      }),
    ],
  });

  assert.equal(merged.answerExcerpt, "");
  assert.equal(merged.answerDocumentId, undefined);
  assert.doesNotMatch(merged.sourceExcerpt, /Svarrad:/);
});

test("duplicate bare IDs merge by exact table identity and requirement text, not order", () => {
  const sourceRequirements = [
    requirement({
      id: "R-1",
      tableId: "Table-A",
      service: "Alpha",
      text: "ALPHA skal leveres med dokumentert kontroll og sporbar verifikasjon.",
      sourceExcerpt: "Table-A R-1 ALPHA kravgrunnlag.",
      documentId: "requirements",
    }),
    requirement({
      id: "R-1",
      tableId: "Table-B",
      service: "Beta",
      text: "BETA skal leveres med dokumentert kontroll og sporbar verifikasjon.",
      sourceExcerpt: "Table-B R-1 BETA kravgrunnlag.",
      documentId: "requirements",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "R-1",
      tableId: "Table-B",
      service: "Beta",
      text: sourceRequirements[1].text,
      answerExcerpt: "BETA-SVAR med navngitt eier og testprotokoll.",
      sourceExcerpt: "Table-B R-1 BETA svarrad.",
      documentId: "solution",
    }),
    requirement({
      id: "R-1",
      tableId: "Table-A",
      service: "Alpha",
      text: sourceRequirements[0].text,
      answerExcerpt: "ALPHA-SVAR med navngitt eier og testprotokoll.",
      sourceExcerpt: "Table-A R-1 ALPHA svarrad.",
      documentId: "solution",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });

  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    [
      "ALPHA-SVAR med navngitt eier og testprotokoll.",
      "BETA-SVAR med navngitt eier og testprotokoll.",
    ],
  );
  assert.ok(merged.every((entry) => entry.answerDocumentId === "solution"));
});

test("exact normalized requirement text disambiguates reversed duplicate IDs", () => {
  const sourceRequirements = [
    requirement({
      id: "R-1",
      text: "ALPHA skal dokumentere en unik kontrollkjede for revisjon.",
      documentId: "requirements",
    }),
    requirement({
      id: "R-1",
      text: "BETA skal dokumentere en separat kontrollkjede for revisjon.",
      documentId: "requirements",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "R-1",
      text: sourceRequirements[1].text,
      answerExcerpt: "BETA-TEXT-SVAR med kontroll og verifikasjon.",
      documentId: "solution",
    }),
    requirement({
      id: "R-1",
      text: sourceRequirements[0].text,
      answerExcerpt: "ALPHA-TEXT-SVAR med kontroll og verifikasjon.",
      documentId: "solution",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });
  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    [
      "ALPHA-TEXT-SVAR med kontroll og verifikasjon.",
      "BETA-TEXT-SVAR med kontroll og verifikasjon.",
    ],
  );
});

test("ambiguous duplicate bare IDs remain unanswered fail-closed", () => {
  const sourceRequirements = [
    requirement({
      id: "R-1",
      text: "Første kildekrav skal ha en dokumentert kontroll.",
      documentId: "requirements",
    }),
    requirement({
      id: "R-1",
      text: "Andre kildekrav skal ha en dokumentert kontroll.",
      documentId: "requirements",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "R-1",
      text: "Leverandørens første rad har ingen eksakt kravtekst.",
      answerExcerpt: "SVAR-A som ikke kan bindes sikkert.",
      documentId: "solution",
    }),
    requirement({
      id: "R-1",
      text: "Leverandørens andre rad har ingen eksakt kravtekst.",
      answerExcerpt: "SVAR-B som ikke kan bindes sikkert.",
      documentId: "solution",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });
  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    ["", ""],
  );
  assert.ok(merged.every((entry) => entry.answerDocumentId === undefined));
  assert.ok(merged.every((entry) => !entry.sourceExcerpt.includes("Svarrad:")));
});

test("resolving one duplicate by text does not bind the remainder by elimination", () => {
  const exactText =
    "Første R-1 skal levere en unik og dokumentert kontrollkjede.";
  const sourceRequirements = [
    requirement({ id: "R-1", text: exactText, documentId: "requirements" }),
    requirement({
      id: "R-1",
      text: "Andre R-1 skal levere en annen dokumentert kontrollkjede.",
      documentId: "requirements",
    }),
  ];
  const solutionEntries = [
    requirement({
      id: "R-1",
      text: exactText,
      answerExcerpt: "FØRSTE-SVAR er eksakt bundet.",
      documentId: "solution",
    }),
    requirement({
      id: "R-1",
      text: "En ubeslektet løsningsrad uten eksakt identitet.",
      answerExcerpt: "REST-SVAR må ikke bindes ved eliminasjon.",
      documentId: "solution",
    }),
  ];

  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });
  assert.deepEqual(
    merged.map((entry) => entry.answerExcerpt),
    ["FØRSTE-SVAR er eksakt bundet.", ""],
  );
});

test("source-to-solution matching stays indexed for large ledgers", () => {
  const rowCount = 300;
  const sourceRequirements = Array.from({ length: rowCount }, (_, index) =>
    requirement({
      id: `R-${index + 1}`,
      text: `Leverandøren skal dokumentere unik kontroll ${index + 1} med sporbarhet og revisjonslogg.`,
      tableId: `Tabell ID 8-${(index % 99) + 1}`,
      service: `Tjeneste ${index + 1}`,
      documentId: "requirements",
      documentEntryOrder: index,
    }),
  );
  const solutionEntries = sourceRequirements.map((entry, index) =>
    requirement({
      ...entry,
      answerExcerpt: `Svar ${index + 1} beskriver ansvarlig eier, revisjonslogg og verifikasjon.`,
      documentId: "solution",
    }),
  );
  const startedAt = performance.now();
  const merged = mergeRequirementCoverageLedgerWithSolutionAnswers({
    sourceRequirements,
    solutionEntries,
  });
  const durationMs = performance.now() - startedAt;

  assert.equal(merged.length, rowCount);
  assert.ok(merged.every((entry) => Boolean(entry.answerExcerpt)));
  assert.ok(
    durationMs < 2_000,
    `indexed requirement matching took ${durationMs.toFixed(1)}ms`,
  );
});

test("unverified attachment reference cannot be rated Godt", () => {
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: requirement({
      sourceExcerpt: "Kravgrunnlag: tilgangsstyring | Svarrad: Se vedlegg 4 for komplett dokumentasjon og testbevis.",
      answerExcerpt: "Se vedlegg 4 for komplett dokumentasjon og testbevis.",
      answerDocumentId: "solution",
    }),
    assessment: "Godt",
    rationale: "Vedlegget dekker kravet.",
    evidence: "Se vedlegg 4.",
    recommendation: "Ingen endring.",
  });

  assert.equal(corrected.assessment, "Uklart");
  assert.match(corrected.rationale, /ikke er verifisert/i);
});

test("self-contained main answer stays Godt with a supplemental attachment", () => {
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: requirement({
      sourceExcerpt:
        "Kravgrunnlag: Leverandøren skal dokumentere tilgangsstyring. | Svarrad: Atea leverer rollebasert tilgang med minste privilegium, godkjenning og sporbar logging. Se vedlegg 4 for utfyllende kontrollmatrise.",
      answerExcerpt:
        "Atea leverer rollebasert tilgang med minste privilegium, godkjenning og sporbar logging. Se vedlegg 4 for utfyllende kontrollmatrise.",
      answerDocumentId: "solution",
    }),
    assessment: "Godt",
    rationale: "Hovedsvaret dekker kravet konkret.",
    evidence: "rollebasert tilgang med minste privilegium",
    recommendation: "Ingen endring.",
  });

  assert.equal(corrected.assessment, "Godt");
  assert.equal(corrected.rationale, "Hovedsvaret dekker kravet konkret.");
});

test("supplemental documentation wording does not hide a self-contained main answer", () => {
  const mainAnswer =
    "Atea leverer rollebasert tilgang med minste privilegium, godkjenning og sporbar logging.";
  const supplementalSentence =
    "Komplett dokumentasjon finnes i vedlegg 3.";
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: requirement({
      sourceExcerpt: `Kravgrunnlag: Leverandøren skal dokumentere tilgangsstyring. | Svarrad: ${mainAnswer} ${supplementalSentence}`,
      answerExcerpt: `${mainAnswer} ${supplementalSentence}`,
      answerDocumentId: "solution",
    }),
    assessment: "Godt",
    rationale: "Hovedsvaret dekker kravet konkret.",
    evidence: "rollebasert tilgang med minste privilegium",
    recommendation: "Ingen endring.",
  });

  assert.equal(corrected.assessment, "Godt");
  assert.equal(corrected.rationale, "Hovedsvaret dekker kravet konkret.");
});

test("supplemental documentation wording alone remains Uklart", () => {
  const answerExcerpt = "Komplett dokumentasjon finnes i vedlegg 3.";
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: requirement({
      sourceExcerpt: `Kravgrunnlag: Leverandøren skal dokumentere tilgangsstyring. | Svarrad: ${answerExcerpt}`,
      answerExcerpt,
      answerDocumentId: "solution",
    }),
    assessment: "Godt",
    rationale: "Vedlegget dekker kravet.",
    evidence: answerExcerpt,
    recommendation: "Ingen endring.",
  });

  assert.equal(corrected.assessment, "Uklart");
  assert.match(corrected.rationale, /ikke er verifisert/i);
});

test("complete data-validation and access evidence preserves the evaluator's Uklart", () => {
  const answerExcerpt =
    "Atea validerer obligatoriske felt, formater og forretningsregler for oppdrag, frivillige, samtykker og meldinger, og avviser eller flagger feilregistreringer før lagring eller videre behandling. Løsningen håndhever samtidig rollebasert tilgang med minste privilegium og dataavgrensning per brukergruppe, og relevante tilgangs- og endringshendelser logges.";
  const entry = requirement({
    id: "R-004",
    text: "Løsningen skal ha datavalidering slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger for frivillig omsorg og besøksvenner.",
    sourceExcerpt: `Kravgrunnlag: datavalidering og tilgang | Svarrad: ${answerExcerpt}`,
    answerExcerpt,
    answerDocumentId: "solution",
    answerReference: "R-004",
  });

  assert.deepEqual(requirementAnswerQualityIssues(answerExcerpt, entry), []);
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry,
    assessment: "Uklart",
    rationale:
      "Sammenhengen mellom datavalidering og tilgang bør tydeliggjøres.",
    evidence: answerExcerpt,
    recommendation: "Legg til en sterkere koblingssetning.",
  });

  assert.equal(corrected.assessment, "Uklart");
  assert.equal(
    corrected.rationale,
    "Sammenhengen mellom datavalidering og tilgang bør tydeliggjøres.",
  );
  assert.equal(corrected.recommendation, "Legg til en sterkere koblingssetning.");
});

test("data-validation post-correction stays Uklart when a required control is absent", () => {
  const requirementText =
    "Løsningen skal ha datavalidering slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger.";
  const incompleteAnswers = [
    {
      label: "validation control",
      answer:
        "Atea håndterer datavalidering. Tilgang styres rollebasert med minste privilegium og dataavgrensning per brukergruppe, og tilgangshendelser logges.",
    },
    {
      label: "role and least privilege",
      answer:
        "Atea validerer obligatoriske felt og formater og avviser feilregistreringer. Tilgang avgrenses per brukergruppe, og tilgangs- og endringshendelser logges.",
    },
    {
      label: "data scope",
      answer:
        "Atea validerer obligatoriske felt og formater og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium, og tilgangs- og endringshendelser logges.",
    },
    {
      label: "per-group data scope",
      answer:
        "Atea validerer obligatoriske felt og formater og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium og generell dataavgrensning, og tilgangs- og endringshendelser logges.",
    },
    {
      label: "logging",
      answer:
        "Atea validerer obligatoriske felt og formater og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium og dataavgrensning per brukergruppe.",
    },
    {
      label: "negated validation",
      answer:
        "Atea validerer obligatoriske felt, men avviser ikke feilregistreringer. Tilgang styres rollebasert med minste privilegium og dataavgrensning per brukergruppe, og tilgangshendelser logges.",
    },
    {
      label: "negated role control",
      answer:
        "Atea validerer obligatoriske felt og avviser feilregistreringer. Løsningen bruker ikke rollebasert tilgang med minste privilegium, men har dataavgrensning per brukergruppe og tilgangshendelser logges.",
    },
    {
      label: "negated data scope",
      answer:
        "Atea validerer obligatoriske felt og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium, men uten dataavgrensning per brukergruppe, og tilgangshendelser logges.",
    },
    {
      label: "negated logging",
      answer:
        "Atea validerer obligatoriske felt og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium og dataavgrensning per brukergruppe, men tilgangshendelser logges ikke.",
    },
  ];

  for (const { label, answer } of incompleteAnswers) {
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry: requirement({
        id: "R-004",
        text: requirementText,
        sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answer}`,
        answerExcerpt: answer,
        answerDocumentId: "solution",
        answerReference: "R-004",
      }),
      assessment: "Uklart",
      rationale: `Mangler ${label}.`,
      evidence: answer,
      recommendation: `Legg til ${label}.`,
    });

    assert.equal(corrected.assessment, "Uklart", label);
  }
});

test("untallied performance design fails generation quality and never promotes evaluator Uklart", () => {
  const answerExcerpt =
    "Atea dimensjonerer ende-til-ende-sporbarhet for hele forløpet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og logging målt per navngitt brukertransaksjon, ut fra en kapasitetsmodell, gjennomfører last- og ytelsestester og etablerer kapasitetsmargin med dynamisk skalering eller eksplisitt provisjonert kapasitet. Siden konkrete ytelsesmål ikke er tallfestet i grunnlaget, foreslår Atea akseptansekriterier for responstid og samtidighet for de samme transaksjonene som avklares med kunden før produksjonssetting.";
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt: `Kravgrunnlag: dimensjonering uten vesentlig treghet | Svarrad: ${answerExcerpt}`,
    answerExcerpt,
    answerDocumentId: "solution",
    answerReference: "R-035",
  });

  const issues = requirementAnswerQualityIssues(answerExcerpt, entry);
  assert.ok(
    issues.includes("missing_supplier_proposed_numeric_performance_target"),
  );
  assert.ok(issues.includes("missing_end_to_end_traceability_performance_binding"));
  assert.equal(
    normalizeRequirementAnswerResult(answerExcerpt, entry, entry.text).source,
    "deterministic_fallback",
  );
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry,
    assessment: "Uklart",
    rationale: "Svaret mangler bindende tall for responstid.",
    evidence: answerExcerpt,
    recommendation: "Finn på konkrete terskler.",
  });

  assert.equal(corrected.assessment, "Uklart");
  assert.equal(corrected.rationale, "Svaret mangler bindende tall for responstid.");
  assert.equal(corrected.recommendation, "Finn på konkrete terskler.");
});

test("documented and committed SLA targets preserve the evaluator's Uklart", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.";
  const answerExcerpt =
    "Atea dimensjonerer og forplikter sporbarhet for de navngitte brukertransaksjonene registrere innmelding, oppdatere status og avslutte saken med en kapasitetsmodell og ytelsesbaseline, verifisert med lasttest og ytelsestest, dynamisk skalering og kapasitetsmargin. Atea forplikter responstidsmålet p95 under 2 sekunder ved 200 samtidige brukere som akseptansekriterium for de samme transaksjonene.";
  const entry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `Kravgrunnlag: ${requirementText} SLA-målet er p95 under 2 sekunder ved 200 samtidige brukere. | Svarrad: ${answerExcerpt}`,
    answerExcerpt,
    answerDocumentId: "solution",
    answerReference: "R-035",
  });

  assert.deepEqual(requirementAnswerQualityIssues(answerExcerpt, entry), []);
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry,
    assessment: "Uklart",
    rationale: "Målet må gjentas.",
    evidence: answerExcerpt,
    recommendation: "Gjenta SLA-målet.",
  });

  assert.equal(corrected.assessment, "Uklart");
  assert.equal(corrected.rationale, "Målet må gjentas.");
  assert.equal(corrected.recommendation, "Gjenta SLA-målet.");
});

test("documented performance targets in text or sourceExcerpt block promotion when omitted", () => {
  const baseRequirement =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet";
  const completeButUntallied =
    "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Atea fastsetter responstidsmål og akseptansekriterier før ytelsestest.";
  const entries = [
    requirement({
      id: "R-035",
      text: `${baseRequirement}, med p95 under 2 sekunder.`,
      sourceExcerpt: `Kravgrunnlag: ${baseRequirement}. | Svarrad: ${completeButUntallied}`,
      answerExcerpt: completeButUntallied,
      answerDocumentId: "solution",
      answerReference: "R-035",
    }),
    requirement({
      id: "R-035",
      text: `${baseRequirement}.`,
      sourceExcerpt: `Kravgrunnlag: ${baseRequirement}. SLA-målet er p95 under 2 sekunder ved 200 samtidige brukere. | Svarrad: ${completeButUntallied}`,
      answerExcerpt: completeButUntallied,
      answerDocumentId: "solution",
      answerReference: "R-035",
    }),
  ];

  for (const entry of entries) {
    assert.ok(
      requirementAnswerQualityIssues(completeButUntallied, entry).includes(
        "missing_documented_performance_target_commitment",
      ),
    );
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry,
      assessment: "Uklart",
      rationale: "Det tallfestede målet er ikke forpliktet.",
      evidence: completeButUntallied,
      recommendation: "Gjengi målet.",
    });
    assert.equal(corrected.assessment, "Uklart");
  }
});

test("a documented maximum cannot be satisfied by repeating the number as a minimum", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet uten vesentlig treghet, med p95 under 2 sekunder.";
  const answerExcerpt =
    "Atea forplikter løsningen til p95 over 2 sekunder. Løsningen bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Responstidsmålet inngår som akseptansekriterium.";
  const entry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answerExcerpt}`,
    answerExcerpt,
    answerDocumentId: "solution",
    answerReference: "R-035",
  });

  assert.ok(
    requirementAnswerQualityIssues(answerExcerpt, entry).includes(
      "missing_documented_performance_target_commitment",
    ),
  );
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry,
    assessment: "Uklart",
    rationale: "Ytelsesmålet har feil retning.",
    evidence: answerExcerpt,
    recommendation: "Forplikt maksimumsmålet.",
  });
  assert.equal(corrected.assessment, "Uklart");
});

test("performance post-correction requires mechanism, test, margin and acceptance", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";
  const incompleteAnswers = [
    {
      label: "capacity mechanism",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og har kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "load or performance test",
      answer:
        "Atea bruker en kapasitetsmodell med dynamisk skalering og kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "capacity margin",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "performance acceptance",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Resultatene overvåkes i produksjon.",
    },
    {
      label: "negated capacity model",
      answer:
        "Atea bruker ingen kapasitetsmodell, men gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "negated performance test",
      answer:
        "Atea bruker en kapasitetsmodell og gjennomfører ikke lasttest eller ytelsestest, men bruker dynamisk skalering med kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "negated scaling",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker ikke dynamisk skalering, men oppgir kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "negated capacity margin",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering uten kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.",
    },
    {
      label: "negated acceptance",
      answer:
        "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Atea foreslår responstidsmål, men ingen akseptansekriterier.",
    },
  ];

  for (const { label, answer } of incompleteAnswers) {
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry: requirement({
        id: "R-035",
        text: requirementText,
        sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answer}`,
        answerExcerpt: answer,
        answerDocumentId: "solution",
        answerReference: "R-035",
      }),
      assessment: "Uklart",
      rationale: `Mangler ${label}.`,
      evidence: answer,
      recommendation: `Legg til ${label}.`,
    });

    assert.equal(corrected.assessment, "Uklart", label);
  }
});

test("targeted post-correction requires answer provenance for the same requirement", () => {
  const answerExcerpt =
    "Atea validerer obligatoriske felt og avviser feilregistreringer. Tilgang styres rollebasert med minste privilegium og dataavgrensning per brukergruppe, og tilgangs- og endringshendelser logges.";
  const requirementText =
    "Løsningen skal ha datavalidering slik at brukergruppene bare får tilgang til data de trenger.";
  const entries = [
    requirement({
      id: "R-004",
      text: requirementText,
      sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answerExcerpt}`,
      answerExcerpt,
      answerDocumentId: "solution",
      answerReference: "R-999",
    }),
    requirement({
      id: "R-004",
      text: requirementText,
      sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answerExcerpt}`,
      answerExcerpt,
      answerReference: "R-004",
    }),
  ];

  for (const entry of entries) {
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry,
      assessment: "Uklart",
      rationale: "Svarproveniens er ikke bundet til kravet.",
      evidence: answerExcerpt,
      recommendation: "Kontroller radkoblingen.",
    });
    assert.equal(corrected.assessment, "Uklart");
  }
});

test("targeted post-correction never upgrades attachment, deferral or decline", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.";
  const complete =
    "Atea bruker en kapasitetsmodell, gjennomfører lasttest og ytelsestest og bruker dynamisk skalering med kapasitetsmargin. Atea foreslår responstidsmål og akseptansekriterier fordi grunnlaget ikke har tallfestede mål.";
  const answers = [
    `${complete} Komplett dokumentasjon finnes i vedlegg 3.`,
    `${complete} Endelig løsning må avklares før vi kan bekrefte leveransen.`,
    `${complete} Kontrollen inngår ikke i leveransen og er utenfor scope.`,
  ];

  for (const answerExcerpt of answers) {
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry: requirement({
        id: "R-035",
        text: requirementText,
        sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${answerExcerpt}`,
        answerExcerpt,
        answerDocumentId: "solution",
        answerReference: "R-035",
      }),
      assessment: "Uklart",
      rationale: "Må kontrolleres.",
      evidence: answerExcerpt,
      recommendation: "Avklar.",
    });

    assert.notEqual(corrected.assessment, "Godt");
  }
});

test("explicit rejection of a mandatory requirement is always Dårlig", () => {
  const declinedAnswers = [
    "Atea kan ikke levere denne kontrollen som del av løsningen.",
    "Kontrollen inngår ikke i leveransen og er utenfor scope.",
    "Kontrollen må håndteres av kunden med eget ansvar og egen dokumentasjon.",
  ];

  for (const answerExcerpt of declinedAnswers) {
    for (const assessment of ["Godt", "Uklart", "Mangler"]) {
      const corrected = correctCoverageAssessmentWithSourceEvidence({
        entry: requirement({
          text: "Leverandøren skal levere og dokumentere kontrollen.",
          sourceExcerpt: `Kravgrunnlag: Leverandøren skal levere kontrollen. | Svarrad: ${answerExcerpt}`,
          answerExcerpt,
          answerDocumentId: "solution",
        }),
        assessment,
        rationale: "Modellens vurdering.",
        evidence: answerExcerpt,
        recommendation: "Modellens anbefaling.",
      });

      assert.equal(corrected.assessment, "Dårlig");
      assert.match(corrected.rationale, /avslår|utenfor leveransen/i);
    }
  }
});

test("mandatory requirement without a matched answer remains Mangler", () => {
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: requirement({
      text: "Leverandøren skal levere og dokumentere kontrollen.",
      sourceExcerpt:
        "Kravgrunnlag: Leverandøren skal levere og dokumentere kontrollen.",
      answerExcerpt: "",
    }),
    assessment: "Godt",
    rationale: "Feilaktig modellvurdering.",
    evidence: "",
    recommendation: "",
  });

  assert.equal(corrected.assessment, "Mangler");
});

test("coverage batch failure fails closed", () => {
  assert.doesNotThrow(() => assertRequirementCoverageBatchesSucceeded([], 4));
  assert.throws(
    () =>
      assertRequirementCoverageBatchesSucceeded(
        [{ startIndex: 18, count: 18, reason: "rate limit" }],
        4,
      ),
    /1 av 4 AI-batcher feilet.*rate limit/,
  );
});

test("coverage retrieval is skipped only for complete substantive exact evidence", () => {
  const complete = requirementFixture(4);
  assert.equal(coverageBatchHasCompleteExactEvidence(complete), true);
  assert.equal(
    coverageBatchHasCompleteExactEvidence([
      ...complete.slice(0, 3),
      requirement({ answerExcerpt: "", sourceExcerpt: "Kravgrunnlag uten svar" }),
    ]),
    false,
  );
  assert.equal(
    coverageBatchHasCompleteExactEvidence([
      ...complete.slice(0, 3),
      requirement({ answerExcerpt: "Ja", sourceExcerpt: "Kravgrunnlag med binært svar" }),
    ]),
    false,
  );
});

test("blank answer-field markers never become answer evidence or registry payload", () => {
  const entry = requirement({
    id: "ID 2-22",
    text: "Leverandøren skal håndtere maskinutstyr.",
    answerExcerpt: "Leverandørens besvarelse ID2- 22",
    sourceExcerpt:
      "Kravtekst før svarfelt: Leverandøren skal håndtere maskinutstyr. | Svarfelt: Leverandørens besvarelse ID2- 22",
  });

  const [registryRow] = buildRequirementResponseBatchRegistry([entry]);
  assert.equal(registryRow.answer_excerpt, undefined);
  assert.equal(coverageBatchHasCompleteExactEvidence([entry]), false);

  const normalized = normalizeRequirementAnswerResult("", entry, entry.text);
  assert.doesNotMatch(
    normalized.evidence,
    /Leverandørens besvarelse|ID2-\s*22/iu,
  );
  assert.match(normalized.evidence, /Leverandøren skal håndtere maskinutstyr/iu);
});

test("batch registries preserve every reference, locator, document and exact excerpt", () => {
  const requirements = requirementFixture();
  const responseRegistry = buildRequirementResponseBatchRegistry(requirements);
  const coverageRegistry = buildRequirementCoverageBatchRegistry(requirements);

  assert.equal(responseRegistry.length, requirements.length);
  assert.equal(coverageRegistry.length, requirements.length);
  assert.equal(new Set(responseRegistry.map((row) => row.ref)).size, 44);
  assert.equal(new Set(coverageRegistry.map((row) => row.ref)).size, 44);
  responseRegistry.forEach((row, index) => {
    assert.equal(row.nr, index + 1);
    assert.equal(row.source_document_title, "Kravspesifikasjon");
    assert.equal(row.answer_document_title, "Leverandørens svar");
    assert.deepEqual(row.heading_path, [requirements[index].heading]);
    assert.equal(row.source_document_id, "requirements-document");
    assert.equal(row.answer_document_id, "solution-document");
    assert.equal(row.page_range, `Side ${index + 1}`);
    assert.equal(row.source_excerpt, requirements[index].sourceExcerpt);
    assert.equal(row.answer_excerpt, requirements[index].answerExcerpt);
    assert.ok(row.full_reference);
    assert.ok(row.source_reference);
  });
});

test("R-033 registry and repair expose the binding API checklist", () => {
  const entry = requirement({
    id: "R-033",
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const [row] = buildRequirementResponseBatchRegistry([entry]);

  assert.match(row.obligatorisk_svarstruktur, /Bindende sjekkliste/i);
  assert.match(row.obligatorisk_svarstruktur, /versjonert REST-API over HTTPS/i);
  assert.match(row.obligatorisk_svarstruktur, /OAuth 2\.0\/OIDC/i);
  assert.match(row.obligatorisk_svarstruktur, /minst to kravrelevante/i);
  assert.match(row.obligatorisk_svarstruktur, /identifikator\/nøkkelfelt/i);
  assert.match(
    row.obligatorisk_svarstruktur,
    /feltmapping.*masterdataansvar.*synkretning.*avvisning/i,
  );
  assert.match(row.obligatorisk_svarstruktur, /foreslått integrasjonskontrakt/i);

  const repair = buildRequirementRepairDirective(
    entry,
    "quality_gate: missing_concrete_api_pattern,missing_concrete_authentication_pattern,missing_concrete_data_model_pattern,incomplete_api_integration_contract",
  );
  assert.match(repair, /Forrige svar manglet spesielt/i);
  assert.match(repair, /produktnøytralt utvekslingsmønster/i);
  assert.match(repair, /klientlegitimasjons-/i);
  assert.match(repair, /minst to navngitte/i);
  assert.match(repair, /identifikator\/nøkkelfelt.*feltmapping.*validering/i);
  assert.match(repair, /navngitte operasjoner.*begrensede scopes/i);
  assert.match(repair, /masterdataansvar.*synkretning/i);
  assert.match(repair, /ikke kundefakta/i);
});

test("R-018 registry requires a concrete test method", () => {
  const entry = requirement({
    id: "R-018",
    text: "Kunden skal få tilgang til testmiljø før produksjonssetting slik at arbeidsflyten kan verifiseres.",
  });
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  const repair = buildRequirementRepairDirective(
    entry,
    "quality_gate: missing_test_method",
  );

  assert.match(row.obligatorisk_svarstruktur, /testdata/i);
  assert.match(row.obligatorisk_svarstruktur, /testscenarier/i);
  assert.match(row.obligatorisk_svarstruktur, /forventede resultater/i);
  assert.match(repair, /Forrige svar manglet spesielt/i);
  assert.match(repair, /dokumentert avviksoppfølging/i);
});

test("structured export portability requires a named machine-readable format", () => {
  const entry = requirement({
    id: "R-002",
    text: "Løsningen skal gjøre det mulig å hente ut oppdrag, frivillige, samtykker og meldinger i et strukturert format ved revisjon eller leverandørbytte.",
  });
  const weak =
    "Atea leverer uttrekk av oppdrag, frivillige, samtykker og meldinger i et strukturert format med definerte dataobjekter og felt.";
  const deferred =
    "Atea leverer hele dataomfanget med faste felt og identifikatorer uten manuell sammenstilling. Eksakt uttrekksformat kan bekreftes i designfasen.";
  const unrelatedJson =
    "Integrasjons-API-et bruker JSON. Datauttrekk leveres i et strukturert format senere.";
  const reviewerRepro =
    "Atea leverer data gjennom integrasjons-API-et som bruker JSON, mens det konkrete uttrekksformatet besluttes i designfasen.";
  const strong =
    "Atea leverer et uttrekk av oppdrag, frivillige, samtykker og meldinger som CSV eller JSON med faste felt og stabile identifikatorer ved revisjon eller leverandørbytte. Uttrekket dekker det relevante dataomfanget uten manuell sammenstilling.";

  assert.ok(
    requirementAnswerQualityIssues(weak, entry).includes(
      "missing_concrete_machine_readable_export_format",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(weak, entry, entry.text).source,
    "deterministic_fallback",
  );
  const deferredIssues = requirementAnswerQualityIssues(deferred, entry);
  assert.ok(
    deferredIssues.includes("missing_concrete_machine_readable_export_format"),
  );
  assert.ok(deferredIssues.includes("deferred_core_scope"));
  assert.equal(
    normalizeRequirementAnswerResult(deferred, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.ok(
    requirementAnswerQualityIssues(unrelatedJson, entry).includes(
      "missing_concrete_machine_readable_export_format",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(unrelatedJson, entry, entry.text).source,
    "deterministic_fallback",
  );
  const reviewerIssues = requirementAnswerQualityIssues(reviewerRepro, entry);
  assert.ok(
    reviewerIssues.includes("missing_concrete_machine_readable_export_format"),
  );
  assert.ok(reviewerIssues.includes("deferred_core_scope"));
  assert.equal(
    normalizeRequirementAnswerResult(reviewerRepro, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );
  assert.equal(
    buildDeterministicFinalRequirementTemplateRepair({ entry }),
    null,
  );
});

test("API serialization never substitutes for an explicit export format", () => {
  const entry = requirement({
    id: "R-002",
    text: "Data skal kunne hentes ut i et maskinlesbart format ved revisjon eller leverandørskifte.",
  });
  const weakAnswers = [
    "Atea leverer data gjennom et API som bruker XML, mens eksportformatet bestemmes senere.",
    "API-kontrakten bruker JSON. I designfasen bestemmer Atea uttrekksformatet.",
    "Atea bruker JSON i integrasjons-API-et; det konkrete leveranseformatet besluttes i designfasen.",
    "API-kontrakten bruker JSON. Eksportformatet velges i designfasen.",
    "API-kontrakten bruker XML. I designfasen velger Atea eksportformatet.",
  ];

  for (const answer of weakAnswers) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes("missing_concrete_machine_readable_export_format"),
      `${answer}: ${issues.join(",")}`,
    );
    assert.ok(
      issues.includes("deferred_core_scope"),
      `${answer}: ${issues.join(",")}`,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }
});

test("explicitly bound CSV, JSON and XML export formats pass", () => {
  const entry = requirement({
    id: "R-002",
    text: "Data skal eksporteres i strukturerte formater ved revisjon eller leverandørskifte.",
  });
  const strongAnswers = [
    "Atea leverer alle relevante data som CSV med faste felt og stabile identifikatorer ved leverandørbytte.",
    "Atea leverer oppdrag, frivillige, samtykker og meldinger som JSON med faste felt og stabile identifikatorer ved revisjon.",
    "Atea eksporterer alle relevante data til CSV med faste felt og stabile identifikatorer ved leverandørskifte.",
    "API-et bruker JSON for løpende integrasjon, mens Atea ved leverandørbytte leverer alle relevante data som CSV med faste felt og stabile identifikatorer.",
    "API-et bruker JSON for løpende integrasjon. Atea leverer alle relevante data som CSV med faste felt og stabile identifikatorer ved leverandørbytte.",
    "Uttrekket leveres som CSV eller JSON med faste felt og identifikatorer for hele det relevante dataomfanget uten manuell sammenstilling.",
    "Data eksporteres som XML med faste felt og stabile identifikatorer ved revisjon eller leverandørskifte, uten manuell sammenstilling.",
    "Eksportformatet er Parquet med dokumenterte felt, identifikatorer og relevant dataomfang uten manuell sammenstilling.",
    "CSV er eksportformatet for alle relevante data, med faste felt og stabile identifikatorer ved leverandørbytte.",
    "Formatet for uttrekket er JSON med faste felt og stabile identifikatorer for relevante data ved leverandørbytte.",
    "Format for datauttrekk er CSV med faste felt og stabile identifikatorer for revisjon.",
  ];

  for (const answer of strongAnswers) {
    assert.deepEqual(
      requirementAnswerQualityIssues(answer, entry),
      [],
      answer,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "batch",
    );
  }
});

test("generic or API data delivery does not imply an export format without safe portability binding", () => {
  const entry = requirement({
    id: "R-002",
    text: "Data skal kunne hentes ut i et maskinlesbart format ved revisjon eller leverandørskifte.",
  });
  const adversarialAnswers = [
    "Atea leverer alle relevante data som JSON med faste felt og stabile identifikatorer.",
    "Integrasjons-API-et leverer alle relevante data som XML ved revisjon.",
    "API-et bruker JSON for datautveksling, og alle relevante data er tilgjengelige ved leverandørbytte.",
  ];

  for (const answer of adversarialAnswers) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes("missing_concrete_machine_readable_export_format"),
      `${answer}: ${issues.join(",")}`,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }
});

test("portability trigger recognizes equivalent format and vendor-switch wording", () => {
  const requirementTexts = [
    "Data skal kunne hentes ut i maskinlesbart format ved leverandørskifte.",
    "Data skal eksporteres i strukturerte formater ved revisjon.",
    "Data skal kunne hentes ut i et strukturert data format ved leverandørbytte.",
  ];

  for (const text of requirementTexts) {
    const entry = requirement({ id: "R-002", text });
    const issues = requirementAnswerQualityIssues(
      "Atea leverer et generelt strukturert datauttrekk.",
      entry,
    );
    assert.ok(
      issues.includes("missing_concrete_machine_readable_export_format"),
      `${text}: ${issues.join(",")}`,
    );
    const [row] = buildRequirementResponseBatchRegistry([entry]);
    assert.match(row.obligatorisk_svarstruktur, /maskinlesbart eksportformat/i);
  }
});

test("structured export registry and repair bind format, schema, scope and no manual assembly", () => {
  const entry = requirement({
    id: "R-002",
    text: "Løsningen skal gjøre det mulig å hente ut alle relevante data i et strukturert format ved revisjon eller leverandørbytte.",
  });
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  const repair = buildRequirementRepairDirective(
    entry,
    "quality_gate: missing_concrete_machine_readable_export_format,deferred_core_scope",
  );

  assert.match(row.obligatorisk_svarstruktur, /strukturert eksport og portabilitet/i);
  assert.match(
    row.obligatorisk_svarstruktur,
    /navngitt maskinlesbart eksportformat.*CSV.*JSON.*Parquet.*XLSX/i,
  );
  assert.match(
    row.obligatorisk_svarstruktur,
    /faste felt og identifikatorer.*revisjon eller leverandørbytte.*uten manuell sammenstilling/i,
  );
  assert.match(repair, /Forrige svar manglet spesielt/i);
  assert.match(
    repair,
    /minst ett navngitt maskinlesbart eksportformat nå/i,
  );
  assert.match(
    repair,
    /faste felt og identifikatorer.*relevant dataomfang.*uten manuell sammenstilling/i,
  );
});

test("exact structured-export rows receive a product-neutral final control repair", () => {
  const text =
    "Kunden skal kunne hente ut oppdrag, frivillige, samtykker, meldinger i et strukturert format ved revisjon eller leverandørbytte.";
  const entries = [
    requirement({
      id: "R-002",
      text,
      sourceExcerpt: `R-002 ${text}`,
      documentId: "requirements-export",
    }),
    requirement({
      id: "Dokumenttekst krav 12",
      text,
      sourceExcerpt: text,
      documentId: "requirements-export",
    }),
  ];
  const repairs = entries.map((entry) => {
    const current = normalizeRequirementAnswerResult(
      "Atea leverer et strukturert datauttrekk med faste felt.",
      entry,
      entry.text,
    );
    assert.equal(current.source, "deterministic_fallback", entry.id);
    const repair = resolveRequirementAnswerAfterStrictHandoff({
      entry,
      current,
      strictRepair: null,
    });

    assert.equal(repair.source, "deterministic_control_repair", entry.id);
    assert.equal(
      repair.answer,
      "Løsningen leverer alle relevante data som CSV og JSON med faste felt og stabile identifikatorer ved revisjon eller leverandørbytte, uten manuell sammenstilling.",
      entry.id,
    );
    assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
    assert.match(repair.evidence, /Kunden skal kunne hente ut/u);
    return repair;
  });

  assert.deepEqual(
    buildDeterministicControlRepairMetadata({ answers: repairs, ledger: entries }),
    {
      deterministic_control_repair_answers: 2,
      deterministic_control_repair_refs: ["R-002", "Dokumenttekst krav 12"],
      deterministic_control_repair_rows: [
        {
          ref: "R-002",
          pattern: "structured_export",
          order_index: 0,
          source_document_id: "requirements-export",
          source_locator: "Side 1, R-002",
        },
        {
          ref: "Dokumenttekst krav 12",
          pattern: "structured_export",
          order_index: 1,
          source_document_id: "requirements-export",
          source_locator: "Side 1, Dokumenttekst krav 12",
        },
      ],
      manual_review_required: true,
      manual_review_note:
        "Deterministisk kontrolltekst er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.",
    },
  );
});

test("structured-export final repair rejects compound, qualified, deferred, referenced and parameterized rows", () => {
  const base =
    "Kunden skal kunne hente ut oppdrag, frivillige, samtykker, meldinger i et strukturert format ved revisjon eller leverandørbytte.";
  const rejected = [
    `${base} Løsningen skal også slette historikken.`,
    base.replace("skal kunne", "skal ikke kunne"),
    `${base} Detaljene følger vedlegg 4.`,
    `${base} Se R-044 for avgrensning.`,
    `${base} Kravet prises separat.`,
    base.replace("meldinger i et", "meldinger og integrere dem i et"),
    base.replace("leverandørbytte", "leverandørbytte innen 24 timer"),
    base.replace("skal kunne", "kan"),
  ];

  for (const text of rejected) {
    const entry = requirement({ id: "R-002", text, sourceExcerpt: text });
    const current = normalizeRequirementAnswerResult("Ja.", entry, text);
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      text,
    );
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair: null,
      }),
      current,
      text,
    );
  }
});

test("manual spreadsheet requirements reject reduction and require elimination", () => {
  const entry = requirement({
    text: "Brukere som frivillige, koordinatorer, mottakere og pårørende skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const weak =
    "Atea bruker integrasjoner og et felles datagrunnlag for å redusere dobbeltregistrering og behovet for manuelle regneark.";
  const strong =
    "Frivillige, koordinatorer, mottakere og pårørende utfører oppgaver, registrering og oppfølging direkte i løsningen. Data registreres én gang i et felles datagrunnlag og synkroniseres via integrasjoner; manuelle regneark brukes ikke.";

  const weakIssues = requirementAnswerQualityIssues(weak, entry);
  assert.ok(weakIssues.includes("missing_direct_in_solution_workflow"));
  assert.ok(weakIssues.includes("does_not_eliminate_manual_spreadsheets"));
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(weak, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  assert.match(row.obligatorisk_svarstruktur, /direkte i løsningen/i);
  assert.match(row.obligatorisk_svarstruktur, /manuelle regneark ikke brukes/i);
});

test("explicit spreadsheet elimination verbs satisfy the quality gate", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const directWorkflow =
    "Brukerne utfører oppgaver, registrering og oppfølging direkte i løsningen. Data registreres én gang i et felles datagrunnlag og gjenbrukes gjennom arbeidsflyten.";
  const eliminationClauses = [
    "Løsningen eliminerer behovet for manuelle regneark.",
    "Løsningen fjerner behovet for manuelle regneark.",
    "Løsningen erstatter bruk av manuelle regneark.",
    "Behovet for manuelle regneark bortfaller.",
    "Manuelle regneark erstattes av løsningen.",
  ];

  for (const eliminationClause of eliminationClauses) {
    const answer = `${directWorkflow} ${eliminationClause}`;
    assert.deepEqual(
      requirementAnswerQualityIssues(answer, entry),
      [],
      eliminationClause,
    );
  }
});

test("spreadsheet reduction, minimization and negated elimination remain insufficient", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const directWorkflow =
    "Brukerne utfører oppgaver, registrering og oppfølging direkte i løsningen. Data registreres én gang i et felles datagrunnlag og gjenbrukes gjennom arbeidsflyten.";
  const insufficientClauses = [
    "Løsningen reduserer behovet for manuelle regneark.",
    "Løsningen minimerer behovet for manuelle regneark.",
    "Løsningen eliminerer ikke behovet for manuelle regneark.",
    "Behovet for manuelle regneark fjernes ikke.",
    "Manuelle regneark erstattes ikke av løsningen.",
  ];

  for (const insufficientClause of insufficientClauses) {
    assert.ok(
      requirementAnswerQualityIssues(
        `${directWorkflow} ${insufficientClause}`,
        entry,
      ).includes("does_not_eliminate_manual_spreadsheets"),
      insufficientClause,
    );
  }
});

test("explicit spreadsheet replacement remains strong despite a later reduction clause", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const answer =
    "Registrering og oppfølging skjer i løsningen fremfor i manuelle regneark. Relevante integrasjoner og et felles datagrunnlag reduserer dobbeltregistrering i den daglige koordineringen.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("native one-time capture and reuse passes without an integration dependency", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const answer =
    "Brukerne utfører registrering og oppfølging direkte i løsningen, og manuelle regneark brukes ikke. Opplysninger registreres kun én gang og gjenbrukes gjennom hele saken.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("spreadsheets excluded from the workflow are not treated as declined scope", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const answer =
    "Brukerne utfører registrering og oppfølging direkte i løsningen. Opplysninger registreres én gang, gjenbrukes gjennom saken, og manuelle regneark inngår ikke i arbeidsflyten.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("causative direct-workflow wording satisfies spreadsheet elimination", () => {
  const entry = requirement({
    text: "Brukere skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const answer =
    "Atea lar frivillige, koordinatorer, mottakere og pårørende utføre oppgaver, registrering og oppfølging direkte i løsningen. Opplysninger registreres én gang, gjenbrukes gjennom saken, og manuelle regneark inngår ikke i arbeidsflyten.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("lossless queue retry requirements need an anti-duplicate mechanism", () => {
  const entry = requirement({
    text: "Løsningen skal integreres med kalender og identitet og håndtere feil, kø og ny kjøring uten tap av oppdrag, frivillige, samtykker og meldinger.",
  });
  const weak =
    "Atea integrerer løsningen gjennom sikre grensesnitt. Feil håndteres med kø, sporbar logging og kontrollert nykjøring uten tap av data.";
  const strong =
    "Atea bruker outbox, idempotensnøkler og korrelasjons-ID for å hindre tap og duplikater i integrasjonen. Feil går til dead-letter-kø med sporbar logging og kontrollert retry eller nykjøring.";

  assert.ok(
    requirementAnswerQualityIssues(weak, entry).includes(
      "missing_duplicate_safe_integration_control",
    ),
  );
  assert.ok(
    requirementAnswerQualityIssues(weak, entry).includes(
      "missing_recovery_loss_control",
    ),
  );
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(weak, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  assert.match(row.obligatorisk_svarstruktur, /idempotens.*deduplisering/i);
  assert.match(row.obligatorisk_svarstruktur, /kø.*retry.*sporbar logging/i);
});

test("correlation ID alone is not a lossless replay control", () => {
  const entry = requirement({
    text: "Løsningen skal integreres med kalender og identitet og håndtere feil, kø og ny kjøring uten tap av data.",
  });
  const answer =
    "Atea merker meldinger med korrelasjons-ID og håndterer feil i kø med sporbar logging og kontrollert retry eller nykjøring.";
  const issues = requirementAnswerQualityIssues(answer, entry);

  assert.ok(issues.includes("missing_duplicate_safe_integration_control"));
  assert.ok(issues.includes("missing_recovery_loss_control"));
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("explicit event logging satisfies lossless retry traceability", () => {
  const entry = requirement({
    text: "Løsningen skal integreres og håndtere feil, kø og ny kjøring uten tap av data.",
  });
  const answer =
    "Atea bruker idempotensnøkkel og duplikatkontroll, samt varig kø med feilkø. Feil, køstatus og kontrollert retry eller nykjøring registreres i en sporbar logg.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("KR-039 lossless integration gets a verified repair before strict handoff", () => {
  const text =
    "Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal integreres med lager og håndtere feil, kø og ny kjøring uten tap av serviceordre, komponentdata, bilder, sjekklister.";
  const entry = requirement({
    id: "KR-039",
    text,
    documentId: "aurorafelt-requirements",
    heading: "Kommentarer fra drift",
    sourceExcerpt: `KR-039: ${text}`,
  });
  const current = normalizeRequirementAnswerResult(
    "Atea bruker outbox og idempotensnøkkel for å hindre tap og duplikater. Feil går til varig dead-letter-kø med kontrollert retry.",
    entry,
    entry.sourceExcerpt,
  );

  assert.equal(current.source, "deterministic_fallback");
  assert.match(current.reason, /missing_queue_retry_traceability/);

  const repair = buildDeterministicFinalRequirementControlRepair({
    entry,
    evidence: current.evidence,
  });
  assert.ok(repair);
  assert.equal(repair.source, "deterministic_control_repair");
  assert.match(
    repair.answer,
    /^Som leverandørens konkrete avklaring beskriver og tilbyr Atea /,
  );
  assert.doesNotMatch(repair.answer, /kundekrav|kunden har|kunden bruker/i);
  assert.deepEqual(requirementAnswerQualityIssues(repair.answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(
      repair.answer,
      entry,
      entry.sourceExcerpt,
    ).source,
    "batch",
  );
  assert.deepEqual(
    resolveRequirementAnswerBeforeStrictHandoff({ entry, current }),
    repair,
  );
  assert.equal(
    buildDeterministicControlRepairMetadata({
      answers: [repair],
      ledger: [entry],
    }).deterministic_control_repair_rows[0]?.pattern,
    "lossless_queue_retry",
  );
});

test("KR-039 deterministic repair fails closed outside the canonical mandatory row", () => {
  const text =
    "Løsningen skal integreres med ERP, lager, kart og identitet og håndtere feil, kø og ny kjøring uten tap av serviceordre, komponentdata, bilder og sjekklister.";
  const rejected = [
    requirement({
      id: "KR-039",
      text: `${text} Løsningen skal også eksportere rapporter som CSV.`,
      sourceExcerpt: `KR-039 | ${text} Løsningen skal også eksportere rapporter som CSV. | Må`,
    }),
    requirement({
      id: "KR-039",
      text,
      sourceExcerpt: `KR-039 | ${text} | Bør`,
    }),
    requirement({
      id: "KR-039",
      text,
      heading: "Opsjoner og tilvalg",
      sourceExcerpt: `KR-039 | ${text} | Må`,
    }),
    requirement({
      id: "KR-039",
      text,
      sourceExcerpt: `KR-039 | ${text} | Må | Særskilt SLA gjelder`,
    }),
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      entry.sourceExcerpt,
    );
  }
});

test("response-time and access compounds require measurements and data scope", () => {
  const entry = requirement({
    text: "Løsningen skal ha måling av responstid slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger.",
  });
  const weak =
    "Atea måler responstid i sentrale brukerflyter og følger avvik gjennom varsling og oppfølging. Tilgang avgrenses rollebasert etter minste privilegium, slik at hver brukergruppe bare ser opplysninger den trenger.";
  const strong =
    "Atea etablerer målepunkter for navngitte brukertransaksjoner og API-kall, med varsling og dokumentert oppfølging eller eskalering av avvik. Tilgang styres med rollemodell og minste privilegium, med dataavgrensning per brukergruppe og på objektnivå.";

  const weakIssues = requirementAnswerQualityIssues(weak, entry);
  assert.ok(weakIssues.includes("missing_response_time_measurement_points"));
  assert.ok(weakIssues.includes("missing_access_data_scope"));
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(weak, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  assert.match(row.obligatorisk_svarstruktur, /målepunkter.*varsling/i);
  assert.match(row.obligatorisk_svarstruktur, /minste privilegium.*dataavgrensning/i);
});

test("automatic-notification compound gates stay strict while complete evidence preserves evaluator assessment", () => {
  const requirementText =
    "Løsningen skal ha automatisk varsling slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger for frivillig omsorg og besøksvenner.";
  const entry = requirement({ id: "R-040", text: requirementText });
  const canaryWeak =
    "Atea etablerer automatisk varsling ved avvik i tilgangsstyring og ved relevante hendelser for frivillige, koordinatorer, mottakere og pårørende, med eskalering til ansvarlige roller. Tilgang styres rollebasert med minste privilegium, slik at hver brukergruppe bare får innsyn i data de trenger for frivillig omsorg og besøksvenner.";
  const strong =
    "Atea sender automatisk varsel ved tildeling av oppdrag, fristbrudd og manglende respons i løsningen og via e-post eller SMS; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd og samtykkeendringer i sakene de følger opp. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne tildelte oppdrag og meldinger, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne oppdrag, meldinger og samtykkeopplysninger.";

  const weakIssues = requirementAnswerQualityIssues(canaryWeak, entry);
  for (const issue of [
    "missing_notification_event_triggers",
    "missing_notification_delivery_channel",
    "missing_notification_recipient_mapping",
    "missing_access_data_scope",
  ]) {
    assert.ok(weakIssues.includes(issue), `${issue}: ${weakIssues}`);
  }
  assert.equal(
    normalizeRequirementAnswerResult(canaryWeak, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );

  const [row] = buildRequirementResponseBatchRegistry([entry]);
  assert.match(row.obligatorisk_svarstruktur, /minst to konkrete hendelser/i);
  assert.match(row.obligatorisk_svarstruktur, /leveringskanal/i);
  assert.match(row.obligatorisk_svarstruktur, /hvem som mottar hva per rolle/i);
  assert.match(row.obligatorisk_svarstruktur, /dataavgrensning per brukergruppe/i);

  const groundedEntry = requirement({
    id: "R-040",
    text: requirementText,
    sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${strong}`,
    answerExcerpt: strong,
    answerEvidenceExcerpt: strong,
    answerDocumentId: "solution",
    answerReference: "R-040",
  });
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry: groundedEntry,
    assessment: "Dårlig",
    rationale: "Svaret er for generisk.",
    evidence: strong,
    recommendation: "Legg til konkrete hendelser og kanaler.",
  });
  assert.equal(corrected.assessment, "Dårlig");
  assert.equal(corrected.rationale, "Svaret er for generisk.");
  assert.equal(
    corrected.recommendation,
    "Legg til konkrete hendelser og kanaler.",
  );

  const withoutChannel = strong.replace(
    "i løsningen og via e-post eller SMS",
    "gjennom løsningens varslingsmekanisme",
  );
  const incompleteEntry = {
    ...groundedEntry,
    sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${withoutChannel}`,
    answerExcerpt: withoutChannel,
    answerEvidenceExcerpt: withoutChannel,
  };
  const notCorrected = correctCoverageAssessmentWithSourceEvidence({
    entry: incompleteEntry,
    assessment: "Dårlig",
    rationale: "Kanalen er ikke konkretisert.",
    evidence: withoutChannel,
    recommendation: "Navngi kanal.",
  });
  assert.equal(notCorrected.assessment, "Dårlig");

  const adversarialAnswers = [
    {
      label: "negated",
      answer:
        "Atea sender ikke automatisk varsel ved tildeling av oppdrag, fristbrudd og manglende respons via e-post eller SMS; frivillige mottar ikke varsler om egne oppdrag, og koordinatorer varsles ikke om fristbrudd. Løsningen bruker ikke rollebasert tilgang med minste privilegium, men beskriver dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare saker, og mottakere og pårørende bare egne meldinger.",
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "optional",
      answer:
        "Som valgfri opsjon etablerer Atea automatisk varsel ved tildeling av oppdrag, fristbrudd og manglende respons via e-post eller SMS; frivillige mottar varsler om egne oppdrag og koordinatorer om fristbrudd. Ved behov kan tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag og koordinatorer bare sine saker.",
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "disconnected trigger",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag via e-post; frivillige mottar varsel om egne oppdrag. Fristbrudd registreres, men utløser ikke varsel. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_event_triggers",
    },
    {
      label: "one generic recipient and access group",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post. Frivillige mottar varsler om egne oppdrag. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag.",
      issue: "missing_notification_recipient_mapping",
    },
    {
      label: "commercially optional add-on",
      answer:
        "Som tilleggstjeneste ved særskilt bestilling sender Atea automatisk varsel ved tildeling av oppdrag, fristbrudd og manglende respons via e-post eller SMS; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "report events disconnected from notification",
      answer:
        "Atea sender automatisk varsel for koordinatorer via e-post, samtidig registrerer løsningen fristbrudd og manglende respons i en rapport. Frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om oppdragene de følger opp. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_event_triggers",
    },
    {
      label: "recipient subject cross-binding",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post. Frivillige står i registeret, og koordinatorer mottar varsler om oppdrag. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_recipient_mapping",
    },
    {
      label: "access subject cross-binding",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe. Frivillige, mottakere og pårørende omfattes av rollemodellen, mens koordinatorer ser bare egne oppdrag.",
      issue: "missing_access_data_scope",
    },
    {
      label: "semantically disabled notification",
      answer: `${strong} Automatisk varsling er deaktivert i produksjon.`,
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "irrelevant binder before report events",
      answer:
        "Atea sender automatisk varsel ved pålogging via e-post, samtidig registrerer løsningen fristbrudd og manglende respons i en rapport. Frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om oppdragene de følger opp. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_event_triggers",
    },
    {
      label: "recipient subject cross-binding without comma",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post. Frivillige står i registeret og koordinatorer mottar varsler om oppdrag. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_recipient_mapping",
    },
    {
      label: "access subject cross-binding without comma",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige og mottakere og pårørende inngår i rollemodellen og koordinatorer ser bare egne oppdrag.",
      issue: "missing_access_data_scope",
    },
    {
      label: "price add-on after separate order",
      answer:
        "Mot pristillegg og etter egen bestilling sender Atea automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "notification remains inactive",
      answer: `${strong} Automatisk varsling forblir inaktiv i produksjon.`,
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "statistics topic cannot capture event binding",
      answer:
        "Atea sender automatisk varsel ved pålogging via e-post og viser statistikk om fristbrudd og manglende respons. Frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om oppdragene de følger opp. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_event_triggers",
    },
    {
      label: "newsletter channel is not a notification channel",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd, og e-post brukes til nyhetsbrev. Frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_delivery_channel",
    },
    {
      label: "recipient colon cross-binding",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post. Frivillige: koordinatorer mottar varsler om oppdrag. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "missing_notification_recipient_mapping",
    },
    {
      label: "access observation cannot cross-bind scope",
      answer:
        "Atea sender automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige samt mottakere og pårørende ser koordinatorer kun behandle egne oppdrag.",
      issue: "missing_access_data_scope",
    },
    {
      label: "paid premium notification",
      answer:
        "Kun i et betalt premiumabonnement sender Atea automatisk varsel ved tildeling av oppdrag og fristbrudd via e-post; frivillige mottar varsler om egne oppdrag, mens koordinatorer mottar varsler om fristbrudd. Tilgang styres rollebasert etter minste privilegium med dataavgrensning per brukergruppe: frivillige ser bare egne oppdrag, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne meldinger.",
      issue: "noncommittal_notification_or_access_control",
    },
    {
      label: "suspended notification",
      answer: `${strong} Automatisk varsling er suspendert i produksjon.`,
      issue: "noncommittal_notification_or_access_control",
    },
  ];
  for (const adversarial of adversarialAnswers) {
    const issues = requirementAnswerQualityIssues(adversarial.answer, entry);
    assert.ok(
      issues.includes(adversarial.issue),
      `${adversarial.label}: ${issues}`,
    );
    assert.equal(
      normalizeRequirementAnswerResult(
        adversarial.answer,
        entry,
        entry.text,
      ).source,
      "deterministic_fallback",
      adversarial.label,
    );
    const adversarialEntry = {
      ...groundedEntry,
      sourceExcerpt: `Kravgrunnlag: ${requirementText} | Svarrad: ${adversarial.answer}`,
      answerExcerpt: adversarial.answer,
      answerEvidenceExcerpt: adversarial.answer,
    };
    const adversarialCorrection = correctCoverageAssessmentWithSourceEvidence({
      entry: adversarialEntry,
      assessment: "Dårlig",
      rationale: "Svaret er ufullstendig.",
      evidence: adversarial.answer,
      recommendation: "Forplikt og konkretiser kontrollene.",
    });
    assert.equal(
      adversarialCorrection.assessment,
      "Dårlig",
      adversarial.label,
    );
  }

  const compoundRequirement = `${requirementText} Løsningen skal også slette alle personopplysninger senest 30 dager etter avsluttet oppdrag.`;
  const compoundEntry = {
    ...groundedEntry,
    text: compoundRequirement,
    sourceExcerpt: `Kravgrunnlag: ${compoundRequirement} | Svarrad: ${strong}`,
  };
  const compoundCorrection = correctCoverageAssessmentWithSourceEvidence({
    entry: compoundEntry,
    assessment: "Dårlig",
    rationale: "Sletteplikten er ikke besvart.",
    evidence: strong,
    recommendation: "Beskriv 30-dagers sletting.",
  });
  assert.equal(compoundCorrection.assessment, "Dårlig");

  const restrictivePermission = strong.replace(
    "frivillige ser bare egne tildelte oppdrag og meldinger, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne oppdrag, meldinger og samtykkeopplysninger",
    "frivillige kan bare se egne tildelte oppdrag og meldinger, koordinatorer kan bare se sakene de forvalter, og mottakere og pårørende kan bare se egne oppdrag, meldinger og samtykkeopplysninger",
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(restrictivePermission, entry),
    [],
  );
  assert.equal(
    normalizeRequirementAnswerResult(
      restrictivePermission,
      entry,
      entry.text,
    ).source,
    "batch",
  );
  const restrictiveInsight = strong.replace(
    "frivillige ser bare egne tildelte oppdrag og meldinger, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne oppdrag, meldinger og samtykkeopplysninger",
    "frivillige kan kun få innsyn i egne tildelte oppdrag og meldinger, koordinatorer kan kun få innsyn i sakene de forvalter, og mottakere og pårørende kan kun få innsyn i egne oppdrag, meldinger og samtykkeopplysninger",
  );
  assert.deepEqual(requirementAnswerQualityIssues(restrictiveInsight, entry), []);
  assert.deepEqual(
    requirementAnswerQualityIssues(
      `${strong} Et separat analyse-dashboard tilbys som tilleggstjeneste.`,
      entry,
    ),
    [],
  );
  const coordinatedRestriction = strong.replace(
    "frivillige ser bare egne tildelte oppdrag og meldinger, koordinatorer bare sakene de forvalter, og mottakere og pårørende bare egne oppdrag, meldinger og samtykkeopplysninger",
    "frivillige, koordinatorer, mottakere og pårørende kan bare se egne oppdrag og meldinger",
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(coordinatedRestriction, entry),
    [],
  );
});

test("access scoped to each role's tasks is an explicit data boundary", () => {
  const entry = requirement({
    text: "Løsningen skal ha måling av responstid slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger.",
  });
  const answer =
    "Atea etablerer målepunkter for navngitte brukertransaksjoner, med varsling og dokumentert oppfølging av avvik. Tilgang styres rollebasert etter minste privilegium, slik at brukergruppene bare får tilgang til data og funksjoner som er avgrenset til deres oppgaver i løsningen.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("role-specific needed data and functions are an explicit access boundary", () => {
  const entry = requirement({
    text: "Løsningen skal ha måling av responstid slik at brukergruppene bare får tilgang til data de trenger.",
  });
  const answer =
    "Atea etablerer målepunkter for navngitte brukertransaksjoner, med varsling og dokumentert oppfølging av avvik. Tilgang styres rollebasert etter minste privilegium, slik at hver rolle bare kan se og behandle data og funksjoner den trenger for sine oppgaver i løsningen.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("named user groups may express the same task-scoped access boundary", () => {
  const entry = requirement({
    text: "Løsningen skal ha måling av responstid slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger.",
  });
  const answer =
    "Atea etablerer målepunkter for navngitte brukertransaksjoner, med varsling og dokumentert oppfølging av avvik. Tilgang styres rollebasert etter minste privilegium, slik at frivillige, koordinatorer, mottakere og pårørende kun får tilgang til data og funksjoner de trenger for sine oppgaver.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("role-specific assigned and authorized objects are an explicit data scope", () => {
  const entry = requirement({
    text: "Løsningen skal ha måling av responstid slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger.",
  });
  const answer =
    "Atea etablerer målepunkter for navngitte brukertransaksjoner, med varsling og dokumentert oppfølging av avvik. Tilgang styres med en rollemodell etter minste privilegium, der frivillige kun ser tildelte oppdrag og nødvendige kontakt- og besøksopplysninger, koordinatorer ser planleggings- og oppfølgingsobjekter i eget ansvarsområde, mottakere ser egne avtaler og samtykker, og pårørende kun ser autoriserte felter.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("dimensioning without slowness requires capacity, test, margin and proposed goals", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
  });
  const weak =
    "Atea dimensjonerer løsningen for sporbarhet og følger ytelse med måling av sentrale brukertransaksjoner og kapasitetsdata.";
  const strong =
    deterministicDimensioningTemplate;

  const weakIssues = requirementAnswerQualityIssues(weak, entry);
  assert.ok(weakIssues.includes("missing_capacity_baseline"));
  assert.ok(weakIssues.includes("missing_load_performance_test"));
  assert.ok(weakIssues.includes("missing_scaling_capacity_margin"));
  assert.ok(weakIssues.includes("missing_proposed_performance_acceptance"));
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(weak, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.equal(
    normalizeRequirementAnswerResult(strong, entry, entry.text).source,
    "batch",
  );
  const [row] = buildRequirementResponseBatchRegistry([entry]);
  assert.match(
    row.obligatorisk_svarstruktur,
    /forplikt nå.*kapasitetsmodell.*ytelsestest.*provisjonert kapasitet.*kapasitetsmargin/i,
  );
  assert.match(
    row.obligatorisk_svarstruktur,
    /konfigurerte leverandørbaselinen eksakt.*p95 under 2 sekunder.*200 samtidige brukere.*Ateas tilbudte leverandørforslag/i,
  );
  assert.match(
    row.obligatorisk_svarstruktur,
    /p95 under 2 sekunder.*antatt lastprofil på 200 samtidige brukere/i,
  );
});

test("supplier baseline is exact, same-sentence bound and never attributed to the source", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
  });
  const arbitraryBaseline = deterministicDimensioningTemplate
    .replace("p95 under 2 sekunder", "p99 under 3 sekunder")
    .replace("200 samtidige brukere", "100 samtidige brukere");
  assert.ok(
    requirementAnswerQualityIssues(arbitraryBaseline, entry).includes(
      "missing_supplier_proposed_numeric_performance_target",
    ),
  );

  for (const falseAttribution of [
    "og samtidig spesifisert av kilden",
    "og samtidig i henhold til konkurransegrunnlaget",
    "og samtidig fastsatt av oppdragsgiveren",
  ]) {
    const falselyAttributed = deterministicDimensioningTemplate.replace(
      "ikke kundekrav fra kilden",
      falseAttribution,
    );
    assert.ok(
      requirementAnswerQualityIssues(falselyAttributed, entry).includes(
        "missing_supplier_proposed_numeric_performance_target",
      ),
      falseAttribution,
    );
  }

  for (const separateFalseAttribution of [
    "Kilden angir også p95 under 2 sekunder ved 200 samtidige brukere.",
    "Kildens krav er p95 under 2 sekunder ved 200 samtidige brukere.",
    "Kunden fastsetter p95 under 2 sek.",
    "Dette målet er også fastsatt av oppdragsgiveren.",
    "De nevnte verdiene følger av kontraktens krav.",
  ]) {
    const validThenMisattributed = `${deterministicDimensioningTemplate} ${separateFalseAttribution}`;
    assert.ok(
      requirementAnswerQualityIssues(validThenMisattributed, entry).includes(
        "missing_supplier_proposed_numeric_performance_target",
      ),
      separateFalseAttribution,
    );
  }

  for (const explicitSourceDenial of [
    "Dette målet er ikke nevnt i kilden.",
    "Responstidsmålet fremgår ikke av konkurransegrunnlaget.",
    "Kunden angir ikke dette målet.",
  ]) {
    const validWithSourceDenial = `${deterministicDimensioningTemplate} ${explicitSourceDenial}`;
    assert.ok(
      !requirementAnswerQualityIssues(validWithSourceDenial, entry).includes(
        "missing_supplier_proposed_numeric_performance_target",
      ),
      explicitSourceDenial,
    );
  }

  const extraTarget = `${deterministicDimensioningTemplate} Atea tilbyr også p99 under 3 sekunder.`;
  assert.ok(
    requirementAnswerQualityIssues(extraTarget, entry).includes(
      "missing_supplier_proposed_numeric_performance_target",
    ),
  );
});

test("documented performance targets reject additional undocumented values", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.";
  const entry = requirement({
    text: requirementText,
    sourceExcerpt: `${requirementText} Responstidsmålet er p95 under 1 sekund ved 500 samtidige brukere.`,
  });
  const answer =
    "Atea dimensjonerer og forplikter sporbarhet for operasjonene registrere innmelding, oppdatere status og avslutte saken med kapasitetsmodell og ytelsesbaseline, lasttest og ytelsestest, autoskalering og kapasitetsmargin. Atea forplikter responstidsmålet p95 under 1 sekund ved 500 samtidige brukere som akseptansekriterium, men tilbyr også p99 under 3 sekunder.";
  assert.ok(
    requirementAnswerQualityIssues(answer, entry).includes(
      "undocumented_performance_target",
    ),
  );
});

test("all non-lifecycle dimensioning families bind controls to their own source focus", () => {
  const focuses = [
    ["robust feilhåndtering ved integrasjonsstans", ["registrere handling", "vise køstatus", "starte kontrollert nykjøring"]],
    ["skalerbarhet ved sesongtopper", ["logge inn", "åpne arbeidsliste", "lagre endring"]],
    ["standardisert rapportering til ledelse", ["åpne rapport", "endre filter", "starte eksport"]],
    ["lav ventetid i kritiske arbeidsprosesser", ["åpne arbeidsliste", "registrere endring", "lagre status"]],
    ["klar rollefordeling mellom avdelinger", ["slå opp rolle", "tildele ansvar", "åpne avdelingsvisning"]],
    ["sikker datadeling med eksterne aktører", ["opprette deling", "hente delte data", "tilbakekalle tilgang"]],
    ["kontroll på tilgangsendringer", ["opprette tilgangsendring", "godkjenne endring", "vise oppdatert tilgang"]],
    ["konfigurerbare arbeidsflyter", ["åpne arbeidsflyt", "endre status", "lagre konfigurasjon"]],
    ["tilgjengelighet på mobil og nettbrett", ["logge inn", "åpne arbeidsliste", "lagre endring"]],
    ["enkel administrasjon uten konsulentbistand", ["opprette bruker", "endre regel", "publisere konfigurasjon"]],
    ["dokumentert beredskap for driftsavbrudd", ["åpne beredskapsstatus", "registrere hendelse", "starte gjenoppretting"]],
  ];

  for (const [focus, operations] of focuses) {
    const entry = requirement({
      text: `Løsningen skal dimensjoneres for ${focus} uten at brukerne opplever vesentlig treghet.`,
    });
    const focusedAnswer =
      `Atea dimensjonerer ${focus} med kapasitetsmodell og ytelsesbaseline, lasttest og ytelsestest, autoskalering og eksplisitt kapasitetsmargin for de navngitte operasjonene ${operations.join(", ")}. ` +
      "Ateas tilbudte responstidsmål er p95 under 2 sekunder for de samme operasjonene ved en antatt lastprofil på 200 samtidige brukere; både målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og brukes som bindende akseptansekriterium.";
    assert.equal(
      requirementAnswerQualityIssues(focusedAnswer, entry).includes(
        "missing_dimensioning_source_focus_binding",
      ),
      false,
      focus,
    );

    const disconnected = `${deterministicDimensioningTemplate} Dette gjelder ${focus}.`;
    assert.ok(
      requirementAnswerQualityIssues(disconnected, entry).includes(
        "missing_dimensioning_source_focus_binding",
      ),
      focus,
    );
  }
});

test("dimensioning source qualifiers require positive, source-faithful clauses", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";
  const cases = [
    {
      sourceQualifier: "Kan prises som opsjon",
      issue: "missing_dimensioning_option_qualifier",
      negative: "Dette leveres ikke som opsjon.",
      positive: "Denne dimensjoneringen tilbys som priset opsjon.",
    },
    {
      sourceQualifier: "Gjelder produksjonsløsning",
      issue: "missing_dimensioning_production_scope",
      negative: "Dette gjelder ikke produksjonsløsningen.",
      positive: "Dimensjoneringen gjelder produksjonsløsningen.",
    },
    {
      sourceQualifier: "Må avklares i designfase",
      issue: "missing_dimensioning_design_phase_qualifier",
      negative: "Designfasen brukes ikke til validering.",
      positive: "Eksakt lastprofil avklares i designfasen.",
    },
    {
      sourceQualifier: "Dokumentasjon ønskes",
      issue: "missing_dimensioning_documentation_qualifier",
      negative: "Dokumentasjon leveres ikke.",
      positive:
        "Atea dokumenterer lastprofil, testresultat og akseptansekriterier.",
    },
    {
      sourceQualifier: "Leverandøren må avklare",
      issue: "missing_dimensioning_clarification_qualifier",
      negative: "Lastprofilen avklares ikke.",
      positive: "Eksakt lastprofil avklares med kunden.",
    },
    {
      sourceQualifier: "Teksten forutsetter at",
      issue: "missing_dimensioning_assumption_qualifier",
      negative: "Tilbudet har ingen forutsetning.",
      positive:
        "Som løsningsforutsetning forutsetter tilbudet den oppgitte lastprofilen.",
    },
    {
      sourceQualifier: "Notat fra behovsarbeidet",
      issue: "missing_dimensioning_note_qualifier",
      negative: "Dette er ikke et notat fra behovsarbeidet.",
      positive:
        "Dette behandles som et notat fra behovsarbeidet og en tilbudt løsningsforutsetning.",
    },
  ];

  for (const fixture of cases) {
    const entry = requirement({
      id: "R-035",
      text: requirementText,
      sourceExcerpt: `R-035 ${requirementText} Må ${fixture.sourceQualifier}`,
    });
    assert.ok(
      requirementAnswerQualityIssues(deterministicDimensioningTemplate, entry).includes(
        fixture.issue,
      ),
      fixture.sourceQualifier,
    );
    assert.ok(
      requirementAnswerQualityIssues(
        `${deterministicDimensioningTemplate} ${fixture.negative}`,
        entry,
      ).includes(fixture.issue),
      `negated ${fixture.sourceQualifier}`,
    );
    assert.equal(
      requirementAnswerQualityIssues(
        `${deterministicDimensioningTemplate} ${fixture.positive}`,
        entry,
      ).includes(fixture.issue),
      false,
      `positive ${fixture.sourceQualifier}`,
    );
  }

  const optionEntry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `R-035 ${requirementText} Må Kan prises som opsjon`,
  });
  assert.ok(
    requirementAnswerQualityIssues(
      `${deterministicDimensioningTemplate} Denne dimensjoneringen tilbys som priset opsjon. Opsjonen inngår likevel ikke i tilbudet.`,
      optionEntry,
    ).includes("missing_dimensioning_option_qualifier"),
  );
  const negatedSourceOption = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `R-035 ${requirementText} Skal ikke prises som opsjon`,
  });
  assert.equal(
    requirementAnswerQualityIssues(
      deterministicDimensioningTemplate,
      negatedSourceOption,
    ).includes("missing_dimensioning_option_qualifier"),
    false,
  );

  const productionEntry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `R-035 ${requirementText} Må Gjelder produksjonsløsning`,
  });
  assert.equal(
    requirementAnswerQualityIssues(
      `${deterministicDimensioningTemplate} Dimensjoneringen gjelder produksjonsløsningen uten vesentlig treghet.`,
      productionEntry,
    ).includes("missing_dimensioning_production_scope"),
    false,
  );

  const solutionProposalEntry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `R-035 ${requirementText} Må Krever løsningsforslag`,
  });
  const withoutSolutionProposal = deterministicDimensioningTemplate.replace(
    "I løsningsforslaget dimensjonerer og forplikter Atea",
    "Atea dimensjonerer og forplikter",
  );
  assert.ok(
    requirementAnswerQualityIssues(
      withoutSolutionProposal,
      solutionProposalEntry,
    ).includes("missing_dimensioning_solution_proposal_qualifier"),
  );
  assert.equal(
    requirementAnswerQualityIssues(
      deterministicDimensioningTemplate,
      solutionProposalEntry,
    ).includes("missing_dimensioning_solution_proposal_qualifier"),
    false,
  );

  const supplierResponseEntry = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt: `R-035 ${requirementText} Må Besvares av leverandør`,
  });
  assert.ok(
    requirementAnswerQualityIssues(
      deterministicDimensioningTemplate,
      supplierResponseEntry,
    ).includes("missing_dimensioning_supplier_response_qualifier"),
  );
  assert.equal(
    requirementAnswerQualityIssues(
      `${deterministicDimensioningTemplate} I leverandørbesvarelsen dimensjonerer og forplikter Atea den samme leveransen.`,
      supplierResponseEntry,
    ).includes("missing_dimensioning_supplier_response_qualifier"),
    false,
  );
});

test("dimensioning template repair allowlists exact single-purpose source rows", () => {
  const requirementText =
    "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";
  const safe = requirement({
    id: "R-035",
    text: requirementText,
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  assert.equal(
    buildDeterministicFinalRequirementTemplateRepair({ entry: safe })?.source,
    "deterministic_template_repair",
  );

  const production = requirement({
    ...safe,
    sourceExcerpt: `R-035 ${requirementText} Må Gjelder produksjonsløsning`,
  });
  const productionRepair = buildDeterministicFinalRequirementTemplateRepair({
    entry: production,
  });
  assert.equal(productionRepair?.source, "deterministic_template_repair");
  assert.match(
    productionRepair?.answer ?? "",
    /I løsningsforslaget for produksjonsløsningen dimensjonerer og forplikter Atea/i,
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(productionRepair?.answer ?? "", production),
    [],
  );

  const blocked = [
    requirement({ ...safe, sourceExcerpt: "Kravgrunnlag" }),
    requirement({
      ...safe,
      sourceExcerpt: `R-035 ${requirementText} Bare ved særskilt bestilling`,
    }),
    requirement({
      ...safe,
      text: `${requirementText} Alle persondata skal også slettes automatisk.`,
      sourceExcerpt: `R-035 ${requirementText} Alle persondata skal også slettes automatisk.`,
    }),
    requirement({
      ...safe,
      sourceExcerpt: `R-035 ${requirementText} Må Kan prises som opsjon`,
    }),
    requirement({
      ...safe,
      sourceExcerpt: `R-035 ${requirementText} Må Må avklares i designfase`,
    }),
    requirement({
      ...safe,
      heading: "Kun ved særskilt bestilling",
    }),
  ];
  for (const entry of blocked) {
    assert.equal(
      buildDeterministicFinalRequirementTemplateRepair({ entry }),
      null,
      entry.sourceExcerpt,
    );
  }

  const profiled = requirement({
    ...safe,
    text: "Løsningen skal dimensjoneres for skalerbarhet ved sesongtopper uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for skalerbarhet ved sesongtopper uten at brukerne opplever vesentlig treghet.",
  });
  const profiledRepair = buildDeterministicFinalRequirementTemplateRepair({
    entry: profiled,
  });
  assert.equal(profiledRepair?.source, "deterministic_template_repair");
  assert.deepEqual(
    requirementAnswerQualityIssues(profiledRepair?.answer ?? "", profiled),
    [],
  );
});

test("canary32 requires lifecycle-bound performance and production-config acceptance", () => {
  const dimensioningEntry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
  });
  const disconnectedPerformanceAnswer =
    "Atea dimensjonerer løsningen med en kapasitetsbaseline for innmelding, oppdragsbehandling, samtykkehåndtering, meldingsutsending og statusvisning, verifisert i last- og ytelsestest og med definert reservekapasitet samt dynamisk skalering der plattformen støtter det. Ytelsesmål og akseptansekriterier foreslås per navngitt brukertransaksjon og godkjennes før produksjonssetting, siden konkrete terskler ikke er oppgitt i kravgrunnlaget.";
  assert.ok(
    requirementAnswerQualityIssues(
      disconnectedPerformanceAnswer,
      dimensioningEntry,
    ).includes("missing_end_to_end_traceability_performance_binding"),
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(
      deterministicDimensioningTemplate,
      dimensioningEntry,
    ),
    [],
  );

  const acceptanceEntry = requirement({
    id: "R-012",
    text: "Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer.",
    sourceExcerpt:
      "R-012 Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer. Må Gjelder produksjonsløsning",
  });
  const acceptanceWithoutProductionBinding =
    "Akseptansetesten dekker brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, retestes og inngår i testoppsummeringen før godkjenning.";
  assert.ok(
    requirementAnswerQualityIssues(
      acceptanceWithoutProductionBinding,
      acceptanceEntry,
    ).includes("missing_acceptance_production_configuration"),
  );
  const acceptanceRepair =
    buildDeterministicFinalRequirementControlRepair({
      entry: acceptanceEntry,
      evidence: acceptanceEntry.sourceExcerpt,
    });
  assert.equal(acceptanceRepair, null);
  const acceptanceWithProductionBinding =
    "Akseptansetesten verifiserer produksjonsløsningens godkjente konfigurasjon i et produksjonslikt testmiljø og dekker brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, retestes og inngår i testoppsummeringen før godkjenning.";
  assert.match(
    acceptanceWithProductionBinding,
    /produksjonsløsningens godkjente konfigurasjon.*produksjonslikt testmiljø/i,
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(
      acceptanceWithProductionBinding,
      acceptanceEntry,
    ),
    [],
  );
});

test("deferred R-035 repair commits core capacity and a labeled supplier target now", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  const repair = buildRequirementRepairDirective(
    entry,
    "quality_gate: deferred_core_scope; handoff_unresolved: quality_gate: deferred_core_scope",
  );

  assert.match(repair, /Forrige svar manglet spesielt/i);
  assert.match(
    repair,
    /forplikt alle tekniske kjerneelementer i presens nå/i,
  );
  assert.match(
    repair,
    /kapasitetsmodell.*last-\/ytelsestest.*provisjonert kapasitet.*kapasitetsmargin/i,
  );
  assert.match(
    repair,
    /kunden ikke har oppgitt tall.*konfigurerte baselinen.*p95 under 2 sekunder.*200 samtidige brukere.*akseptansekriterium nå.*leverandørforslag.*uten andre ytelsestall.*uten å utsettes/i,
  );
});

test("strict R-035 handoff requires a labeled measurable supplier target", () => {
  const prompt = buildStrictRequirementHandoffUserPrompt({
    projectName: "R-035 repair",
    acceptedAnswerContext: [],
    strictRow: {
      nr: 35,
      ref: "R-035",
      kravtekst:
        "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
      avvist_arsak: "quality_gate: deferred_core_scope",
      obligatorisk_svarstruktur: "DIRECTIVE_SENTINEL",
    },
  });

  assert.match(
    prompt,
    /Ikke plasser teknisk kjerneomfang og avklaringsspråk i samme setning/i,
  );
  assert.match(
    prompt,
    /første setning forplikte kapasitetsmodell.*last-\/ytelsestest.*provisjonert kapasitet.*kapasitetsmargin nå/i,
  );
  assert.match(
    prompt,
    /kunden ikke har oppgitt tall.*konfigurerte leverandørbaselinen eksakt.*p95 under 2 sekunder.*200 samtidige brukere.*leverandørforslag og bindende akseptansekriterium.*ikke som kundekrav.*ingen andre ytelsestall.*ikke utsettes/i,
  );
});

test("strict handoff never permits supplier baseline beside documented source targets", () => {
  const prompt = buildStrictRequirementHandoffUserPrompt({
    projectName: "Documented SLA repair",
    acceptedAnswerContext: [],
    strictRow: {
      nr: 35,
      ref: "R-035",
      kravtekst:
        "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet, med p95 under 1 sekund.",
      har_dokumenterte_ytelsesmaal: true,
      avvist_arsak: "quality_gate: missing_documented_performance_target_commitment",
      obligatorisk_svarstruktur: "DIRECTIVE_SENTINEL",
    },
  });

  assert.doesNotMatch(prompt, /konfigurerte leverandørbaselinen/i);
  assert.match(
    prompt,
    /Hvis kravet har tallfestet terskel, behold terskelen/i,
  );
});

test("final R-035 template repair is verbatim, measurable, two sentences and provenance-labeled", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  const result = buildDeterministicFinalRequirementTemplateRepair({
    entry,
    evidence: entry.sourceExcerpt,
  });

  assert.ok(result);
  assert.equal(result.answer, deterministicDimensioningTemplate);
  assert.equal(result.source, "deterministic_template_repair");
  assert.equal(isDeterministicTemplateRepairAnswer(result.answer), true);
  assert.equal(
    isDeterministicTemplateRepairAnswer(
      `  ${result.answer.replaceAll(" ", "  ")}  `,
    ),
    true,
  );
  assert.equal(
    isDeterministicTemplateRepairAnswer(
      result.answer.replace("ytelsesbaseline", "kapasitetsbaseline"),
    ),
    false,
  );
  assert.match(
    result.answer,
    /tilbudte responstidsmål.*p95 under 2 sekunder.*de samme transaksjonene.*antatt lastprofil på 200 samtidige brukere.*leverandørforutsetning.*ikke kundekrav.*akseptansekriterium/i,
  );
  assert.equal(result.answer.match(/[.!?](?:\s|$)/g)?.length, 2);
});

test("final template repair rejects nonmatching requirements and documented targets", () => {
  const baseRequirement =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet";
  const entries = [
    requirement({
      id: "R-025",
      text: "Løsningen skal vise status fra innmelding til avslutning.",
    }),
    requirement({
      id: "R-035",
      text: `${baseRequirement}, med p95 under 2 sekunder.`,
    }),
    requirement({
      id: "R-035",
      text: `${baseRequirement}.`,
      sourceExcerpt: `Kravgrunnlag: ${baseRequirement}. SLA-målet er p95 under 2 sekunder ved 200 samtidige brukere. | Svarrad: Svaret omtaler ikke målet.`,
    }),
  ];

  for (const entry of entries) {
    assert.equal(
      buildDeterministicFinalRequirementTemplateRepair({ entry }),
      null,
    );
  }
});

test("validated dimensioning control repair is available before strict handoff while an accepted strict answer still wins", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  const current = normalizeRequirementAnswerResult(
    "Kapasitetsmodell avklares senere med kunden.",
    entry,
    entry.sourceExcerpt,
  );
  const acceptedStrictRepair = normalizeRequirementAnswerResult(
    deterministicDimensioningTemplate,
    entry,
    entry.sourceExcerpt,
  );

  assert.equal(current.source, "deterministic_fallback");
  assert.equal(acceptedStrictRepair.source, "batch");
  assert.strictEqual(
    resolveRequirementAnswerAfterStrictHandoff({
      entry,
      current,
      strictRepair: acceptedStrictRepair,
    }),
    acceptedStrictRepair,
  );
  assert.equal(
    resolveRequirementAnswerAfterStrictHandoff({
      entry,
      current,
      strictRepair: null,
    }).source,
    "deterministic_control_repair",
  );
  assert.equal(
    resolveRequirementAnswerBeforeStrictHandoff({ entry, current }).source,
    "deterministic_control_repair",
  );
  assert.deepEqual(
    buildDeterministicControlRepairMetadata({
      answers: [resolveRequirementAnswerBeforeStrictHandoff({ entry, current })],
      ledger: [entry],
    }),
    {
      deterministic_control_repair_answers: 1,
      deterministic_control_repair_refs: ["R-035"],
      deterministic_control_repair_rows: [
        {
          ref: "R-035",
          pattern: "dimensioning_supplier_baseline",
          order_index: 0,
          source_document_id: null,
          source_locator: "Side 1, R-035",
        },
      ],
      manual_review_required: true,
      manual_review_note:
        "Deterministisk kontrolltekst er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.",
    },
  );
  assert.deepEqual(
    buildDeterministicTemplateRepairMetadata({
      answers: [resolveRequirementAnswerBeforeStrictHandoff({ entry, current })],
      ledger: [entry],
    }),
    {
      deterministic_template_repair_answers: 0,
      deterministic_template_repair_refs: [],
      deterministic_template_repair_rows: [],
      manual_review_required: false,
    },
  );
});

test("template repair metadata is auditable and leaves unrelated fallbacks unresolved", () => {
  const dimensioningEntry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  const unrelatedEntry = requirement({
    id: "R-036",
    text: "Løsningen skal dokumentere tilgangsstyring.",
  });
  const templateRepair = buildDeterministicFinalRequirementTemplateRepair({
    entry: dimensioningEntry,
  });
  const unresolved = normalizeRequirementAnswerResult(
    "Ja.",
    unrelatedEntry,
    unrelatedEntry.sourceExcerpt,
  );

  assert.ok(templateRepair);
  assert.equal(unresolved.source, "deterministic_fallback");
  assert.strictEqual(
    resolveRequirementAnswerAfterStrictHandoff({
      entry: unrelatedEntry,
      current: unresolved,
      strictRepair: null,
    }),
    unresolved,
  );
  assert.deepEqual(
    buildDeterministicTemplateRepairMetadata({
      answers: [templateRepair, unresolved],
      ledger: [dimensioningEntry, unrelatedEntry],
    }),
    {
      deterministic_template_repair_answers: 1,
      deterministic_template_repair_refs: ["R-035"],
      deterministic_template_repair_rows: [
        {
          ref: "R-035",
          order_index: 0,
          source_document_id: null,
          source_locator: "Side 1, R-035",
        },
      ],
      manual_review_required: true,
      manual_review_note:
        "Standardformulering er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.",
    },
  );
  assert.deepEqual(
    buildDeterministicTemplateRepairMetadata({
      answers: [unresolved],
      ledger: [unrelatedEntry],
    }),
    {
      deterministic_template_repair_answers: 0,
      deterministic_template_repair_refs: [],
      deterministic_template_repair_rows: [],
      manual_review_required: false,
    },
  );
});

test("proposal input metadata separates customer requirements from supplier evidence", () => {
  const ledger = [
    requirement({
      id: "K-REF",
      text: "Leverandøren skal inkludere minst 3 referanser med kontaktdata.",
    }),
    requirement({
      id: "K-CV",
      text: "CV-er for aktuelle kandidater skal vedlegges tilbudet med referanser.",
    }),
    requirement({
      id: "K-ISO",
      text: "Leverandøren må oppgi relevante sikkerhetssertifiseringer og legge ved SoA.",
    }),
    requirement({
      id: "K-PRICE",
      text: "Prismodell, timepriser og avtalt margin skal fremgå av Bilag 7.",
    }),
    requirement({
      id: "K-CSR",
      text: "Beskriv virksomhetens samfunnsansvar, mangfold og inkludering.",
    }),
    requirement({
      id: "K-DECISION",
      text: "Leverandøren må klargjøre hvorvidt underleverandørene videreføres eller erstattes.",
    }),
    requirement({
      id: "K-TECH",
      text: "Løsningen skal logge sikkerhetshendelser med sporbar oppfølging.",
    }),
  ];

  const withoutEvidence = buildProposalInputRequiredMetadata({ ledger });
  assert.equal(withoutEvidence.proposal_input_required_count, 6);
  assert.deepEqual(withoutEvidence.proposal_input_required_refs, [
    "K-REF",
    "K-CV",
    "K-ISO",
    "K-PRICE",
    "K-CSR",
    "K-DECISION",
  ]);
  assert.deepEqual(
    withoutEvidence.proposal_input_required_rows.find(
      (row) => row.ref === "K-ISO",
    )?.reasons,
    ["security_assurance_evidence"],
  );

  const withEvidence = buildProposalInputRequiredMetadata({
    ledger,
    evidenceDocuments: [
      {
        title: "Leverandørbevis",
        file_name: "supplier-evidence.md",
        raw_text:
          [
            "Kunde 1: Equinor ASA\nKontaktperson: Ola Nordmann\nE-post: ola@example.no\nTelefon: +47 900 00 001.",
            "Kunde 2: Statkraft AS. Kontaktperson: Kari Nordli, kari@example.no, +47 900 00 002.",
            "Kunde 3: Telenor Norge AS. Kontaktperson: Per Hansen, per@example.no, +47 900 00 003.",
            "CV. Kandidatnavn: Ada Lovelace. Kompetanse og arbeidserfaring: ti år med sikkerhetsarkitektur.",
            "ISO/IEC 27001 sertifikatnummer NO-12345, utstedt av DNV og gyldig til 2027-12-31.",
            "Statement of Applicability (SoA), versjon 4, dato 2026-06-01, kontroll A.5.1.",
            "Prismodell: timepris 1 750 NOK, margin 8 %, betalingsvilkår netto 30 dager.",
          ].join("\n"),
      },
    ],
  });
  assert.equal(withEvidence.proposal_input_required_count, 2);
  assert.deepEqual(withEvidence.proposal_input_required_refs, [
    "K-CSR",
    "K-DECISION",
  ]);

  const filenameOnly = buildProposalInputRequiredMetadata({
    ledger,
    evidenceDocuments: [
      {
        title: "ISO 27001 SoA og CV-er",
        file_name: "prismodell-kundereferanser.pdf",
        raw_text: "",
      },
    ],
  });
  assert.equal(filenameOnly.proposal_input_required_count, 6);

  const mentionsAndDeferrals = buildProposalInputRequiredMetadata({
    ledger,
    evidenceDocuments: [
      {
        title: "Tilbudsnotat",
        file_name: "tilbudsnotat.md",
        raw_text: [
          "Kundereferanser kan leveres på forespørsel.",
          "CV-er ettersendes senere.",
          "Vi har ISO 27001 og SoA.",
          "Vi har en prismodell som avtales senere.",
          "Samfunnsansvar, mangfold og inkludering er viktig.",
          "Underleverandørløsningen avklares senere.",
        ].join("\n"),
      },
    ],
  });
  assert.equal(mentionsAndDeferrals.proposal_input_required_count, 6);

  const completeEvidenceWithUnrelatedDeferral = buildProposalInputRequiredMetadata({
    ledger: [ledger[0]],
    evidenceDocuments: [
      {
        title: "Referanser",
        file_name: "referanser.md",
        raw_text: [
          "Kunde 1: Equinor ASA\nKontaktperson: Ola Nordmann\nE-post: ola@example.no\nTelefon: +47 900 00 001.",
          "Kunde 2: Statkraft AS\nKontaktperson: Kari Nordli\nE-post: kari@example.no\nTelefon: +47 900 00 002.",
          "Kunde 3: Telenor Norge AS\nKontaktperson: Per Hansen\nE-post: per@example.no\nTelefon: +47 900 00 003.",
          "Reisemøter avtales senere.",
        ].join("\n\n"),
      },
    ],
  });
  assert.equal(completeEvidenceWithUnrelatedDeferral.proposal_input_required_count, 0);

  const rowBoundEvidence = buildProposalInputRequiredMetadata({
    ledger: [
      requirement({
        id: "K-CV-PM",
        text: "CV for navngitt prosjektleder skal vedlegges tilbudet.",
      }),
      requirement({
        id: "K-CV-SEC",
        text: "CV for navngitt sikkerhetsarkitekt skal vedlegges tilbudet.",
      }),
      requirement({
        id: "K-PRICE-SEC",
        text: "Timepris for sikkerhetsarkitekt skal oppgis.",
      }),
      requirement({
        id: "K-DECISION-SUB",
        text: "Oppgi hvorvidt underleverandørene videreføres eller erstattes.",
      }),
    ],
    evidenceDocuments: [
      {
        title: "Delvis leverandørbevis",
        file_name: "delvis.md",
        raw_text: [
          "CV. Kandidatnavn: Ada Lovelace. Rolle: prosjektleder. Kompetanse og arbeidserfaring: ti år.",
          "Timepris for prosjektleder: 1 750 NOK.",
          "SOC inngår i tilbudet.",
        ].join("\n\n"),
      },
    ],
  });
  assert.deepEqual(rowBoundEvidence.proposal_input_required_refs, [
    "K-CV-SEC",
    "K-PRICE-SEC",
    "K-DECISION-SUB",
  ]);
});

test("template provenance blocks only deterministic Uklart promotion, not AI Godt", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "Kravgrunnlag: Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet. | Svarrad: " +
      deterministicDimensioningTemplate,
    answerExcerpt: deterministicDimensioningTemplate,
    answerDocumentId: "solution",
    answerReference: "R-035",
  });
  const evaluation = {
    entry,
    rationale: "Svaret bør vurderes manuelt.",
    evidence: deterministicDimensioningTemplate,
    recommendation: "Kontroller kundetilpasningen.",
  };

  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      ...evaluation,
      assessment: "Uklart",
    }).assessment,
    "Uklart",
  );
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      ...evaluation,
      assessment: "Godt",
    }).assessment,
    "Godt",
  );
});

test("final template repair fails closed when another quality gate issue applies", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres uten vesentlig treghet og beskrive API, autentisering og datamodell.",
  });

  assert.ok(
    requirementAnswerQualityIssues(deterministicDimensioningTemplate, entry)
      .length > 0,
  );
  assert.equal(
    buildDeterministicFinalRequirementTemplateRepair({ entry }),
    null,
  );
});

test("normalization enrichment makes final template repair fail closed", () => {
  const entry = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres uten vesentlig treghet og ha dokumenterte RTO/RPO-mål.",
  });
  const normalized = normalizeRequirementAnswerResult(
    deterministicDimensioningTemplate,
    entry,
    entry.sourceExcerpt,
  );

  assert.equal(normalized.source, "deterministic_fallback");
  assert.equal(isDeterministicTemplateRepairAnswer(normalized.answer), false);
  assert.equal(
    buildDeterministicFinalRequirementTemplateRepair({ entry }),
    null,
  );
});

test("tested fixed capacity with reserve is a valid scaling alternative", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
  });
  const answer = deterministicDimensioningTemplate;

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "batch",
  );
});

test("untallied performance goals cannot remain an open clarification", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
  });
  const answer =
    "Atea dimensjonerer ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og logging per navngitt brukertransaksjon, med en kapasitetsmodell og ytelsesbaseline, verifisert med lasttest og ytelsestest, samt provisjonert kapasitet med kapasitetsmargin. Atea angir responstidsmål og akseptansekriterier for de samme transaksjonene; dersom kunden ikke har tallfestet målene, fastsettes disse som en avklaring før akseptansetest.";

  assert.ok(
    requirementAnswerQualityIssues(answer, entry).includes(
      "missing_supplier_proposed_numeric_performance_target",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("complete mechanisms still require a measurable supplier target", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
  });
  const answer =
    "Atea dimensjonerer ende-til-ende-sporbarhet fra innmelding til avslutning, inkludert revisjonsspor, statushistorikk og logging per navngitt brukertransaksjon, med en kapasitetsmodell og ytelsesbaseline basert på volum- og lastprofil, verifisert med lasttest og ytelsestest, samt provisjonert kapasitet med kapasitetsmargin. Ytelsesmål og akseptansekriterier for de samme transaksjonene foreslås og avklares med kunden fordi måltall ikke er tallfestet.";

  assert.ok(
    requirementAnswerQualityIssues(answer, entry).includes(
      "missing_supplier_proposed_numeric_performance_target",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("capacity mechanisms cannot be deferred as parameter clarification", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
  });
  const answer =
    "Atea foreslår ytelsesmål og akseptansekriterier uten bindende tall. Kapasitetsmodell avklares senere med kunden.";

  assert.ok(
    requirementAnswerQualityIssues(answer, entry).includes(
      "deferred_core_scope",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("numeric clarification cannot shield core capacity deferred in the same sentence", () => {
  const entry = requirement({
    text: "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.",
  });
  const answer =
    "Kapasitetsmodell, lasttest, provisjonert kapasitet med kapasitetsmargin og eksakte/tallfestede ytelsesmål og akseptansekriterier avklares med kunden fordi tall ikke er oppgitt.";
  const issues = requirementAnswerQualityIssues(answer, entry);

  assert.ok(issues.includes("deferred_core_scope"));
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("ordinary requirements are not inflated with a mandatory answer structure", () => {
  const entry = requirement({
    id: "R-025",
    text: "Det skal være mulig å følge status fra opprettelse til avslutning.",
  });
  const [row] = buildRequirementResponseBatchRegistry([entry]);

  assert.equal("obligatorisk_svarstruktur" in row, false);
  assert.equal(buildRequirementRepairDirective(entry, "low_value_answer"), "");
});

test("strict handoff keeps row evidence, style and directive without full contexts", () => {
  const strictRow = {
    nr: 33,
    ref: "R-033",
    kravtekst: "Leverandøren skal beskrive API, autentisering og datamodell.",
    radutdrag: "RADUTDRAG_SENTINEL",
    kildegrunnlag: "KILDE_SENTINEL",
    svargrunnlag: "EVIDENCE_SENTINEL",
    avvist_svar: "REJECTED_ANSWER_SENTINEL",
    avvist_arsak: "quality_gate: missing_concrete_api_pattern",
    obligatorisk_svarstruktur: "DIRECTIVE_SENTINEL",
  };
  const style = Array.from({ length: 4 }, (_, index) => ({
    nr: index + 1,
    ref: `K-${index + 1}`,
    svar: `STYLE_${index + 1}_SENTINEL`,
    svargrunnlag: `STYLE_EVIDENCE_${index + 1}`,
    source: "batch",
  }));
  const prompt = buildStrictRequirementHandoffUserPrompt({
    projectName: "Compact strict",
    acceptedAnswerContext: style,
    strictRow,
    baseContext: "FULL_BASE_CONTEXT_SENTINEL",
    documentContextForHandoff: "FULL_DOCUMENT_CONTEXT_SENTINEL",
  });

  assert.match(prompt, /RADUTDRAG_SENTINEL/);
  assert.match(prompt, /KILDE_SENTINEL/);
  assert.match(prompt, /EVIDENCE_SENTINEL/);
  assert.match(prompt, /REJECTED_ANSWER_SENTINEL/);
  assert.match(prompt, /DIRECTIVE_SENTINEL/);
  assert.doesNotMatch(prompt, /Ikke plasser teknisk kjerneomfang/i);
  assert.match(prompt, /STYLE_1_SENTINEL/);
  assert.match(prompt, /STYLE_3_SENTINEL/);
  assert.doesNotMatch(prompt, /STYLE_4_SENTINEL/);
  assert.doesNotMatch(prompt, /FULL_BASE_CONTEXT_SENTINEL/);
  assert.doesNotMatch(prompt, /FULL_DOCUMENT_CONTEXT_SENTINEL/);
});

test("rejected AI text stays transient for handoff and strict repair", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell.",
  });
  const rejected =
    "Atea vil senere beskrive API, autentisering og datamodell i løsningsforslaget.";
  const result = normalizeRequirementAnswerResult(rejected, entry, entry.text);

  assert.equal(result.source, "deterministic_fallback");
  assert.equal(result.rejectedAnswer, rejected);
  assert.notEqual(result.answer, rejected);
  assert.equal(requirementAnswerForRepair(result), rejected);

  const prompt = buildStrictRequirementHandoffUserPrompt({
    projectName: "Transient repair",
    acceptedAnswerContext: [],
    strictRow: {
      nr: 1,
      ref: "K-1",
      kravtekst: entry.text,
      avvist_svar: requirementAnswerForRepair(result),
      avvist_arsak: result.reason,
    },
  });
  assert.match(prompt, /Atea vil senere beskrive API/);
});

test("exact duplicate reuse repairs two acceptance rows before handoff without changing ledger order", () => {
  const acceptanceRequirement =
    "Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer.";
  const strongAnswer =
    "Atea verifiserer produksjonsløsningens godkjente konfigurasjon i et produksjonslikt testmiljø gjennom en akseptansetest som dekker brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, og hvert avvik retestes før samlet testoppsummering og godkjenning.";
  const ledger = [
    requirement({
      id: "Dokumenttekst krav 38",
      text: acceptanceRequirement,
      documentId: "requirements-pdf",
      heading: "Leveranse, test og opplæring",
      service: "Produksjonsløsning",
      sourceExcerpt: `Dokumenttekst krav 38 ${acceptanceRequirement} Må Gjelder produksjonsløsning`,
    }),
    requirement({
      id: "R-012",
      text: acceptanceRequirement,
      documentId: "requirements-pdf",
      heading: "  LEVERANSE,   TEST OG OPPLÆRING ",
      service: "produksjonsløsning",
      sourceExcerpt: `R-012 ${acceptanceRequirement} Må Gjelder produksjonsløsning`,
    }),
    requirement({
      id: "R-024",
      text: acceptanceRequirement,
      documentId: "requirements-pdf",
      heading: "Leveranse, test og opplæring",
      service: "Produksjonsløsning",
      sourceExcerpt: `R-024 ${acceptanceRequirement} Må Gjelder produksjonsløsning`,
    }),
  ];
  const originalLedger = structuredClone(ledger);
  const accepted = normalizeRequirementAnswerResult(
    strongAnswer,
    ledger[0],
    ledger[0].sourceExcerpt,
  );
  const answers = [
    accepted,
    normalizeRequirementAnswerResult("Ja.", ledger[1], ledger[1].sourceExcerpt),
    normalizeRequirementAnswerResult("Oppfylt.", ledger[2], ledger[2].sourceExcerpt),
  ];

  assert.equal(accepted.source, "batch");
  assert.equal(
    answers.filter((answer) => answer.source === "deterministic_fallback")
      .length,
    2,
  );

  const result = reuseExactDuplicateRequirementAnswers({ ledger, answers });

  assert.deepEqual(ledger, originalLedger);
  assert.deepEqual(
    result.answers.map((answer) => answer.source),
    ["batch", "exact_duplicate_reuse", "exact_duplicate_reuse"],
  );
  assert.equal(
    result.answers.filter(
      (answer) => answer.source === "deterministic_fallback",
    ).length,
    0,
    "the two repaired rows must no longer be handoff candidates",
  );
  assert.deepEqual(result.metadata, {
    exact_duplicate_reuse_answers: 2,
    exact_duplicate_reuse_refs: ["R-012", "R-024"],
  });
  assert.equal("manual_review_required" in result.metadata, false);
  assert.equal(
    result.answers[1].evidence,
    normalizeRequirementAnswerResult(
      strongAnswer,
      ledger[1],
      ledger[1].sourceExcerpt,
    ).evidence,
  );
  assert.equal(
    result.answers[2].evidence,
    normalizeRequirementAnswerResult(
      strongAnswer,
      ledger[2],
      ledger[2].sourceExcerpt,
    ).evidence,
  );
  assert.match(result.answers[1].evidence, /R-012/);
  assert.match(result.answers[2].evidence, /R-024/);
  assert.doesNotMatch(result.answers[1].evidence, /Uten nummer/);
  assert.doesNotMatch(result.answers[2].evidence, /Uten nummer/);
});

test("exact duplicate reuse rejects cross-document, cross-section, fuzzy and foreign-ID donors", () => {
  const acceptanceRequirement =
    "Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer.";
  const strongAnswer =
    "Atea gjennomfører akseptansetest som dekker brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, og hvert avvik retestes før samlet testoppsummering og godkjenning.";
  const donorEntry = requirement({
    id: "Uten nummer",
    text: acceptanceRequirement,
    documentId: "requirements-pdf",
    heading: "Leveranse, test og opplæring",
    service: "Produksjonsløsning",
  });
  const accepted = normalizeRequirementAnswerResult(
    strongAnswer,
    donorEntry,
    donorEntry.sourceExcerpt,
  );
  assert.equal(accepted.source, "batch");

  const rejectedTargets = [
    requirement({
      id: "R-001",
      text: acceptanceRequirement,
      documentId: "another-pdf",
      heading: donorEntry.heading,
      service: donorEntry.service,
    }),
    requirement({
      id: "R-002",
      text: acceptanceRequirement,
      documentId: donorEntry.documentId,
      heading: "Drift",
      service: donorEntry.service,
    }),
    requirement({
      id: "R-003",
      text: acceptanceRequirement,
      documentId: donorEntry.documentId,
      heading: donorEntry.heading,
      service: "Testmiljø",
    }),
    requirement({
      id: "R-004",
      text: acceptanceRequirement.replace("feilscenarier", "feilscenarioer"),
      documentId: donorEntry.documentId,
      heading: donorEntry.heading,
      service: donorEntry.service,
    }),
  ];

  for (const target of rejectedTargets) {
    const fallback = normalizeRequirementAnswerResult("Ja.", target);
    const result = reuseExactDuplicateRequirementAnswers({
      ledger: [donorEntry, target],
      answers: [accepted, fallback],
    });
    assert.equal(result.answers[1].source, "deterministic_fallback");
    assert.equal(result.metadata.exact_duplicate_reuse_answers, 0);
  }

  const exactTarget = requirement({
    id: "R-005",
    text: acceptanceRequirement,
    documentId: donorEntry.documentId,
    heading: donorEntry.heading,
    service: donorEntry.service,
  });
  const foreignIdDonor = {
    ...accepted,
    answer: `${strongAnswer} Gjennomføringen følger R-999.`,
  };
  const foreignIdResult = reuseExactDuplicateRequirementAnswers({
    ledger: [donorEntry, exactTarget],
    answers: [
      foreignIdDonor,
      normalizeRequirementAnswerResult("Ja.", exactTarget),
    ],
  });
  assert.equal(
    foreignIdResult.answers[1].source,
    "deterministic_fallback",
  );
  assert.equal(foreignIdResult.metadata.exact_duplicate_reuse_answers, 0);
});

test("exact duplicate reuse re-runs target quality gates and rejects fallback or template donors", () => {
  const dimensioningRequirement =
    "Løsningen skal dimensjoneres for sporbarhet uten at brukerne opplever vesentlig treghet.";
  const donorEntry = requirement({
    id: "Uten nummer",
    text: dimensioningRequirement,
    documentId: "requirements-pdf",
    heading: "Ytelse",
    service: "Produksjonsløsning",
    sourceExcerpt: dimensioningRequirement,
  });
  const targetEntry = requirement({
    id: "R-035",
    text: dimensioningRequirement,
    documentId: donorEntry.documentId,
    heading: donorEntry.heading,
    service: donorEntry.service,
    sourceExcerpt: `${dimensioningRequirement} SLA-målet er p95 under 1 sekund ved 500 samtidige brukere.`,
  });
  const answerWithoutTargetValues = deterministicDimensioningTemplate;
  const donor = normalizeRequirementAnswerResult(
    answerWithoutTargetValues,
    donorEntry,
    donorEntry.sourceExcerpt,
  );
  const targetFallback = normalizeRequirementAnswerResult("Ja.", targetEntry);

  assert.equal(donor.source, "batch");
  assert.equal(
    normalizeRequirementAnswerResult(
      answerWithoutTargetValues,
      targetEntry,
      targetEntry.sourceExcerpt,
    ).source,
    "deterministic_fallback",
  );
  const qualityMismatchResult = reuseExactDuplicateRequirementAnswers({
    ledger: [donorEntry, targetEntry],
    answers: [donor, targetFallback],
  });
  assert.equal(
    qualityMismatchResult.answers[1].source,
    "deterministic_fallback",
  );
  assert.equal(
    qualityMismatchResult.metadata.exact_duplicate_reuse_answers,
    0,
  );

  for (const source of [
    "deterministic_fallback",
    "deterministic_template_repair",
  ]) {
    const forbiddenDonor = { ...donor, source };
    const result = reuseExactDuplicateRequirementAnswers({
      ledger: [donorEntry, donorEntry],
      answers: [forbiddenDonor, targetFallback],
    });
    assert.equal(result.answers[1].source, "deterministic_fallback");
    assert.equal(result.metadata.exact_duplicate_reuse_answers, 0);
  }
});

test("failed answer samples are hidden by default and opt-in for diagnostics", () => {
  const rows = [
    {
      nr: 1,
      ref: "K-1",
      reason: "quality_gate: missing_concrete_api_pattern",
      rejected_answer_sample: "SENSITIVE_REJECTED_ANSWER_SENTINEL",
    },
  ];
  const previous = process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS;
  delete process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS;
  try {
    const defaultSummary = formatUnresolvedRequirementResponseSummary(rows);
    assert.match(defaultSummary, /K-1/);
    assert.doesNotMatch(defaultSummary, /SENSITIVE_REJECTED_ANSWER_SENTINEL/);
    assert.match(
      formatUnresolvedRequirementResponseSummary(rows, true),
      /SENSITIVE_REJECTED_ANSWER_SENTINEL/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS;
    } else {
      process.env.REQUIREMENT_RESPONSE_DIAGNOSTIC_FAILED_ANSWERS = previous;
    }
  }
});

test("successful ledger metadata always serializes unresolved fallbacks as an array", () => {
  assert.deepEqual(serializeUnresolvedRequirementFallbackAnswers([]), {
    unresolved_fallback_answers: [],
  });
  assert.deepEqual(
    serializeUnresolvedRequirementFallbackAnswers([
      { nr: 2, ref: "K-2", reason: "quality_gate" },
    ]),
    {
      unresolved_fallback_answers: [
        { nr: 2, ref: "K-2", reason: "quality_gate" },
      ],
    },
  );
});

test("requirement response batch rejects a missing middle row without positional cross-linking", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const registry = buildRequirementResponseBatchRegistry(entries);
  const rows = [
    { nr: 1, ref: registry[0].ref, svar: "Svar for krav 1." },
    { nr: 3, ref: registry[2].ref, svar: "Svar for krav 3." },
  ];

  assert.throws(
    () => validateRequirementResponseBatchRows({ rows, entries }),
    /forventet 3 rader, mottok 2.*mangler nr=2/i,
  );
  const second = answerFromBatchRows({
    rows,
    entry: entries[1],
    absoluteIndex: 1,
  });
  assert.equal(second.source, "deterministic_fallback");
  assert.match(second.reason, /nr=2.*fant 0/i);
  assert.notEqual(second.answer, "Svar for krav 3.");
});

test("requirement response batch rejects duplicate row numbers", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const registry = buildRequirementResponseBatchRegistry(entries);
  const rows = [
    { nr: 1, ref: registry[0].ref, svar: "Første svar." },
    { nr: 1, ref: registry[1].ref, svar: "Duplisert svar." },
    { nr: 3, ref: registry[2].ref, svar: "Tredje svar." },
  ];

  assert.throws(
    () => validateRequirementResponseBatchRows({ rows, entries }),
    /dupliserte nr=1.*mangler nr=2/i,
  );
});

test("requirement response batch accepts reordering and maps by exact number", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const registry = buildRequirementResponseBatchRegistry(entries);
  const rows = [
    { nr: 3, ref: registry[2].ref, svar: "Svar tre." },
    { nr: 1, ref: registry[0].ref, svar: "Svar én." },
    { nr: 2, ref: registry[1].ref, svar: "Svar to." },
  ];

  const mapped = validateRequirementResponseBatchRows({ rows, entries });
  assert.deepEqual(
    mapped.map((row) => row.svar),
    ["Svar én.", "Svar to.", "Svar tre."],
  );
});

test("requirement response batch rejects a reference from another row", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const registry = buildRequirementResponseBatchRegistry(entries);
  const rows = [
    { nr: 1, ref: registry[0].ref, svar: "Svar én." },
    { nr: 2, ref: registry[2].ref, svar: "Feilkoblet svar." },
    { nr: 3, ref: registry[2].ref, svar: "Svar tre." },
  ];

  assert.throws(
    () => validateRequirementResponseBatchRows({ rows, entries }),
    /nr=2 har ref=.*forventet/i,
  );
  const second = answerFromBatchRows({
    rows,
    entry: entries[1],
    absoluteIndex: 1,
  });
  assert.equal(second.source, "deterministic_fallback");
  assert.match(second.reason, /nr=2 har feil ref/i);
});

test("requirement response batch requires an explicit reference on every row", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const registry = buildRequirementResponseBatchRegistry(entries);
  const rows = [
    { nr: 1, ref: registry[0].ref, svar: "Svar én." },
    { nr: 2, svar: "Svar uten identitet." },
    { nr: 3, ref: registry[2].ref, svar: "Svar tre." },
  ];

  assert.throws(
    () => validateRequirementResponseBatchRows({ rows, entries }),
    /nr=2 mangler ref/i,
  );
  const second = answerFromBatchRows({
    rows,
    entry: entries[1],
    absoluteIndex: 1,
  });
  assert.equal(second.source, "deterministic_fallback");
  assert.match(second.reason, /nr=2 mangler ref/i);
  assert.notEqual(second.answer, "Svar uten identitet.");
});

test("coverage batch maps reordered rows by exact nr and ref", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );
  const rows = [
    { nr: 3, ref: "K-3", assessment: "Godt" },
    { nr: 1, ref: "K-1", assessment: "Dårlig" },
    { nr: 2, ref: "K-2", assessment: "Uklart" },
  ];

  const mapped = validateRequirementCoverageBatchRows({
    rows,
    entries,
    startIndex: 0,
  });
  assert.deepEqual(
    mapped.map((row) => row.nr),
    [1, 2, 3],
  );
});

test("coverage batch rejects missing, swapped, duplicate, and extra identities", () => {
  const entries = [1, 2, 3].map((nr) =>
    requirement({
      id: `K-${nr}`,
      text: `Leverandøren skal levere kontroll ${nr} med dokumentert ansvar.`,
    }),
  );

  assert.throws(
    () =>
      validateRequirementCoverageBatchRows({
        rows: [
          { nr: 1, ref: "K-1", assessment: "Godt" },
          { nr: 2, ref: "K-3", assessment: "Godt" },
          { nr: 3, ref: "K-2", assessment: "Godt" },
        ],
        entries,
        startIndex: 0,
      }),
    /nr=2 har ref=.*forventet.*nr=3 har ref=/i,
  );
  assert.throws(
    () =>
      validateRequirementCoverageBatchRows({
        rows: [
          { nr: 1, assessment: "Godt" },
          { nr: 2, ref: "K-2", assessment: "Godt" },
          { nr: 3, ref: "K-3", assessment: "Godt" },
        ],
        entries,
        startIndex: 0,
      }),
    /nr=1 mangler ref/i,
  );
  assert.throws(
    () =>
      validateRequirementCoverageBatchRows({
        rows: [
          { nr: 1, ref: "K-1", assessment: "Godt" },
          { nr: 1, ref: "K-1", assessment: "Dårlig" },
          { nr: 3, ref: "K-3", assessment: "Godt" },
          { nr: 4, ref: "K-4", assessment: "Godt" },
        ],
        entries,
        startIndex: 0,
      }),
    /forventet 3 rader, mottok 4.*uventet nr=4.*dupliserte nr=1.*mangler nr=2/i,
  );
});

test("document findings relink four unique evidence excerpts to their exact coverage rows", () => {
  const coverage = evidenceRelinkingCoverageFixture();
  const findings = [
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      assessment: "Godt",
      finding: "Integrasjonen er robust.",
      evidence:
        '"Atea integrerer kalender og identitet gjennom et kontrollert integrasjonslag der hver hendelse behandles med idempotensnøkkel eller duplikatkontroll og lagres i varig kø med outbox/inbox"',
      recommendation: "Behold kontrollene.",
    },
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      assessment: "Godt",
      finding: "Revisjonssporet er konkret.",
      evidence:
        "Atea logger endringer i oppdrag, frivillige, samtykker og meldinger med tjenesteidentitet, tidspunkt, gammel verdi og ny verdi.",
      recommendation: "Angi oppbevaringstid.",
    },
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      assessment: "Godt",
      finding: "Overvåkingen er driftsnær.",
      evidence:
        '"Overvåking av tilgjengelighet, integrasjonsstatus, køer, feilrater og sentrale brukertransaksjoner"',
      recommendation: "Angi terskler.",
    },
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      assessment: "Godt",
      finding: "Eksporten er dekket.",
      evidence:
        '"Atea leverer uttrekk av oppdrag, frivillige, samtykker og meldinger i et strukturert format fra produksjonsløsningen ved revisjon eller leverandørbytte."',
      recommendation: "Angi format.",
    },
  ];

  const normalized = normalizeDocumentFindingsAgainstCoverage(
    findings,
    coverage,
  );
  const expectedReferences = ["R-003", "R-010", "R-005", "R-002"];

  assert.deepEqual(
    normalized.map((finding) => finding.matched_requirement_reference),
    expectedReferences,
  );
  assert.deepEqual(
    normalized.map((finding) => finding.reference),
    expectedReferences.map(
      (reference) =>
        coverage.items.find((item) => item.reference === reference)
          .full_reference,
    ),
  );
  assert.ok(
    normalized.every((finding) => finding.reference_match === "coverage"),
  );
  assert.deepEqual(
    normalized.map((finding) => finding.evidence),
    expectedReferences.map(
      (reference) =>
        coverage.items.find((item) => item.reference === reference).evidence,
    ),
  );
  assert.ok(
    normalized.every(
      (finding) => finding.evidence_grounding === "coverage_exact",
    ),
  );
});

test("ellipsis finding relinks to R-005 but stores the exact coverage evidence", () => {
  const coverage = evidenceRelinkingCoverageFixture();
  const expected = coverage.items.find((item) => item.reference === "R-005");
  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "R-001",
        reference_match: "coverage",
        matched_requirement_reference: "R-001",
        assessment: "Godt",
        finding: "Overvåkingen er driftsnær.",
        evidence:
          '"Overvåking av tilgjengelighet, integrasjonsstatus ... varsles til ansvarlige driftsroller."',
        recommendation: "Behold driftskontrollene.",
      },
    ],
    coverage,
  );

  assert.equal(normalized.reference_match, "coverage");
  assert.equal(normalized.matched_requirement_reference, "R-005");
  assert.equal(normalized.reference, expected.full_reference);
  assert.equal(normalized.evidence, expected.evidence);
  assert.equal(normalized.evidence_grounding, "coverage_exact");
});

test("duplicate short references never pick the first row for ambiguous finding evidence", () => {
  const base = coverageFixture(2);
  const coverage = {
    ...base,
    items: base.items.map((item, index) => ({
      ...item,
      reference: "R-005",
      full_reference: `Kravdokument ${index + 1} > Drift > R-005`,
      source_reference: `Kravdokument ${index + 1}, R-005`,
      evidence: `Overvåking av tilgjengelighet og integrasjonsstatus varsles til ansvarlige driftsroller med kontrollspor for miljø ${index + 1}.`,
    })),
  };

  for (const evidence of [
    '"Overvåking av tilgjengelighet og integrasjonsstatus ... varsles til ansvarlige driftsroller."',
    "",
  ]) {
    const [normalized] = normalizeDocumentFindingsAgainstCoverage(
      [
        {
          reference: "R-005",
          reference_match: "coverage",
          matched_requirement_reference: "R-005",
          assessment: "Uklart",
          finding: "Overvåkingen må knyttes til riktig dokument.",
          evidence,
          recommendation: "Avklar dokumentreferansen.",
        },
      ],
      coverage,
    );

    assert.equal(normalized.reference_match, "section");
    assert.equal(normalized.matched_requirement_reference, null);
    assert.match(normalized.reference, /^Seksjonsfunn:/);
  }
});

test("generic evidence cannot keep an unrelated direct coverage reference", () => {
  const coverage = evidenceRelinkingCoverageFixture();
  const genericEvidence =
    "## Kravbesvarelse ### Funksjonelle krav | Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |";
  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "Kravdokument > Kontrollområde > R-001",
        reference_match: "coverage",
        matched_requirement_reference: "R-001",
        assessment: "Uklart",
        finding:
          "Kravtabellen viser dekning, men ikke en samlet målarkitektur.",
        evidence: genericEvidence,
        recommendation: "Legg til en arkitektur- og leveranseseksjon.",
      },
    ],
    coverage,
  );

  assert.equal(normalized.reference_match, "section");
  assert.equal(normalized.matched_requirement_reference, null);
  assert.match(normalized.reference, /^Seksjonsfunn:/);
  assert.equal(normalized.evidence, "");
  assert.equal(normalized.evidence_grounding, undefined);
});

test("coverage-grounded findings inherit the canonical assessment and rationale", () => {
  const base = coverageFixture(1);
  const canonical = {
    ...base.items[0],
    assessment: "Dårlig",
    rationale:
      "Svaret mangler en konkret datamodell og kan derfor ikke vurderes som komplett.",
    recommendation:
      "Navngi dataobjekter, nøkkelfelt, mapping og validering.",
  };
  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: canonical.full_reference,
        reference_match: "coverage",
        matched_requirement_reference: canonical.reference,
        assessment: "Godt",
        finding: "Løsningen er komplett og fullt testbar.",
        evidence: canonical.evidence,
        recommendation: "Ingen tiltak er nødvendig.",
      },
    ],
    { ...base, items: [canonical] },
  );

  assert.equal(normalized.reference_match, "coverage");
  assert.equal(normalized.evidence_grounding, "coverage_exact");
  assert.equal(normalized.assessment, canonical.assessment);
  assert.equal(normalized.finding, canonical.rationale);
  assert.equal(normalized.recommendation, canonical.recommendation);
  assert.doesNotMatch(normalized.finding, /komplett og fullt testbar/i);
  assert.doesNotMatch(normalized.recommendation, /Ingen tiltak/i);
});

test("identifier continuations never bind to the shorter coverage row R-022", () => {
  const base = coverageFixture(1);
  const coverage = {
    ...base,
    items: [
      {
        ...base.items[0],
        reference: "R-022",
        full_reference: "Kravdokument > Audit > R-022",
        source_reference: "Kravdokument, R-022",
        evidence:
          "Atea logger hver endring med bruker, tidspunkt, gammel verdi og ny verdi.",
      },
    ],
  };
  for (const reference of ["R-0220", "R-022-A", "R-022.1", "R-022/1"]) {
    const [normalized] = normalizeDocumentFindingsAgainstCoverage(
      [
        {
          reference,
          reference_match: "coverage",
          matched_requirement_reference: "R-022",
          assessment: "Uklart",
          finding: "Denne raden må ikke kobles ved prefiks.",
          evidence: "",
          recommendation: "Behold funnet som et seksjonsfunn uten kravbevis.",
        },
      ],
      coverage,
    );

    assert.equal(normalized.reference_match, "section", reference);
    assert.equal(normalized.matched_requirement_reference, null, reference);
    assert.ok(normalized.reference.includes(reference), reference);
    assert.equal(normalized.evidence, "", reference);
    assert.equal(normalized.evidence_grounding, undefined, reference);
  }

  const [exact] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "Kontrollområde > R-022",
        assessment: "Godt",
        finding: "Den eksakte krav-ID-en kan fortsatt kobles.",
        evidence: "",
        recommendation: "Behold eksakt ID-sporbarhet.",
      },
    ],
    coverage,
  );
  assert.equal(exact.reference_match, "coverage");
  assert.equal(exact.matched_requirement_reference, "R-022");
  assert.equal(exact.evidence_grounding, "coverage_exact");
});

test("a direct coverage reference may use item evidence only when candidate evidence is missing", () => {
  const coverage = evidenceRelinkingCoverageFixture();
  const expected = coverage.items.find((item) => item.reference === "R-003");
  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: expected.full_reference,
        reference_match: "coverage",
        matched_requirement_reference: "R-003",
        assessment: "Godt",
        finding: "Integrasjonen er robust.",
        evidence: "",
        recommendation: "Behold kontrollene.",
      },
    ],
    coverage,
  );

  assert.equal(normalized.reference_match, "coverage");
  assert.equal(normalized.matched_requirement_reference, "R-003");
  assert.equal(normalized.reference, expected.full_reference);
  assert.equal(normalized.evidence, expected.evidence);
  assert.equal(normalized.evidence_grounding, "coverage_exact");
});

test("duplicate evidence is ambiguous and does not pick the first coverage row", () => {
  const duplicateEvidence =
    "Atea leverer samme eksakte kontrolltekst med navngitt ansvar, sporbar logging, testbevis og månedlig rapportering.";
  const base = coverageFixture(2);
  const coverage = {
    ...base,
    items: base.items.map((item, index) => ({
      ...item,
      reference: `R-02${index}`,
      full_reference: `Kravdokument > R-02${index}`,
      source_reference: `Kravdokument, R-02${index}`,
      evidence: duplicateEvidence,
    })),
  };

  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "Overordnet kontrolltekst",
        assessment: "Godt",
        finding: "Kontrollen er omtalt flere steder.",
        evidence: duplicateEvidence,
        recommendation: "Avklar riktig kravrad.",
      },
    ],
    coverage,
  );

  assert.equal(normalized.reference_match, "section");
  assert.equal(normalized.matched_requirement_reference, null);
  assert.match(normalized.reference, /^Seksjonsfunn:/);
});

test("explicit section findings stay sections even when evidence matches coverage", () => {
  const coverage = evidenceRelinkingCoverageFixture();
  const evidence = coverage.items.find((item) => item.reference === "R-003").evidence;
  const [normalized] = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "Seksjonsfunn: Løsningsdokument – status",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Dårlig",
        finding: "Statusseksjonen mangler tilbudsledelse.",
        evidence,
        recommendation: "Skriv en kundetilpasset åpning.",
      },
    ],
    coverage,
  );

  assert.equal(normalized.reference, "Seksjonsfunn: Løsningsdokument – status");
  assert.equal(normalized.reference_match, "section");
  assert.equal(normalized.matched_requirement_reference, null);
});

test("section findings require an exact raw document excerpt for trusted grounding", () => {
  const coverage = coverageFixture(1);
  const documentText = [
    "## Tilgangsstyring",
    "Atea etablerer rollebasert tilgang med minste privilegium, logging og dokumentert godkjenning for administratorer.",
    "Kontrollen verifiseres før produksjonssetting.",
  ].join("\n");
  const exactEvidence =
    "rollebasert tilgang med minste privilegium, logging og dokumentert godkjenning";
  const fuzzyEvidence =
    "Atea etablerer rollebasert tilgang med minste privilegium og logging for administratorer.";
  const normalized = normalizeDocumentFindingsAgainstCoverage(
    [
      {
        reference: "Seksjonsfunn: Tilgangsstyring",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Godt",
        finding:
          "Tilgangsstyringen beskriver både minste privilegium og en sporbar godkjenningskontroll.",
        evidence: exactEvidence,
        recommendation:
          "Behold den eksplisitte koblingen mellom rolle, logging og godkjenning.",
      },
      {
        reference: "Seksjonsfunn: Parafrase",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Godt",
        finding: "Parafrasen overlapper teksten, men er ikke et eksakt utdrag.",
        evidence: fuzzyEvidence,
        recommendation: "Bruk et ordrett dokumentutdrag.",
      },
      {
        reference: "Seksjonsfunn: Fabrikkert",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Godt",
        finding: "Det fabrikerte utsagnet finnes ikke i dokumentet.",
        evidence: "Atea garanterer null avvik og full autonom kontroll.",
        recommendation: "Fjern påstanden eller finn ordrett bevis.",
      },
      {
        reference: "Seksjonsfunn: Blank",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Godt",
        finding: "Et funn uten bevis kan ikke regnes som sterkt grunnet.",
        evidence: "",
        recommendation: "Legg til et eksakt dokumentutdrag.",
      },
    ],
    coverage,
    { evidenceDocumentText: documentText },
  );

  assert.equal(normalized[0].evidence, exactEvidence);
  assert.equal(normalized[0].evidence_grounding, "document_exact");
  assert.match(normalized[0].finding, /minste privilegium/i);
  assert.match(normalized[0].recommendation, /rolle, logging og godkjenning/i);
  for (const finding of normalized.slice(1)) {
    assert.equal(finding.evidence, "");
    assert.equal(finding.evidence_grounding, undefined);
    assert.equal(finding.reference_match, "section");
  }
});

test("solution evaluation prompt requires answer-bearing finding evidence", () => {
  const prompt = buildSolutionEvaluationPrompt();
  assert.match(prompt, /Krav-kolonnen alene er ikke bevis for løsningen/iu);
  assert.doesNotMatch(prompt, /helst ordrett fra relevant kravrad/iu);
});

test("stored evaluation drops ungrounded section findings while keeping exact coverage evidence", () => {
  const coverage = coverageFixture(2);
  const exact = coverage.items[1];
  const normalized = normalizeSolutionEvaluationResult({
    fit_to_customer_needs: "Kravene er vurdert mot svargrunnlaget.",
    strengths: [],
    weaknesses: [],
    generic_sections: [],
    missing_elements: [],
    risks_to_customer: [],
    trust_signals: [],
    likely_score_assessment: {
      quality: "Høy",
      delivery_confidence: "Høy",
      risk: "Lav",
      competitiveness: "Høy",
    },
    improvement_recommendations: [],
    value_assessment: [],
    rewrite_suggestions: [],
    document_findings: [
      {
        reference: "Seksjonsfunn: Status",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Dårlig",
        finding: "Statusseksjonen er for generell.",
        evidence: "Dette parafraserte utsagnet finnes ikke i dokumentet.",
        recommendation: "Bruk et ordrett utdrag.",
      },
      {
        reference: "Seksjonsfunn: ## Kravbesvarelse",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Uklart",
        finding:
          "Overskriften alene dokumenterer ikke den påståtte svakheten i gjennomføringen.",
        evidence: "## Kravbesvarelse",
        recommendation:
          "Bruk et substansielt ordrett utdrag fra løsningsinnholdet.",
      },
      {
        reference: "Seksjonsfunn: Kontrollmodell",
        reference_match: "section",
        matched_requirement_reference: null,
        assessment: "Godt",
        finding: "",
        evidence:
          "Atea leverer et substansielt løsningsinnhold med sporbare kontroller.",
        recommendation: "",
      },
      {
        reference: exact.full_reference,
        reference_match: "coverage",
        matched_requirement_reference: exact.reference,
        assessment: "Godt",
        finding: "Kontrollen er konkret og testbar.",
        evidence: "",
        recommendation: "Behold kontrollsporet.",
      },
    ],
    requirement_coverage: coverage,
    architecture_comparison: {
      winner: "Uavgjort",
      architect_solution_score: 80,
      system_solution_score: 80,
      verdict: "Løsningen er balansert.",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    },
    executive_summary: "Kravene er sporbare.",
  }, {
    evidenceDocumentText:
      "## Kravbesvarelse\nAtea leverer et substansielt løsningsinnhold med sporbare kontroller.",
  });

  assert.equal(normalized.document_findings.length, 1);
  assert.equal(
    normalized.document_findings[0].matched_requirement_reference,
    exact.reference,
  );
  assert.equal(normalized.document_findings[0].evidence, exact.evidence);
  assert.equal(
    normalized.document_findings[0].evidence_grounding,
    "coverage_exact",
  );

  const validSectionEvidence =
    "Atea beskriver en styrt innføring med beslutningspunkter, test og dokumentert overgang til drift.";
  const validSection = normalizeSolutionEvaluationResult(
    {
      ...normalized,
      document_findings: [
        {
          reference: "Seksjonsfunn: Styrt innføring",
          reference_match: "section",
          matched_requirement_reference: null,
          assessment: "Godt",
          finding:
            "Gjennomføringen er konkret koblet til styring, test og overgang til drift.",
          evidence: validSectionEvidence,
          recommendation:
            "Behold den tydelige koblingen mellom beslutningspunkter og driftssetting.",
        },
      ],
      requirement_coverage: coverage,
    },
    { evidenceDocumentText: validSectionEvidence },
  );
  assert.equal(validSection.document_findings.length, 1);
  assert.equal(validSection.document_findings[0].reference_match, "section");
  assert.equal(
    validSection.document_findings[0].evidence_grounding,
    "document_exact",
  );

  const requirementColumnText =
    "Leverandøren skal dokumentere tilgangsstyring for alle brukere.";
  const answerColumnText =
    "Atea leverer rollebasert tilgang med dokumentert godkjenning.";
  const answerBearingText = solutionDocumentAnswerBearingText(
    [
      "## Status",
      "Løsningen er strukturert i sporbare svarrader.",
      "| Kravref | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      `| K-001 | ${requirementColumnText} | ${answerColumnText} | Tilgang logges og verifiseres før produksjon. | Kravspesifikasjon |`,
      "| | Tom referanse | EMPTY_REFERENCE_ANSWER | Skal hoppes over uten å stoppe tabellen. | Kravspesifikasjon |",
      "| K-002 | Et annet krav | SECOND_VALID_ANSWER | Kontrollert svargrunnlag. | Kravspesifikasjon |",
      "",
      "| Kravref | Krav | Svargrunnlag |",
      "|---|---|---|",
      "| K-003 | Et tredje krav | NO_ANSWER_COLUMN_SENTINEL |",
    ].join("\n"),
  );
  assert.match(answerBearingText, new RegExp(answerColumnText, "u"));
  assert.match(answerBearingText, /SECOND_VALID_ANSWER/u);
  assert.doesNotMatch(answerBearingText, new RegExp(requirementColumnText, "u"));
  assert.doesNotMatch(answerBearingText, /EMPTY_REFERENCE_ANSWER/u);
  assert.doesNotMatch(answerBearingText, /NO_ANSWER_COLUMN_SENTINEL/u);

  const requirementColumnFinding = normalizeSolutionEvaluationResult(
    {
      ...normalized,
      document_findings: [
        {
          reference: "Seksjonsfunn: Kravtabell",
          reference_match: "section",
          matched_requirement_reference: null,
          assessment: "Godt",
          finding:
            "Kravsitatet påstås feilaktig å dokumentere leverandørens løsning.",
          evidence: requirementColumnText,
          recommendation:
            "Bruk et ordrett utdrag fra Svar eller Svargrunnlag i stedet.",
        },
      ],
      requirement_coverage: coverage,
    },
    { evidenceDocumentText: answerBearingText },
  );
  assert.equal(requirementColumnFinding.document_findings.length, 1);
  assert.equal(
    requirementColumnFinding.document_findings[0].reference_match,
    "coverage",
  );
  assert.equal(
    requirementColumnFinding.document_findings[0]
      .matched_requirement_reference,
    coverage.items[0].reference,
  );
});

test("stored evaluation supplements only from an exact answered coverage row", () => {
  const coverage = coverageFixture(2);
  const normalized = normalizeSolutionEvaluationResult({
    fit_to_customer_needs: "Kravene er vurdert mot svargrunnlaget.",
    strengths: [],
    weaknesses: [],
    generic_sections: [],
    missing_elements: [],
    risks_to_customer: [],
    trust_signals: [],
    likely_score_assessment: {
      quality: "Høy",
      delivery_confidence: "Høy",
      risk: "Lav",
      competitiveness: "Høy",
    },
    improvement_recommendations: [],
    value_assessment: [],
    rewrite_suggestions: [],
    document_findings: [
      {
        reference: "K-999",
        assessment: "Uklart",
        finding: "En tvetydig modellpåstand skal ikke lagres som bevis.",
        evidence: "Et parafrasert og ubundet bevis.",
        recommendation: "Bruk eksakt bevis.",
      },
    ],
    requirement_coverage: coverage,
    architecture_comparison: {
      winner: "Uavgjort",
      architect_solution_score: 80,
      system_solution_score: 80,
      verdict: "Løsningen er balansert.",
      strong_critique: [],
      pragmatic_reflections: [],
      strategy_improvement_advice: [],
    },
    executive_summary: "Kravene er sporbare.",
  });

  assert.equal(normalized.document_findings.length, 1);
  assert.equal(
    normalized.document_findings[0].matched_requirement_reference,
    coverage.items[0].reference,
  );
  assert.equal(
    normalized.document_findings[0].finding,
    coverage.items[0].rationale,
  );
  assert.equal(
    normalized.document_findings[0].evidence,
    coverage.items[0].evidence,
  );
  assert.equal(
    normalized.document_findings[0].evidence_grounding,
    "coverage_exact",
  );

  const unansweredCoverage = {
    ...coverage,
    items: coverage.items.map((item) => ({
      ...item,
      answer_document_id: null,
      answer_document_title: null,
    })),
  };
  const withoutAnswer = normalizeSolutionEvaluationResult({
    ...normalized,
    document_findings: [],
    requirement_coverage: unansweredCoverage,
  });
  assert.deepEqual(withoutAnswer.document_findings, []);

  const titleOnlyCoverage = {
    ...coverage,
    items: coverage.items.map((item) => ({
      ...item,
      answer_document_id: null,
      answer_document_title: "Leverandørens svar",
    })),
  };
  const withTitleOnly = normalizeSolutionEvaluationResult({
    ...normalized,
    document_findings: [],
    requirement_coverage: titleOnlyCoverage,
  });
  assert.deepEqual(withTitleOnly.document_findings, []);

  const decorativeCoverage = {
    ...coverage,
    items: coverage.items.map((item) => ({
      ...item,
      evidence: "## Kravbesvarelse",
    })),
  };
  const withDecorativeEvidence = normalizeSolutionEvaluationResult({
    ...normalized,
    document_findings: [],
    requirement_coverage: decorativeCoverage,
  });
  assert.deepEqual(withDecorativeEvidence.document_findings, []);
});

test("holistic compact registry keeps 100% document-scoped identities and locators", () => {
  const coverage = coverageFixture();
  const registry = buildRequirementCoverageRegistry(coverage);

  assert.equal(registry.length, 44);
  assert.equal(new Set(registry.map((row) => row.reference)).size, 44);
  registry.forEach((row, index) => {
    const item = coverage.items[index];
    assert.equal(row.nr, index + 1);
    assert.equal(row.source_reference, item.source_reference);
    assert.equal(row.source_document_id, item.source_document_id);
    assert.equal(row.page_range, item.page_range);
    assert.equal(row.table_id, item.table_id);
    assert.equal(row.requirement_subtitle, item.requirement_subtitle);
    assert.equal(row.assessment, item.assessment);
    assert.equal(row.requirement, item.requirement);
    assert.ok(row.requirement.length <= 180);
    assert.deepEqual(Object.keys(row), [
      "nr",
      "reference",
      "source_document_id",
      "source_reference",
      "assessment",
      "page_range",
      "table_id",
      "requirement_subtitle",
      "requirement",
    ]);
  });
});

test("44 and 500 row holistic contexts preserve identities and non-Godt details", (t) => {
  for (const count of [44, 500]) {
    const coverage = distributedCoverageFixture(count);
    const payload = buildRequirementCoverageEvaluationPayload(coverage);
    const context = buildRequirementCoverageEvaluationContext(coverage);
    const legacyChars = JSON.stringify(
      legacyExpandedCoveragePayload(coverage),
    ).length;
    const payloadChars = JSON.stringify(payload).length;
    const expectedNonGood = coverage.items.filter(
      (item) => item.assessment !== "Godt",
    );

    assert.equal(payload.coverage_registry.length, count);
    payload.coverage_registry.forEach((row, index) => {
      const item = coverage.items[index];
      assert.equal(row.nr, index + 1);
      assert.equal(row.reference, item.reference);
      assert.equal(row.source_document_id, item.source_document_id);
      assert.equal(row.assessment, item.assessment);
      assert.equal(row.page_range, item.page_range);
      assert.equal(row.table_id, item.table_id);
      assert.equal(row.requirement_subtitle, item.requirement_subtitle);
      assert.ok(row.source_reference.length <= 160);
      assert.ok(row.requirement.length <= 180);
    });

    assert.equal(
      payload.non_good_detail_selection.total_non_good_requirements,
      expectedNonGood.length,
    );
    assert.equal(
      payload.non_good_detail_selection.detailed_non_good_requirements,
      payload.prioritized_non_good_requirements.length,
    );
    assert.equal(
      payload.non_good_detail_selection.omitted_non_good_requirements,
      expectedNonGood.length -
        payload.prioritized_non_good_requirements.length,
    );
    assert.ok(
      payload.prioritized_non_good_requirements.length <=
        payload.non_good_detail_selection.detail_row_budget,
    );
    assert.equal(
      payload.non_good_detail_selection.detail_characters,
      JSON.stringify(payload.prioritized_non_good_requirements).length,
    );
    assert.ok(
      payload.non_good_detail_selection.detail_characters <=
        payload.non_good_detail_selection.detail_character_budget,
    );
    payload.prioritized_non_good_requirements.forEach((row) => {
      const item = expectedNonGood.find(
        (candidate) =>
          candidate.order_index + 1 === row.nr &&
          candidate.source_document_id === row.source_document_id,
      );
      assert.ok(item);
      assert.equal(row.nr, item.order_index + 1);
      assert.equal(row.reference, item.reference);
      assert.equal(row.source_document_id, item.source_document_id);
      assert.equal(row.requirement, item.requirement);
      assert.equal(row.evidence, item.evidence);
      assert.equal(row.rationale, item.rationale);
      assert.equal(row.recommendation, item.recommendation);
    });

    assert.ok(payload.good_examples.length >= 3);
    assert.ok(payload.good_examples.length <= 5);
    assert.ok(
      new Set(payload.good_examples.map((row) => row.source_document_id)).size >= 3,
    );
    payload.good_examples.forEach((row) => {
      const item = coverage.items.find(
        (candidate) =>
          candidate.order_index + 1 === row.nr &&
          candidate.source_document_id === row.source_document_id,
      );
      assert.ok(item);
      assert.equal(row.requirement, item.requirement);
      assert.equal(row.evidence, item.evidence);
      assert.equal(row.rationale, item.rationale);
    });

    t.diagnostic(
      JSON.stringify({
        fixture_requirements: count,
        non_good: expectedNonGood.length,
        detailed_non_good:
          payload.prioritized_non_good_requirements.length,
        detail_chars: payload.non_good_detail_selection.detail_characters,
        legacy_payload_chars: legacyChars,
        compact_payload_chars: payloadChars,
        saved_chars: legacyChars - payloadChars,
        saved_ratio: Number((1 - payloadChars / legacyChars).toFixed(4)),
        holistic_context_chars: context.length,
      }),
    );
    assert.ok(payloadChars <= legacyChars * 0.7);
    assert.ok(context.length <= (count === 44 ? 70_000 : 350_000));
  }
});

test("500 non-Godt rows stay complete in the registry while detail obeys both budgets", (t) => {
  const base = distributedCoverageFixture(500);
  const assessments = ["Mangler", "Dårlig", "Uklart"];
  const items = base.items.map((item, index) => ({
    ...item,
    assessment: assessments[index % assessments.length],
  }));
  const coverage = {
    ...base,
    good: 0,
    weak: items.filter((item) => item.assessment === "Dårlig").length,
    missing: items.filter((item) => item.assessment === "Mangler").length,
    unclear: items.filter((item) => item.assessment === "Uklart").length,
    items,
  };
  const payload = buildRequirementCoverageEvaluationPayload(coverage);
  const context = buildRequirementCoverageEvaluationContext(coverage);
  const metadata = payload.non_good_detail_selection;

  assert.equal(payload.coverage_registry.length, 500);
  payload.coverage_registry.forEach((row, index) => {
    assert.equal(row.nr, index + 1);
    assert.equal(row.source_document_id, items[index].source_document_id);
    assert.equal(row.assessment, items[index].assessment);
  });
  assert.equal(metadata.total_non_good_requirements, 500);
  assert.equal(
    metadata.detailed_non_good_requirements,
    payload.prioritized_non_good_requirements.length,
  );
  assert.equal(
    metadata.omitted_non_good_requirements,
    500 - payload.prioritized_non_good_requirements.length,
  );
  assert.ok(payload.prioritized_non_good_requirements.length > 0);
  assert.ok(
    payload.prioritized_non_good_requirements.length <=
      metadata.detail_row_budget,
  );
  assert.equal(
    metadata.detail_characters,
    JSON.stringify(payload.prioritized_non_good_requirements).length,
  );
  assert.ok(metadata.detail_characters <= metadata.detail_character_budget);
  assert.deepEqual(
    new Set(
      payload.prioritized_non_good_requirements.map((row) => row.assessment),
    ),
    new Set(assessments),
  );
  assert.ok(
    new Set(
      payload.prioritized_non_good_requirements.map(
        (row) => row.source_document_id,
      ),
    ).size >= 7,
  );
  assert.ok(
    new Set(
      payload.prioritized_non_good_requirements.map(
        (row) => row.requirement_subtitle,
      ),
    ).size >= 7,
  );
  payload.prioritized_non_good_requirements.forEach((row) => {
    const source = items.find(
      (item) =>
        item.order_index + 1 === row.nr &&
        item.source_document_id === row.source_document_id,
    );
    assert.ok(source);
    assert.equal(row.requirement, source.requirement);
    assert.equal(row.rationale, source.rationale);
    assert.equal(row.evidence, source.evidence);
    assert.equal(row.recommendation, source.recommendation);
  });

  const rowBudgeted = selectDistributedNonGoodCoverageDetails(items, {
    maxRows: 12,
    charBudget: 1_000_000,
  });
  assert.equal(rowBudgeted.details.length, 12);
  assert.equal(rowBudgeted.metadata.detail_row_budget, 12);
  const characterBudgeted = selectDistributedNonGoodCoverageDetails(items, {
    maxRows: 500,
    charBudget: 12_000,
  });
  assert.ok(characterBudgeted.details.length > 0);
  assert.ok(characterBudgeted.details.length < 500);
  assert.equal(
    JSON.stringify(characterBudgeted.details).length,
    characterBudgeted.metadata.detail_characters,
  );
  assert.ok(characterBudgeted.metadata.detail_characters <= 12_000);
  assert.ok(context.length <= 350_000);
  t.diagnostic(
    JSON.stringify({
      fixture_requirements: 500,
      registry_rows: payload.coverage_registry.length,
      detailed_rows: payload.prioritized_non_good_requirements.length,
      omitted_rows: metadata.omitted_non_good_requirements,
      detail_chars: metadata.detail_characters,
      detail_char_budget: metadata.detail_character_budget,
      holistic_context_chars: context.length,
    }),
  );
});

test("large holistic registries stay bounded while retaining a full deterministic hash", () => {
  for (const count of [1_000, 10_000]) {
    const coverage = distributedCoverageFixture(count);
    const payload = buildRequirementCoverageEvaluationPayload(coverage);
    const context = buildRequirementCoverageEvaluationContext(coverage);
    assert.equal(payload.coverage_registry_total, count);
    assert.equal(payload.coverage_registry.length, 500);
    assert.equal(payload.coverage_registry_omitted, count - 500);
    assert.match(payload.coverage_registry_sha256, /^[0-9a-f]{64}$/u);
    assert.ok(context.length < 350_000);
    assert.equal(payload.coverage_registry[0].nr, 1);
    assert.equal(payload.coverage_registry.at(-1).nr, count);
  }
});

test("distributed good examples cover documents and sections with full evidence", () => {
  const coverage = distributedCoverageFixture(44);
  const examples = selectDistributedGoodCoverageExamples(coverage.items);

  assert.equal(examples.length, 5);
  assert.ok(new Set(examples.map((row) => row.source_document_id)).size >= 3);
  assert.ok(new Set(examples.map((row) => row.requirement_subtitle)).size >= 3);
  examples.forEach((row) => {
    const source = coverage.items.find(
      (item) => item.order_index + 1 === row.nr,
    );
    assert.ok(source);
    assert.equal(row.evidence, source.evidence);
  });
});

test("authoritative registries remove duplicated 44-row ledgers and shrink context", (t) => {
  const requirements = requirementFixture();
  const coverage = coverageFixture();
  const fullLedger = [
    "### Presis kravledger for vurdering",
    ...requirements.map(
      (entry, index) =>
        `${index + 1}. ${entry.id} | ${entry.documentTitle} | ${entry.headingPath.join(" > ")} | ${entry.text} | ${entry.sourceExcerpt} | ${entry.answerExcerpt}`,
    ),
  ].join("\n");
  const responseRegistry = JSON.stringify(
    buildRequirementResponseBatchRegistry(requirements),
  );
  const coverageContext = buildRequirementCoverageEvaluationContext(coverage);
  const retained = suppressDuplicatedDocumentLedgerContext({
    documentLedgerContext: fullLedger,
    authoritativeRequirementRegistryPresent: true,
  });

  const legacyRequirementChars = fullLedger.length + 2 + responseRegistry.length;
  const optimizedRequirementChars = retained.length + responseRegistry.length;
  const legacyEvaluationChars = fullLedger.length + 2 + coverageContext.length;
  const optimizedEvaluationChars = retained.length + coverageContext.length;

  assert.equal(retained, "");
  assert.ok(optimizedRequirementChars < legacyRequirementChars);
  assert.ok(optimizedEvaluationChars < legacyEvaluationChars);
  assert.ok(responseRegistry.includes("K-044"));
  assert.ok(coverageContext.includes("K-044"));
  t.diagnostic(
    JSON.stringify({
      fixture_requirements: 44,
      duplicated_ledger_chars_removed: fullLedger.length + 2,
      requirement_prompt_chars_before: legacyRequirementChars,
      requirement_prompt_chars_after: optimizedRequirementChars,
      evaluation_prompt_chars_before: legacyEvaluationChars,
      evaluation_prompt_chars_after: optimizedEvaluationChars,
    }),
  );
});

test("ledger dedupe retains document and section metadata", () => {
  const context = [
    "### Evaluerings- og risikoleger",
    "Dokument: Kravspesifikasjon",
    "Tillit: high (1)",
    "Krav: 44",
    "Seksjoner: 1 Sikkerhet | 2 Integrasjon",
    "Kravutdrag: K-1: duplisert kravtekst | K-2: duplisert kravtekst",
    "### Presis kravledger for vurdering",
    "Denne kravledgeren er bygget deterministisk.",
    "Dokument: Kravspesifikasjon",
    "Krav funnet: 44",
    "- 1. K-1 | duplisert kravtekst",
  ].join("\n");
  const retained = suppressDuplicatedDocumentLedgerContext({
    documentLedgerContext: context,
    authoritativeRequirementRegistryPresent: true,
  });

  assert.match(retained, /Dokument: Kravspesifikasjon/);
  assert.match(retained, /Tillit: high \(1\)/);
  assert.match(retained, /Krav: 44/);
  assert.match(retained, /Seksjoner: 1 Sikkerhet \| 2 Integrasjon/);
  assert.doesNotMatch(retained, /Kravutdrag:/);
  assert.doesNotMatch(retained, /Presis kravledger/);
  assert.doesNotMatch(retained, /- 1\. K-1/);
});

test("coverage batches respect row and character budgets without losing order", () => {
  const requirements = requirementFixture().map((entry, index) => ({
    ...entry,
    sourceExcerpt: `${entry.sourceExcerpt} ${"kilde ".repeat(120 + (index % 4) * 40)}`,
    answerExcerpt: `${entry.answerExcerpt} ${"bevis ".repeat(80 + (index % 5) * 30)}`,
  }));
  const chunks = chunkRequirementCoverage(requirements, {
    maxRows: 18,
    charBudget: 6_000,
  });
  const flattened = chunks.flatMap((chunk) => chunk.entries);

  assert.ok(chunks.length > 3);
  assert.deepEqual(
    flattened.map((entry) => entry.id),
    requirements.map((entry) => entry.id),
  );
  assert.equal(new Set(flattened).size, requirements.length);
  chunks.forEach((chunk, index) => {
    assert.ok(chunk.entries.length <= 18);
    assert.ok(chunk.estimatedPromptChars <= 6_000);
    const expectedStart = chunks
      .slice(0, index)
      .reduce((total, candidate) => total + candidate.entries.length, 0);
    assert.equal(chunk.startIndex, expectedStart);
  });
});

test("coverage prompt treats unverified attachments as Uklart without goodwill", () => {
  const prompt = requirementCoverageSystemPrompt();

  assert.match(prompt, /skal kravet vurderes som Uklart/i);
  assert.match(prompt, /Ikke gi goodwill-dekning eller Godt/i);
  assert.match(prompt, /selvstendig.*kan beholde Godt/i);
  assert.doesNotMatch(prompt, /gi goodwill og vurder som Godt/i);
});

test("strict handoff governor enforces one global call and concurrency budget", async () => {
  const governor = createRequirementResponseStrictHandoffGovernor({
    limits: {
      maxCalls: 3,
      deadlineMs: 120_000,
      concurrency: 2,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
    assertActive: () => {},
  });
  let active = 0;
  let maximumActive = 0;
  let invocations = 0;

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      governor.run(async () => {
        invocations += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => queueMicrotask(resolve));
        active -= 1;
        return "ok";
      }),
    ),
  );

  assert.equal(invocations, 3);
  assert.ok(maximumActive <= 2);
  assert.equal(
    results.filter((result) => result.status === "completed").length,
    3,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "skipped" &&
        result.reason === "call_budget_exhausted",
    ).length,
    17,
  );
  assert.deepEqual(governor.snapshot(17), {
    outcome: "failed_closed",
    terminal_reason: "call_budget_exhausted",
    configured_call_budget: 3,
    configured_deadline_ms: 120_000,
    configured_concurrency: 2,
    strict_candidates: 20,
    calls_started: 3,
    repairs_accepted: 0,
    calls_without_accepted_repair: 3,
    skipped_call_budget: 17,
    skipped_deadline: 0,
    unresolved_after_handoff: 17,
  });
});

test("handoff progress reports exact unresolved rows during a partial deadline", () => {
  const progress = createRequirementResponseHandoffProgressTracker([
    2, 4, 6, 8,
  ]);
  progress.markResolved(4);
  progress.markResolved(4);
  progress.markResolved(999);

  const governor = createRequirementResponseStrictHandoffGovernor({
    limits: {
      maxCalls: 12,
      deadlineMs: 120_000,
      concurrency: 2,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
    assertActive: () => {},
  });
  assert.equal(progress.unresolvedCount(), 3);
  assert.deepEqual(governor.snapshot(progress.unresolvedCount(), "deadline_exceeded"), {
    outcome: "failed_closed",
    terminal_reason: "deadline_exceeded",
    configured_call_budget: 12,
    configured_deadline_ms: 120_000,
    configured_concurrency: 2,
    strict_candidates: 0,
    calls_started: 0,
    repairs_accepted: 0,
    calls_without_accepted_repair: 0,
    skipped_call_budget: 0,
    skipped_deadline: 0,
    unresolved_after_handoff: 3,
  });
});

test("strict handoff governor shrinks provider timeout and stops at its deadline", async () => {
  let now = 0;
  const governor = createRequirementResponseStrictHandoffGovernor({
    limits: {
      maxCalls: 12,
      deadlineMs: 12_000,
      concurrency: 1,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
    now: () => now,
    assertActive: () => {},
  });
  let observedTimeout = 0;
  const first = await governor.run(async (timeoutMs) => {
    observedTimeout = timeoutMs;
    return "ok";
  });
  assert.equal(first.status, "completed");
  assert.equal(observedTimeout, 12_000);

  now = 8_000;
  const second = await governor.run(async () => "must-not-run");
  assert.deepEqual(second, {
    status: "skipped",
    reason: "deadline_exceeded",
  });
  assert.deepEqual(governor.snapshot(2, "deadline_exceeded"), {
    outcome: "failed_closed",
    terminal_reason: "deadline_exceeded",
    configured_call_budget: 12,
    configured_deadline_ms: 12_000,
    configured_concurrency: 1,
    strict_candidates: 2,
    calls_started: 1,
    repairs_accepted: 0,
    calls_without_accepted_repair: 1,
    skipped_call_budget: 0,
    skipped_deadline: 1,
    unresolved_after_handoff: 2,
  });
});

test("strict handoff limits accept emergency zero and reject unsafe env values", () => {
  assert.deepEqual(
    resolveRequirementResponseStrictHandoffLimits({
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_MAX_CALLS: "0",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_MS: "10000",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_CONCURRENCY: "4",
    }),
    {
      maxCalls: 0,
      deadlineMs: 10_000,
      concurrency: 4,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
  );
  assert.deepEqual(
    resolveRequirementResponseStrictHandoffLimits({
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_MAX_CALLS: "999",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_DEADLINE_MS: "1",
      REQUIREMENT_RESPONSE_STRICT_HANDOFF_CONCURRENCY: "99",
    }),
    {
      maxCalls: 12,
      deadlineMs: 120_000,
      concurrency: 2,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
  );
});

test("strict handoff emergency zero never invokes the provider", async () => {
  const limits = resolveRequirementResponseStrictHandoffLimits({
    REQUIREMENT_RESPONSE_STRICT_HANDOFF_MAX_CALLS: "0",
  });
  const governor = createRequirementResponseStrictHandoffGovernor({
    limits,
    assertActive: () => {},
  });
  let invoked = false;
  const result = await governor.run(async () => {
    invoked = true;
    return "unexpected";
  });

  assert.equal(invoked, false);
  assert.deepEqual(result, {
    status: "skipped",
    reason: "call_budget_exhausted",
  });
  assert.equal(governor.snapshot(1).outcome, "failed_closed");
});

test("strict handoff queue counts waiting time against the global deadline", async () => {
  let now = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const governor = createRequirementResponseStrictHandoffGovernor({
    limits: {
      maxCalls: 12,
      deadlineMs: 12_000,
      concurrency: 1,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
    now: () => now,
    assertActive: () => {},
  });
  let invocations = 0;
  const first = governor.run(async () => {
    invocations += 1;
    await firstGate;
    return "first";
  });
  await Promise.resolve();
  const queued = governor.run(async () => {
    invocations += 1;
    return "queued";
  });
  now = 8_000;
  releaseFirst();

  assert.equal((await first).status, "completed");
  assert.deepEqual(await queued, {
    status: "skipped",
    reason: "deadline_exceeded",
  });
  assert.equal(invocations, 1);
});

test("strict handoff abort removes queued work before another call starts", async () => {
  const controller = new AbortController();
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const governor = createRequirementResponseStrictHandoffGovernor({
    limits: {
      maxCalls: 12,
      deadlineMs: 120_000,
      concurrency: 1,
      minCallWindowMs: 5_000,
      callTimeoutMs: 45_000,
    },
    signal: controller.signal,
    assertActive: () => {},
  });
  let invocations = 0;
  const first = governor.run(async () => {
    invocations += 1;
    await firstGate;
    return "first";
  });
  await Promise.resolve();
  const queued = governor.run(async () => {
    invocations += 1;
    return "must-not-run";
  });
  const abortError = new Error("workflow aborted");
  controller.abort(abortError);

  await assert.rejects(queued, /workflow aborted/);
  releaseFirst();
  assert.equal((await first).status, "completed");
  assert.equal(invocations, 1);
});

test("handoff keeps at most three accepted style examples", (t) => {
  const examples = Array.from({ length: 24 }, (_, index) => ({
    nr: index + 1,
    svar: `Godkjent svar ${index + 1}`,
  }));
  const selected = limitRequirementHandoffStyleExamples(examples);
  const beforeChars = JSON.stringify(examples).length;
  const afterChars = JSON.stringify(selected).length;

  assert.deepEqual(selected, examples.slice(0, 3));
  assert.ok(afterChars < beforeChars);
  t.diagnostic(
    JSON.stringify({
      handoff_style_examples_before: examples.length,
      handoff_style_examples_after: selected.length,
      handoff_style_chars_before: beforeChars,
      handoff_style_chars_after: afterChars,
    }),
  );
});

test("holistic structure preview keeps coverage across late document sections", () => {
  const structure = Array.from({ length: 100 }, (_, index) => ({
    reference: `Section ${index + 1}`,
    text: `Architecture signal ${index + 1}`,
  }));
  const selected = selectDocumentStructureEntries(
    structure,
    12,
    "distributed",
  );

  assert.equal(selected.length, 12);
  assert.equal(selected[0].reference, "Section 1");
  assert.equal(selected.at(-1).reference, "Section 100");
  assert.ok(selected.some((entry) => entry.reference === "Section 55"));
  assert.equal(new Set(selected.map((entry) => entry.reference)).size, 12);
});

test("mandatory hedging is rejected for full-document repair", () => {
  const entry = requirement({
    text: "Leverandøren skal levere overvåking, hendelsesvarsling og månedlig driftsrapport.",
  });
  const answer =
    "Atea kan levere overvåking og hendelsesvarsling med ansvarslinje og månedlig driftsrapport over status, hendelser og tiltak.";

  assert.equal(
    normalizeMandatoryRequirementCommitment(answer, entry).startsWith(
      "Atea leverer",
    ),
    true,
  );
  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);
  assert.equal(result.source, "deterministic_fallback");
  assert.match(result.reason, /weak_mandatory_commitment/);
});

test("future API descriptions and deferred core scope are rejected", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utvekslingen.",
  });
  const answer =
    "Løsningsforslaget vil beskrive API, autentisering og datamodell. Endelige grensesnitt og sikkerhetsmekanisme avklares i designfasen.";
  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.equal(result.source, "deterministic_fallback");
  assert.match(result.reason, /future_description_instead_of_answer/);
  assert.match(result.reason, /deferred_core_scope/);
  assert.match(result.reason, /missing_concrete_api_pattern/);
});

test("compound descriptive answers retain a necessary fourth sentence", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utvekslingen.",
  });
  const answer = [
    "Atea leverer integrasjonen som et versjonert HTTPS REST-API med operasjonene opprett, hent og oppdater.",
    "Autentisering bruker OIDC-klientlegitimasjon med begrensede scopes, kildesystemet er master, og løsningen synkroniserer data fra master til mottaker.",
    "Løsningen utfører feltmapping av navn og status, avviser ugyldige data og sender versjonskonflikter til feilkø.",
    "Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som bruker, rolle og hendelse med faste identifikatorer, feltmapping og valideringsregler.",
  ].join(" ");
  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);

  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.equal(result.source, "batch");
  assert.equal(result.answer, answer);
});

test("mandatory passive hedging, future delivery and delayed phases are rejected", () => {
  const entry = requirement({
    text: "Leverandøren skal levere overvåking med dokumentert ansvar og kontroll.",
  });
  const fixtures = [
    ["Dette kan leveres med dokumentert ansvar og kontroll.", "weak_mandatory_commitment"],
    ["Dette vil kunne leveres med dokumentert ansvar og kontroll.", "weak_mandatory_commitment"],
    [
      "Overvåkingen leveres med dokumentert ansvar og kontroll i en senere prosjektfase.",
      "deferred_core_scope",
    ],
    [
      "Ansvar og kontroll beskrives i detaljprosjekteringen.",
      "deferred_core_scope",
    ],
    ["Kontrollen inngår ikke og må håndteres av kunden.", "mandatory_requirement_declined"],
  ];

  for (const [answer, expectedIssue] of fixtures) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(issues.includes(expectedIssue), `${answer}: ${issues.join(",")}`);
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }
});

test("documenting deviations is a deliverable, not a deferred meta-description", () => {
  const entry = requirement({
    text: "Beskriv hvordan avvik dokumenteres.",
  });
  const direct =
    "Tilbudet skal dokumentere alle avvik i sakssystemet med ansvarlig eier, status, tiltak og sporbar lukking.";
  const deferred =
    "Løsningsforslaget vil senere beskrive hvordan avvik dokumenteres og følges opp.";

  assert.deepEqual(requirementAnswerQualityIssues(direct, entry), []);
  assert.doesNotMatch(
    normalizeRequirementAnswerResult(direct, entry, entry.text).reason ?? "",
    /future_description_instead_of_answer/,
  );
  assert.ok(
    requirementAnswerQualityIssues(deferred, entry).includes(
      "future_description_instead_of_answer",
    ),
  );
});

test("concrete product-neutral API design passes the quality gate", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utvekslingen.",
  });
  const answer =
    "Atea leverer et versjonert HTTPS REST-API med OAuth 2.0-klientlegitimasjon, begrensede scopes og operasjonene opprett, hent og oppdater. Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som bruker, rolle og hendelse med faste identifikatorer og feltmapping av navn og status; identitetsløsningen er master, data synkroniseres fra master til mottaker, og ugyldige data eller versjonskonflikter sendes til avvikslogg.";
  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(result.source, "batch");
  assert.equal(result.answer, answer);
});

test("real strict-handoff API answer accepts repeated named objects and detailed field mappings", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const answer =
    "Atea leverer en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS mellom skyplattformen og både kalender og identitet, sikret med OAuth 2.0/OIDC og klientlegitimasjon med separate scopes og operasjonene opprett, hent og oppdater, der kalenderutveksling beskrives med objektet kalenderhendelse (eventId/uid som nøkkelfelt, mapping av tittel, starttid og sluttid) og identitetsutveksling med objektet brukeridentitet (userId/objectId som nøkkelfelt, mapping av visningsnavn og e-post). Kalenderen og identitetsløsningen er master for hvert sitt objekt, skyplattformen synkroniserer fra hver master, og ugyldige data eller versjonskonflikter avvises til feilkø; øvrige felt, dataeierskap og synkretning er uttrykkelig en foreslått integrasjonskontrakt.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  const normalized = normalizeRequirementAnswerResult(
    answer,
    entry,
    entry.text,
  );
  assert.equal(normalized.source, "batch");
  assert.equal(normalized.answer, answer);
});

test("equivalent concrete mapper syntax and definite-plural objects pass", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const answers = [
    "Atea leverer en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS for kalender og identitet, sikret med OAuth 2.0/OIDC, separate scopes og operasjonene opprett, hent og oppdater. Løsningen bruker objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapper feltene tittel, starttid og rolle; kalenderen og identitetsløsningen er master, data synkroniseres fra hver kilde til skyplattformen, og ugyldige kalender- eller identitetsdata avvises til feilkø.",
    "Atea leverer en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS for kalender og identitet, sikret med OAuth 2.0/OIDC, separate scopes og operasjonene opprett, hent og oppdater. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfelt og mapping av tittel, starttid og rolle; kalenderen og identitetsløsningen er master, data synkroniseres fra hver kilde til skyplattformen, og ugyldige kalender- eller identitetsdata avvises til feilkø.",
  ];

  for (const answer of answers) {
    assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "batch",
    );
  }
});

test("named API objects still require validation or a genuinely detailed field mapping", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const answer =
    "Atea leverer en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS for kalender og identitet, sikret med OAuth 2.0/OIDC, der objektet kalenderhendelse og objektet brukeridentitet har nøkkelfelt og mapping av faste felt og relevante data.";

  const issues = requirementAnswerQualityIssues(answer, entry);
  assert.ok(issues.includes("missing_concrete_data_model_pattern"), issues);
  assert.equal(
    normalizeRequirementAnswerResult(answer, entry, entry.text).source,
    "deterministic_fallback",
  );
});

test("proposed API contracts cannot waive target relevance or manufacture field detail", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const prefix =
    "Atea leverer en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS for kalender og identitet, sikret med OAuth 2.0/OIDC.";
  const rejected = [
    `${prefix} Datamodellen omfatter objektet faktura og objektet atomvåpen med nøkkelfelt og mapping av fakturanummer og beløp.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet atomvåpen med nøkkelfelt og mapping av tittel og starttid.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapping av feltene og attributtene.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapping av feltene i datamodellen og andre relevante felt.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapping av nødvendige felter og aktuelle verdier.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapping av bruker og logging gjennomføres.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt og mapping av tittel.`,
    `${prefix} Datamodellen omfatter objektet kalenderhendelse og objektet brukeridentitet med nøkkelfelt, mapping av tittel og starttid og validering; objektet kalenderhendelse er valgfritt.`,
  ];

  for (const answer of rejected) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes("missing_concrete_data_model_pattern"),
      `${answer}: ${issues}`,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }
});

test("API data-model quality rejects canary19 generic categories and accepts named target-grounded objects", () => {
  const calendarRequirement =
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.";
  const membershipRequirement =
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og medlemsregister.";
  const genericCalendar =
    "Atea beskriver en standardisert integrasjonsmodell mot kalender og identitet med versjonert REST-API over HTTPS og autentisering via OAuth 2.0/OIDC med tjenesteidentitet. Datamodellen spesifiserer kjerneobjekter, identifikatorer, feltmapping og valideringsregler for sikker og konsistent utveksling.";
  const genericMembership =
    "Atea beskriver en standard API-modell mot medlemsregister basert på versjonert REST over HTTPS og autentisering med OAuth 2.0/OIDC og tjenesteidentitet. Datamodellen definerer kjerneobjekter, faste felt og identifikatorer samt feltmapping og valideringsregler for konsistent datautveksling.";
  const strongCalendar =
    "Atea beskriver utvekslingen mellom skyplattformen og kalender og identitet som et versjonert REST-API over HTTPS med OAuth 2.0/OIDC, tjenesteidentitet, separate scopes og operasjonene opprett, hent og oppdater. Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som bruker, rolle, gruppe og kalenderhendelse med faste identifikatorer og feltmapping av rolle og starttid; kalenderen og identitetsløsningen er master, data synkroniseres fra hver master, og ugyldige data eller versjonskonflikter avvises til feilkø.";
  const strongMembership =
    "Atea beskriver utvekslingen mellom skyplattformen og medlemsregister som et versjonert REST-API over HTTPS med OAuth 2.0/OIDC, tjenesteidentitet, begrenset scope og operasjonene hent og oppdater. Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som medlem eller frivillig, kontaktinformasjon, status og referanse-ID, med feltmapping av navn og status; medlemsregisteret er master, data synkroniseres fra master til skyplattformen, og ugyldige data eller versjonskonflikter avvises til avvikslogg.";
  const calendarEntry = requirement({ text: calendarRequirement });
  const membershipEntry = requirement({ text: membershipRequirement });

  for (const [answer, entry] of [
    [genericCalendar, calendarEntry],
    [genericMembership, membershipEntry],
  ]) {
    const result = normalizeRequirementAnswerResult(answer, entry, entry.text);
    assert.equal(result.source, "deterministic_fallback");
    assert.match(result.reason, /missing_concrete_data_model_pattern/u);
  }
  for (const [answer, entry] of [
    [strongCalendar, calendarEntry],
    [strongMembership, membershipEntry],
  ]) {
    assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "batch",
    );
  }
  const withOptionalSupplement = `${strongCalendar} En supplerende webhook kan brukes ved behov for ikke-kritiske varsler.`;
  assert.deepEqual(
    requirementAnswerQualityIssues(withOptionalSupplement, calendarEntry),
    [],
  );
  assert.equal(
    normalizeRequirementAnswerResult(
      withOptionalSupplement,
      calendarEntry,
      calendarEntry.text,
    ).source,
    "batch",
  );
  const spacedRestApi = strongCalendar.replace("REST-API", "REST API");
  assert.deepEqual(requirementAnswerQualityIssues(spacedRestApi, calendarEntry), []);
  assert.equal(
    normalizeRequirementAnswerResult(
      spacedRestApi,
      calendarEntry,
      calendarEntry.text,
    ).source,
    "batch",
  );

  const wrongTarget = normalizeRequirementAnswerResult(
    strongMembership,
    calendarEntry,
    calendarEntry.text,
  );
  assert.equal(wrongTarget.source, "deterministic_fallback");
  assert.match(wrongTarget.reason, /missing_concrete_data_model_pattern/u);
});

test("API contract gate rejects the exact canary28 weak answers and every missing operational binding", () => {
  const calendarEntry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const membershipEntry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og medlemsregister.",
  });
  const canary28Answers = [
    [
      calendarEntry,
      "Som foreslått integrasjonskontrakt skjer utvekslingen mellom skyplattform, kalender og identitet gjennom et versjonert REST-API over HTTPS, sikret med OAuth 2.0/OIDC og tjenesteidentitet. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med identifikatorer hendelses-ID og bruker-ID; feltmapping gjennomføres og valideres.",
    ],
    [
      membershipEntry,
      "Atea beskriver en foreslått integrasjonskontrakt med versjonert REST-API over HTTPS og autentisering med OAuth 2.0/OIDC og tjenesteidentitet for utveksling mellom skyplattformen og medlemsregister. Datamodellen omfatter frivillig og medlemskap med frivillig-ID og medlems-ID som nøkkelfelt, mapping av navn, kontaktinformasjon og status mellom medlemsregister og skyplattform og validering av obligatoriske felter.",
    ],
  ];

  for (const [entry, answer] of canary28Answers) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(issues.includes("incomplete_api_integration_contract"), issues);
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }

  const complete =
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0-klientlegitimasjon, separate scopes og operasjonene opprett, hent og oppdater. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID og feltmapping av starttid og rolle; kalenderen og identitetsløsningen er master, skyplattformen synkroniserer fra hver master til mottakeren, og ugyldige data eller versjonskonflikter avvises til feilkø.";
  const weakened = [
    complete.replace(" og operasjonene opprett, hent og oppdater", ""),
    complete.replace("separate scopes og ", ""),
    complete.replace("kalenderen og identitetsløsningen er master, ", ""),
    complete.replace(
      "skyplattformen synkroniserer fra hver master til mottakeren, ",
      "",
    ),
    complete.replace(
      "og ugyldige data eller versjonskonflikter avvises til feilkø",
      "",
    ),
  ];

  assert.deepEqual(requirementAnswerQualityIssues(complete, calendarEntry), []);
  for (const answer of weakened) {
    const issues = requirementAnswerQualityIssues(answer, calendarEntry);
    assert.ok(
      issues.includes("incomplete_api_integration_contract"),
      `${answer}: ${issues}`,
    );
  }
});

test("API contract controls reject negation, overprivilege, wrong-domain mapping and cross-binding", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const complete =
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0-klientlegitimasjon, separate scopes og operasjonene opprett, hent og oppdater. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID og feltmapping av starttid og rolle; kalenderen og identitetsløsningen er autoritative kilder, skyplattformen synkroniserer fra hver kilde til mottakeren, og ugyldige data eller versjonskonflikter avvises til feilkø.";
  const rejected = [
    complete.replace(
      "kalenderen og identitetsløsningen er autoritative kilder",
      "kalenderen og identitetsløsningen er aldri autoritative kilder",
    ),
    complete.replace(
      "skyplattformen synkroniserer fra hver kilde til mottakeren",
      "skyplattformen synkroniserer aldri data fra hver kilde til mottakeren",
    ),
    complete.replace(
      "ugyldige data eller versjonskonflikter avvises til feilkø",
      "løsningen avviser aldri ugyldige data eller versjonskonflikter til feilkø",
    ),
    complete.replace("feltmapping av starttid og rolle", "feltmapping av fakturanummer og beløp"),
    complete.replace("separate scopes", "et ubegrenset superuser-scope"),
    complete.replace(
      "operasjonene opprett, hent og oppdater",
      "GET er kun et mulig eksempel",
    ),
    complete.replace("feltmapping av starttid og rolle", "feltmapping av ingen og ingenting"),
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS mot kalender og identitet med OAuth 2.0-klientlegitimasjon, og datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID. Et separat økonomi-API har et begrenset faktura-scope og operasjonene hent og oppdater, feltmapping av fakturanummer og beløp utføres, faktura er master, økonomidata synkroniseres fra økonomisystemet til arkivet, og ugyldige økonomidata avvises til feilkø.",
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS mot kalender og identitet med OAuth 2.0-klientlegitimasjon; et separat økonomi-API har et begrenset faktura-scope og operasjonene hent og oppdater. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID; økonomi-API-et utfører feltmapping av starttid og rolle, faktura er master, økonomidata synkroniseres fra økonomisystemet til arkivet, og ugyldige økonomidata avvises til feilkø.",
  ];

  for (const answer of rejected) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes("incomplete_api_integration_contract"),
      `${answer}: ${issues}`,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer, entry, entry.text).source,
      "deterministic_fallback",
    );
  }
});

test("API contract accepts bound synonyms and ignores optional extras after a complete core", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const answer =
    "Som foreslått integrasjonskontrakt bruker skyplattformen et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0-klientlegitimasjon og minste privilegium med egne rettighetssett for kalenderlesing, kalenderskriving og identitetslesing; integrasjonen støtter oppretting, lesing og oppdatering. Datamodellen omfatter objektene kalenderhendelse og brukeridentitet med nøkkelfeltene hendelses-ID og bruker-ID, og starttid og rolle oversettes eksplisitt til tilsvarende felt; kalenderen og identitetsløsningen er hvert sitt system of record, endringer strømmer én vei fra hver kilde inn i skyplattformen, og poster med manglende nøkler, ugyldig format eller versjonskonflikt stoppes og rutes til en dead-letter-kø.";

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  for (const inlineSafetyBoundary of [
    answer.replace(
      "Datamodellen omfatter",
      "Ingen ugyldige data godtas, og datamodellen omfatter",
    ),
    answer.replace(
      "minste privilegium med egne rettighetssett",
      "ingen administrator-tilgang gis og minste privilegium med egne rettighetssett",
    ),
  ]) {
    assert.deepEqual(
      requirementAnswerQualityIssues(inlineSafetyBoundary, entry),
      [],
      inlineSafetyBoundary,
    );
  }
  for (const optionalExtra of [
    "En ekstra DELETE-operasjon kan aktiveres ved behov.",
    "Et ekstra rapport-scope kan brukes ved behov.",
    "Ingen ugyldige data godtas.",
    "Ingen administrator-tilgang gis.",
  ]) {
    const supplemented = `${answer} ${optionalExtra}`;
    assert.deepEqual(
      requirementAnswerQualityIssues(supplemented, entry),
      [],
      optionalExtra,
    );
    assert.equal(
      normalizeRequirementAnswerResult(supplemented, entry, entry.text).source,
      "batch",
      optionalExtra,
    );
  }
});

test("API response prompts require named grounded data elements without inventing customer facts", () => {
  for (const prompt of [
    requirementBatchSystemPrompt(),
    requirementHandoffSystemPrompt(),
  ]) {
    assert.match(prompt, /minst to navngitte/i);
    assert.match(prompt, /alle integrasjonsmål/i);
    assert.match(prompt, /navngitte operasjoner/i);
    assert.match(prompt, /begrensede scopes\/rettigheter/i);
    assert.match(prompt, /masterdataansvar og synkretning/i);
    assert.match(prompt, /ugyldige og konfliktende data/i);
    assert.match(prompt, /foreslått integrasjonskontrakt/i);
    assert.match(prompt, /ikke dikt endepunktstier/i);
    assert.match(prompt, /ikke som eksisterende kundefakta|ikke kundefakta/i);
  }
});

test("API quality fails closed for token-only, negated, optional and wrong-domain controls", () => {
  const entry = requirement({
    text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
  });
  const namedModel =
    "Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som bruker, rolle og kalenderhendelse med faste identifikatorer, feltmapping og validering.";
  const fixtures = [
    {
      answer: `Atea bruker en versjonert policy for utveksling mellom kalender og identitet med OAuth 2.0/OIDC og tjenesteidentitet. ${namedModel}`,
      issue: "missing_concrete_api_pattern",
    },
    {
      answer: `Atea utveksler kalender og identitet uten REST eller HTTPS, men med versjonert dokumentasjon og OAuth 2.0/OIDC. ${namedModel}`,
      issue: "missing_concrete_api_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet. Ingen autentisering etableres; OAuth omtales bare som alternativ. ${namedModel}`,
      issue: "missing_concrete_authentication_pattern",
    },
    {
      answer:
        "Atea leverer et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0/OIDC. Datamodellen omfatter ikke bruker eller kalenderhendelse, men faktura og betaling med faste identifikatorer, feltmapping og validering.",
      issue: "missing_concrete_data_model_pattern",
    },
    {
      answer:
        "Atea leverer et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0/OIDC. Datamodellen omfatter objekter som faktura og betaling med faste identifikatorer, feltmapping og validering.",
      issue: "missing_concrete_data_model_pattern",
    },
    {
      answer:
        "Atea leverer et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0/OIDC. Datamodellen omfatter objekter som kalenderhendelse og atomvåpen med faste identifikatorer, feltmapping og validering.",
      issue: "missing_concrete_data_model_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0/OIDC. ${namedModel} Feltmapping er valgfri, og validering kan utføres ved behov.`,
      issue: "missing_concrete_data_model_pattern",
    },
    {
      answer: `Atea omtaler kalender og identitet med OAuth 2.0/OIDC, men REST-API er valgfritt. ${namedModel}`,
      issue: "missing_concrete_api_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet, mens OAuth 2.0 kan brukes ved behov. ${namedModel}`,
      issue: "missing_concrete_authentication_pattern",
    },
    {
      answer: `Atea bruker ikke REST-API for kalender og identitet, men OAuth 2.0/OIDC benyttes. ${namedModel}`,
      issue: "missing_concrete_api_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet, men bruker ikke OAuth 2.0/OIDC. ${namedModel}`,
      issue: "missing_concrete_authentication_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet med OAuth 2.0/OIDC. ${namedModel} Atea utfører ikke feltmapping. Validering leveres med regelkontroll.`,
      issue: "missing_concrete_data_model_pattern",
    },
    {
      answer: `Ved behov bruker Atea REST-API for kalender og identitet med OAuth 2.0/OIDC. ${namedModel}`,
      issue: "missing_concrete_api_pattern",
    },
    {
      answer: `Atea leverer et versjonert REST-API over HTTPS for kalender og identitet. Som opsjon leverer Atea OAuth 2.0/OIDC. ${namedModel}`,
      issue: "missing_concrete_authentication_pattern",
    },
  ];

  for (const fixture of fixtures) {
    const issues = requirementAnswerQualityIssues(fixture.answer, entry);
    assert.ok(issues.includes(fixture.issue), `${fixture.answer}: ${issues}`);
    assert.equal(
      normalizeRequirementAnswerResult(fixture.answer, entry, entry.text)
        .source,
      "deterministic_fallback",
    );
  }
});

test("exact duplicate reuse replaces a generic API data-model answer without another handoff", () => {
  const text =
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.";
  const donorAnswer =
    "Atea beskriver utvekslingen mellom skyplattformen og kalender og identitet som et versjonert REST-API over HTTPS med OAuth 2.0/OIDC, tjenesteidentitet, separate scopes og operasjonene opprett, hent og oppdater. Som foreslått integrasjonskontrakt omfatter datamodellen kjerneobjekter som bruker, rolle, gruppe og kalenderhendelse med faste identifikatorer og feltmapping av rolle og starttid; kalenderen og identitetsløsningen er master, data synkroniseres fra hver master, og ugyldige data eller versjonskonflikter avvises til feilkø.";
  const genericAnswer =
    "Atea beskriver en standardisert integrasjonsmodell mot kalender og identitet med versjonert REST-API over HTTPS og autentisering via OAuth 2.0/OIDC med tjenesteidentitet. Datamodellen spesifiserer kjerneobjekter, identifikatorer, feltmapping og valideringsregler for sikker og konsistent utveksling.";
  const ledger = [
    requirement({
      id: "R-033",
      text,
      documentId: "requirements-pdf",
      heading: "Integrasjoner og API",
      sourceExcerpt: `R-033 ${text}`,
    }),
    requirement({
      id: "R-039",
      text,
      documentId: "requirements-pdf",
      heading: "Integrasjoner og API",
      sourceExcerpt: `R-039 ${text}`,
    }),
  ];
  const answers = [
    normalizeRequirementAnswerResult(
      donorAnswer,
      ledger[0],
      ledger[0].sourceExcerpt,
    ),
    normalizeRequirementAnswerResult(
      genericAnswer,
      ledger[1],
      ledger[1].sourceExcerpt,
    ),
  ];
  assert.deepEqual(
    answers.map((answer) => answer.source),
    ["batch", "deterministic_fallback"],
  );

  const reused = reuseExactDuplicateRequirementAnswers({ ledger, answers });
  assert.deepEqual(
    reused.answers.map((answer) => answer.source),
    ["batch", "exact_duplicate_reuse"],
  );
  assert.equal(reused.answers[1].answer, donorAnswer);
  assert.match(reused.answers[1].evidence, /R-039/u);
  assert.doesNotMatch(reused.answers[1].evidence, /R-033/u);
});

test("numeric and commercial unknowns may remain explicit clarifications", () => {
  const entry = requirement({
    text: "Løsningen skal ha backup og dokumentert gjenoppretting.",
  });
  const answer =
    "Atea leverer backup med testet gjenoppretting, verifikasjon og dokumentert ansvar. Eksakte RTO/RPO-mål og kommersielle priser avklares før forpliktelse.";
  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.doesNotMatch(
    result.reason ?? "",
    /deferred_core_scope/,
  );
  assert.equal(result.source, "batch");
});

test("canary29 backup deferrals fail closed while a pre-production operating matrix passes", () => {
  const entry = requirement({
    id: "R-011",
    text: "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av oppdrag, frivillige, samtykker, meldinger.",
    sourceExcerpt:
      "R-011 Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av oppdrag, frivillige, samtykker, meldinger. Må Må avklares i designfase",
  });
  const canary29 =
    "Atea etablerer rutiner for backup av oppdrag, frivillige, samtykker og meldinger, kontrollert gjenoppretting, integritetsverifikasjon etter restore og dokumenterte restore-tester med loggede avvik og korrigerende tiltak. Eksakte frekvenser, lagringstider og eventuelle RTO/RPO-parametere avklares i designfasen. Eksakte RTO/RPO-mål eller bindende nedetidsmål er ikke tallfestet i bilaget og avklares som foreslåtte tjenestenivåer før forpliktelse.";
  const strong =
    "Løsningen etablerer og drifter en dokumentert backup-rutine for produksjonsdata om oppdrag, frivillige, samtykker og meldinger, med driftsansvarlig rolle, jobbkontroll og avviksvarsling; frekvens, oppbevaringstid, RTO, RPO og testkalender fastsettes per dataklasse i en backupmatrise som godkjennes før produksjonssetting og gjelder som bindende driftsparametere. Kontrollert gjenoppretting følger dokumentert runbook; dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.";

  assert.ok(
    requirementAnswerQualityIssues(canary29, entry).includes(
      "incomplete_backup_restore_verification",
    ),
  );
  assert.equal(
    normalizeRequirementAnswerResult(canary29, entry, entry.text).source,
    "deterministic_fallback",
  );
  assert.deepEqual(requirementAnswerQualityIssues(strong, entry), []);
  const normalized = normalizeRequirementAnswerResult(
    strong,
    entry,
    entry.text,
  );
  assert.equal(normalized.source, "batch");
  assert.equal(normalized.answer, strong);
  assert.doesNotMatch(normalized.answer, /ikke tallfestet|før forpliktelse/i);
});

test("generic backup prose no longer receives an invented RTO or RPO clarification", () => {
  const entry = requirement({
    text: "Løsningen skal ha backup og dokumentert gjenoppretting.",
  });
  const answer =
    "Atea leverer dokumentert backup og testet gjenoppretting med navngitt ansvar og verifikasjon.";
  const result = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.equal(result.source, "batch");
  assert.doesNotMatch(result.answer, /RTO|RPO|nedetidsmål/i);
});

test("backup guard ignores unrelated SLA headings and accepts common evidence synonyms", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);
  const synonymousAnswer = fixture.completeAnswer
    .replace("backupmatrise", "backup-matrise")
    .replace("kontrollsummer", "sjekksummer");
  const entry = requirement({
    id: fixture.id,
    text: fixture.text,
    heading: "Tilgjengelighet, SLA og kontinuitet",
    sourceExcerpt: `${fixture.id} ${fixture.text}`,
  });

  assert.deepEqual(
    requirementAnswerQualityIssues(synonymousAnswer, entry),
    [],
  );
  const normalized = normalizeRequirementAnswerResult(
    synonymousAnswer,
    entry,
    entry.sourceExcerpt,
  );
  assert.equal(normalized.source, "batch");
  assert.equal(normalized.answer, synonymousAnswer);
  assert.doesNotMatch(normalized.answer, /ikke tallfestet|før forpliktelse/i);
});

test("backup verification synonyms trigger the full quality gate", () => {
  for (const control of [
    "verifisering",
    "validering",
    "kontroll av gjenoppretting",
    "testing av gjenoppretting",
  ]) {
    const entry = requirement({
      text: `Det skal finnes rutiner for backup, gjenoppretting og ${control} av oppdrag, frivillige, samtykker og meldinger.`,
    });
    const weak =
      "Løsningen tar backup av oppdrag og kan gjenopprette data ved behov.";
    assert.ok(
      requirementAnswerQualityIssues(weak, entry).includes(
        "incomplete_backup_restore_verification",
      ),
      control,
    );
  }

  const unrelatedTestEnvironment = requirement({
    text: "Løsningen skal ha backup og gjenoppretting samt et separat testmiljø før produksjonssetting.",
  });
  assert.deepEqual(
    requirementAnswerQualityIssues(
      "Løsningen etablerer backup og kontrollert gjenoppretting, og gir tilgang til et separat testmiljø med testdata før produksjonssetting.",
      unrelatedTestEnvironment,
    ).filter((issue) => issue === "incomplete_backup_restore_verification"),
    [],
  );
});

test("conditional or non-binding backup matrices fail closed", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);
  const variants = [
    fixture.completeAnswer.replace(
      "fastsettes per dataklasse",
      "avtales ved behov per dataklasse",
    ),
    fixture.completeAnswer.replace(
      "gjelder som bindende driftsparametere",
      "er ikke bindende driftsparametere",
    ),
    fixture.completeAnswer.replace(
      "fastsettes per dataklasse",
      "kan fastsettes per dataklasse",
    ),
    fixture.completeAnswer.replace(
      "fastsettes per dataklasse",
      "når kunden ber om det, fastsettes per dataklasse",
    ),
    fixture.completeAnswer.replace(
      "og retest frem til godkjenning",
      "frem til godkjenning",
    ),
    `${fixture.completeAnswer} Hele rutinen leveres bare når kunden bestiller den.`,
    `${fixture.completeAnswer} Dette gjelder ikke produksjonsdata, og kontrollsummer og objekttellinger utføres ikke.`,
    fixture.completeAnswer.replace(
      "fastsettes per dataklasse",
      "foreslås å bindes per dataklasse",
    ),
    `${fixture.completeAnswer} Backupmatrisen gjelder eventuelt etter nærmere avtale.`,
    `${fixture.completeAnswer} Eksakte frekvenser og lagringstider avklares i designfasen.`,
    `${fixture.completeAnswer} Ingen av de ovennevnte kontrollene gjennomføres.`,
    `${fixture.completeAnswer} Samtlige beskrevne aktiviteter er valgfrie.`,
    `${fixture.completeAnswer} Den samlede leveransen aktiveres bare etter særskilt bestilling.`,
    `${fixture.completeAnswer} Alle beskrevne tiltak er avhengige av kundens særskilte godkjenning.`,
    `${fixture.completeAnswer} Disse mekanismene inngår kun i et separat tilvalg.`,
    `${fixture.completeAnswer} Det samlede omfanget gjelder under forutsetning av ny bestilling.`,
    `${fixture.completeAnswer} De nevnte kontrollene gjennomføres ikke.`,
    `${fixture.completeAnswer} Ingen slike tiltak iverksettes.`,
    `${fixture.completeAnswer} Alt ovenfor er valgfritt.`,
    `${fixture.completeAnswer} Samtlige punkter leveres med forbehold om separat ordre.`,
    `${fixture.completeAnswer} Det foregående inngår etter kundens bestilling.`,
    `${fixture.completeAnswer} Hele pakken er en valgfri del.`,
    `${fixture.completeAnswer} Ingen av dem leveres.`,
    `${fixture.completeAnswer} Alt dette er frivillig.`,
    `${fixture.completeAnswer} Hele opplegget er valgfritt.`,
    `${fixture.completeAnswer} Leveransen forutsetter en tilleggsbestilling.`,
    `${fixture.completeAnswer} Kontrollene tilbys mot særskilt bestilling.`,
    fixture.completeAnswer.replace(
      "dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test",
      "restore verifiseres visuelt, og hver restore-test",
    ) + " En separat eksportjobb bruker kontrollsummer og objekttelling.",
    fixture.completeAnswer.replace(
      "retest frem til godkjenning",
      "retest bare av brukergrensesnittet frem til godkjenning",
    ),
    fixture.completeAnswer.replace(
      "retest frem til godkjenning",
      "retest av brukergrensesnittet frem til godkjenning",
    ),
    fixture.completeAnswer
      .replace("backup-rutine for produksjonsdata", "backup-rutine for testdata")
      .concat(" Et separat dashbord viser produksjonsdata."),
    fixture.completeAnswer
      .replace(
        "med driftsansvarlig rolle, jobbkontroll og avviksvarsling",
        "uten navngitt driftsansvar",
      )
      .concat(
        " Deployprosessen har driftsansvarlig rolle, jobbkontroll og avviksvarsling.",
      ),
    fixture.completeAnswer
      .replace("backup-rutine for produksjonsdata", "backup-rutine for testdata")
      .replace(
        "med driftsansvarlig rolle, jobbkontroll og avviksvarsling",
        "og produksjonsdashbordets deployprosess har driftsansvarlig rolle, jobbkontroll og avviksvarsling",
      ),
    fixture.completeAnswer.replace(
      "dataintegritet verifiseres med kontrollsummer og objekttelling",
      "restore verifiseres visuelt og eksportjobben bruker kontrollsummer og objekttelling",
    ),
    fixture.completeAnswer.replace(
      "dataintegritet verifiseres med kontrollsummer og objekttelling",
      "restore verifiseres visuelt og rapporteringsjobben bruker kontrollsummer og objekttelling",
    ),
    fixture.completeAnswer
      .replace("backup-rutine for produksjonsdata", "backup-rutine for testdata")
      .replace(
        "med driftsansvarlig rolle, jobbkontroll og avviksvarsling",
        "og integrasjonsprosessen for produksjonsdata har driftsansvarlig rolle, jobbkontroll og avviksvarsling",
      ),
  ];
  const entry = highConfidenceCoverageEntry(fixture);

  for (const answer of variants) {
    assert.ok(
      requirementAnswerQualityIssues(answer, entry).includes(
        "incomplete_backup_restore_verification",
      ),
      answer,
    );
  }
});

test("documented RTO and RPO values must be preserved exactly without false enrichment", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);
  const entry = requirement({
    id: fixture.id,
    text: fixture.text,
    heading: "SLA og tilgjengelighet",
    sourceExcerpt: `${fixture.id} ${fixture.text} RTO 4 timer og RPO 1 time.`,
  });
  const committed = fixture.completeAnswer.replace(
    "RTO, RPO og testkalender",
    "RTO 4 timer, RPO 1 time og testkalender",
  );

  assert.ok(
    requirementAnswerQualityIssues(fixture.completeAnswer, entry).includes(
      "missing_documented_backup_continuity_target",
    ),
  );
  assert.deepEqual(requirementAnswerQualityIssues(committed, entry), []);
  const normalized = normalizeRequirementAnswerResult(
    committed,
    entry,
    entry.sourceExcerpt,
  );
  assert.equal(normalized.source, "batch");
  assert.equal(normalized.answer, committed);
  assert.doesNotMatch(normalized.answer, /ikke tallfestet|før forpliktelse/i);

  for (const sourceTargets of [
    "RTO: 4 timer og RPO: 1 time",
    "RTO = 4 timer og RPO = 1 time",
    "RTO ≤ 4 timer og RPO maks. 1 time",
    "RTO – 4 timer og RPO — 1 time",
    "RTO4h/RPO1h",
    "RTO 04:00 og RPO 00:15",
    "RTO fire timer og RPO én time",
    "RTO 1 døgn og RPO ett døgn",
    "RTO PT4H og RPO PT1H",
    "RTO PT90M og RPO PT30M",
    "RTO PT1H30M og RPO PT15M",
    "RTO halvannen time og RPO en halv time",
    "Gjenoppretting innen 4 t og maksimalt datatap 1 t",
    "Gjenoppretting innen fire timer og maksimalt datatap én time",
    "RTO P1D og RPO PT30S",
  ]) {
    const formattedEntry = {
      ...entry,
      sourceExcerpt: `${fixture.id} ${fixture.text} ${sourceTargets}.`,
    };
    assert.ok(
      requirementAnswerQualityIssues(fixture.completeAnswer, formattedEntry).includes(
        "missing_documented_backup_continuity_target",
      ),
      sourceTargets,
    );
  }

  const sourceMentionOnly = `${fixture.completeAnswer} Kilden oppgir RTO 4 timer og RPO 1 time.`;
  assert.ok(
    requirementAnswerQualityIssues(sourceMentionOnly, entry).includes(
      "missing_documented_backup_continuity_target",
    ),
  );

  const boundedEntry = {
    ...entry,
    sourceExcerpt: `${fixture.id} ${fixture.text} RTO ≤ 4 timer og RPO ≤ 1 time.`,
  };
  const wrongDirection = fixture.completeAnswer.replace(
    "RTO, RPO og testkalender",
    "RTO ≥ 4 timer, RPO ≥ 1 time og testkalender",
  );
  assert.ok(
    requirementAnswerQualityIssues(wrongDirection, boundedEntry).includes(
      "missing_documented_backup_continuity_target",
    ),
  );

  const crossBound = `${fixture.completeAnswer} Løsningen binder backupmatrisen, mens RTO 4 timer og RPO 1 time står kun som referanseverdier.`;
  assert.ok(
    requirementAnswerQualityIssues(crossBound, entry).includes(
      "missing_documented_backup_continuity_target",
    ),
  );

  for (const sourceTargets of [
    "RTO 2 timer og 30 minutter og RPO 1 time",
    "RTO 1 t 30 min og RPO 15 min",
  ]) {
    const compoundEntry = {
      ...entry,
      sourceExcerpt: `${fixture.id} ${fixture.text} ${sourceTargets}.`,
    };
    const partialAnswer = fixture.completeAnswer.replace(
      "RTO, RPO og testkalender",
      "RTO 2 timer, RPO 1 time og testkalender",
    );
    assert.ok(
      requirementAnswerQualityIssues(partialAnswer, compoundEntry).includes(
        "missing_documented_backup_continuity_target",
      ),
      sourceTargets,
    );
  }
});

test("an unrelated SLA reporting requirement never receives RTO or RPO prose", () => {
  const entry = requirement({
    text: "Leverandøren skal rapportere SLA for svartid og support hver måned.",
  });
  const answer =
    "Leverandøren rapporterer svartid, supporthenvendelser og avvik hver måned med ansvarlig oppfølging.";
  const normalized = normalizeRequirementAnswerResult(answer, entry, entry.text);

  assert.equal(normalized.source, "batch");
  assert.equal(normalized.answer, answer);
  assert.doesNotMatch(normalized.answer, /RTO|RPO|nedetidsmål/i);

  const statusEntry = requirement({
    text: "Leverandøren skal rapportere RTO-status i SLA-rapporten hver måned.",
  });
  const statusAnswer =
    "Leverandøren rapporterer RTO-status og avvik i SLA-rapporten hver måned med ansvarlig oppfølging.";
  const normalizedStatus = normalizeRequirementAnswerResult(
    statusAnswer,
    statusEntry,
    statusEntry.text,
  );
  assert.equal(normalizedStatus.answer, statusAnswer);
  assert.doesNotMatch(normalizedStatus.answer, /RPO|nedetidsmål|før forpliktelse/i);

  const deadlineStatusEntry = requirement({
    text: "Leverandøren skal rapportere RTO-status innen 1 time etter hendelsen.",
  });
  const deadlineStatusAnswer =
    "Leverandøren rapporterer RTO-status innen én time etter hendelsen og logger ansvarlig oppfølging.";
  const normalizedDeadlineStatus = normalizeRequirementAnswerResult(
    deadlineStatusAnswer,
    deadlineStatusEntry,
    deadlineStatusEntry.text,
  );
  assert.equal(normalizedDeadlineStatus.answer, deadlineStatusAnswer);
  assert.doesNotMatch(
    normalizedDeadlineStatus.answer,
    /RPO|nedetidsmål|før forpliktelse/i,
  );
});

test("exact duplicate reuse rejects materially different row qualifiers", () => {
  const text =
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av oppdrag, frivillige, samtykker, meldinger.";
  const donorEntry = requirement({
    id: "R-011",
    text,
    documentId: "requirements-pdf",
    heading: "Drift, overvåking og ytelse",
    sourceExcerpt: `${text} Må avklares i designfase`,
  });
  const targetEntry = requirement({
    id: "R-023",
    text,
    documentId: "requirements-pdf",
    heading: "Drift, overvåking og ytelse",
    sourceExcerpt: `${text} Gjelder produksjonsløsning`,
  });
  const donor = normalizeRequirementAnswerResult(
    "Løsningen etablerer og drifter en dokumentert backup-rutine for produksjonsdata om oppdrag, frivillige, samtykker og meldinger, med driftsansvarlig rolle, jobbkontroll og avviksvarsling; frekvens, oppbevaringstid, RTO, RPO og testkalender fastsettes per dataklasse i en backupmatrise som godkjennes før produksjonssetting og gjelder som bindende driftsparametere. Kontrollert gjenoppretting følger dokumentert runbook; dataintegritet verifiseres med kontrollsummer og objekttelling, og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.",
    donorEntry,
    donorEntry.sourceExcerpt,
  );
  const fallback = normalizeRequirementAnswerResult(
    "Ja.",
    targetEntry,
    targetEntry.sourceExcerpt,
  );
  const reused = reuseExactDuplicateRequirementAnswers({
    ledger: [donorEntry, targetEntry],
    answers: [donor, fallback],
  });

  assert.deepEqual(reused.answers.map((answer) => answer.source), [
    "batch",
    "deterministic_fallback",
  ]);
  assert.equal(reused.metadata.exact_duplicate_reuse_answers, 0);
});

test("exact duplicate qualifier identity removes only the structural row ID", () => {
  const text =
    "Akseptansetest skal dekke minst brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer.";
  const answer =
    "Løsningen tester brukerroller, integrasjoner, rapporter, feilscenarier og tilgangsendringer med forventede resultater. Avvik logges med ansvarlig tiltak, retestes og inngår i testoppsummering før godkjenning.";
  const donorEntry = requirement({
    id: "X1",
    text,
    documentId: "requirements-pdf",
    heading: "Akseptanse",
    sourceExcerpt: `X1 ${text} Avhenger av X1`,
  });
  const targetEntry = requirement({
    id: "X2",
    text,
    documentId: "requirements-pdf",
    heading: "Akseptanse",
    sourceExcerpt: `X2 ${text} Avhenger av X2`,
  });
  const reused = reuseExactDuplicateRequirementAnswers({
    ledger: [donorEntry, targetEntry],
    answers: [
      normalizeRequirementAnswerResult(answer, donorEntry),
      normalizeRequirementAnswerResult("Ja.", targetEntry),
    ],
  });

  assert.deepEqual(reused.answers.map(({ source }) => source), [
    "batch",
    "deterministic_fallback",
  ]);
});

test("test environment answers require a concrete verification method", () => {
  const entry = requirement({
    text: "Kunden skal få tilgang til testmiljø før produksjonssetting.",
  });
  const weak = normalizeRequirementAnswerResult(
    "Atea gir kunden tilgang til testmiljø før produksjonssetting og følger opp leveransen.",
    entry,
    entry.text,
  );
  const strong = normalizeRequirementAnswerResult(
    "Atea gir kunden tilgang til testmiljø før produksjonssetting med representative testscenarioer, testdata, forventet resultat og dokumentert oppfølging av avvik.",
    entry,
    entry.text,
  );

  assert.equal(weak.source, "deterministic_fallback");
  assert.match(weak.reason, /missing_test_method/);
  assert.equal(strong.source, "batch");
});

test("deterministic final control repair passes the existing quality gate for all five exact patterns", () => {
  const repairs = highConfidenceCoverageFixtures.map((fixture) => {
    const entry = highConfidenceCoverageEntry(fixture);
    const repair = buildDeterministicFinalRequirementControlRepair({
      entry,
      evidence: entry.text,
    });

    assert.ok(repair, fixture.id);
    assert.equal(repair.source, "deterministic_control_repair", fixture.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repair.answer, entry),
      [],
      fixture.id,
    );
    assert.equal(
      normalizeRequirementAnswerResult(repair.answer, entry, entry.text).source,
      "batch",
      fixture.id,
    );
    assert.ok(
      (repair.answer.match(/[.!?](?:\s|$)/g)?.length ?? 0) >= 1 &&
        (repair.answer.match(/[.!?](?:\s|$)/g)?.length ?? 0) <= 2,
      fixture.id,
    );
    assert.doesNotMatch(repair.answer, /\d/, fixture.id);
    assert.doesNotMatch(repair.answer, /\b(?:Atea|kunden|Petoro)\b/i, fixture.id);
    return repair;
  });

  assert.deepEqual(
    buildDeterministicControlRepairMetadata({
      answers: repairs,
      ledger: highConfidenceCoverageFixtures.map((fixture) =>
        highConfidenceCoverageEntry(fixture),
      ),
    }),
    {
      deterministic_control_repair_answers: 5,
      deterministic_control_repair_refs: [
        "Dokumenttekst krav 2",
        "R-032",
        "R-022",
        "R-011",
        "R-024",
      ],
      deterministic_control_repair_rows: [
        {
          ref: "Dokumenttekst krav 2",
          pattern: "timed_reminder",
          order_index: 0,
          source_document_id: null,
          source_locator: "Side 1, Dokumenttekst krav 2",
        },
        {
          ref: "R-032",
          pattern: "historical_migration",
          order_index: 1,
          source_document_id: null,
          source_locator: "Side 1, R-032",
        },
        {
          ref: "R-022",
          pattern: "audit_change_log",
          order_index: 2,
          source_document_id: null,
          source_locator: "Side 1, R-022",
        },
        {
          ref: "R-011",
          pattern: "backup_restore",
          order_index: 3,
          source_document_id: null,
          source_locator: "Side 1, R-011",
        },
        {
          ref: "R-024",
          pattern: "acceptance_test",
          order_index: 4,
          source_document_id: null,
          source_locator: "Side 1, R-024",
        },
      ],
      manual_review_required: true,
      manual_review_note:
        "Deterministisk kontrolltekst er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.",
    },
  );
});

test("100-folder-001 repairs all ten previously unresolved rows before handoff", () => {
  const apiWarehouse =
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og lager.";
  const apiErp =
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og ERP.";
  const backup =
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.";
  const secureSharing =
    "Løsningen skal dimensjoneres for sikker datadeling med eksterne aktører uten at brukerne opplever vesentlig treghet.";
  const lowLatency =
    "Løsningen skal dimensjoneres for lav ventetid i kritiske arbeidsprosesser uten at brukerne opplever vesentlig treghet.";
  const noManual =
    "Brukere som feltteknikere, planleggere og driftssentral skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.";
  const entries = [
    requirement({
      id: "Dokumenttekst krav 16",
      text: apiWarehouse,
      sourceExcerpt: apiWarehouse,
    }),
    requirement({
      id: "Støttedokument - tabell 3, rad 3",
      text: apiWarehouse,
      sourceExcerpt: `${apiWarehouse} | Kan | Må avklares i designfase`,
    }),
    requirement({
      id: "Dokumenttekst krav 17",
      text: apiErp,
      sourceExcerpt: apiErp,
    }),
    requirement({
      id: "KR-057",
      text: apiWarehouse,
      sourceExcerpt: `KR-057: ${apiWarehouse}`,
    }),
    requirement({
      id: "KR-004",
      text: backup,
      sourceExcerpt: `KR-004 | ${backup} | Bør | Gjelder produksjonsløsning`,
    }),
    requirement({
      id: "Støttedokument - tabell 4, rad 6",
      text: backup,
      sourceExcerpt: `${backup} | Bør | Krever løsningsforslag`,
    }),
    requirement({
      id: "Dokumenttekst krav 25",
      text: secureSharing,
      sourceExcerpt: secureSharing,
    }),
    requirement({
      id: "KR-046",
      text: backup,
      sourceExcerpt: `KR-046: ${backup}`,
    }),
    requirement({
      id: "KR-052",
      text: lowLatency,
      sourceExcerpt: `KR-052: ${lowLatency}`,
    }),
    requirement({
      id: "KR-065",
      text: noManual,
      sourceExcerpt: `KR-065 | ${noManual} | Må | Må avklares i designfase`,
    }),
  ];

  const repaired = applyVerifiedDeterministicControlRepairs({
    ledger: entries,
    answers: entries.map((entry) =>
      normalizeRequirementAnswerResult("Ja.", entry, entry.text),
    ),
  });

  assert.equal(repaired.length, 10);
  for (const [index, answer] of repaired.entries()) {
    const entry = entries[index];
    assert.equal(answer.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(answer.answer, entry),
      [],
      entry.id,
    );
    assert.equal(
      normalizeRequirementAnswerResult(answer.answer, entry, entry.text).source,
      "batch",
      entry.id,
    );
  }

  assert.match(repaired[0].answer, /lager/i);
  assert.match(repaired[1].answer, /prioritet «Kan»/i);
  assert.match(repaired[1].answer, /I designfasen/i);
  assert.match(repaired[2].answer, /ERP/i);
  assert.match(repaired[4].answer, /serviceordre.*komponentdata.*bilder.*sjekklister/i);
  assert.match(repaired[4].answer, /prioritet «Bør»/i);
  assert.match(repaired[4].answer, /produksjonsløsningen/i);
  assert.match(repaired[5].answer, /prioritet «Bør»/i);
  assert.match(repaired[5].answer, /I løsningsforslaget/i);
  assert.match(repaired[6].answer, /sikker datadeling med eksterne aktører/i);
  assert.match(repaired[8].answer, /lav ventetid i kritiske arbeidsprosesser/i);
  assert.match(repaired[9].answer, /prioritet «Må»/i);
  assert.match(repaired[9].answer, /I designfasen/i);
  assert.match(repaired[9].answer, /manuelle regneark brukes ikke/i);

  const metadata = buildDeterministicControlRepairMetadata({
    answers: repaired,
    ledger: entries,
    repairStageByIndex: new Map(
      entries.map((_, index) => [index, "pre_handoff"]),
    ),
  });
  assert.equal(metadata.deterministic_control_repair_answers, 10);
  assert.equal(
    metadata.deterministic_control_repair_answers_before_handoff,
    10,
  );
  assert.equal(
    metadata.deterministic_control_repair_answers_during_handoff,
    0,
  );
  assert.ok(
    metadata.deterministic_control_repair_rows.every(
      (row) => row.repair_stage === "pre_handoff",
    ),
  );
  assert.equal(metadata.manual_review_required, true);
});

test("fallback counters distinguish batch output from actual handoff candidates", () => {
  const batch = [
    { source: "deterministic_fallback" },
    { source: "deterministic_fallback" },
    { source: "batch" },
  ];
  const beforeHandoff = [
    { source: "deterministic_control_repair" },
    { source: "deterministic_fallback" },
    { source: "batch" },
  ];
  const afterHandoff = [
    { source: "deterministic_control_repair" },
    { source: "full_document_handoff" },
    { source: "batch" },
  ];

  assert.deepEqual(
    buildRequirementFallbackStageMetadata({
      afterBatch: batch,
      beforeHandoff,
      afterHandoff,
    }),
    {
      deterministic_fallback_answers_after_batch: 2,
      deterministic_fallback_answers_before_handoff: 1,
      deterministic_fallback_answers_after_handoff: 0,
    },
  );
});

test("backup final repair allowlists only the two known non-material canary qualifiers", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);

  for (const qualifier of [
    "Må avklares i designfase",
    "Gjelder produksjonsløsning",
    "Må Må avklares i designfasen",
    "Bør Må avklares i designfase",
  ]) {
    const entry = requirement({
      id: fixture.id,
      text: fixture.text,
      sourceExcerpt: `${fixture.id} ${fixture.text} ${qualifier}`,
    });
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry })?.source,
      "deterministic_control_repair",
      qualifier,
    );
  }

  const generic = requirement({
    id: "B-1",
    text: "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon.",
    sourceExcerpt:
      "B-1 Det skal finnes rutiner for backup, gjenoppretting og verifikasjon.",
  });
  assert.equal(buildDeterministicFinalRequirementControlRepair({ entry: generic }), null);

  for (const context of [
    { heading: "Opsjoner og tilvalg" },
    { service: "Prises separat" },
    { heading: "Avklares etter kontraktsinngåelse" },
    { heading: "Valgfri del" },
    { service: "Etter kundens valg" },
    { heading: "Etter nærmere avtale" },
    { service: "Forutsetter særskilt godkjenning" },
    { documentTitle: "Opsjoner og tilvalg" },
    { heading: "Kun ved bestilling" },
    { service: "Etter kundens beslutning" },
    { heading: "Ikke inkludert i grunnpris" },
    { documentTitle: "Kommersielle forbehold" },
  ]) {
    const entry = requirement({
      id: fixture.id,
      text: fixture.text,
      sourceExcerpt: `${fixture.id} ${fixture.text}`,
      ...context,
    });
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      JSON.stringify(context),
    );
  }
});

test("backup follow-up may span two adjacent restore-specific sentences", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);
  const splitFollowup = fixture.completeAnswer.replace(
    "og hver restore-test logger resultat, avvik, korrigerende tiltak og retest frem til godkjenning.",
    "Hver restore-test logger resultat og avvik. Korrigerende tiltak utføres, og restore-testen retestes frem til godkjenning.",
  );
  const entry = highConfidenceCoverageEntry(fixture, splitFollowup);

  assert.deepEqual(requirementAnswerQualityIssues(splitFollowup, entry), []);
  assert.equal(
    normalizeRequirementAnswerResult(splitFollowup, entry, entry.text).source,
    "batch",
  );

  for (const validVariant of [
    fixture.completeAnswer.replace(
      "hver restore-test logger resultat",
      "hver restore-test bruker representative testdata og logger resultat",
    ),
    fixture.completeAnswer.replace(
      "retest frem til godkjenning",
      "retest av den korrigerte restore-jobben frem til godkjenning",
    ),
    fixture.completeAnswer.replace(
      "retest frem til godkjenning",
      "gjenopprettingstesten kjøres på nytt frem til godkjenning",
    ),
  ]) {
    const validEntry = highConfidenceCoverageEntry(fixture, validVariant);
    assert.deepEqual(
      requirementAnswerQualityIssues(validVariant, validEntry),
      [],
      validVariant,
    );
  }
});

test("post-strict resolution still preserves control and template provenance", () => {
  for (const fixture of highConfidenceCoverageFixtures) {
    const entry = highConfidenceCoverageEntry(fixture);
    const current = normalizeRequirementAnswerResult("Ja.", entry, entry.text);
    const strictRepair = normalizeRequirementAnswerResult(
      fixture.completeAnswer,
      entry,
      entry.text,
    );
    assert.equal(current.source, "deterministic_fallback", fixture.id);
    assert.equal(strictRepair.source, "batch", fixture.id);
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair,
      }),
      strictRepair,
      fixture.id,
    );
    assert.equal(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair: null,
      }).source,
      "deterministic_control_repair",
      fixture.id,
    );
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current: strictRepair,
        strictRepair: null,
      }),
      strictRepair,
      fixture.id,
    );
  }
});

test("exact control repairs preempt the expensive single-row strict handoff", () => {
  for (const fixture of highConfidenceCoverageFixtures) {
    const entry = highConfidenceCoverageEntry(fixture);
    const current = normalizeRequirementAnswerResult("Ja.", entry, entry.text);
    const resolved = resolveRequirementAnswerBeforeStrictHandoff({
      entry,
      current,
    });

    assert.equal(current.source, "deterministic_fallback", fixture.id);
    assert.equal(resolved.source, "deterministic_control_repair", fixture.id);
  }

  const unrelated = requirement({
    text: "Leverandøren skal dokumentere en månedlig driftsrapport.",
  });
  const unresolved = normalizeRequirementAnswerResult(
    "Ja.",
    unrelated,
    unrelated.text,
  );
  assert.strictEqual(
    resolveRequirementAnswerBeforeStrictHandoff({
      entry: unrelated,
      current: unresolved,
    }),
    unresolved,
  );

  const templateOnly = requirement({
    id: "R-035",
    text: "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.",
    sourceExcerpt:
      "R-035 Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig Må Krever løsningsforslag treghet.",
  });
  const templateFallback = normalizeRequirementAnswerResult(
    "Kapasitetsmodell avklares senere med kunden.",
    templateOnly,
    templateOnly.sourceExcerpt,
  );
  assert.equal(templateFallback.source, "deterministic_fallback");
  assert.equal(
    resolveRequirementAnswerBeforeStrictHandoff({
      entry: templateOnly,
      current: templateFallback,
    }).source,
    "deterministic_control_repair",
  );
  assert.equal(
    resolveRequirementAnswerAfterStrictHandoff({
      entry: templateOnly,
      current: templateFallback,
      strictRepair: null,
    }).source,
    "deterministic_control_repair",
  );
});

test("static reminder and migration repairs fail closed for source-only design or option scope", () => {
  const reminderFixture = highConfidenceCoverageFixtures[0];
  const migrationFixture = highConfidenceCoverageFixtures[1];
  const entries = [
    requirement({
      id: "Uten nummer",
      text: reminderFixture.text,
      heading: "Designavklaring",
      sourceExcerpt: `Kravgrunnlag: ${reminderFixture.text} | Merknad: Må avklares i designfase`,
    }),
    requirement({
      id: "R-032",
      text: migrationFixture.text,
      heading: "Opsjoner og tilvalg",
      service: "Prises separat",
      sourceExcerpt: `Kravgrunnlag: ${migrationFixture.text} | Merknad: Må avklares i designfase`,
    }),
  ];

  for (const entry of entries) {
    const current = normalizeRequirementAnswerResult(
      entry.id === "R-032"
        ? migrationFixture.observedAnswer
        : reminderFixture.observedAnswer,
      entry,
      entry.text,
    );
    assert.equal(current.source, "deterministic_fallback", entry.id);
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      entry.id,
    );
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair: null,
      }),
      current,
      entry.id,
    );
  }
});

test("deterministic control repair fails closed for compound, nonmatching, parameterized, negated and attachment requirements", () => {
  const reminder = highConfidenceCoverageFixtures[0].text;
  const migration = highConfidenceCoverageFixtures[1].text;
  const audit = highConfidenceCoverageFixtures[2].text;
  const backup = highConfidenceCoverageFixtures[3].text;
  const acceptance = highConfidenceCoverageFixtures[4].text;
  const rejected = [
    `${reminder} Løsningen skal også eksportere rapporter som CSV.`,
    "Løsningen skal dokumentere tilgangsstyring.",
    `${reminder} Påminnelsen sendes hver 24. time.`,
    `${backup} RTO skal være 2 timer.`,
    audit.replace("skal logges", "skal ikke logges"),
    `${acceptance} Detaljene følger vedlegg 4.`,
    `${migration} Kravet leveres som valgfritt tilvalg.`,
  ];

  for (const text of rejected) {
    const entry = requirement({ text, sourceExcerpt: text });
    const current = normalizeRequirementAnswerResult("Ja.", entry, text);
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      text,
    );
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair: null,
      }),
      current,
      text,
    );
  }
});

test("deterministic control repair keeps evidence bound to the target ledger row", () => {
  const fixture = highConfidenceCoverageFixtures[2];
  const entry = requirement({
    id: "R-AUD-TARGET",
    text: fixture.text,
    sourceExcerpt: `R-AUD-TARGET | ${fixture.text}`,
    documentId: "requirements-target",
  });
  const repair = buildDeterministicFinalRequirementControlRepair({
    entry,
    evidence: "FOREIGN_DONOR_EVIDENCE",
  });

  assert.ok(repair);
  assert.equal(repair.source, "deterministic_control_repair");
  assert.equal(repair.evidence, entry.sourceExcerpt);
  assert.doesNotMatch(repair.evidence, /FOREIGN_DONOR_EVIDENCE/);
  assert.deepEqual(
    buildDeterministicControlRepairMetadata({
      answers: [repair],
      ledger: [entry],
    }).deterministic_control_repair_rows,
    [
      {
        ref: "R-AUD-TARGET",
        pattern: "audit_change_log",
        order_index: 0,
        source_document_id: "requirements-target",
        source_locator: "Side 1, R-AUD-TARGET",
      },
    ],
  );
});

test("exact API and notification rows receive quality-gated deterministic answer repairs only", () => {
  const fixtures = [
    {
      id: "R-033",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
      pattern: "api_calendar_identity",
    },
    {
      id: "R-021",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og medlemsregister.",
      pattern: "api_membership_register",
    },
    {
      id: "R-040",
      text: "Løsningen skal ha automatisk varsling slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger for frivillig omsorg og besøksvenner.",
      pattern: "automatic_notification_access",
    },
  ];

  for (const fixture of fixtures) {
    const entry = requirement({
      id: fixture.id,
      text: fixture.text,
      sourceExcerpt: fixture.text,
      documentId: "requirements-exact-control",
    });
    const current = normalizeRequirementAnswerResult("Ja.", entry, entry.text);
    assert.equal(current.source, "deterministic_fallback", fixture.id);
    const repaired = resolveRequirementAnswerAfterStrictHandoff({
      entry,
      current,
      strictRepair: null,
    });
    assert.equal(repaired.source, "deterministic_control_repair", fixture.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repaired.answer, entry),
      [],
      fixture.id,
    );
    assert.equal(repaired.evidence, entry.sourceExcerpt, fixture.id);
    assert.deepEqual(
      buildDeterministicControlRepairMetadata({
        answers: [repaired],
        ledger: [entry],
      }).deterministic_control_repair_rows,
      [
        {
          ref: fixture.id,
          pattern: fixture.pattern,
          order_index: 0,
          source_document_id: "requirements-exact-control",
          source_locator: `Side 1, ${fixture.id}`,
        },
      ],
      fixture.id,
    );

    for (const changedText of [
      `${fixture.text} Løsningen skal også slette data innen 30 dager.`,
      `${fixture.text} Leveres bare som valgfritt tilvalg.`,
    ]) {
      const changedEntry = requirement({
        id: fixture.id,
        text: changedText,
        sourceExcerpt: changedText,
      });
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({
          entry: changedEntry,
        }),
        null,
        changedText,
      );
    }
  }
});

test("exact control repairs fail closed when source-only qualifiers change delivery scope", () => {
  const fixtures = [
    {
      id: "R-033",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
    },
    {
      id: "R-021",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og medlemsregister.",
    },
    {
      id: "R-040",
      text: "Løsningen skal ha automatisk varsling slik at frivillige, koordinatorer, mottakere og pårørende bare får tilgang til data de trenger for frivillig omsorg og besøksvenner.",
    },
  ];
  const qualifiers = [
    "Kan prises som opsjon",
    "Leverandøren må avklare omfanget",
    "Dokumentasjon ønskes",
    "Teksten forutsetter at kunden bestiller tilvalget",
  ];

  for (const fixture of fixtures) {
    for (const qualifier of qualifiers) {
      const entry = requirement({
        id: fixture.id,
        text: fixture.text,
        sourceExcerpt: `${fixture.id} | ${fixture.text} | Må | ${qualifier}`,
      });
      const current = normalizeRequirementAnswerResult(
        "Ja.",
        entry,
        entry.sourceExcerpt,
      );

      assert.equal(current.source, "deterministic_fallback");
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({ entry }),
        null,
        `${fixture.id}: ${qualifier}`,
      );
      assert.strictEqual(
        resolveRequirementAnswerBeforeStrictHandoff({ entry, current }),
        current,
        `${fixture.id}: ${qualifier}`,
      );
    }
  }
});

test("field-aware priority parsing preserves Merknad payload and static priority policy", () => {
  const staticFixtures = [
    {
      id: "R-033",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
    },
    {
      id: "R-REM",
      text: highConfidenceCoverageFixtures[0].text,
    },
    {
      id: "R-EXP",
      text: "Kunden skal kunne hente ut oppdrag, frivillige, samtykker, meldinger i et strukturert format ved revisjon eller leverandørbytte.",
    },
  ];

  for (const fixture of staticFixtures) {
    const mandatory = requirement({
      id: fixture.id,
      text: fixture.text,
      sourceExcerpt: `${fixture.id} | ${fixture.text} | Prioritet: Må`,
    });
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry: mandatory })
        ?.source,
      "deterministic_control_repair",
      fixture.id,
    );

    for (const tail of [
      "Prioritet: Bør",
      "Prioritet: Kan",
      "Prioritet: Må | Merknad: Bør",
      "Prioritet: Må | Merknad: Kan",
      "Bør | Merknad: Kan",
    ]) {
      const entry = requirement({
        id: fixture.id,
        text: fixture.text,
        sourceExcerpt: `${fixture.id} | ${fixture.text} | ${tail}`,
      });
      const current = normalizeRequirementAnswerResult(
        "Ja.",
        entry,
        entry.sourceExcerpt,
      );
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({ entry }),
        null,
        `${fixture.id}: ${tail}`,
      );
      assert.strictEqual(
        resolveRequirementAnswerBeforeStrictHandoff({ entry, current }),
        current,
        `${fixture.id}: ${tail}`,
      );
    }
  }
});

test("static deterministic repairs reject every unbound source qualifier", () => {
  const staticFixtures = [
    {
      id: "R-033",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
    },
    {
      id: "R-REM",
      text: highConfidenceCoverageFixtures[0].text,
    },
    {
      id: "R-EXP",
      text: "Kunden skal kunne hente ut oppdrag, frivillige, samtykker, meldinger i et strukturert format ved revisjon eller leverandørbytte.",
    },
  ];
  const qualifiers = [
    "Kan prises som opsjon",
    "Må avklares i designfase",
    "Leveres mot pristillegg",
    "Ikke inkludert i grunnpris",
    "Kun ved særskilt bestilling",
    "Gjelder produksjonsløsningen",
    "Dokumentasjon ønskes",
    "Skal ikke leveres",
    "Løsningen skal også slette data innen 30 dager.",
  ];

  for (const fixture of staticFixtures) {
    for (const qualifier of qualifiers) {
      const entry = requirement({
        id: fixture.id,
        text: fixture.text,
        sourceExcerpt: `${fixture.id} | ${fixture.text} | Må | ${qualifier}`,
      });
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({ entry }),
        null,
        `${fixture.id}: ${qualifier}`,
      );
    }
  }
});

test("dynamic deterministic repairs never erase unsupported Merknad qualifiers", () => {
  const entries = [
    requirement({
      id: "API-1",
      text: "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og lager.",
    }),
    requirement({
      id: "BACKUP-1",
      text: "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.",
    }),
    requirement({
      id: "WORKFLOW-1",
      text: "Brukere som feltteknikere, planleggere og driftssentral skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
    }),
    requirement({
      id: "PERF-1",
      text: "Løsningen skal dimensjoneres for lav ventetid i kritiske arbeidsprosesser uten at brukerne opplever vesentlig treghet.",
    }),
  ].map((entry) => ({
    ...entry,
    sourceExcerpt: `${entry.id} | ${entry.text} | Prioritet: Må | Merknad: Kan`,
  }));

  for (const entry of entries) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      entry.id,
    );
  }
});

test("actual project 001 source chrome binds exact IDs and preserves backup provenance", () => {
  const backupText =
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.";
  const dimensioningText =
    "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";
  const entries = [
    requirement({
      id: "KR-004",
      text: backupText,
      heading: "Drift og support",
      tableId: "DOCX tabell 4",
      documentTitle: "001_Bilag_2_Krav_AuroraFelt_Service_AS",
      sourceExcerpt: `ID / markering: KR-004 | Krav: ${backupText} | Prioritet: Bør | Merknad: Gjelder produksjonsløsning`,
    }),
    requirement({
      id: "KR-022",
      text: dimensioningText,
      heading: "Drift og support",
      documentTitle: "001_Bilag_2_Krav_AuroraFelt_Service_AS",
      sourceExcerpt: `[KR-022] ${dimensioningText}`,
    }),
    requirement({
      id: "KR-064",
      text: backupText,
      heading: "Drift og support",
      documentTitle: "001_Bilag_2_Krav_AuroraFelt_Service_AS",
      sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText}`,
    }),
  ];

  const repairs = entries.map((entry) => {
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.equal(repair?.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repair?.answer ?? "", entry),
      [],
      entry.id,
    );
    return repair;
  });

  assert.match(repairs[0]?.answer ?? "", /prioritet «Bør»/i);
  assert.match(repairs[0]?.answer ?? "", /produksjonsløsningen/i);
  assert.match(
    repairs[1]?.answer ?? "",
    /Ateas tilbudte responstidsmål er p95 under 2 sekunder.*200 samtidige brukere.*Ateas leverandørforutsetning/i,
  );
  assert.match(repairs[2]?.answer ?? "", /kravraden fra behovsarbeidet/i);
});

test("project 001 source-chrome support remains exact and backup-only", () => {
  const backupText =
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.";
  const dimensioningText =
    "Løsningen skal dimensjoneres for sporbarhet fra innmelding til avslutning uten at brukerne opplever vesentlig treghet.";
  const rejected = [
    requirement({
      id: "KR-004",
      text: backupText,
      sourceExcerpt: `ID / markering: KR-999 | Krav: ${backupText} | Prioritet: Bør | Merknad: Gjelder produksjonsløsning`,
    }),
    requirement({
      id: "KR-022",
      text: dimensioningText,
      sourceExcerpt: `[KR-999] ${dimensioningText}`,
    }),
    requirement({
      id: "KR-064",
      text: backupText,
      sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} | Merknad: RTO er 2 timer`,
    }),
    requirement({
      id: "KR-064",
      text: `${backupText} RTO skal være 2 timer.`,
      sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} RTO skal være 2 timer.`,
    }),
    requirement({
      id: "KR-064",
      text: backupText,
      sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} | Merknad: Kan prises som opsjon`,
    }),
    requirement({
      id: "KR-064",
      text: `${backupText} Løsningen skal også slette data etter avslutning.`,
      sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} Løsningen skal også slette data etter avslutning.`,
    }),
    requirement({
      id: "KR-022",
      text: dimensioningText,
      sourceExcerpt: `KR-022 - Notat fra behovsarbeidet: ${dimensioningText}`,
    }),
    ...[
      "not_in_scope",
      "kan_prises_som_opsjon",
      "rto_2_timer",
      "kr_999",
    ].map((residual) =>
      requirement({
        id: "KR-064",
        text: backupText,
        sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} | ${residual}`,
      }),
    ),
    requirement({
      id: "KR-064",
      text: backupText,
      sourceExcerpt: `KR-999 - Notat fra behovsarbeidet: ${backupText}`,
    }),
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.sourceExcerpt}`,
    );
  }
});

const project010ExactParserRows = [
  {
    id: "Notatkrav-01",
    text:
      "leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Notat - Notat fra behovsarbeidet: Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    documentEntryOrder: 6431,
  },
  {
    id: "Notatkrav-02",
    text:
      "leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og LMS.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Notat - Notat fra behovsarbeidet: Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og LMS.",
    documentEntryOrder: 6583,
  },
  {
    id: "FUN-39",
    text:
      "leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    sourceExcerpt:
      "FUN-39 - Notat fra behovsarbeidet: Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    documentEntryOrder: 6722,
  },
  {
    id: "Notatkrav-03",
    text:
      "leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og ID-porten og CRM.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Notat - Notat fra behovsarbeidet: Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og ID-porten og CRM.",
    documentEntryOrder: 6875,
  },
  {
    id: "Dokumenttekst krav 33",
    text:
      "Løsningen skal dimensjoneres for tilgjengelighet for ansatte på mobil og nettbrett uten at brukerne opplever vesentlig treghet.",
    pages: [1],
    heading: "Drift og support",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "[x] Løsningen skal dimensjoneres for tilgjengelighet for ansatte på mobil og nettbrett uten at brukerne opplever vesentlig treghet.",
    documentEntryOrder: 7821,
  },
  {
    id: "FUN-73",
    text:
      "Leverandøren må avklare og beskrive hvordan følgende løses: det skal være mulig å følge status på kurs, prøver, sertifikater, deltakerprofiler fra opprettelse til avslutning.",
    pages: [1],
    heading: "Prioritert kravtabell",
    sourceExcerpt:
      "FUN-73: Leverandøren må avklare og beskrive hvordan følgende løses: det skal være mulig å følge status på kurs, prøver, sertifikater, deltakerprofiler fra opprettelse til avslutning.",
    documentEntryOrder: 2352,
  },
  {
    id: "Dokumenttekst krav 24",
    text:
      "Løsningen skal integreres med ID-porten og CRM og håndtere feil, kø og ny kjøring uten tap av kurs, prøver, sertifikater, deltakerprofiler.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Løsningen skal integreres med ID-porten og CRM og håndtere feil, kø og ny kjøring uten tap av kurs, prøver, sertifikater, deltakerprofiler.",
    documentEntryOrder: 6050,
  },
  {
    id: "FUN-65",
    text:
      "Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte offline-støtte for å gjennomføre digital kursplattform for påmelding, eksamen og sertifikatbevis på en kontrollert og sporbar måte.",
    pages: [1],
    heading: "Notater fra fagansvarlige",
    sourceExcerpt:
      "FUN-65: Leverandøren må avklare og beskrive hvordan følgende løses: løsningen skal støtte offline-støtte for å gjennomføre digital kursplattform for påmelding, eksamen og sertifikatbevis på en kontrollert og sporbar måte.",
    documentEntryOrder: 11329,
  },
  {
    id: "FUN-66",
    text:
      "Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    pages: [],
    heading: "Åpne avklaringer",
    tableId: "DOCX tabell 6",
    sourceExcerpt:
      "ID / markering: FUN-66 | Krav: Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv. | Prioritet: Må | Merknad: Kan prises som opsjon",
    documentEntryOrder: 12820,
  },
  {
    id: "FUN-07",
    text:
      "Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    pages: [],
    heading: "Prioritert kravtabell",
    tableId: "DOCX tabell 1",
    sourceExcerpt:
      "ID / markering: FUN-07 | Krav: Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv. | Prioritet: Kan | Merknad: Må avklares i designfase",
    documentEntryOrder: 414,
  },
  {
    id: "Dokumenttekst krav 3",
    text:
      "Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    pages: [1],
    heading: "Prioritert kravtabell",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    documentEntryOrder: 1232,
  },
  {
    id: "FUN-71",
    text:
      "leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    pages: [1],
    heading: "Notater fra fagansvarlige",
    sourceExcerpt:
      "FUN-71 - Notat fra behovsarbeidet: Leverandøren skal beskrive hvordan løsningen ivaretar lav ventetid i kritiske arbeidsprosesser for kurs og sertifisering for arbeidsliv.",
    documentEntryOrder: 10767,
  },
  {
    id: "Avklaringskrav-07",
    text:
      "leverandøren må avklare og beskrive hvordan følgende løses: det skal være mulig å følge status på kurs, prøver, sertifikater, deltakerprofiler fra opprettelse til avslutning.",
    pages: [1],
    heading: "Åpne avklaringer",
    tableId: "Dokumenttekst",
    sourceExcerpt:
      "Avklaring: Leverandøren må avklare og beskrive hvordan følgende løses: det skal være mulig å følge status på kurs, prøver, sertifikater, deltakerprofiler fra opprettelse til avslutning.",
    documentEntryOrder: 13942,
  },
  {
    id: "FUN-81",
    text:
      "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    pages: [1],
    heading: "Datadeling og grensesnitt",
    sourceExcerpt:
      "[FUN-81] Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og betalingsløsning.",
    documentEntryOrder: 6190,
  },
].map((row) =>
  requirement({
    ...row,
    documentId: "supporting_document",
    documentTitle: "010_Bilag_2_Krav_LaeringsVindu_Akademi_AS",
  }),
);

test("actual project 010 parser rows receive source-bound final repairs", () => {
  const repairs = project010ExactParserRows.map((entry) => {
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.equal(repair?.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repair?.answer ?? "", entry),
      [],
      entry.id,
    );
    return repair;
  });

  for (const repair of repairs.slice(0, 4)) {
    assert.match(repair?.answer ?? "", /kravraden fra behovsarbeidet/i);
    assert.match(repair?.answer ?? "", /foreslått integrasjonskontrakt/i);
    assert.doesNotMatch(
      repair?.answer ?? "",
      /kundens eksisterende|kunden har fastsatt|kundespesifikt endepunkt/i,
    );
  }
  assert.match(repairs[0]?.answer ?? "", /betalingsløsning/i);
  assert.match(repairs[1]?.answer ?? "", /LMS/i);
  assert.equal(repairs[0]?.answer, repairs[2]?.answer);
  assert.match(repairs[3]?.answer ?? "", /ID-porten og CRM/i);
  for (const payment of [repairs[0], repairs[2], repairs[13]]) {
    assert.match(
      payment?.answer ?? "",
      /betalingstransaksjon.*kurspåmelding.*deltakerkobling.*oppgjør.*transaksjons-ID.*påmeldings-ID.*deltaker-ID.*beløp.*valuta.*betalingsstatus.*tidsstempel.*feilkode.*oppgjørsreferanse/is,
    );
    assert.match(
      payment?.answer ?? "",
      /skyplattformen er autoritativ for kurspåmelding.*betalingsløsningen er autoritativt system for betalingstransaksjon/is,
    );
    assert.doesNotMatch(
      payment?.answer ?? "",
      /kundens eksisterende|kunden har fastsatt|kundespesifikt endepunkt/i,
    );
  }
  assert.match(
    repairs[1]?.answer ?? "",
    /kurs.*kursgjennomføring.*deltaker.*prøve.*resultat.*sertifikat.*kurs-ID.*gjennomførings-ID.*deltaker-ID.*prøve-ID.*sertifikat-ID.*påmeldingsstatus.*poengsum.*beståttstatus.*gyldighetsperiode/is,
  );
  assert.match(
    repairs[1]?.answer ?? "",
    /LMS er autoritativt system for kursgjennomføring.*skyplattformen er autoritativ for påmelding.*mottar gjennomføring og resultat.*oppretter sertifikatet.*publiserer sertifikatstatus/is,
  );
  assert.doesNotMatch(repairs[1]?.answer ?? "", /hent(?:er)? sertifikat/i);

  const dimensioning = repairs[4]?.answer ?? "";
  assert.match(
    dimensioning,
    /tilgjengelighet for ansatte på mobil og nettbrett.*logge inn.*åpne arbeidsliste.*lagre endring/i,
  );
  assert.match(
    dimensioning,
    /Ateas tilbudte responstidsmål er p95 under 2 sekunder.*200 samtidige brukere.*Ateas leverandørforutsetning.*bindende akseptansekriterium/i,
  );
  assert.match(
    dimensioning,
    /alle ansattefunksjoner og arbeidsflater.*ikke en avgrensning av leveranseomfanget.*hele ansatteflaten/i,
  );
  assert.match(
    dimensioning,
    /måler Atea de faktiske arbeidsflytene.*topprofilen.*enhets- og nettlesermatrisen.*sammen med kunden.*uttrykkelig avtalt akseptanse- og dimensjoneringsprofil.*minste dimensjoneringsgrunnlag.*ikke fremstilt som kundens volum.*kapasitet- og prisforutsetning.*godkjennes før produksjonssetting/is,
  );
  assert.doesNotMatch(
    dimensioning,
    /ikke et kapasitetstak|ubegrenset kapasitet|kunden har bekreftet|kundebekreftet volum/i,
  );
  assert.doesNotMatch(dimensioning, /kunden krever|kundens responstidsmål/i);

  assert.match(
    repairs[5]?.answer ?? "",
    /kurs opprettet.*publisert.*pågår.*avsluttet.*prøver opprettet.*åpen.*levert.*vurdert.*sertifikater kladd.*utstedt.*deltakerprofiler opprettet.*aktiv.*inaktiv/is,
  );
  assert.match(
    repairs[6]?.answer ?? "",
    /ID-porten.*synkron OIDC.*køes ikke.*CRM.*outbox.*idempotensnøkkel.*dead-letter-kø.*avstemming/is,
  );
  assert.match(
    repairs[7]?.answer ?? "",
    /offline-støtte for alle tre prosessene.*påmelding.*eksamensbesvarelse.*sertifikatgrunnlag.*kryptert lokal kø.*avvikslogg/is,
  );
  assert.match(
    repairs[8]?.answer ?? "",
    /separat priset opsjon.*p95 under 2 sekunder.*200 samtidige brukere.*leverandørforutsetning.*overvåker Atea p95.*varsler ved avvik/is,
  );
  assert.match(repairs[9]?.answer ?? "", /prioritet «Kan».*p95 under 2 sekunder/is);
  assert.match(repairs[9]?.answer ?? "", /I designfasen validerer Atea bare endelig lastprofil/i);
  assert.doesNotMatch(repairs[9]?.answer ?? "", /opsjon/i);
  assert.match(repairs[10]?.answer ?? "", /Atea forplikter lav ventetid.*p95 under 2 sekunder/is);
  assert.doesNotMatch(
    repairs[10]?.answer ?? "",
    /prioritet|designfasen|kravraden fra behovsarbeidet|opsjon/i,
  );
  assert.match(
    repairs[11]?.answer ?? "",
    /kravraden fra behovsarbeidet.*p95 under 2 sekunder/is,
  );
  assert.doesNotMatch(repairs[11]?.answer ?? "", /opsjon|designfasen/i);
  assert.match(
    repairs[12]?.answer ?? "",
    /leverandørens konkrete avklaring.*standardstatuser.*kundespesifikke overgangsregler/is,
  );
});

test("project 010 paid findings fail generation quality until exact source-bound reconciliation", () => {
  const fixtures = [
    {
      entry: project010ExactParserRows[5],
      issue: "incomplete_lifecycle_status_contract",
      weak:
        "Atea legger til grunn en standard livsløpsmodell for kurs, prøver, sertifikater og deltakerprofiler med synlig status, tidsstempel, ansvarlig rolle og historikk fra opprettelse til avslutning. Endelige statusverdier og eventuelle kundespesifikke overgangsregler avklares i design, men funksjonen leveres som del av standardløsningen.",
    },
    {
      entry: project010ExactParserRows[6],
      issue: "incomplete_identity_crm_lossless_contract",
      weak:
        "Atea etablerer integrasjon der kall mot ID-porten og datautveksling mot CRM beskyttes med idempotensnøkkel eller duplikatkontroll, varig kø eller outbox for asynkrone oppdateringer og sporbar logging per transaksjon for kurs, prøver, sertifikater og deltakerprofiler. Feil håndteres med kontrollert retry, dead-letter-kø og operatørstyrt nykjøring fra checkpoint eller avstemming, slik at oppdateringer kan gjenopptas uten datatap.",
    },
    {
      entry: project010ExactParserRows[3],
      issue: "incomplete_identity_crm_api_contract",
      weak:
        "For kravraden fra behovsarbeidet tilbyr Atea som foreslått integrasjonskontrakt et versjonert REST-API over HTTPS mellom skyplattformen og ID-porten og CRM, med OAuth 2.0-klientlegitimasjon, separate scopes for id-porten-lesing, id-porten-skriving, crm-lesing og crm-skriving og operasjonene opprett, hent og oppdater. Datamodellen omfatter dataelementene id-porten-referanse, id-porten-status, crm-referanse og crm-status med nøkkelfeltene id-porten-referanse-ID og crm-referanse-ID og feltmapping av id-porten-referanse, id-porten-status, crm-referanse og crm-status; ID-porten og CRM er hvert sitt system of record.",
    },
    {
      entry: project010ExactParserRows[4],
      issue: "incomplete_employee_mobile_dimensioning_scope",
      weak:
        "Atea dimensjonerer og forplikter tilgjengelighet for ansatte på mobil og nettbrett for operasjonene logge inn, åpne arbeidsliste og lagre endring etter en kapasitetsmodell og ytelsesbaseline som verifiseres med last- og ytelsestest samt provisjonert kapasitet med eksplisitt reservekapasitet. Ateas tilbudte responstidsmål er p95 under 2 sekunder ved en antatt lastprofil på 200 samtidige brukere for de samme operasjonene; både målet og lastprofilen er Ateas leverandørforutsetning, ikke kundekrav fra kilden, og brukes som bindende akseptansekriterium før produksjonssetting.",
    },
    {
      entry: project010ExactParserRows[7],
      issue: "incomplete_offline_tender_workflow",
      weak:
        "Atea foreslår offline-støtte som et kontrollert standardmønster for utvalgte arbeidsflater med forhåndslastede data, for eksempel registrering av fremmøte og prøveresultater ved ustabil dekning. Endringer lagres lokalt med tidsstempel og brukeridentitet og synkroniseres ved gjenopprettet forbindelse; manglende, ugyldige eller konfliktende oppdateringer settes i avvikskø for manuell behandling.",
    },
    {
      entry: project010ExactParserRows[8],
      issue: "incomplete_low_latency_tender_contract",
      weak:
        "Atea ivaretar lav ventetid ved å legge kritiske arbeidsprosesser som påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat i lette, transaksjonsnære arbeidsflater, mens tyngre jobber håndteres asynkront i bakgrunnen. Akseptkriterier for svartid foreslås før produksjonssetting; dersom kunden ønsker dette håndtert kommersielt som opsjon, kan samme løsningsmønster avgrenses uten å endre kjerneløsningen.",
    },
  ];

  for (const fixture of fixtures) {
    const weakResult = normalizeRequirementAnswerResult(
      fixture.weak,
      fixture.entry,
      fixture.entry.sourceExcerpt,
    );
    assert.equal(weakResult.source, "deterministic_fallback", fixture.entry.id);
    assert.match(weakResult.reason ?? "", new RegExp(fixture.issue), fixture.entry.id);
    assert.match(
      buildRequirementRepairDirective(fixture.entry, weakResult.reason),
      new RegExp(fixture.issue === "incomplete_employee_mobile_dimensioning_scope"
        ? "alle ansattefunksjoner"
        : fixture.issue === "incomplete_identity_crm_api_contract"
          ? "OIDC Authorization Code"
          : fixture.issue === "incomplete_identity_crm_lossless_contract"
            ? "synkrone OIDC"
            : fixture.issue === "incomplete_lifecycle_status_contract"
              ? "standardstatuser"
              : fixture.issue === "incomplete_offline_tender_workflow"
                ? "kryptert lokal kø"
                : "separat priset opsjon", "i"),
      fixture.entry.id,
    );

    const repair = buildDeterministicFinalRequirementControlRepair({
      entry: fixture.entry,
      evidence: fixture.entry.sourceExcerpt,
    });
    assert.equal(repair?.source, "deterministic_control_repair", fixture.entry.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repair?.answer ?? "", fixture.entry),
      [],
      fixture.entry.id,
    );
  }
});

test("project 010 paid-finding reconciliation fails closed on altered source scope", () => {
  const lifecycle = project010ExactParserRows[5];
  const lossless = project010ExactParserRows[6];
  const offline = project010ExactParserRows[7];
  const lowLatency = project010ExactParserRows[8];
  const rejected = [
    {
      ...lifecycle,
      sourceExcerpt: `${lifecycle.sourceExcerpt} | Merknad: Statusverdier følger vedlegg 9`,
    },
    {
      ...lossless,
      sourceExcerpt: `${lossless.sourceExcerpt} | Merknad: CRM-kø eies av kunden`,
    },
    {
      ...offline,
      sourceExcerpt: `${offline.sourceExcerpt} | Merknad: Kan prises som opsjon`,
    },
    { ...lowLatency, id: "FUN-67" },
    { ...lowLatency, heading: "Opsjoner og tilvalg" },
    { ...lowLatency, tableId: "DOCX tabell 7" },
    {
      ...lowLatency,
      sourceExcerpt: lowLatency.sourceExcerpt.replace(
        "Merknad: Kan prises som opsjon",
        "Merknad: Kundens mål er p95 under 1 sekund",
      ),
    },
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.sourceExcerpt}`,
    );
  }
});

test("project 010 duplicate requirement contexts preserve their own source qualifiers", () => {
  const fun07 = project010ExactParserRows[9];
  const plain = project010ExactParserRows[10];
  const needsNote = project010ExactParserRows[11];
  const clarification = project010ExactParserRows[12];
  const weakLowLatency =
    "Atea ivaretar lav ventetid ved å legge kritiske arbeidsprosesser som påmelding, statusoppslag, registrering av prøveresultater og utstedelse av sertifikat i lette, transaksjonsnære arbeidsflater, mens tyngre jobber håndteres asynkront i bakgrunnen. Akseptkriterier for svartid foreslås før produksjonssetting.";
  const weakLifecycle =
    "Atea løser dette med en felles statusmodell for kurs, prøver, sertifikater og deltakerprofiler fra opprettelse til avslutning. Løsningen viser gjeldende status, historikk, ansvarlig rolle og dato for siste endring.";

  for (const entry of [fun07, plain, needsNote]) {
    const weak = normalizeRequirementAnswerResult(
      weakLowLatency,
      entry,
      entry.sourceExcerpt,
    );
    assert.equal(weak.source, "deterministic_fallback", entry.id);
    assert.match(weak.reason ?? "", /incomplete_low_latency_tender_contract/);
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.equal(repair?.source, "deterministic_control_repair", entry.id);
    assert.deepEqual(
      requirementAnswerQualityIssues(repair?.answer ?? "", entry),
      [],
      entry.id,
    );
  }

  const weakClarification = normalizeRequirementAnswerResult(
    weakLifecycle,
    clarification,
    clarification.sourceExcerpt,
  );
  assert.equal(weakClarification.source, "deterministic_fallback");
  assert.match(
    weakClarification.reason ?? "",
    /incomplete_lifecycle_status_contract/,
  );
  const repairedClarification = buildDeterministicFinalRequirementControlRepair({
    entry: clarification,
  });
  assert.equal(repairedClarification?.source, "deterministic_control_repair");
  assert.deepEqual(
    requirementAnswerQualityIssues(
      repairedClarification?.answer ?? "",
      clarification,
    ),
    [],
  );

  const altered = [
    {
      ...fun07,
      sourceExcerpt: `${fun07.sourceExcerpt} | Merknad: Kan prises som opsjon`,
    },
    {
      ...plain,
      sourceExcerpt: `${plain.sourceExcerpt} | Merknad: Kan prises som opsjon`,
    },
    {
      ...needsNote,
      sourceExcerpt: `${needsNote.sourceExcerpt} | Kundens mål er p95 under 1 sekund`,
    },
    { ...clarification, id: "Avklaringskrav-08" },
    { ...clarification, heading: "Andre avklaringer" },
    { ...clarification, tableId: "Annen tabell" },
    {
      ...clarification,
      sourceExcerpt: `${clarification.sourceExcerpt} | Merknad: Statusverdier følger vedlegg 9`,
    },
  ];
  for (const entry of altered) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      `${entry.id}: ${entry.sourceExcerpt}`,
    );
  }
});

test("project 010 payment and LMS contracts reject thin, unsafe, negated and direction-conflicting variants", () => {
  const paymentEntries = [
    project010ExactParserRows[0],
    project010ExactParserRows[2],
    project010ExactParserRows[13],
  ];
  const lmsEntry = project010ExactParserRows[1];
  const thinPayment =
    "Atea tilbyr et versjonert REST-API over HTTPS mot betalingsløsning med OAuth 2.0-klientlegitimasjon og operasjonene opprett, hent og oppdater. Datamodellen omfatter betalingsløsning-referanse og betalingsløsning-status med referanse-ID og feltmapping; betalingsløsningen er master og ugyldige data sendes til feilkø.";
  const thinLms =
    "Atea tilbyr et versjonert REST-API over HTTPS mot LMS med OAuth 2.0-klientlegitimasjon og LMS-lesing og LMS-skriving. Datamodellen omfatter LMS-referanse og LMS-status med referanse-ID og feltmapping; LMS er master og ugyldige data sendes til feilkø.";

  for (const entry of paymentEntries) {
    const weak = normalizeRequirementAnswerResult(
      thinPayment,
      entry,
      entry.sourceExcerpt,
    );
    assert.equal(weak.source, "deterministic_fallback", entry.id);
    assert.match(weak.reason ?? "", /incomplete_payment_api_contract/);
    assert.match(
      buildRequirementRepairDirective(entry, weak.reason),
      /betalingstransaksjon.*kurspåmelding.*deltakerkobling.*oppgjør/is,
    );
  }
  const weakLms = normalizeRequirementAnswerResult(
    thinLms,
    lmsEntry,
    lmsEntry.sourceExcerpt,
  );
  assert.equal(weakLms.source, "deterministic_fallback");
  assert.match(weakLms.reason ?? "", /incomplete_lms_api_contract/);
  assert.match(
    buildRequirementRepairDirective(lmsEntry, weakLms.reason),
    /kursgjennomføring.*deltaker.*prøve.*resultat.*sertifikat/is,
  );

  const paymentRepair = buildDeterministicFinalRequirementControlRepair({
    entry: paymentEntries[0],
  });
  const lmsRepair = buildDeterministicFinalRequirementControlRepair({
    entry: lmsEntry,
  });
  assert.ok(paymentRepair);
  assert.ok(lmsRepair);
  const rejectedAnswers = [
    {
      entry: paymentEntries[0],
      issue: "incomplete_payment_api_contract",
      answer: `${paymentRepair.answer} API-et bruker ubegrenset admin-scope.`,
    },
    {
      entry: paymentEntries[0],
      issue: "incomplete_payment_api_contract",
      answer: paymentRepair.answer.replace(
        "betalingsløsningen er autoritativt system",
        "betalingsløsningen er ikke autoritativt system",
      ),
    },
    {
      entry: lmsEntry,
      issue: "incomplete_lms_api_contract",
      answer: `${lmsRepair.answer} LMS-integrasjonen bruker ubegrenset admin-scope.`,
    },
    {
      entry: lmsEntry,
      issue: "incomplete_lms_api_contract",
      answer: lmsRepair.answer
        .replace("publiser sertifikatstatus", "hent sertifikat")
        .replace(
          "publiserer sertifikatstatus og referanse til LMS",
          "mottar sertifikatstatus fra LMS",
        ),
    },
  ];
  for (const fixture of rejectedAnswers) {
    const issues = requirementAnswerQualityIssues(fixture.answer, fixture.entry);
    assert.ok(issues.includes(fixture.issue), fixture.answer);
    assert.equal(
      normalizeRequirementAnswerResult(
        fixture.answer,
        fixture.entry,
        fixture.entry.sourceExcerpt,
      ).source,
      "deterministic_fallback",
    );
  }

  for (const entry of [paymentEntries[0], lmsEntry]) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({
        entry: {
          ...entry,
          sourceExcerpt: `${entry.sourceExcerpt} | Kunden har fastsatt feltene kundenummer og avtalenummer`,
        },
      }),
      null,
      entry.id,
    );
  }
});

test("project 010 mobile supplier baseline remains bounded and evaluator Uklart is never promoted", () => {
  const source = project010ExactParserRows[4];
  const repair = buildDeterministicFinalRequirementControlRepair({ entry: source });
  assert.equal(repair?.source, "deterministic_control_repair");
  const entry = {
    ...source,
    answerExcerpt: repair?.answer,
    answerDocumentId: "solution",
    answerReference: source.id,
  };
  const corrected = correctCoverageAssessmentWithSourceEvidence({
    entry,
    assessment: "Uklart",
    rationale:
      "Kundens faktiske topprofil og enhetsmatrise må fortsatt valideres før endelig dimensjonering.",
    evidence: repair?.answer ?? "",
    recommendation:
      "Avtal topprofil og enhetsmatrise som akseptanseprofil før produksjonssetting.",
  });
  assert.equal(corrected.assessment, "Uklart");
  assert.match(corrected.rationale, /faktiske topprofil/);
  assert.doesNotMatch(
    repair?.answer ?? "",
    /ikke et kapasitetstak|ubegrenset kapasitet|kunden har bekreftet|kundebekreftet volum/i,
  );
});

test("project 010 source-bound repairs reject altered notes and dimensioning scope", () => {
  const api = project010ExactParserRows[0];
  const dimensioning = project010ExactParserRows[4];
  const rejected = [
    {
      ...api,
      sourceExcerpt: api.sourceExcerpt + " | Merknad: Kan prises som opsjon",
    },
    {
      ...api,
      sourceExcerpt: api.sourceExcerpt.replace(
        "Notat - Notat fra behovsarbeidet",
        "Workshopnotat fra behovsarbeidet",
      ),
    },
    {
      ...api,
      sourceExcerpt:
        api.sourceExcerpt +
        " Kunden har fastsatt feltene kundenummer og avtalenummer.",
    },
    {
      ...api,
      heading: "Opsjoner og tilvalg",
    },
    {
      ...api,
      text:
        "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og LMS og CRM og ID-porten.",
      sourceExcerpt:
        "Notat - Notat fra behovsarbeidet: Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og LMS og CRM og ID-porten.",
    },
    {
      ...dimensioning,
      sourceExcerpt: dimensioning.sourceExcerpt.replace("[x]", "[ ]"),
    },
    {
      ...dimensioning,
      sourceExcerpt: dimensioning.sourceExcerpt + " Kan prises som opsjon.",
    },
    {
      ...dimensioning,
      sourceExcerpt:
        dimensioning.sourceExcerpt +
        " Kundens mål er p95 under 1 sekund.",
    },
    {
      ...dimensioning,
      text:
        "Løsningen skal dimensjoneres for tilgjengelighet for konsulenter på mobil og nettbrett uten at brukerne opplever vesentlig treghet.",
      sourceExcerpt:
        "[x] Løsningen skal dimensjoneres for tilgjengelighet for konsulenter på mobil og nettbrett uten at brukerne opplever vesentlig treghet.",
    },
    {
      ...dimensioning,
      tableId: "Annen tabell",
    },
  ];

  for (const entry of rejected) {
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      entry.id + ": " + entry.sourceExcerpt,
    );
  }
});

test("backup needs-note copy composes priority and production scope without weakening residual checks", () => {
  const backupText =
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.";

  for (const priority of ["Må", "Bør", "Kan"]) {
    for (const production of [false, true]) {
      const entry = requirement({
        id: "KR-064",
        text: backupText,
        sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} | Prioritet: ${priority}${
          production ? " | Merknad: Gjelder produksjonsløsning" : ""
        }`,
      });
      const repair = buildDeterministicFinalRequirementControlRepair({ entry });
      assert.equal(
        repair?.source,
        "deterministic_control_repair",
        `${priority}/${production}`,
      );
      assert.match(repair?.answer ?? "", /kravraden fra behovsarbeidet/i);
      assert.match(
        repair?.answer ?? "",
        new RegExp(`med prioritet «${priority}»`, "i"),
      );
      if (production) {
        assert.match(repair?.answer ?? "", /for produksjonsløsningen/i);
      }
      assert.doesNotMatch(
        repair?.answer ?? "",
        /for produksjonsløsningen for raden med prioritet/i,
      );
      assert.deepEqual(
        requirementAnswerQualityIssues(repair?.answer ?? "", entry),
        [],
      );
    }
  }

  const optionalEntry = requirement({
    id: "KR-064",
    text: backupText,
    sourceExcerpt: `KR-064 - Notat fra behovsarbeidet: ${backupText} | Prioritet: Kan`,
  });
  const committed = buildDeterministicFinalRequirementControlRepair({
    entry: optionalEntry,
  });
  assert.ok(committed);
  const weakened = committed.answer.replace(
    "etablerer og drifter Atea",
    "kan Atea etablere og drifte",
  );
  assert.ok(
    requirementAnswerQualityIssues(weakened, optionalEntry).includes(
      "incomplete_backup_restore_verification",
    ),
  );
});

test("deterministic repair context safety covers every source context field", () => {
  const routeFixtures = [
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og kalender og identitet.",
    highConfidenceCoverageFixtures[0].text,
    "Det skal finnes rutiner for backup, gjenoppretting og verifikasjon av serviceordre, komponentdata, bilder, sjekklister.",
    "Kunden skal kunne hente ut oppdrag, frivillige, samtykker, meldinger i et strukturert format ved revisjon eller leverandørbytte.",
    "Leverandøren skal beskrive API, autentisering og datamodell for utveksling mellom skyplattformen og lager.",
    "Brukere som feltteknikere, planleggere og driftssentral skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
    "Løsningen skal dimensjoneres for lav ventetid i kritiske arbeidsprosesser uten at brukerne opplever vesentlig treghet.",
  ];
  const unsafeContexts = [
    { id: "Opsjon ID 1" },
    { heading: "Opsjoner og tilvalg" },
    { service: "Ikke inkludert i grunnpris" },
    { tableId: "Tilvalgstabell" },
    { documentTitle: "Kommersielle forbehold" },
  ];

  for (const text of routeFixtures) {
    for (const context of unsafeContexts) {
      const entry = requirement({
        id: "SAFE-ID",
        heading: "Krav",
        text,
        sourceExcerpt: text,
        ...context,
      });
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({ entry }),
        null,
        `${text}: ${JSON.stringify(context)}`,
      );
    }
  }
});

test("dimensioning dynamic qualifiers are reflected and production grammar has an actor", () => {
  const text =
    "Løsningen skal dimensjoneres for lav ventetid i kritiske arbeidsprosesser uten at brukerne opplever vesentlig treghet.";

  for (const priority of ["Bør", "Kan"]) {
    const entry = requirement({
      id: "PERF-1",
      text,
      sourceExcerpt: `PERF-1 | ${text} | Prioritet: ${priority}`,
    });
    const repair = buildDeterministicFinalRequirementControlRepair({ entry });
    assert.equal(repair?.source, "deterministic_control_repair", priority);
    assert.match(repair?.answer ?? "", new RegExp(`prioritet «${priority}»`, "i"));
    assert.deepEqual(requirementAnswerQualityIssues(repair?.answer ?? "", entry), []);
  }

  const production = requirement({
    id: "PERF-1",
    text,
    sourceExcerpt: `PERF-1 | ${text} | Prioritet: Må | Gjelder produksjonsløsningen`,
  });
  const productionRepair = buildDeterministicFinalRequirementControlRepair({
    entry: production,
  });
  assert.equal(productionRepair?.source, "deterministic_control_repair");
  assert.match(
    productionRepair?.answer ?? "",
    /I løsningsforslaget for produksjonsløsningen dimensjonerer og forplikter Atea/i,
  );
  assert.deepEqual(
    requirementAnswerQualityIssues(productionRepair?.answer ?? "", production),
    [],
  );

  const proposal = requirement({
    id: "PERF-1",
    text,
    sourceExcerpt: `PERF-1 | ${text} | Må | Krever løsningsforslag`,
  });
  const proposalRepair = buildDeterministicFinalRequirementControlRepair({
    entry: proposal,
  });
  assert.equal(proposalRepair?.source, "deterministic_control_repair");
  assert.match(proposalRepair?.answer ?? "", /I løsningsforslaget/i);
});

test("actual R-043 reduction is replaced by an exact no-manual-spreadsheet control", () => {
  const entry = requirement({
    id: "R-043",
    text: "Brukere som frivillige, koordinatorer, mottakere og pårørende skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
    heading: "Felles arbeidsflate",
    documentId: "requirements-r043",
    sourceExcerpt:
      "Brukere som frivillige, koordinatorer, mottakere og pårørende skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.",
  });
  const reducedAnswer =
    "Løsningen reduserer dobbeltregistrering og behovet for manuelle regneark gjennom integrasjoner og et felles datagrunnlag.";
  const current = normalizeRequirementAnswerResult(
    reducedAnswer,
    entry,
    entry.text,
  );

  assert.equal(current.source, "deterministic_fallback");
  assert.match(current.reason, /does_not_eliminate_manual_spreadsheets/);
  const repaired = resolveRequirementAnswerAfterStrictHandoff({
    entry,
    current,
    strictRepair: null,
  });
  assert.equal(repaired.source, "deterministic_control_repair");
  assert.equal(
    repaired.answer,
    "Atea tilbyr en arbeidsflyt der frivillige, koordinatorer, mottakere og pårørende utfører oppgaver, registrering og oppfølging direkte i løsningen. Oppgaver opprettes og oppdateres i det felles datagrunnlaget, data registreres én gang og deles mellom brukergruppenes arbeidsflyter; manuelle regneark brukes ikke.",
  );
  assert.equal(repaired.evidence, entry.text);
  assert.deepEqual(requirementAnswerQualityIssues(repaired.answer, entry), []);
  assert.doesNotMatch(repaired.answer, /\b(?:reduser|minimer)\w*/i);
  assert.doesNotMatch(repaired.answer, /\bintegrasjon\w*/i);
  assert.deepEqual(
    buildDeterministicControlRepairMetadata({
      answers: [repaired],
      ledger: [entry],
    }),
    {
      deterministic_control_repair_answers: 1,
      deterministic_control_repair_refs: ["R-043"],
      deterministic_control_repair_rows: [
        {
          ref: "R-043",
          pattern: "no_manual_spreadsheet",
          order_index: 0,
          source_document_id: "requirements-r043",
          source_locator: "Side 1, R-043",
        },
      ],
      manual_review_required: true,
      manual_review_note:
        "Deterministisk kontrolltekst er brukt for disse kravradene og krever manuell gjennomgang og kundetilpasning før innlevering.",
    },
  );
});

test("no-manual-spreadsheet repair rejects qualified or compound requirement text", () => {
  const base =
    "Brukere som frivillige, koordinatorer, mottakere og pårørende skal kunne utføre oppgaver i løsningen uten dobbeltregistrering i manuelle regneark.";
  const rejected = [
    `${base} Målet er å redusere bruken av regneark.`,
    `${base} Bruken av regneark skal minimeres.`,
    base.replace("skal kunne", "skal ikke kunne"),
    `${base} Løsningen skal også støtte lønnskjøring.`,
    `${base} Detaljer følger vedlegg 4.`,
    `${base} Se R-044 for avgrensning.`,
    `${base} Maksimalt 2 registreringer per sak.`,
  ];

  for (const text of rejected) {
    const entry = requirement({
      id: "R-043",
      text,
      sourceExcerpt: text,
    });
    const current = normalizeRequirementAnswerResult("Ja.", entry, text);
    assert.equal(
      buildDeterministicFinalRequirementControlRepair({ entry }),
      null,
      text,
    );
    assert.strictEqual(
      resolveRequirementAnswerAfterStrictHandoff({
        entry,
        current,
        strictRepair: null,
      }),
      current,
      text,
    );
  }
});

test("five high-confidence control patterns expose exact checklists and deterministic repairs", () => {
  const weakObservedRows = new Set([
    "Dokumenttekst krav 2",
    "R-032",
    "R-022",
    "R-011",
  ]);

  for (const fixture of highConfidenceCoverageFixtures) {
    const observedEntry = highConfidenceCoverageEntry(
      fixture,
      fixture.observedAnswer,
    );
    const observedIssues = requirementAnswerQualityIssues(
      fixture.observedAnswer,
      observedEntry,
    );
    if (weakObservedRows.has(fixture.id)) {
      assert.ok(
        observedIssues.includes(fixture.issue),
        `${fixture.id}: ${observedIssues.join(",")}`,
      );
      assert.equal(
        normalizeRequirementAnswerResult(
          fixture.observedAnswer,
          observedEntry,
          observedEntry.text,
        ).source,
        "deterministic_fallback",
      );
    } else {
      assert.deepEqual(observedIssues, [], fixture.id);
      assert.equal(
        normalizeRequirementAnswerResult(
          fixture.observedAnswer,
          observedEntry,
          observedEntry.text,
        ).source,
        "batch",
      );
    }

    const completeEntry = highConfidenceCoverageEntry(fixture);
    assert.deepEqual(
      requirementAnswerQualityIssues(fixture.completeAnswer, completeEntry),
      [],
      fixture.id,
    );
    assert.equal(
      normalizeRequirementAnswerResult(
        fixture.completeAnswer,
        completeEntry,
        completeEntry.text,
      ).source,
      "batch",
      fixture.id,
    );

    const [registryRow] = buildRequirementResponseBatchRegistry([
      completeEntry,
    ]);
    assert.match(
      registryRow.obligatorisk_svarstruktur,
      fixture.checklist,
      fixture.id,
    );
    assert.match(
      buildRequirementRepairDirective(
        completeEntry,
        `quality_gate: ${fixture.issue}`,
      ),
      fixture.repair,
      fixture.id,
    );
  }
});

test("historical migration mapping and data-quality deferrals remain core-scope failures", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-032",
  );
  assert.ok(fixture);
  const entry = highConfidenceCoverageEntry(fixture);
  const answers = [
    fixture.observedAnswer,
    "Atea gjennomfører testlast og validering med avviksrapport før produksjonssetting. Eksakt datamapping avklares i designfasen, før avvik korrigeres og retestes for godkjenning.",
    "Atea etablerer feltmapping, testlast, validering og avviksrapport. Datakvalitetsavvik avklares med kunden før korrigering, retest og godkjenning.",
  ];

  for (const answer of answers) {
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes("deferred_core_scope"),
      `${answer}: ${issues.join(",")}`,
    );
  }
});

test("exact complete control evidence preserves bound Uklart or Dårlig evaluator assessments", () => {
  for (const fixture of highConfidenceCoverageFixtures) {
    const entry = highConfidenceCoverageEntry(fixture);
    for (const assessment of ["Uklart", "Dårlig"]) {
      const corrected = correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment,
        rationale: `Modellen vurderte ${fixture.id} som ${assessment}.`,
        evidence: fixture.completeAnswer,
        recommendation: "Legg til udokumentert ekstraomfang.",
      });

      assert.equal(corrected.assessment, assessment, `${fixture.id}: ${assessment}`);
      assert.equal(
        corrected.rationale,
        `Modellen vurderte ${fixture.id} som ${assessment}.`,
        fixture.id,
      );
      assert.ok(
        fixture.completeAnswer.startsWith(corrected.evidence.replace(/…$/, "")),
        fixture.id,
      );
      assert.equal(
        corrected.recommendation,
        "Legg til udokumentert ekstraomfang.",
      );
    }
  }
});

test("incomplete observed reminder, migration and audit rows are never promoted", () => {
  for (const fixture of highConfidenceCoverageFixtures.slice(0, 3)) {
    const entry = highConfidenceCoverageEntry(
      fixture,
      fixture.observedAnswer,
    );
    for (const assessment of ["Uklart", "Dårlig"]) {
      assert.notEqual(
        correctCoverageAssessmentWithSourceEvidence({
          entry,
          assessment,
          rationale: "Modellens opprinnelige vurdering.",
          evidence: fixture.observedAnswer,
          recommendation: "Fullfør kontrollkjeden.",
        }).assessment,
        "Godt",
        `${fixture.id}: ${assessment}`,
      );
    }
  }
});

test("explicitly negated mandatory signals fail every high-confidence quality gate", () => {
  const cases = [
    ["Dokumenttekst krav 2", "Det brukes ingen påminnelsesregel eller trigger."],
    ["Dokumenttekst krav 2", "Utsendelse og status logges ikke."],
    ["R-032", "Det brukes ingen feltmapping."],
    ["R-032", "Avvik korrigeres ikke før produksjonssetting."],
    ["R-022", "Atea logger og lagrer ikke gammel og ny verdi."],
    ["R-022", "Atea bruker ikke bruker- eller tjenesteidentitet."],
    ["R-011", "Det finnes ingen backup-rutine eller runbook."],
    ["R-011", "Restore-test gjennomføres ikke."],
    ["R-024", "Akseptansetesten dekker ikke brukerroller."],
    ["R-024", "Retest gjennomføres ikke."],
  ];

  for (const [id, contradiction] of cases) {
    const fixture = highConfidenceCoverageFixtures.find(
      (candidate) => candidate.id === id,
    );
    assert.ok(fixture);
    const answer = `${fixture.completeAnswer} ${contradiction}`;
    const entry = highConfidenceCoverageEntry(fixture, answer);
    const issues = requirementAnswerQualityIssues(answer, entry);
    assert.ok(
      issues.includes(fixture.issue),
      `${id}: ${contradiction}: ${issues.join(",")}`,
    );
    assert.notEqual(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Den negative klausulen må respekteres.",
        evidence: answer,
        recommendation: "Fjern motsetningen.",
      }).assessment,
      "Godt",
      `${id}: ${contradiction}`,
    );
  }
});

test("anaphoric, optional and conditional language blocks deterministic promotion", () => {
  const blockers = [
    "Dette gjennomføres likevel ikke.",
    "Kontrollen utføres aldri.",
    "Et obligatorisk felt utelates.",
    "Kontrollen er valgfri.",
    "Dette leveres ved behov.",
    "Dette leveres dersom funksjonen er tilgjengelig.",
    "Dette kan leveres senere.",
    "This control may be omitted.",
    "This is optional and not committed.",
    "Auditloggen vil inneholde de obligatoriske feltene.",
    "Auditloggen forventes å inneholde de obligatoriske feltene.",
    "Som hovedregel gjennomføres kontrollen.",
    "Kontrollen gjennomføres så langt det er mulig.",
    "Atea tar sikte på å gjennomføre kontrollen.",
    "Atea tilstreber å gjennomføre kontrollen.",
  ];

  for (const fixture of highConfidenceCoverageFixtures) {
    for (const blocker of blockers) {
      const answer = `${fixture.completeAnswer} ${blocker}`;
      const entry = highConfidenceCoverageEntry(fixture, answer);
      assert.notEqual(
        correctCoverageAssessmentWithSourceEvidence({
          entry,
          assessment: "Dårlig",
          rationale: "Svak eller betinget forpliktelse.",
          evidence: answer,
          recommendation: "Gjør forpliktelsen entydig.",
        }).assessment,
        "Godt",
        `${fixture.id}: ${blocker}`,
      );
    }
  }
});

test("strict provenance guards remain fail-closed without promoting a valid Uklart row", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-022",
  );
  assert.ok(fixture);
  const invalidReferences = [
    "R-0220",
    "R-022-A",
    "R-022.1",
    "R-022/1",
    "R-022_old",
    "R-022,R-023",
    "R-023,R-022",
    "R-999,R-022",
    "Forbedret kravsvar, Side 1, R-999, R-022",
    "R-999/R-022",
    "R-022,R-022",
  ];
  for (const answerReference of invalidReferences) {
    const entry = {
      ...highConfidenceCoverageEntry(fixture),
      answerReference,
    };
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Radidentiteten er ikke eksakt.",
        evidence: fixture.completeAnswer,
        recommendation: "Bind svaret til én eksakt rad.",
      }).assessment,
      "Uklart",
      answerReference,
    );
  }

  const namedFixture = { ...fixture, id: "R-AUD" };
  for (const answerReference of ["R-AUD0", "R-AUD-A"]) {
    const entry = {
      ...highConfidenceCoverageEntry(namedFixture),
      answerReference,
    };
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Radidentiteten er ikke eksakt.",
        evidence: fixture.completeAnswer,
        recommendation: "Bruk eksakt radidentitet.",
      }).assessment,
      "Uklart",
      answerReference,
    );
  }

  const blankDocumentIdentity = {
    ...highConfidenceCoverageEntry(fixture),
    answerDocumentId: " \t ",
  };
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: blankDocumentIdentity,
      assessment: "Uklart",
      rationale: "Dokumentidentiteten mangler.",
      evidence: fixture.completeAnswer,
      recommendation: "Oppgi dokumentidentitet.",
    }).assessment,
    "Uklart",
  );

  for (const tableId of ["PDF krav-ID", "Dokumenttekst", "T-99"]) {
    const genericTableReference = {
      ...highConfidenceCoverageEntry(fixture),
      tableId,
      answerReference: tableId,
    };
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry: genericTableReference,
        assessment: "Uklart",
        rationale: "Tabellnavnet er ikke en radidentitet.",
        evidence: fixture.completeAnswer,
        recommendation: "Bruk eksakt krav-ID.",
      }).assessment,
      "Uklart",
      tableId,
    );
  }

  const mergedReference = {
    ...highConfidenceCoverageEntry(fixture),
    answerReference:
      "Forbedret kravsvar, Side 1, Kravbesvarelse, Markdown kravbesvarelse, R-022",
  };
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: mergedReference,
      assessment: "Uklart",
      rationale: "Den siste referansedelen identifiserer eksakt rad.",
      evidence: fixture.completeAnswer,
      recommendation: "Behold sporbarheten.",
    }).assessment,
    "Uklart",
  );
});

test("source-only option, external evidence and post-award deferral block all five patterns", () => {
  const sourceBlockers = [
    "Kravet er en opsjon.",
    "Dette er et valgfritt tilvalg.",
    "Leveransen prises separat.",
    "Bevis finnes i separat dokument 4.",
    "Dokumentasjon finnes i SharePoint via lenke https://example.invalid/4.",
    "Kontrollvalget besluttes etter kontraktsinngåelse.",
    "Løsningen bestemmes i en senere prosjektfase.",
    "Mekanismen velges etter kontraktstildeling.",
    "Detaljene fastsettes i designfasen.",
    "Omfanget bestemmes ved oppstart.",
    "Løsningen velges senere.",
    "Kontrollen avklares med kunden.",
    "Mekanismen besluttes under detaljprosjektering.",
    "Detaljene er TBD.",
    "Dokumentasjonen ettersendes.",
    "Kontrollen er under utarbeidelse.",
    "Omfanget avtales senere.",
    "Kundens godkjenning avventes.",
    "Forutsetter senere avklaring.",
    "Se separat PDF.",
    "Bevis finnes i kontrollmatrise.xlsx.",
    "Dokumentasjon finnes i OneDrive.",
    "Detaljene ligger i Teams.",
    "Se kundens dokumentportal.",
    "Leveres som tilleggstjeneste.",
    "Krever separat bestilling.",
    "Kunden kan velge kontrollen bort.",
    "Ikke inkludert i basisleveransen.",
    "Tilbys kun ved særskilt bestilling.",
  ];

  for (const fixture of highConfidenceCoverageFixtures) {
    for (const blocker of sourceBlockers) {
      const entry = highConfidenceCoverageEntry(
        fixture,
        fixture.completeAnswer,
        `${fixture.text} ${blocker}`,
      );
      assert.equal(
        correctCoverageAssessmentWithSourceEvidence({
          entry,
          assessment: "Uklart",
          rationale: "Kildekvalifikatoren må vurderes.",
          evidence: fixture.completeAnswer,
          recommendation: "Kontroller kilden.",
        }).assessment,
        "Uklart",
        `${fixture.id}: ${blocker}`,
      );
    }
  }
});

test("source qualifiers remain blocked and an ordinary title does not promote Uklart", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-022",
  );
  assert.ok(fixture);
  const base = highConfidenceCoverageEntry(fixture);
  const entries = [
    { ...base, heading: "Opsjoner og tilvalg" },
    { ...base, heading: "Se vedlegg 4" },
    { ...base, heading: "Avklares etter kontraktsinngåelse" },
    { ...base, service: "Prises separat" },
    { ...base, service: "Valgfritt tilvalg" },
    { ...base, documentTitle: "Opsjoner" },
  ];

  for (const entry of entries) {
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Kildekonteksten inneholder en kvalifikator.",
        evidence: fixture.completeAnswer,
        recommendation: "Kontroller kildekonteksten.",
      }).assessment,
      "Uklart",
      `${entry.heading} ${entry.service ?? ""} ${entry.documentTitle ?? ""}`,
    );
  }

  const ordinaryBilagTitle = { ...base, documentTitle: "Bilag 1 Krav" };
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: ordinaryBilagTitle,
      assessment: "Uklart",
      rationale: "Dokumenttittelen er ordinær.",
      evidence: fixture.completeAnswer,
      recommendation: "Behold sporbarheten.",
    }).assessment,
    "Uklart",
  );
});

test("answer-side files, links, options and post-award decisions block promotion", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-022",
  );
  assert.ok(fixture);
  const blockers = [
    "Beviset finnes i separat fil 4.",
    "Dokumentasjonen ligger i et separat dokument.",
    "Kontrollmatrisen ligger i SharePoint via lenke https://example.invalid/audit.",
    "Kontrollen tilbys som valgfritt tilvalg.",
    "Leveransen prises separat.",
    "Dette er en opsjon.",
    "This control is optional.",
    "Detaljene besluttes etter kontraktsinngåelse.",
    "Mekanismen bestemmes i en senere fase.",
    "Løsningen velges etter kontraktstildeling.",
    "Se separat PDF.",
    "Bevis finnes i kontrollmatrise.xlsx.",
    "Dokumentasjon finnes i OneDrive.",
    "Detaljene ligger i Teams.",
    "Se kundens dokumentportal.",
    "Detaljene fastsettes i designfasen.",
    "Omfanget bestemmes ved oppstart.",
    "Løsningen velges senere.",
    "Kontrollen avklares med kunden.",
    "Mekanismen besluttes under detaljprosjektering.",
  ];

  for (const blocker of blockers) {
    const answer = `${fixture.completeAnswer} ${blocker}`;
    const entry = highConfidenceCoverageEntry(fixture, answer);
    assert.notEqual(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Dårlig",
        rationale: "Ekstern eller kvalifisert dekning.",
        evidence: answer,
        recommendation: "Dokumenter en ubetinget hovedleveranse.",
      }).assessment,
      "Godt",
      blocker,
    );
  }
});

test("canonical row cleaning and true qualifiers both preserve evaluator Uklart", () => {
  for (const fixture of highConfidenceCoverageFixtures) {
    const rawRow =
      `${fixture.id} | ${fixture.text} Bør Kan prises som opsjon |`;
    const cleanEntry = highConfidenceCoverageEntry(
      fixture,
      fixture.completeAnswer,
      rawRow,
    );
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry: cleanEntry,
        assessment: "Uklart",
        rationale: "Generert prioriteringskommentar skal renses.",
        evidence: fixture.completeAnswer,
        recommendation: "Behold svaret.",
      }).assessment,
      "Uklart",
      fixture.id,
    );

    const trueQualifier = highConfidenceCoverageEntry(
      fixture,
      fixture.completeAnswer,
      `${rawRow} Kravet prises som opsjon.`,
    );
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry: trueQualifier,
        assessment: "Uklart",
        rationale: "En ekte opsjonsklausul må bevares.",
        evidence: fixture.completeAnswer,
        recommendation: "Kontroller opsjonsomfanget.",
      }).assessment,
      "Uklart",
      fixture.id,
    );
  }
});

test("compound requirements never receive deterministic single-pattern promotion", () => {
  const compounds = [
    [
      "Dokumenttekst krav 2",
      "Løsningen skal også bruke kundestyrt kryptering.",
    ],
    ["R-024", "Akseptansetest skal også inkludere penetrasjonstest."],
    ["R-011", "Backup skal lagres kryptert i to regioner."],
  ];

  for (const [id, extraRequirement] of compounds) {
    const fixture = highConfidenceCoverageFixtures.find(
      (candidate) => candidate.id === id,
    );
    assert.ok(fixture);
    const compoundFixture = {
      ...fixture,
      text: `${fixture.text} ${extraRequirement}`,
    };
    const entry = highConfidenceCoverageEntry(
      compoundFixture,
      fixture.completeAnswer,
      compoundFixture.text,
    );
    assert.equal(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Ekstrakravet er ikke vurdert.",
        evidence: fixture.completeAnswer,
        recommendation: "Vurder hele det sammensatte kravet.",
      }).assessment,
      "Uklart",
      `${id}: ${extraRequirement}`,
    );
  }

  const reminder = highConfidenceCoverageFixtures[0];
  const sourceOnlyCompound = highConfidenceCoverageEntry(
    reminder,
    reminder.completeAnswer,
    `${reminder.text} Løsningen skal også bruke kundestyrt kryptering.`,
  );
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: sourceOnlyCompound,
      assessment: "Uklart",
      rationale: "Kilden har et ekstra obligatorisk krav.",
      evidence: reminder.completeAnswer,
      recommendation: "Vurder hele kilden.",
    }).assessment,
    "Uklart",
  );
});

test("Svarrad cannot create mandatory status for a non-mandatory source row", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-022",
  );
  assert.ok(fixture);
  const nonMandatoryText = fixture.text.replace("skal logges", "logges");
  const answer = fixture.completeAnswer.replace("Atea logger", "Atea skal logge");
  const entry = requirement({
    id: fixture.id,
    text: nonMandatoryText,
    sourceExcerpt: `Kravgrunnlag: ${nonMandatoryText} | Svarrad: ${answer}`,
    answerExcerpt: answer,
    answerDocumentId: "solution",
    answerReference: fixture.id,
  });

  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry,
      assessment: "Uklart",
      rationale: "Kravkilden har ingen obligatorisk modalitet.",
      evidence: answer,
      recommendation: "Bevar kildeklassifiseringen.",
    }).assessment,
    "Uklart",
  );
});

test("complete acceptance-test evidence preserves Uklart with or without a source option", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-024",
  );
  assert.ok(fixture);
  const noOption = highConfidenceCoverageEntry(fixture);
  const withOption = highConfidenceCoverageEntry(
    fixture,
    fixture.completeAnswer,
    `${fixture.text} Kravet prises som opsjon.`,
  );
  const evaluation = {
    assessment: "Uklart",
    rationale: "Akseptansetest må verifiseres.",
    evidence: fixture.completeAnswer,
    recommendation: "Kontroller omfanget.",
  };

  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      ...evaluation,
      entry: noOption,
    }).assessment,
    "Uklart",
  );
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      ...evaluation,
      entry: withOption,
    }).assessment,
    "Uklart",
  );
});

test("backup deterministic promotion fails closed for every parameter-like source clause", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-011",
  );
  assert.ok(fixture);
  const committedAnswer =
    "Atea etablerer en dokumentert backup-rutine for oppdrag, frivillige, samtykker og meldinger, med kontrollert gjenoppretting og verifikasjon av dataintegritet. Backup kjøres daglig med lagringstid 30 dager, og Atea forplikter RTO 4 timer samt RPO 1 time. Restore-test gjennomføres, avvik logges, korrigerende tiltak utføres og retest godkjennes.";
  const sourceClauses = [
    "Oppbevaring er 30 dager.",
    "Det kreves 30 dagers oppbevaring.",
    "Lagringstid er 30 dager.",
    "Backupvinduet er 23:00–01:00.",
    "Backup skal være immutable i 90 dager.",
    "Gjenoppretting skal skje innen 4 timer.",
    "RTO er 4 timer og RPO er 1 time.",
    "RTO4h/RPO1h.",
    "Backupfrekvens er daglig.",
    "Backup kjøres hver natt.",
    "Det brukes kontinuerlig backup.",
    "Det brukes WORM-lagring.",
    "Maksimalt datatap er én time.",
    "Data oppbevares i tretti dager.",
    "Full backup kjøres søndag.",
    "Inkrementell backup kjøres hver sjette time.",
    "Backup beholdes til 31.12.2030.",
  ];

  for (const clause of sourceClauses) {
    for (const answer of [fixture.completeAnswer, committedAnswer]) {
      const entry = highConfidenceCoverageEntry(
        fixture,
        answer,
        `${fixture.text} ${clause}`,
      );
      const corrected = correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Kildeparametrene må kontrolleres.",
        evidence: answer,
        recommendation: "Kontroller alle dokumenterte parametere.",
      });
      assert.equal(corrected.assessment, "Uklart", `${clause}: ${answer}`);
      assert.equal(
        buildDeterministicFinalRequirementControlRepair({ entry }),
        null,
        `deterministic repair must preserve source clause: ${clause}`,
      );
    }
  }

  const negativeCommitment = committedAnswer.replace(
    "Atea forplikter RTO 4 timer samt RPO 1 time",
    "Atea forplikter ikke RTO 4 timer eller RPO 1 time",
  );
  const negativeEntry = highConfidenceCoverageEntry(
    fixture,
    negativeCommitment,
    `${fixture.text} RTO er 4 timer og RPO er 1 time.`,
  );
  for (const entry of [
    negativeEntry,
    highConfidenceCoverageEntry(fixture, negativeCommitment),
  ]) {
    assert.notEqual(
      correctCoverageAssessmentWithSourceEvidence({
        entry,
        assessment: "Uklart",
        rationale: "Negativ forpliktelse.",
        evidence: negativeCommitment,
        recommendation: "Forplikt målene.",
      }).assessment,
      "Godt",
    );
  }

  const independentlyGood = highConfidenceCoverageEntry(
    fixture,
    committedAnswer,
    `${fixture.text} RTO er 4 timer og RPO er 1 time.`,
  );
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry: independentlyGood,
      assessment: "Godt",
      rationale: "AI-vurderingen har kontrollert hele parameterkravet.",
      evidence: committedAnswer,
      recommendation: "Behold dokumentasjonen.",
    }).assessment,
    "Godt",
  );
});

test("high-confidence correction does not become a general assessment override", () => {
  const answer =
    "Atea leverer en månedlig driftsrapport med navngitt eier, kontrollpunkter, avvikslogg og dokumentert godkjenning.";
  const entry = requirement({
    id: "R-099",
    text: "Leverandøren skal levere en månedlig driftsrapport.",
    sourceExcerpt: `Kravgrunnlag: Leverandøren skal levere en månedlig driftsrapport. | Svarrad: ${answer}`,
    answerExcerpt: answer,
    answerDocumentId: "solution",
    answerReference: "R-099",
  });

  assert.deepEqual(requirementAnswerQualityIssues(answer, entry), []);
  assert.equal(
    correctCoverageAssessmentWithSourceEvidence({
      entry,
      assessment: "Dårlig",
      rationale: "Modellens vurdering skal bevares uten et målrettet mønster.",
      evidence: answer,
      recommendation: "Bevar vurderingen.",
    }).assessment,
    "Dårlig",
  );
});

test("high-confidence correction preserves provenance and evidence blockers", () => {
  const fixture = highConfidenceCoverageFixtures.find(
    ({ id }) => id === "R-022",
  );
  assert.ok(fixture);
  const baseEntry = highConfidenceCoverageEntry(fixture);
  const variants = [
    {
      label: "missing answer document",
      entry: { ...baseEntry, answerDocumentId: undefined },
      assessment: "Uklart",
    },
    {
      label: "wrong row reference",
      entry: { ...baseEntry, answerReference: "R-999" },
      assessment: "Dårlig",
    },
    {
      label: "supplemental attachment",
      entry: highConfidenceCoverageEntry(
        fixture,
        `${fixture.completeAnswer} Se vedlegg 4 for kontrollmatrisen.`,
      ),
      assessment: "Uklart",
    },
    {
      label: "deferred solution",
      entry: highConfidenceCoverageEntry(
        fixture,
        `${fixture.completeAnswer} Endelig løsning må avklares med kunden.`,
      ),
      assessment: "Uklart",
    },
    {
      label: "declined delivery",
      entry: highConfidenceCoverageEntry(
        fixture,
        `${fixture.completeAnswer} Kontrollen inngår ikke i leveransen.`,
      ),
      assessment: "Dårlig",
    },
    {
      label: "Mangler is outside the targeted correction",
      entry: baseEntry,
      assessment: "Mangler",
    },
  ];

  for (const variant of variants) {
    const corrected = correctCoverageAssessmentWithSourceEvidence({
      entry: variant.entry,
      assessment: variant.assessment,
      rationale: "Behold blokkeringen.",
      evidence: variant.entry.answerExcerpt,
      recommendation: "Verifiser grunnlaget.",
    });
    assert.notEqual(corrected.assessment, "Godt", variant.label);
  }
});
