import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const repositoryRoot = path.resolve(frontendRoot, "../..");
const jiti = createJiti(
  path.join(frontendRoot, "document-intelligence-tests.cjs"),
  {
    alias: { "@": frontendRoot, "server-only": "/dev/null" },
    interopDefault: true,
  },
);
const {
  normalizeNorwegianTextForSearch,
  normalizeGeneratedNorwegianProse,
  detectNorwegianParseAnomalies,
  canonicalizeNorwegianDocumentText,
  diagnoseNorwegianDocumentText,
} = await jiti.import(
    path.join(
      frontendRoot,
      "lib/server/document-intelligence/norwegian-language.ts",
    ),
  );
const {
  customerAnalysisPipeline,
  documentAnalysisVersion,
  isDocumentAnalysisEnabled,
  isDocumentAnalysisV3Enabled,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/config.ts",
  ),
);
const { buildCanonicalDocumentProjection } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/canonical-document.ts",
  ),
);
const { preferTrustedStructuredRequirementText } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/requirement-text.ts",
  ),
);
const {
  buildCustomerAnalysisV3SystemPrompt,
  buildCustomerAnalysisV3UserPrompt,
  buildCustomerAnalysisCriticalFactChecklist,
  customerAnalysisV3ContextUsage,
  CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
  CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS,
  enrichCustomerAnalysisWithCriticalFacts,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-v3.ts",
  ),
);
const { normalizeCustomerAnalysisNorwegianProse } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-language.ts",
  ),
);
const { normalizeCustomerAnalysisResult } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-postprocess.ts",
  ),
);
const { isNearDuplicate, splitIntoSentences } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/text-normalization.ts",
  ),
);
const {
  customerAnalysisRegenerationContract,
  MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
  mergeCustomerAnalysisSectionPatch,
  sectionFieldNames,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-fields.ts",
  ),
);
const { chooseDocumentParserRoute } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/quality-router.ts",
  ),
);
const { compileDocumentIntelligenceArtifact } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/evidence-compiler.ts",
  ),
);
const { documentSourceContentHash } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/content-hash.ts",
  ),
);
const {
  customerAnalysisPromptContextLimit,
  SUPPORTING_PROMPT_CONTEXT_TOTAL_CHARS,
  supportingPromptContextLimit,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/context-budget.ts",
  ),
);
const { resolveCustomerAnalysisContexts } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-contexts.ts",
  ),
);
const { normalizeAzureLayoutResult } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/azure-layout.ts",
  ),
);
const { analyzeLocalPdfPage, buildLocalPdfDocument, LOCAL_PDF_LAYOUT_PARSER } =
  await jiti.import(
    path.join(
      frontendRoot,
      "lib/server/document-intelligence/local-pdf-layout.ts",
    ),
  );
const { isCurrentDocumentIntelligenceContext } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-context.ts",
  ),
);
const { buildDocumentParserAttemptEvents } = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/parse-orchestrator.ts",
  ),
);
const { extractTextFromBuffer } = await jiti.import(
  path.join(frontendRoot, "lib/server/documents.ts"),
);

test("Norwegian normalization repairs known PDF artifacts without changing evidence input", () => {
  const source = "L everandøren skal støtte Kundenog behandle I D 2 - 11 med arbeids stasjon.";
  const normalized = normalizeNorwegianTextForSearch(source);
  assert.match(normalized, /Leverandøren skal støtte Kunden og/u);
  assert.match(normalized, /ID 2-11/u);
  assert.equal(source.startsWith("L everandøren"), true);
  assert.deepEqual(
    detectNorwegianParseAnomalies({ text: source, hasStructuredTables: false }),
    ["split_word", "joined_party_word", "spaced_requirement_id"],
  );
});

test("document analysis v3 is opt-in and off restores the legacy PDF parser contract", async () => {
  const configuredVersion = process.env.DOCUMENT_ANALYSIS_VERSION;
  const previous = process.env.DOCUMENT_INTELLIGENCE_V2;
  const pdfPath = path.join(
    repositoryRoot,
    "test-data/tenders/tender_nordic_hybrid_cloud_2026.pdf",
  );
  const buffer = await readFile(pdfPath);
  try {
    delete process.env.DOCUMENT_ANALYSIS_VERSION;
    delete process.env.DOCUMENT_INTELLIGENCE_V2;
    assert.equal(isDocumentAnalysisEnabled(), false);
    assert.equal(documentAnalysisVersion(), "off");
    assert.equal(customerAnalysisPipeline(), "legacy");

    process.env.DOCUMENT_ANALYSIS_VERSION = "off";
    const legacy = await extractTextFromBuffer({
      buffer,
      fileName: path.basename(pdfPath),
      contentType: "application/pdf",
      role: "primary_customer_document",
      useDocling: false,
    });
    assert.equal(legacy.parserUsed, "pdf-parse");
    assert.ok(legacy.sourceMap.length > 0);
    assert.ok(legacy.sourceMap.every((entry) => entry.kind === undefined));

    process.env.DOCUMENT_ANALYSIS_VERSION = "v3";
    const v3 = await extractTextFromBuffer({
      buffer,
      fileName: path.basename(pdfPath),
      contentType: "application/pdf",
      role: "primary_customer_document",
      useDocling: false,
    });
    assert.equal(isDocumentAnalysisV3Enabled(), true);
    assert.equal(customerAnalysisPipeline(), "v3");
    assert.equal(v3.parserUsed, LOCAL_PDF_LAYOUT_PARSER);
    assert.equal(v3.rawText, legacy.rawText);
    assert.ok(v3.sourceMap.some((entry) => entry.kind));

    delete process.env.DOCUMENT_ANALYSIS_VERSION;
    process.env.DOCUMENT_INTELLIGENCE_V2 = "on";
    assert.equal(documentAnalysisVersion(), "v3");
  } finally {
    if (configuredVersion === undefined) {
      delete process.env.DOCUMENT_ANALYSIS_VERSION;
    } else {
      process.env.DOCUMENT_ANALYSIS_VERSION = configuredVersion;
    }
    if (previous === undefined) {
      delete process.env.DOCUMENT_INTELLIGENCE_V2;
    } else {
      process.env.DOCUMENT_INTELLIGENCE_V2 = previous;
    }
  }
});

test("canonical Norwegian projection repairs notation while preserving source evidence", () => {
  const source = "leverandøren skal støtte Kundenog migrere arbeids-\nstasjon ,uten avvik";
  assert.deepEqual(diagnoseNorwegianDocumentText(source, { sentenceLike: true }), [
    "joined_party_word",
    "space_before_punctuation",
    "missing_space_after_punctuation",
    "lowercase_sentence_start",
    "missing_terminal_punctuation",
  ]);
  assert.equal(
    canonicalizeNorwegianDocumentText(source, { sentenceLike: true }),
    "Leverandøren skal støtte Kunden og migrere arbeidsstasjon, uten avvik.",
  );

  const projection = buildCanonicalDocumentProjection({
    rawText: source,
    structureMap: [
      {
        reference: "Kravtabell 1, rad 1, side 2",
        text: "KR-1-2 Må leverandøren skal støtte Kundenog migrere arbeids-\nstasjon ,uten avvik",
        kind: "table",
        parser: LOCAL_PDF_LAYOUT_PARSER,
        page: 2,
        cells: {
          "Krav-ID": "KR-1-2",
          Prioritet: "Må",
          Kravtekst: source,
        },
      },
    ],
    title: "Kravgrunnlag",
    parserUsed: LOCAL_PDF_LAYOUT_PARSER,
  });
  assert.equal(projection.blocks[0].sourceText.startsWith("KR-1-2 Må"), true);
  assert.equal(
    projection.blocks[0].canonicalText,
    "Krav-ID: KR-1-2 | Prioritet: Må | Kravtekst: Leverandøren skal støtte Kunden og migrere arbeidsstasjon, uten avvik.",
  );
  assert.equal(projection.languageQuality.sourcePreserved, true);
  assert.equal(projection.languageQuality.canonicalDiagnosticCount, 0);
});

