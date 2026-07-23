import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
const { normalizeNorwegianTextForSearch, detectNorwegianParseAnomalies } =
  await jiti.import(
    path.join(
      frontendRoot,
      "lib/server/document-intelligence/norwegian-language.ts",
    ),
  );
const {
  documentAnalysisVersion,
  isDocumentAnalysisEnabled,
  isDocumentAnalysisV3Enabled,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/config.ts",
  ),
);
const {
  buildCanonicalDocumentProjection,
  canonicalizeNorwegianDocumentText,
  diagnoseNorwegianDocumentText,
} = await jiti.import(
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
  CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
  CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS,
} = await jiti.import(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/customer-analysis-v3.ts",
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
const {
  isCurrentDocumentIntelligenceContext,
  shouldUseCompiledCustomerAnalysisContext,
} = await jiti.import(
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

  assert.equal(CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.required,
    [...CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS],
  );
  assert.equal(CUSTOMER_ANALYSIS_V3_REQUIRED_FIELDS.length, 19);
  assert.equal(
    CUSTOMER_ANALYSIS_V3_JSON_SCHEMA.properties.implicit_requirements.maxItems,
    3,
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
});

test("quality routing keeps clean documents fast and tries local structure before Azure", () => {
  const cleanText = "Leverandøren skal beskrive sikker drift. ".repeat(160);
  const clean = chooseDocumentParserRoute({
    rawText: cleanText,
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

test("customer analysis keeps source-rich local context until compression is necessary", () => {
  assert.equal(
    shouldUseCompiledCustomerAnalysisContext({
      rawTextLength: 16_920,
      analysisContextLength: 8_000,
      isPrimaryDocument: true,
    }),
    false,
  );
  assert.equal(
    shouldUseCompiledCustomerAnalysisContext({
      rawTextLength: 32_000,
      analysisContextLength: 8_000,
      isPrimaryDocument: true,
    }),
    true,
  );
  assert.equal(
    shouldUseCompiledCustomerAnalysisContext({
      rawTextLength: 7_500,
      analysisContextLength: 3_000,
      isPrimaryDocument: false,
    }),
    false,
  );
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
  assert.match(first.analysisContext, /Bilag 2 tabell 1, rad 2, side 6/u);
  assert.doesNotMatch(first.analysisContext, /evidence_ids/u);
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

test("production deployment keeps document intelligence opt-in and password ownership stable", async () => {
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
  assert.match(bicep, /name: 'APP_PASSWORD_OWNER_ID'/u);
  assert.match(workflow, /DOCUMENT_ANALYSIS_VERSION:.*'off'/u);
  assert.match(workflow, /OPENAI_DOCUMENT_ANALYSIS_MODEL:.*'gpt-5\.6-terra'/u);
  assert.match(workflow, /sharedAppUserId="\$APP_PASSWORD_OWNER_ID"/u);
});