test("Norwegian punctuation normalization preserves decimal commas", () => {
  const source =
    "Tilgjengeligheten er 99,9 prosent og volumet er 1,15 millioner.Hei,verden";
  assert.deepEqual(diagnoseNorwegianDocumentText(source), [
    "missing_space_after_punctuation",
  ]);
  assert.equal(
    canonicalizeNorwegianDocumentText(source),
    "Tilgjengeligheten er 99,9 prosent og volumet er 1,15 millioner. Hei, verden",
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Tilgjengeligheten er 99, 9 prosent ,og volumet er 1, 15 millioner.Mål:kvalitet!Neste kontroll er kl. 12:00 og målt nivå er 100%.",
    ),
    "Tilgjengeligheten er 99,9 prosent, og volumet er 1,15 millioner. Mål: kvalitet! Neste kontroll er kl. 12.00 og målt nivå er 100 prosent.",
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Utløser: Kritiske tilgjengelighetsfeil ikke rettes før produksjonssetting. Utløser: Dersom feil ikke rettes, kan kravet brytes.",
    ),
    "Utløser: Kritiske tilgjengelighetsfeil rettes ikke før produksjonssetting. Utløser: Dersom feil ikke rettes, kan kravet brytes.",
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Redusere andelen nye søknader som må kompletteres fra 18 prosent til 10 prosent eller lavere.",
    ),
    "Redusere andelen nye søknader som må kompletteres, fra 18 prosent til 10 prosent eller lavere.",
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Hva blir eksakt antall skjermede saker og hvilke kodeverk skal gjelde?",
    ),
    "Hva blir eksakt antall skjermede saker, og hvilke kodeverk skal gjelde?",
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Hvilke fem kilder er kritiske, og hvilke kriterier gjelder?",
    ),
    "Hvilke fem kilder er kritiske, og hvilke kriterier gjelder?",
  );
});

test("sentence splitting preserves Norwegian dates and clock abbreviations", () => {
  assert.deepEqual(
    splitIntoSentences(
      "Tildeling er forventet 20. juli 2026. Tilbudsfristen er kl. 12.00.",
    ),
    [
      "Tildeling er forventet 20. juli 2026.",
      "Tilbudsfristen er kl. 12.00.",
    ],
  );
  assert.equal(
    normalizeGeneratedNorwegianProse(
      "Rammen er EUR 2.9 million, og fristen er kl. 15:00.",
    ),
    "Rammen er EUR 2,9 millioner, og fristen er kl. 15.00.",
  );
});

test("near-duplicate detection preserves numeric, unit, and negation differences", () => {
  for (const [left, right] of [
    ["RTO 2 timer", "RTO 4 timer"],
    ["Varsle innen 5 minutter", "Varsle innen 15 minutter"],
    ["Kravet gjelder 7 bygg", "Kravet gjelder 12 bygg"],
    ["Løsningen skal støtte kamera", "Løsningen skal ikke støtte kamera"],
    ["Gjenoppretting skal skje innen 5 minutter", "Gjenoppretting skal skje innen 5 timer"],
    ["RTO 4 timer og RPO 2 timer", "RTO 2 timer og RPO 4 timer"],
  ]) {
    assert.equal(isNearDuplicate(left, right), false, `${left} <> ${right}`);
  }
  assert.equal(
    isNearDuplicate("RTO er 4 timer.", "  rto 4 timer  "),
    true,
  );
});

test("customer analysis language cleanup fixes prose and preserves exact evidence", () => {
  const normalized = normalizeCustomerAnalysisNorwegianProse({
    customer_profile_summary: "Volumet er 1, 15 millioner.Mål:kvalitet.",
    customer_goals_summary: "Tilgjengeligheten er 99, 9 prosent.",
    high_level_solution_design: "Fase 1:kartlegging.",
    high_level_architecture_mermaid: "flowchart LR\n  A[99, 9] --> B",
    customer_profile: ["Kunden har 100% dekning."],
    customer_goals: [],
    implicit_requirements: [
      {
        title: "Trygg overgang",
        description: "Migrering!Kontroll.",
        category: "Risiko",
        importance: "Kritisk",
        kind: "Implisitt",
        source_reference: "Side 2 ,rad 1",
        source_excerpt: "Kilden sier 1, 15 millioner.",
      },
    ],
    prioritized_requirements: [],
    ambiguities: [],
    risks: [],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [],
    signal_words: ["WCAG 2.2"],
    expected_solution_direction: [],
    recommended_services: [],
    value_opportunities: [],
    positioning_recommendations: [],
    executive_summary: "Konklusjon:klar.",
  });
  assert.equal(
    normalized.customer_profile_summary,
    "Volumet er 1,15 millioner. Mål: kvalitet.",
  );
  assert.equal(normalized.customer_profile[0], "Kunden har 100 prosent dekning.");
  assert.equal(
    normalized.implicit_requirements[0].description,
    "Migrering! Kontroll.",
  );
  assert.equal(
    normalized.implicit_requirements[0].source_reference,
    "Side 2 ,rad 1",
  );
  assert.equal(
    normalized.implicit_requirements[0].source_excerpt,
    "Kilden sier 1, 15 millioner.",
  );
  assert.equal(
    normalized.high_level_architecture_mermaid,
    "flowchart LR\n  A[99, 9] --> B",
  );
});

test("customer analysis postprocessing preserves the established output rules", () => {
  const analysis = {
    customer_profile_summary: "Kunden trenger kontroll.",
    customer_goals_summary: "Målet er sikker drift.",
    high_level_solution_design: "Bruk en styrt plattform.",
    high_level_architecture_mermaid: "ikke et diagram",
    customer_profile: ["Offentlig kunde", "Offentlig   kunde"],
    customer_goals: ["Sikker drift"],
    implicit_requirements: [
      {
        title: "  Revisjonsspor  ",
        description: "  Alle endringer skal kunne spores.  ",
        category: "Sikkerhet",
        importance: "Kritisk",
        kind: "Implisitt",
        source_reference: "  Side 2, tabell 1  ",
        source_excerpt: "  Nøyaktig   kildetekst  ",
      },
    ],
    prioritized_requirements: [],
    ambiguities: [
      "Hvilke lokasjoner inngår i leveranseomfanget?",
      "Hvilke krav gjelder for tjenestens oppetid?",
      "Hvem har ansvar for eksisterende integrasjoner?",
      "Når skal migreringen være ferdig gjennomført?",
      "Hvilke regulatoriske krav må løsningen oppfylle?",
      "Hvordan skal beredskap utenfor åpningstid håndteres?",
      "Hvilken prismodell forventer kunden i tilbudet?",
    ],
    risks: [
      "Leveranseteamet mangler kapasitet.",
      "Kunden kan få driftsavbrudd.",
    ],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [],
    signal_words: ["Azure Monitor", "azure monitor"],
    signal_word_counts: {},
    expected_solution_direction: [],
    recommended_services: [
      {
        service_id: "service-1",
        service_name: "Sikker drift",
        usefulness_percent: 85,
        customer_need: "Kontroll",
        recommendation_reason: "Reduserer risiko.",
        evidence: "Krav om revisjonsspor.",
        risk_or_caveat: "Må avklares.",
      },
    ],
    value_opportunities: [
      {
        title: "Mer effektiv saksflyt",
        description: "Automatisering reduserer tidsbruk.",
        value_categories: ["Høyere produktivitet"],
        profit_share_percent: 20,
      },
      {
        title: "Sikrere drift",
        description: "Kontroller reduserer risiko.",
        value_categories: ["Redusert risiko"],
        profit_share_percent: 80,
      },
    ],
    positioning_recommendations: [],
    executive_summary: "Prioriter kontroll og sikker drift.",
  };

  const normalized = normalizeCustomerAnalysisResult(analysis, {
    signalSourceText: "Azure Monitor brukes her. Azure   Monitor brukes igjen.",
  });
  assert.deepEqual(normalized.customer_profile, ["Offentlig kunde"]);
  assert.equal(
    normalized.implicit_requirements[0].source_reference,
    "Side 2, tabell 1",
  );
  assert.equal(
    normalized.implicit_requirements[0].source_excerpt,
    "Nøyaktig kildetekst",
  );
  assert.deepEqual(normalized.risks_for_us, [
    "Leveranseteamet mangler kapasitet.",
  ]);
  assert.deepEqual(normalized.risks_for_customer, [
    "Kunden kan få driftsavbrudd.",
  ]);
  assert.deepEqual(normalized.signal_words, ["Azure Monitor"]);
  assert.deepEqual(normalized.ambiguities, [
    "Hvilke lokasjoner inngår i leveranseomfanget?",
    "Hvilke krav gjelder for tjenestens oppetid?",
    "Hvem har ansvar for eksisterende integrasjoner?",
    "Når skal migreringen være ferdig gjennomført?",
    "Hvilke regulatoriske krav må løsningen oppfylle?",
  ]);
  assert.equal(normalized.signal_word_counts["Azure Monitor"], 2);
  assert.equal(
    normalized.value_opportunities.reduce(
      (total, item) => total + item.profit_share_percent,
      0,
    ),
    100,
  );
  assert.match(normalized.high_level_architecture_mermaid, /^flowchart LR/u);
  assert.equal(normalized.recommended_services.length, 1);

  const enriched = enrichCustomerAnalysisWithCriticalFacts(analysis, [
    {
      documentId: "primary",
      title: "Kravgrunnlag",
      role: "primary_customer_document",
      context: "",
      sourceText: [
        "Niva har 12 klinikker og omtrent 210 000 konsultasjoner per år.",
        "RTO er 4 timer og RPO er 30 minutter.",
        "Tilbudsfrist 23.10.2026 kl. 12.00.",
      ].join("\n"),
    },
  ]);
  assert.match(enriched.customer_profile[0], /12 klinikker/u);
  assert.match(
    enriched.prioritized_requirements[0].requirement,
    /RTO 4 timer/u,
  );
  assert.match(
    enriched.positioning_recommendations[0],
    /Tilbudsfrist 23.10.2026/u,
  );

  const withoutCatalog = normalizeCustomerAnalysisResult(analysis, {
    serviceCandidates: [],
  });
  assert.deepEqual(withoutCatalog.recommended_services, []);

  const grounded = normalizeCustomerAnalysisResult(
    {
      ...analysis,
      implicit_requirements: [
        {
          title: "Logging av endringer",
          description:
            "Systemet må logge alle endringer med bruker og tidspunkt.",
          category: "Sikkerhet",
          importance: "Kritisk",
          kind: "Implisitt",
          source_reference: "Feil referanse",
          source_excerpt: "Et omskrevet og ikke ordrett sitat.",
        },
        {
          title: "Oppdiktet behov",
          description: "Flyvende biler må støttes.",
          category: "Omfang",
          importance: "Viktig",
          kind: "Implisitt",
          source_reference: "Ukjent",
          source_excerpt: "Ingen slik tekst finnes.",
        },
      ],
    },
    {
      sourceDocuments: [
        {
          title: "Kravgrunnlag",
          rawText:
            "Systemet skal logge alle endringer med bruker og tidspunkt.\nAndre krav gjelder sikker drift.",
          structureMap: [
            {
              reference: "Side 4, krav SIK-7",
              text: "Systemet skal logge alle endringer med bruker og tidspunkt.",
            },
          ],
        },
      ],
    },
  );
  assert.equal(grounded.implicit_requirements.length, 1);
  assert.equal(
    grounded.implicit_requirements[0].source_reference,
    "Side 4, krav SIK-7",
  );
  assert.equal(
    grounded.implicit_requirements[0].source_excerpt,
    "Systemet skal logge alle endringer med bruker og tidspunkt.",
  );

  const exactQuote = "Kunden krever sporbar godkjenning av alle endringer.";
  const exactRequirement = {
    title: "Sporbar godkjenning",
    description: "Alle endringer må godkjennes og kunne spores.",
    category: "Sikkerhet",
    importance: "Kritisk",
    kind: "Implisitt",
    source_reference: "Dokument B",
    source_excerpt: exactQuote,
  };
  const correctedExact = normalizeCustomerAnalysisResult(
    {
      ...analysis,
      implicit_requirements: [exactRequirement],
    },
    {
      sourceDocuments: [
        { title: "Dokument A", rawText: exactQuote },
        { title: "Dokument B", rawText: "Et annet dokumentinnhold." },
      ],
    },
  );
  assert.equal(
    correctedExact.implicit_requirements[0].source_reference,
    "Dokument A",
  );

  const ambiguousExact = normalizeCustomerAnalysisResult(
    {
      ...analysis,
      implicit_requirements: [
        { ...exactRequirement, source_reference: "Ukjent dokument" },
      ],
    },
    {
      sourceDocuments: [
        { title: "Dokument A", rawText: exactQuote },
        { title: "Dokument B", rawText: exactQuote },
      ],
    },
  );
  assert.deepEqual(ambiguousExact.implicit_requirements, []);

  const resolvedExact = normalizeCustomerAnalysisResult(
    {
      ...analysis,
      implicit_requirements: [exactRequirement],
    },
    {
      sourceDocuments: [
        { title: "Dokument A", rawText: exactQuote },
        { title: "Dokument B", rawText: exactQuote },
      ],
    },
  );
  assert.equal(
    resolvedExact.implicit_requirements[0].source_reference,
    "Dokument B",
  );

  const completedExactExcerpt = normalizeCustomerAnalysisResult(
    {
      ...analysis,
      implicit_requirements: [
        {
          ...exactRequirement,
          source_reference: "Kundedokument – side 3, tekstblokk 11",
          source_excerpt:
            "Behovsområde 12: Styring Universitetet bør se etableringstid, kostnad, kapasitet, policyavvik, eksport og avslutningsstatus per fakultet og",
        },
      ],
    },
    {
      sourceDocuments: [
        {
          title: "Kravgrunnlag",
          rawText:
            "Behovsområde 12: Styring\nUniversitetet bør se etableringstid, kostnad, kapasitet, policyavvik, eksport og avslutningsstatus per fakultet og prosjekt.",
        },
      ],
    },
  );
  assert.equal(
    completedExactExcerpt.implicit_requirements[0].source_excerpt,
    "Behovsområde 12: Styring Universitetet bør se etableringstid, kostnad, kapasitet, policyavvik, eksport og avslutningsstatus per fakultet og prosjekt.",
  );
  assert.equal(
    completedExactExcerpt.implicit_requirements[0].source_reference,
    "Kravgrunnlag",
  );

  const withoutFixtureMetadata = normalizeCustomerAnalysisResult({
    ...analysis,
    customer_profile_summary:
      "Nordhavn kommune er et fiktivt testgrunnlag som anskaffer en programvaretjeneste for byggesak.",
    customer_profile: [
      "Dokumentet opplyser at alle virksomheter, leverandører, tall og avtaler er fiktive.",
      "Kommunen har 38 400 innbyggere.",
    ],
  });
  assert.equal(
    withoutFixtureMetadata.customer_profile_summary,
    "Nordhavn kommune anskaffer en programvaretjeneste for byggesak.",
  );
  assert.deepEqual(withoutFixtureMetadata.customer_profile, [
    "Kommunen har 38 400 innbyggere.",
  ]);

  const distinctRequirements = normalizeCustomerAnalysisResult({
    ...analysis,
    implicit_requirements: [],
    prioritized_requirements: [
      {
        requirement: "RTO skal være 2 timer.",
        priority: "Kritisk",
        reason: "Kravet styrer beredskapen.",
      },
      {
        requirement: "RTO skal være 4 timer.",
        priority: "Kritisk",
        reason: "Kravet styrer beredskapen.",
      },
    ],
  });
  assert.equal(distinctRequirements.prioritized_requirements.length, 2);

  const fiveModelRequirements = Array.from({ length: 5 }, (_, index) => ({
    requirement: `Krav ${index + 1} skal oppfylles.`,
    priority: "Viktig",
    reason: `Dokumentert prioritet ${index + 1}.`,
  }));
  const enrichedAndCapped = enrichCustomerAnalysisWithCriticalFacts(
    {
      ...analysis,
      implicit_requirements: [],
      prioritized_requirements: fiveModelRequirements,
    },
    [
      {
        documentId: "primary",
        title: "Kravgrunnlag",
        role: "primary_customer_document",
        context: "",
        sourceText:
          "Operativ kjerne skal ha RTO 2 timer og RPO 15 minutter.",
      },
    ],
  );
  assert.equal(
    enrichedAndCapped.prioritized_requirements.length,
    MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
  );
  assert.match(
    enrichedAndCapped.prioritized_requirements[0].requirement,
    /RTO 2 timer/u,
  );
  assert.equal(
    normalizeCustomerAnalysisResult(enrichedAndCapped).prioritized_requirements
      .length,
    MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
  );
});

test("trusted local requirement rows replace only matching truncated generated text", () => {
  const generated = {
    id: "KR-063-34",
    text: "Det skal være mulig å følge status på migrering fra sakssystem med begrensede",
    pages: [7],
    heading: "Migrering",
    sourceExcerpt: "kort utdrag",
  };
  const trusted = {
    ...generated,
    text: "Det skal være mulig å følge status på migrering fra sakssystem med begrensede API-er, e-postmapper og filserver med tellinger, avvik og godkjenningspunkt.",
    sourceExcerpt: "komplett tabellcelle",
  };
  assert.equal(
    preferTrustedStructuredRequirementText(generated, trusted).text,
    trusted.text,
  );
  assert.equal(
    preferTrustedStructuredRequirementText(
      { ...generated, text: `Rad 34 ${trusted.text} Må` },
      trusted,
    ).text,
    trusted.text,
  );
  assert.equal(
    preferTrustedStructuredRequirementText(generated, {
      ...trusted,
      text: "Leverandøren skal levere et helt annet krav.",
    }).text,
    generated.text,
  );
  assert.equal(
    preferTrustedStructuredRequirementText(
      { ...generated, text: `${generated.text}.` },
      {
        ...trusted,
        text: `${generated.text}. - se notat: Kunden ønsker en annen arbeidsflyt.`,
      },
    ).text,
    `${generated.text}.`,
  );
});

test("customer analysis v3 has one lean strict contract and one context per document", () => {
  const system = buildCustomerAnalysisV3SystemPrompt();
  assert.ok(system.length < 5_000);
  assert.match(system, /korrekt norsk bokmål/u);
  assert.match(system, /source_reference/u);
  assert.match(system, /samlet være 100/u);
  assert.match(system, /menneskelige beslutningskontroller/u);
  assert.match(system, /Utelat dokumentmetadata/u);
  assert.match(system, /faktisk slutter grammatisk ufullstendig/u);

  assert.equal(CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.required,
    [...CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS],
  );
  assert.equal(CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS.length, 19);
  assert.deepEqual(
    buildCustomerAnalysisCriticalFactChecklist([
      {
        documentId: "primary",
        title: "Kravgrunnlag",
        role: "primary_customer_document",
        context: [
          "- [KONTEKST] Niva har 12 klinikker, 480 ansatte og omtrent 210 000 konsultasjoner per år.",
          "- [KRAV] Operativ kjerne skal ha RTO 2 timer og RPO 15 minutter.",
          "- [KONTEKST] Dette er en generell setning uten verdi.",
        ].join("\n"),
      },
    ]).map((item) => item.fact),
    [
      "Dokumenterte skala- og volumtall: 12 klinikker; 480 ansatte; omtrent 210 000 konsultasjoner per år.",
      "Dokumenterte kontinuitetsmål: RTO 2 timer; RPO 15 minutter.",
    ],
  );
  assert.deepEqual(
    buildCustomerAnalysisCriticalFactChecklist([
      {
        documentId: "scenario",
        title: "Prisgrunnlag",
        role: "primary_customer_document",
        context: "",
        sourceText: [
          "Kommunen har 127 ansatte og behandler 3 200 byggesaker per år.",
          "Tilbudet skal forklare lisenskonsekvensen av 50, 100 og 200 eksterne brukere.",
        ].join("\n"),
      },
    ]).map((item) => item.fact),
    [
      "Dokumenterte skala- og volumtall: 127 ansatte; 3 200 byggesaker per år.",
    ],
  );
  assert.deepEqual(
    buildCustomerAnalysisCriticalFactChecklist([
      {
        documentId: "english",
        title: "RFP",
        role: "primary_customer_document",
        context: "",
        sourceText: [
          "Intent to Bid deadline: March 12, 2026 17:00 CET.",
          "The platform must support failover with an RTO of 60 minutes and an RPO of 15 minutes.",
          "Root cause analysis must be completed within five business days.",
        ].join("\n"),
      },
    ]).map((item) => item.fact),
    [
      "Dokumenterte kontinuitetsmål: RTO 60 minutter; RPO 15 minutter.",
      "Dokumenterte tekniske grenseverdier: Rotårsaksanalyse skal fullføres innen fem virkedager.",
      "Dokumenterte nøkkelfrister: Frist for å melde tilbudsintensjon 12. mars 2026 kl. 17.00 CET.",
    ],
  );
  const unstructuredCriticalFacts = buildCustomerAnalysisCriticalFactChecklist([
    {
      documentId: "unstructured",
      title: "Møtereferat med krav",
      role: "primary_customer_document",
      context: "",
      sourceText: [
        "Oppnå 98 prosent synkronisering av komplette arbeidsordrer innen fem minutter etter at dekning er gjenopprettet.",
        "Datainnsamling skal bruke lesende OPC UA eller godkjent mellomvare i industriell DMZ.",
        "Prediktive modeller skal ikke erstatte sikkerhetsalarmer, sperrer eller operatørens godkjente prosedyrer.",
        "Kritisk operativ funksjon skal være tilgjengelig 24x7 med 99,9 prosent månedlig tilgjengelighet og vakt for prioritet 1.",
        "Sikre at 100 prosent av prosjektene har navngitt dataeier, klassifisering, formål og sluttdato.",
        "Pilot starter 15. februar 2027, og ordinær drift åpner 1. september 2027.",
        "Generative modeller skal ikke trenes på eller beholde prosjektdata uten eksplisitt, dokumentert godkjenning.",
      ].join("\n"),
    },
  ]).map((item) => item.fact);
  assert.ok(
    unstructuredCriticalFacts.some(
      (fact) =>
        fact ===
        "Dokumenterte tekniske grenseverdier: Oppnå 98 prosent synkronisering av komplette arbeidsordrer innen fem minutter etter at dekning er gjenopprettet.",
    ),
  );
  assert.ok(
    unstructuredCriticalFacts.some(
      (fact) =>
        fact ===
        "Dokumenterte milepæler: Pilot starter 15. februar 2027, og ordinær drift åpner 1. september 2027.",
    ),
  );
  assert.ok(
    unstructuredCriticalFacts.some(
      (fact) =>
        fact ===
        "Dokumenterte effektmål: Oppnå 98 prosent synkronisering av komplette arbeidsordrer innen fem minutter etter at dekning er gjenopprettet | Sikre at 100 prosent av prosjektene har navngitt dataeier, klassifisering, formål og sluttdato.",
    ),
  );
  const enrichedUnstructuredFacts = enrichCustomerAnalysisWithCriticalFacts(
    {
      customer_profile_summary: "",
      customer_goals_summary: "",
      high_level_solution_design:
        "Prediktive modeller skal støtte, men aldri erstatte, sikkerhetsalarmer, sperrer eller operatørens godkjente prosedyrer.",
      high_level_architecture_mermaid: "",
      customer_profile: [],
      customer_goals: [],
      implicit_requirements: [],
      prioritized_requirements: [],
      ambiguities: [],
      risks: [],
      risks_for_us: [],
      risks_for_customer: [],
      likely_evaluation_criteria: [],
      signal_words: [],
      expected_solution_direction: [],
      recommended_services: [],
      value_opportunities: [],
      positioning_recommendations: [],
      executive_summary: "",
    },
    [
      {
        documentId: "unstructured",
        title: "Møtereferat med krav",
        role: "primary_customer_document",
        context: "",
        sourceText: [
          "Oppnå 98 prosent synkronisering av komplette arbeidsordrer innen fem minutter etter at dekning er gjenopprettet.",
          "Synkroniser komplette arbeidsordrer innen fem minutter etter gjenopprettet dekning.",
          "Lesemerknad Dokumentet viser til ISO 27001 og eventuelle domenestandarder som FHIR R4. Disse er ikke nye krav.",
          "Datainnsamling skal bruke lesende OPC UA eller godkjent mellomvare i industriell DMZ.",
          "Kritiske sikkerhetsalarmer skal ikke erstattes av prediktive modeller.",
          "Prediktive modeller skal ikke erstatte sikkerhetsalarmer, sperrer eller operatørens godkjente prosedyrer.",
          "Sikre at 100 prosent av prosjektene har navngitt dataeier, klassifisering, formål og sluttdato.",
          "Pilot starter 15. februar 2027, og ordinær drift åpner 1. september 2027.",
          "Generative modeller skal ikke trenes på eller beholde prosjektdata uten eksplisitt, dokumentert godkjenning.",
        ].join("\n"),
      },
    ],
  );
  const enrichedRequirementText =
    enrichedUnstructuredFacts.prioritized_requirements
      .map((item) => item.requirement)
      .join("\n");
  assert.match(
    enrichedRequirementText,
    /Oppnå 98 prosent synkronisering.+innen fem minutter/u,
  );
  assert.doesNotMatch(
    enrichedRequirementText,
    /Dokumenterte tekniske grenseverdier|Lesemerknad|FHIR R4|Kritiske sikkerhetsalarmer/u,
  );
  assert.equal(
    enrichedUnstructuredFacts.prioritized_requirements.filter((item) =>
      /innen fem minutter/u.test(item.requirement),
    ).length,
    1,
  );
  assert.deepEqual(enrichedUnstructuredFacts.customer_goals, [
    "Oppnå 98 prosent synkronisering av komplette arbeidsordrer innen fem minutter etter at dekning er gjenopprettet. Sikre at 100 prosent av prosjektene har navngitt dataeier, klassifisering, formål og sluttdato.",
  ]);
  assert.match(
    enrichedUnstructuredFacts.positioning_recommendations.join("\n"),
    /Pilot starter 15. februar 2027.+1. september 2027/u,
  );
  assert.match(
    enrichedRequirementText,
    /Generative modeller skal ikke trenes på eller beholde prosjektdata/u,
  );
  assert.ok(
    unstructuredCriticalFacts.some(
      (fact) =>
        fact.includes("OPC UA") &&
        fact.includes("operatørens godkjente prosedyrer"),
    ),
  );
  assert.ok(
    unstructuredCriticalFacts.some(
      (fact) =>
        fact.includes("24x7") &&
        fact.includes("99,9 prosent månedlig tilgjengelighet"),
    ),
  );
  assert.deepEqual(
    buildCustomerAnalysisCriticalFactChecklist([
      {
        documentId: "primary",
        title: "Kravgrunnlag",
        role: "primary_customer_document",
        context:
          "- [KONTEKST] Kolonnestøy med RTO 20 budsjett 30 og en ufullstendig setning",
        sourceText:
          "Niva har 12 klinikker, 480 ansatte og omtrent 210 000 konsultasjoner per år.",
      },
    ]).map((item) => item.fact),
    [
      "Dokumenterte skala- og volumtall: 12 klinikker; 480 ansatte; omtrent 210 000 konsultasjoner per år.",
    ],
  );
  assert.equal(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.properties.implicit_requirements.maxItems,
    3,
  );
  assert.equal(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.properties.ambiguities.maxItems,
    5,
  );
  assert.equal(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.properties.prioritized_requirements
      .maxItems,
    MAX_CUSTOMER_ANALYSIS_PRIORITIZED_REQUIREMENTS,
  );
  assert.equal(
    "minItems" in
      CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.properties.implicit_requirements,
    false,
  );

  const user = buildCustomerAnalysisV3UserPrompt({
    projectName: "Norsk anskaffelse",
    documents: [
      {
        documentId: "primary",
        title: "Kravgrunnlag",
        role: "primary_customer_document",
        context: "Krav-ID: KR-1 | Kravtekst: Løsningen skal ha revisjonsspor.",
      },
      {
        documentId: "support",
        title: "Vedlegg",
        role: "supporting_document",
        context: "Tilbudsfrist er 1. august 2026 kl. 12:00.",
      },
    ],
    foundationFacts: "Ingen oppdiktede fakta.",
  });
  assert.equal(user.match(/BEGIN_CANONICAL_DOCUMENT_/gu)?.length, 2);
  assert.equal(user.match(/END_CANONICAL_DOCUMENT_/gu)?.length, 2);
  assert.equal(user.match(/Krav-ID: KR-1/gu)?.length, 1);
  assert.doesNotMatch(user, /Semantisk dokumentdekning|Retrieval-kvalitet/u);

  const primaryTail = "KVALITET VEKTES 45 PROSENT";
  const longPrimary = buildCustomerAnalysisV3UserPrompt({
    projectName: "Langt norsk bilag",
    documents: [
      {
        documentId: "long-primary",
        title: "Bilag 1",
        role: "primary_customer_document",
        context: `${"Krav og kundekontekst. ".repeat(650)}${primaryTail}`,
      },
    ],
  });
  assert.match(longPrimary, new RegExp(primaryTail, "u"));
  assert.doesNotMatch(longPrimary, /\[avkortet\]/u);
  assert.deepEqual(
    customerAnalysisV3ContextUsage([
      {
        documentId: "large",
        title: "Stort dokument",
        role: "primary_customer_document",
        context: "x".repeat(18_001),
      },
    ]),
    [
      {
        documentId: "large",
        inputChars: 18_001,
        limitChars: 18_000,
        truncated: true,
      },
    ],
  );
});

test("customer analysis context budgets preserve the explicit primary and supporting policy", () => {
  assert.equal(
    customerAnalysisPromptContextLimit({
      role: "primary_customer_document",
      supportingDocumentCount: 20,
    }),
    18_000,
  );
  assert.equal(supportingPromptContextLimit(4), 4_000);
  assert.equal(supportingPromptContextLimit(8), 2_000);
  assert.equal(supportingPromptContextLimit(14), 1_142);
  assert.equal(supportingPromptContextLimit(79), 202);
  assert.equal(supportingPromptContextLimit(100), 160);

  for (const count of [1, 4, 8, 14, 79, 100]) {
    const limit = supportingPromptContextLimit(count);
    assert.ok(limit > 0);
    assert.ok(
      limit * count <= SUPPORTING_PROMPT_CONTEXT_TOTAL_CHARS,
      `${count} supporting documents exceeded the aggregate budget`,
    );
  }

  const manyDocuments = [
    {
      documentId: "primary",
      title: "Primærdokument",
      role: "primary_customer_document",
      context: "Primær kontekst",
    },
    ...Array.from({ length: 79 }, (_, index) => ({
      documentId: `support-${index + 1}`,
      title: `Støttedokument ${index + 1}`,
      role: "supporting_document",
      context: "x".repeat(5_000),
    })),
  ];
  const usage = customerAnalysisV3ContextUsage(manyDocuments);
  assert.ok(
    usage
      .filter((item) => item.documentId !== "primary")
      .reduce((total, item) => total + item.limitChars, 0) <=
      SUPPORTING_PROMPT_CONTEXT_TOTAL_CHARS,
  );
  const prompt = buildCustomerAnalysisV3UserPrompt({
    projectName: "Mange støttedokumenter",
    documents: manyDocuments,
  });
  assert.equal(prompt.match(/BEGIN_CANONICAL_DOCUMENT_/gu)?.length, 80);
});

test("section regeneration derives a strict subset schema and cannot mutate other fields", () => {
  const contract = customerAnalysisRegenerationContract("risks");
  assert.deepEqual(contract.fields, [
    "risks",
    "risks_for_us",
    "risks_for_customer",
  ]);
  assert.deepEqual(contract.schema.required, contract.fields);
  assert.equal(contract.schema.additionalProperties, false);
  assert.deepEqual(sectionFieldNames("needs"), ["implicit_requirements"]);

  const analysis = {
    customer_profile_summary: "Uendret kundeprofil",
    customer_goals_summary: "Uendret mål",
    high_level_solution_design: "Uendret design",
    high_level_architecture_mermaid: "flowchart LR\nA --> B",
    customer_profile: [],
    customer_goals: [],
    implicit_requirements: [],
    prioritized_requirements: [],
    ambiguities: [],
    risks: ["Gammel samlet risiko"],
    risks_for_us: [],
    risks_for_customer: [],
    likely_evaluation_criteria: [],
    signal_words: [],
    expected_solution_direction: [],
    recommended_services: [],
    value_opportunities: [],
    positioning_recommendations: [],
    executive_summary: "Uendret strategi",
  };
  const merged = mergeCustomerAnalysisSectionPatch({
    analysis,
    section: "risks",
    patch: {
      risks: ["Ny samlet risiko"],
      risks_for_us: ["Ny tilbudsrisiko"],
      customer_profile_summary: "Skal ignoreres",
    },
  });
  assert.equal(merged.customer_profile_summary, "Uendret kundeprofil");
  assert.deepEqual(merged.risks, ["Ny samlet risiko"]);
  assert.deepEqual(merged.risks_for_us, ["Ny tilbudsrisiko"]);
  assert.deepEqual(analysis.risks, ["Gammel samlet risiko"]);
});

test("quality routing keeps clean documents fast and tries local structure before Azure", () => {
  const cleanText = "Leverandøren skal beskrive sikker drift. ".repeat(160);
  const clean = chooseDocumentParserRoute({
    rawText: cleanText,
    canonicalText: cleanText,
    sourceMap: Array.from({ length: 12 }, (_, index) => ({
      reference: `Side ${Math.floor(index / 6) + 1}`,
      page: Math.floor(index / 6) + 1,
      text: `Avsnitt ${index + 1}: Leverandøren skal beskrive sikker drift.`,
      kind: "text",
      parser: "pdf-parse",
    })),
    fileFormat: "pdf",
    fileSizeBytes: 120_000,
    parserUsed: "pdf-parse",
    isHighImpactDocument: true,
    azureAvailable: true,
    doclingAvailable: true,
  });
  assert.equal(clean.route, "native");

  const brokenTable = chooseDocumentParserRoute({
    rawText:
      `${cleanText}\nID 2-01 Krav én\nID 2-02 Krav to\nID 2-03 Krav tre\nID 2-04 Krav fire`,
    canonicalText: cleanText,
    sourceMap: [{ reference: "Side 1", page: 1, text: cleanText }],
    fileFormat: "pdf",
    fileSizeBytes: 120_000,
    parserUsed: "pdf-parse",
    isHighImpactDocument: true,
    azureAvailable: true,
    doclingAvailable: true,
  });
  assert.equal(brokenTable.route, "docling");
  assert.ok(
    brokenTable.quality.norwegianAnomalies.includes(
      "unstructured_requirement_table",
    ),
  );

  const cloudFallback = chooseDocumentParserRoute({
    rawText: brokenTable.quality.hasRequirementSignals
      ? `${cleanText}\nID 2-01 Krav én\nID 2-02 Krav to\nID 2-03 Krav tre\nID 2-04 Krav fire`
      : cleanText,
    canonicalText: cleanText,
    sourceMap: [{ reference: "Side 1", page: 1, text: cleanText }],
    fileFormat: "pdf",
    fileSizeBytes: 120_000,
    parserUsed: "pdf-parse",
    isHighImpactDocument: true,
    azureAvailable: true,
    doclingAvailable: false,
  });
  assert.equal(cloudFallback.route, "azure_layout");
});

test("customer analysis rejects stale source revisions and compiler versions", () => {
  const compilerVersion = "document-analysis.3.0.0";
  assert.equal(
    isCurrentDocumentIntelligenceContext({
      sourceRevision: 4,
      documentSourceRevision: 4,
      compilerVersion,
    }),
    true,
  );
  assert.equal(
    isCurrentDocumentIntelligenceContext({
      sourceRevision: 3,
      documentSourceRevision: 4,
      compilerVersion,
    }),
    false,
  );
  assert.equal(
    isCurrentDocumentIntelligenceContext({
      sourceRevision: 4,
      documentSourceRevision: 4,
      compilerVersion: "evidence-compiler.1.1.0",
    }),
    false,
  );
});

test("customer analysis compiles stale contexts on demand and tolerates persistence failures", async () => {
  const document = {
    id: "document-1",
    project_id: "project-1",
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Kundekrav",
    file_name: "kundekrav.txt",
    file_format: "txt",
    content_type: "text/plain",
    file_size_bytes: 120,
    processing_status: "enhanced_ready",
    parser_used: "plain-text",
    chunk_source_revision: 2,
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
    raw_text: "Kunden skal ha oppstart senest 1. oktober 2026.",
    file_base64: "",
    structure_map: [],
  };
  const warnings = [];
  const result = await resolveCustomerAnalysisContexts({
    projectId: document.project_id,
    documents: [document],
    dependencies: {
      listContexts: async () => [
        {
          documentId: document.id,
          sourceRevision: 1,
          compilerVersion: "stale",
          parserUsed: "plain-text",
          quality: {},
          evidenceCounts: {},
          analysisContext: "utdatert",
        },
      ],
      storeArtifact: async () => false,
      now: () => "2026-07-24T00:00:00.000Z",
      warn: (fields) => warnings.push(fields),
    },
  });

  assert.equal(result.compiledOnDemandCount, 1);
  assert.equal(result.persistenceFailureCount, 1);
  assert.match(
    result.contexts.get(document.id).analysisContext,
    /oppstart senest 1\. oktober 2026/u,
  );
  assert.equal(warnings[0].event, "compiled_on_demand_persist_failed");

  const rejected = await resolveCustomerAnalysisContexts({
    projectId: document.project_id,
    documents: [document],
    dependencies: {
      listContexts: async () => [],
      storeArtifact: async () => {
        throw new Error("database unavailable");
      },
      now: () => "2026-07-24T00:00:00.000Z",
      warn: () => {},
    },
  });
  assert.equal(rejected.persistenceFailureCount, 1);
  assert.equal(rejected.contexts.has(document.id), true);
});

test("on-demand compilation handles 500 KB raw text within two seconds", async () => {
  const rawText =
    "Kunden skal dokumentere sikkerhet, frister og evalueringskriterier.\n\n".repeat(
      8_000,
    );
  const startedAt = performance.now();
  const result = await resolveCustomerAnalysisContexts({
    projectId: "large-project",
    documents: [
      {
        id: "large-document",
        project_id: "large-project",
        role: "primary_customer_document",
        supporting_subtype: null,
        title: "Stort dokument",
        file_name: "large.txt",
        file_format: "txt",
        content_type: "text/plain",
        file_size_bytes: Buffer.byteLength(rawText),
        processing_status: "enhanced_ready",
        parser_used: "plain-text",
        chunk_source_revision: 1,
        created_at: "2026-07-24T00:00:00.000Z",
        updated_at: "2026-07-24T00:00:00.000Z",
        raw_text: rawText,
        file_base64: "",
        structure_map: [],
      },
    ],
    dependencies: {
      listContexts: async () => [],
      storeArtifact: async () => true,
      now: () => "2026-07-24T00:00:00.000Z",
      warn: () => {},
    },
  });
  assert.equal(result.compiledOnDemandCount, 1);
  assert.ok(performance.now() - startedAt < 2_000);
});

test("local PDF layout compiles flat Norwegian requirement rows without changing fast-path text", () => {
  const item = (str, x, y, width) => ({
    str,
    width,
    height: 10,
    transform: [10, 0, 0, 10, x, y],
  });
  const items = [
    item("Krav-ID", 40, 760, 55),
    item("Rad", 120, 760, 20),
    item("Prioritet", 150, 760, 45),
    item("Kravtekst", 220, 760, 55),
    item("KR-063-01", 40, 730, 65),
    item("01", 120, 730, 12),
    item("Bør", 150, 730, 18),
    item("Løsningen skal støtte sikker innlogging.", 220, 730, 220),
    item("KR-063-02", 40, 710, 65),
    item("02", 120, 710, 12),
    item("Må", 150, 710, 16),
    item("Leverandøren skal dokumentere logging.", 220, 710, 230),
    item("KR-063-03", 40, 690, 65),
    item("03", 120, 690, 12),
    item("Opsjon", 150, 690, 35),
    item("Kunden skal kunne eksportere rapporter.", 220, 690, 230),
  ];
  const page = analyzeLocalPdfPage({ pageNumber: 1, items });
  assert.match(page.rawText, /KR-063-01 01 Bør Løsningen/u);

  const parsed = buildLocalPdfDocument({
    pages: [page],
    label: "Kravgrunnlag",
  });
  const rows = parsed.sourceMap.filter((entry) => entry.kind === "table");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].parser, LOCAL_PDF_LAYOUT_PARSER);
  assert.equal(rows[0].cells["Krav-ID"], "KR-063-01");
  assert.equal(rows[0].cells.Prioritet, "Bør");
  assert.equal(rows[0].cells.Rad, "01");
  assert.equal(
    rows[0].cells.Kravtekst,
    "Løsningen skal støtte sikker innlogging.",
  );
  assert.match(parsed.rawText, /\[\[SIDE:1\]\]/u);
});

test("evidence compiler creates stable, exact and source-addressable Norwegian evidence", () => {
  const base = {
    documentId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    title: "Bilag 2",
    fileName: "bilag-2.pdf",
    fileFormat: "pdf",
    fileSizeBytes: 100_000,
    sourceRevision: 4,
    parserUsed: "azure-layout-v4",
    rawText: "ID 2-01 L everandøren skal dokumentere sikker drift.",
    structureMap: [
      {
        reference: "Bilag 2 tabell 1, rad 2, side 6",
        text: "ID 2-01 | L everandøren skal dokumentere sikker drift.",
        kind: "azure_table_row",
        parser: "azure-layout-v4",
        page: 6,
        table_index: 0,
        row_index: 1,
        source_id: "table-0-row-1",
        polygon: [1, 2, 3, 2, 3, 4, 1, 4],
      },
    ],
    isHighImpactDocument: true,
    compiledAt: "2026-07-14T12:00:00.000Z",
  };
  const first = compileDocumentIntelligenceArtifact(base);
  const second = compileDocumentIntelligenceArtifact({
    ...base,
    compiledAt: "2026-07-14T13:00:00.000Z",
  });
  const requirement = first.evidence.find(
    (evidence) => evidence.kind === "requirement",
  );
  assert.ok(requirement);
  assert.match(requirement.text, /Leverandøren/u);
  assert.match(requirement.sourceText, /L everandøren/u);
  assert.match(requirement.normalizedText, /Leverandøren/u);
  assert.equal(requirement.provenance.page, 6);
  assert.equal(requirement.provenance.sourceId, "table-0-row-1");
  assert.equal(requirement.id, second.evidence[0].id);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(
    createHash("sha256").update(first.analysisContext).digest("hex"),
    "45c0e8918e3da179a924aacbc15a4b41085440450d14649762775133f83101f0",
  );
  assert.match(first.analysisContext, /Bilag 2 tabell 1, rad 2, side 6/u);
  assert.doesNotMatch(first.analysisContext, /evidence_ids/u);
});

test("evidence compiler reuses quality only when parser, revision and content hash match", () => {
  const rawText = "Leverandøren skal levere sikker drift innen 1. oktober 2026.";
  const structureMap = [
    {
      reference: "Side 1",
      text: rawText,
      kind: "text",
      parser: "plain-text",
    },
  ];
  const quality = {
    score: 0.123,
    textCoverage: 0.123,
    readability: 0.123,
    structureCoverage: 0.123,
    sourceEntryCount: 1,
    pageCount: 1,
    tableCount: 0,
    suspiciousCharacterRatio: 0,
    hasRequirementSignals: true,
    hasEvaluationSignals: false,
    hasUnresolvedVisualReferences: false,
    norwegianAnomalies: [],
  };
  const shared = {
    documentId: "quality-document",
    projectId: "quality-project",
    title: "Krav",
    fileName: "krav.txt",
    fileFormat: "txt",
    fileSizeBytes: 100,
    sourceRevision: 4,
    parserUsed: "plain-text",
    rawText,
    structureMap,
    isHighImpactDocument: true,
    compiledAt: "2026-07-24T00:00:00.000Z",
  };
  const contentHash = documentSourceContentHash({ rawText, structureMap });
  const reused = compileDocumentIntelligenceArtifact({
    ...shared,
    precomputedQuality: {
      quality,
      parserUsed: "plain-text",
      sourceRevision: 4,
      contentHash,
    },
  });
  assert.equal(reused.routing.quality.score, 0.123);

  const recomputed = compileDocumentIntelligenceArtifact({
    ...shared,
    precomputedQuality: {
      quality,
      parserUsed: "plain-text",
      sourceRevision: 4,
      contentHash: "mismatch",
    },
  });
  assert.notEqual(recomputed.routing.quality.score, 0.123);
});

test("evidence compiler reserves coverage for deadlines in requirement-heavy documents", () => {
  const structureMap = Array.from({ length: 300 }, (_, index) => ({
    reference: `Krav ${index + 1}`,
    text: `KR-${index + 1} Leverandøren skal oppfylle obligatorisk krav nummer ${index + 1}.`,
    kind: "table",
    parser: "test",
    page: 1,
    table_index: 0,
    row_index: index,
  }));
  structureMap.push({
    reference: "Frister",
    text: "Tilbudsfrist er 1. august 2026 klokken 12:00.",
    kind: "text",
    parser: "test",
    page: 2,
    table_index: undefined,
    row_index: undefined,
  });
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: "00000000-0000-4000-8000-000000000011",
    projectId: "00000000-0000-4000-8000-000000000012",
    title: "Stor kravfil",
    fileName: "krav.pdf",
    fileFormat: "pdf",
    fileSizeBytes: 500_000,
    sourceRevision: 1,
    parserUsed: "test",
    rawText: structureMap.map((entry) => entry.text).join("\n"),
    structureMap,
    isHighImpactDocument: true,
  });

  assert.equal(artifact.evidence.length, 240);
  assert.ok(artifact.evidence.some((unit) => unit.kind === "deadline"));
  assert.match(artifact.analysisContext, /KATEGORIDEKNING/u);
  assert.match(artifact.analysisContext.slice(0, 3_000), /Tilbudsfrist/u);
});

test("parser attempt events use the persisted source revision supplied after ingestion", () => {
  const quality = chooseDocumentParserRoute({
    rawText: "ID 2-01 Krav én\nID 2-02 Krav to\nID 2-03 Krav tre\nID 2-04 Krav fire",
    canonicalText:
      "ID 2-01 Krav én\nID 2-02 Krav to\nID 2-03 Krav tre\nID 2-04 Krav fire",
    sourceMap: [],
    fileFormat: "pdf",
    fileSizeBytes: 120_000,
    parserUsed: "pdf-parse",
    isHighImpactDocument: true,
    azureAvailable: true,
    doclingAvailable: true,
  });
  const parsed = {
    rawText: "Kravgrunnlag",
    sourceMap: [],
    contentType: "application/pdf",
    fileName: "krav.pdf",
    fileFormat: "pdf",
    fileBase64: "",
    parserUsed: "pdf-parse",
  };
  const events = buildDocumentParserAttemptEvents({
    sourceRevision: 7,
    selection: {
      parsed,
      decision: quality,
      selectedQuality: quality.quality,
      selectedContentHash: "test-content-hash",
      localAttempted: true,
      azureAttempted: true,
    },
  });

  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.sourceRevision), [7, 7]);
  assert.equal(events[1].eventType, "parser_fallback");
});

test("Azure layout normalization preserves table coordinates and figure regions", () => {
  const normalized = normalizeAzureLayoutResult({
    title: "Kravbilag",
    analyzeResult: {
      content: "ID 2-01 Leverandøren skal levere.",
      paragraphs: [],
      tables: [
        {
          boundingRegions: [
            {
              pageNumber: 3,
              polygon: [
                { x: 1, y: 2 },
                { x: 4, y: 2 },
                { x: 4, y: 5 },
                { x: 1, y: 5 },
              ],
            },
          ],
          cells: [
            { rowIndex: 0, columnIndex: 0, kind: "columnHeader", content: "Krav-ID" },
            { rowIndex: 0, columnIndex: 1, kind: "columnHeader", content: "Kravtekst" },
            { rowIndex: 1, columnIndex: 0, content: "ID 2-01" },
            { rowIndex: 1, columnIndex: 1, content: "Leverandøren skal levere." },
          ],
        },
      ],
      figures: [
        {
          id: "figure-1",
          caption: { content: "Målarkitektur" },
          boundingRegions: [{ pageNumber: 4, polygon: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
        },
      ],
    },
  });
  const tableRow = normalized.sourceMap.find(
    (entry) => entry.kind === "azure_table_row",
  );
  assert.equal(tableRow?.cells?.["Krav-ID"], "ID 2-01");
  assert.equal(tableRow?.page, 3);
  assert.deepEqual(tableRow?.polygon, [1, 2, 4, 2, 4, 5, 1, 5]);
  assert.equal(
    normalized.sourceMap.find((entry) => entry.kind === "azure_figure")?.page,
    4,
  );
});

test("document intelligence migration is service-only and stores encrypted payloads", async () => {
  const sql = await readFile(
    path.join(
      repositoryRoot,
      "supabase/migrations/20260714144342_document_intelligence_v2.sql",
    ),
    "utf8",
  );
  assert.match(sql, /artifact_encrypted jsonb not null/u);
  assert.match(sql, /analysis_context_encrypted text not null/u);
  assert.match(sql, /enable row level security/u);
  assert.match(sql, /from public, anon, authenticated/u);
  assert.match(sql, /to service_role/u);
  assert.match(sql, /save_document_intelligence_artifact/u);
  assert.match(sql, /document\.chunk_source_revision = p_source_revision/u);
  assert.match(sql, /for update/u);
  assert.match(sql, /source_revision <= excluded\.source_revision/u);
  assert.doesNotMatch(sql, /create policy/iu);
});

test("document intelligence A/B hard corpus is configured without machine-specific paths", async () => {
  const [v2Source, v3Source] = await Promise.all([
    readFile(
      path.join(repositoryRoot, "scripts/document_intelligence_ab_eval.mjs"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "scripts/document_analysis_v3_eval.mjs"),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(v2Source, /\/Users\//u);
  assert.match(v2Source, /--hard-corpus-root/u);
  assert.match(v2Source, /DOCUMENT_INTELLIGENCE_HARD_CORPUS_ROOT/u);
  assert.doesNotMatch(v3Source, /\/Users\//u);
  assert.match(v3Source, /ABSOLUTE_BUDGET_CAP_USD = 15/u);
  assert.match(v3Source, /store: false/u);
  assert.match(v3Source, /"gpt-5\.6-terra"/u);
  assert.match(v3Source, /"gpt-5\.6-sol"/u);
});

test("production deployment keeps document intelligence opt-in and admin identity stable", async () => {
  const [envExample, bicep, workflow] = await Promise.all([
    readFile(path.join(repositoryRoot, ".env.example"), "utf8"),
    readFile(
      path.join(repositoryRoot, "infra/azure/container-app.bicep"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, ".github/workflows/deploy-azure.yml"),
      "utf8",
    ),
  ]);
  assert.match(envExample, /^DOCUMENT_ANALYSIS_VERSION=off$/mu);
  assert.match(envExample, /^OPENAI_DOCUMENT_ANALYSIS_MODEL=gpt-5\.6-terra$/mu);
  assert.match(bicep, /param documentAnalysisVersion string = 'off'/u);
  assert.match(bicep, /param openAiDocumentAnalysisModel string = 'gpt-5\.6-terra'/u);
  assert.match(bicep, /name: 'APP_ADMIN_PRINCIPAL_ID'/u);
  assert.match(bicep, /name: 'APP_ADMIN_ACCESS_PASSWORD_HASH'/u);
  assert.match(workflow, /DOCUMENT_ANALYSIS_VERSION:.*'off'/u);
  assert.match(workflow, /OPENAI_DOCUMENT_ANALYSIS_MODEL:.*'gpt-5\.6-terra'/u);
  assert.match(workflow, /adminPrincipalId="\$APP_ADMIN_PRINCIPAL_ID"/u);
});
