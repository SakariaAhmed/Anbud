import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import {
  ApiClient,
  HARNESS_CHECKPOINT_SCHEMA_VERSION,
  PETORO_GOLDEN_REQUIREMENT_IDS_V1,
  PETORO_GOLDEN_TEXT_SHA256_V1,
  PETORO_GOLDEN_TEXT_ANCHORS_V1,
  RELEVANT_25_V1_PROFILE,
  SYNTHETIC_CUSTOMER_DOCUMENT_TITLE,
  SYNTHETIC_CUSTOMER_FILE_NAME,
  aggregateProjects,
  analyzeCleanupBaseline,
  analyzeRequirementCoverageIntegrity,
  assertGeneratedArtifactSourceScope,
  approximateCost,
  buildFailureCheckpoint,
  buildHarnessCanonicalRequirementScope,
  buildIntegrityLedgerFromGeneratedSolutionArtifact,
  buildSyntheticCustomerDocument,
  checkpointArtifactHashes,
  checkpointConfigurationRevision,
  checkpointIdentity,
  checkpointIdentityMismatch,
  compareLedgerWithFasitRows,
  compareLedgerWithRequirementOracle,
  cleanupTargetsFromEventsAndDatabase,
  documentTitleForUpload,
  isRunOwnedProject,
  listStoragePrefixFiles,
  mergeExistingProjectArtifacts,
  normalizeRequirementMeaning,
  parseRetryAfterMs,
  protectedPetoroProjectsFromBaseline,
  projectDocumentDetailFromParsed,
  projectCheckpointContext,
  readJsonCheckpoint,
  reusableCheckpointIssue,
  resolveRunnerModelPlan,
  assertRunnerModelPreflight,
  scoreProject,
  selectProjects,
  selectionProfileMetadata,
  selectedScope,
  shardStopReason,
  strictProjectGate,
  sharedEstimatedCostStatus,
  sharedCostCapStopReason,
  technicalProjectGate,
  summarizeTelemetry,
  validateSelectionProfileSources,
  waitForHealth,
  writeHtmlReport,
  writeJson,
} from "./run_vurdering_api_full_251.mjs";

test("harness requirement comparison never masks grammatical supplier corruption", () => {
  assert.notEqual(
    normalizeRequirementMeaning("Leverandør er ansvarlig."),
    normalizeRequirementMeaning("Leverandører ansvarlig."),
  );
  assert.notEqual(
    normalizeRequirementMeaning("En underleverandør er ansvarlig."),
    normalizeRequirementMeaning("En underleverandører ansvarlig."),
  );
});

test("cleanup-only never depends on selection-profile source bytes", () => {
  const source = readFileSync(
    new URL("./run_vurdering_api_full_251.mjs", import.meta.url),
    "utf8",
  );
  const cleanupStart = source.indexOf("if (options.cleanupOnly)");
  const cleanupEnd = source.indexOf(
    "const discovered = await discoverProjects(options);",
    cleanupStart,
  );
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupEnd, -1);
  const cleanupBlock = source.slice(cleanupStart, cleanupEnd);
  assert.match(cleanupBlock, /cleanupCreatedProjects/u);
  assert.doesNotMatch(cleanupBlock, /discoverProjects/u);
  assert.doesNotMatch(cleanupBlock, /validateSelectionProfileSources/u);
});

function selectionOptions(overrides = {}) {
  return {
    runId: "audit-test",
    runIdExplicit: true,
    discoverOnly: false,
    selectionProfile: "",
    corpus: null,
    includePetoro: false,
    requireProtectedPetoro: false,
    only: "",
    fromIndex: null,
    toIndex: null,
    shardIndex: null,
    shardCount: null,
    limit: null,
    expectSelected: null,
    customerAnalysisApi: true,
    model: "gpt-5.4",
    baseUrl: "",
    ...overrides,
  };
}

test("strict model preflight exposes and rejects implicit analysis promotion", () => {
  const promoted = resolveRunnerModelPlan(
    { model: "gpt-5.4-mini" },
    { OPENAI_MODEL: "gpt-5.4-mini" },
  );
  assert.deepEqual(promoted, {
    requestedModel: "gpt-5.4-mini",
    configuredDefaultModel: "gpt-5.4-mini",
    configuredAnalysisModel: "gpt-5.4",
    effectiveDefaultModel: "gpt-5.4-mini",
    effectiveAnalysisModel: "gpt-5.4",
    promotedAnalysisModel: true,
    effectiveByStage: {
      customerAnalysis: "gpt-5.4-mini",
      requirementResponseBatch: "gpt-5.4",
      requirementCoverageBatch: "gpt-5.4",
      solutionEvaluationHolistic: "gpt-5.4",
    },
  });
  assert.throws(
    () =>
      assertRunnerModelPreflight(
        { model: "gpt-5.4-mini", strictModel: true },
        { OPENAI_MODEL: "gpt-5.4-mini" },
      ),
    /Strict model preflight failed before API calls.*OPENAI_ANALYSIS_MODEL=gpt-5\.4-mini/u,
  );

  const strictMini = assertRunnerModelPreflight(
    { model: "gpt-5.4-mini", strictModel: true },
    {
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_ANALYSIS_MODEL: "gpt-5.4-mini",
    },
  );
  assert.equal(strictMini.promotedAnalysisModel, false);
  assert.equal(strictMini.effectiveAnalysisModel, "gpt-5.4-mini");
});

test("shared estimated cost cap stops before the next project and documents concurrency caveat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vurdering-cost-cap-"));
  const serverLogPath = path.join(root, "server.log");
  try {
    await writeFile(
      serverLogPath,
      `${JSON.stringify({
        event: "ai_json_completion_timing",
        model: "gpt-5.4-mini",
        input_tokens: 1_000_000,
        output_tokens: 0,
        total_tokens: 1_000_000,
        system_chars: 0,
        user_chars: 0,
        duration_ms: 1,
      })}\n`,
      "utf8",
    );
    const options = {
      serverLogPath,
      maxEstimatedCostUsd: 0.4,
    };
    const status = sharedEstimatedCostStatus(options);
    assert.equal(status.reached, true);
    assert.equal(status.estimatedCostUsd, 0.5);
    assert.equal(status.enforcement, "before_first_project_and_between_projects");
    assert.match(status.caveat, /Concurrent shards.*overshoot/u);

    const stop = sharedCostCapStopReason(options, "100-folder-002");
    assert.equal(stop?.kind, "cost_cap");
    assert.equal(stop?.projectId, "100-folder-002");
    assert.match(stop?.issues[0] ?? "", /reached cap \$0\.40/u);

    assert.equal(
      sharedCostCapStopReason(
        { serverLogPath, maxEstimatedCostUsd: null },
        "100-folder-002",
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function corpusProjects() {
  return [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `100-folder-${String(index + 1).padStart(3, "0")}`,
      corpus: "100-folder",
      sourceNumber: String(index + 1).padStart(3, "0"),
      documentName: `requirement-${String(index + 1).padStart(3, "0")}.docx`,
      requirementPath: `/fixtures/requirement-${String(index + 1).padStart(3, "0")}.docx`,
    })),
    {
      id: "petoro",
      corpus: "Petoro",
      sourceNumber: "251",
      documentName: "petoro.pdf",
      requirementPath: "/fixtures/petoro.pdf",
    },
  ];
}

function requirementScopeDocument(id, overrides = {}) {
  return {
    id,
    project_id: "scope-project",
    role: "supporting_document",
    supporting_subtype: "kravdokument",
    title: `Kravdokument ${id}`,
    file_name: `${id}.md`,
    file_format: "md",
    content_type: "text/markdown",
    file_size_bytes: 100,
    page_count: 1,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "test",
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    raw_text: "Kravtekst",
    file_base64: "",
    structure_map: [],
    ...overrides,
  };
}

function scopeLedgerEntry(document, id, text, order) {
  return {
    id,
    text,
    pages: [1],
    heading: "Kravseksjon",
    sourceExcerpt: `${document.title}, Side 1, ${id}`,
    documentId: document.id,
    documentTitle: document.title,
    documentEntryOrder: order,
  };
}

function combinedScopeFixture() {
  const customerDocument = requirementScopeDocument("customer", {
    role: "primary_customer_document",
    supporting_subtype: null,
    title: "Bilag 1 - Kundebehov",
    file_name: "bilag-1.md",
  });
  const formalDocument = requirementScopeDocument("requirements", {
    title: "Bilag 2 - Krav",
    file_name: "bilag-2.md",
  });
  const customerOnlyText =
    "Løsningen skal kunne innføres stegvis uten omfattende spesialutvikling.";
  const firstFormalText =
    "Leverandøren skal dokumentere sporbar endringskontroll.";
  const secondFormalText =
    "Løsningen skal tilby strukturert eksport ved leverandørbytte.";
  const customerLedger = [
    scopeLedgerEntry(customerDocument, "C-001", customerOnlyText, 0),
    scopeLedgerEntry(customerDocument, "K-001", firstFormalText, 1),
  ];
  const bilag2Ledger = [
    scopeLedgerEntry(formalDocument, "K-001", firstFormalText, 0),
    scopeLedgerEntry(formalDocument, "K-002", secondFormalText, 1),
  ];
  const canonical = buildHarnessCanonicalRequirementScope({
    customerDocument,
    formalRequirementDocuments: [formalDocument],
    requirementLedgerResults: [
      { document: customerDocument, ledger: customerLedger },
      { document: formalDocument, ledger: bilag2Ledger },
    ],
  });
  return {
    customerDocument,
    formalDocument,
    customerLedger,
    bilag2Ledger,
    canonical,
  };
}

function coverageItem(index, assessment = "Godt") {
  return {
    order_index: index,
    reference: `R-${String(index + 1).padStart(3, "0")}`,
    requirement_subtitle: `Kravoverskrift ${index + 1}`,
    assessment,
    rationale: "Konkret begrunnelse med tilstrekkelig detaljnivå.",
    evidence: "Sporbart leveransebevis med dokumentert kontrollpunkt.",
    recommendation: "Anbefalt oppfølging med ansvar, frist og akseptanse.",
    answer_document_id: "solution-doc",
  };
}

function artifactMarkdownForCoverage(items, additionalEvidence = []) {
  const escapeCell = (value) => String(value ?? "").replace(/\|/g, "\\|");
  return [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...items.map(
      (item) =>
        `| ${escapeCell(item.reference)} | Kravtekst | ${escapeCell(item.evidence)} | ${escapeCell(item.evidence)} | Kildedokument |`,
    ),
    "",
    ...additionalEvidence,
  ].join("\n");
}

function generationMetadata(sourceCount) {
  const requirementRefs = Array.from(
    { length: sourceCount },
    (_, index) => `R-${String(index + 1).padStart(3, "0")}`,
  );
  return {
    method: "ledger_batch",
    total_requirements: sourceCount,
    batch_count: 2,
    failed_batches: 0,
    deterministic_fallback_answers_after_handoff: 0,
    deterministic_template_repair_answers: 0,
    deterministic_template_repair_refs: [],
    deterministic_template_repair_rows: [],
    deterministic_control_repair_answers: 0,
    deterministic_control_repair_refs: [],
    deterministic_control_repair_rows: [],
    proposal_input_required_count: 0,
    proposal_input_required_refs: [],
    proposal_input_required_rows: [],
    manual_review_required: false,
    unresolved_fallback_answers: [],
    coverage_enforced: true,
    source_evidence_enforced: true,
    requirement_refs: requirementRefs,
    immutable_row_manifest: {
      version: 1,
      rows: requirementRefs.map((ref, index) => ({
        order_index: index,
        ref,
        requirement_text_normalized: `Kravtekst ${index + 1}`,
        source_locator: `Kildedokument, rad ${index + 1}`,
        source_document_id: "requirement-document",
        row_sha256: String(index + 1).padStart(64, "0"),
      })),
      manifest_sha256: "f".repeat(64),
    },
  };
}

function generationMetadataWithRefs(refs) {
  const metadata = generationMetadata(refs.length);
  metadata.requirement_refs = [...refs];
  metadata.immutable_row_manifest.rows =
    metadata.immutable_row_manifest.rows.map((row, index) => ({
      ...row,
      ref: refs[index],
    }));
  return metadata;
}

function scoringInput({
  assessments = Array(10).fill("Godt"),
  coverageOverrides = {},
  metadata = generationMetadata(assessments.length),
  fasitComparison = null,
  documentFindings = [
    {
      reference: "Seksjonsfunn: samlet løsningsbeskrivelse",
      reference_match: "section",
      matched_requirement_reference: null,
      finding:
        "Leveransemodellen er konkret beskrevet med ansvar og kontrollpunkter.",
      evidence: "Samlet løsningsbeskrivelse med dokumentert leveransemodell.",
      evidence_grounding: "document_exact",
      recommendation:
        "Behold koblingen mellom ansvar, kontrollpunkt og dokumentert akseptanse.",
    },
  ],
  artifactMarkdown = null,
  evaluationOverrides = {},
  oracleComparison = { ok: true },
  expectedSolutionDocumentId = "solution-doc",
} = {}) {
  const items = assessments.map((assessment, index) =>
    coverageItem(index, assessment),
  );
  const counts = {
    good: assessments.filter((value) => value === "Godt").length,
    weak: assessments.filter((value) => value === "Dårlig").length,
    missing: assessments.filter((value) => value === "Mangler").length,
    unclear: assessments.filter((value) => value === "Uklart").length,
  };
  const coverage = {
    total_requirements: assessments.length,
    assessed_requirements: assessments.length,
    items,
    coverage_summary:
      "Alle krav er vurdert med dokumentforankret evidens, begrunnelse og anbefalt oppfølging.",
    ...counts,
    ...coverageOverrides,
  };
  const evaluation = {
    fit_to_customer_needs:
      "Løsningen svarer presist på kundens behov og binder leveransen til tydelige kontrollpunkter, ansvar og dokumentert akseptanse.",
    strengths: [
      "Besvarelsen har komplett kravsporbarhet med konkrete leveransebevis.",
      "Ansvar, verifikasjon og akseptanse er tydelig knyttet til hvert krav.",
    ],
    weaknesses: [
      "Enkelte detaljer bør fortsatt presiseres kontraktuelt før endelig signering.",
    ],
    risks_to_customer: [
      "Manglende oppfølging av avklaringer kan gi restusikkerhet i gjennomføringen.",
    ],
    improvement_recommendations: [
      "Bevar sporbarheten mellom krav, tiltak, kontrollpunkt og akseptanse.",
      "Lukk alle kommersielle avklaringer med tydelig ansvar og frist.",
    ],
    likely_score_assessment: {
      quality: "Svært høy kvalitet med komplett og konkret dekning.",
      delivery_confidence:
        "Høy leveransesikkerhet med dokumenterte kontrollpunkter.",
      risk: "Lav restusikkerhet når de beskrevne tiltakene følges.",
      competitiveness:
        "Meget konkurransedyktig og tydelig differensiert besvarelse.",
    },
    requirement_coverage: coverage,
    architecture_comparison: {
      winner: "Arkitektløsning",
      architect_solution_score: 96,
      system_solution_score: 94,
      verdict:
        "Arkitektløsningen er marginalt sterkest fordi den kombinerer full kravsporbarhet med konkrete leveransebevis og en tydelig gjennomføringsmodell.",
      strong_critique: [
        "Besvarelsen kan styrkes ytterligere ved å tallfeste operative mål der kilden tillater dette.",
      ],
      pragmatic_reflections: [
        "Den foreslåtte modellen er realistisk fordi ansvar og kontrollpunkter kan innarbeides direkte i leveranseplanen.",
      ],
      strategy_improvement_advice: [
        "Bruk de dokumenterte kontrollpunktene aktivt som differensierende bevis i tilbudet.",
      ],
    },
    executive_summary:
      "Besvarelsen er helhetlig, sporbar og handlingsrettet. Den dekker alle identifiserte krav med konkrete leveransebevis, tydelig ansvar, verifikasjon og akseptanse, samtidig som gjenværende avklaringer er synlige og styrbare.",
    document_findings: documentFindings,
    ...evaluationOverrides,
  };
  const resolvedArtifactMarkdown =
    artifactMarkdown ??
    artifactMarkdownForCoverage(
      items,
      documentFindings.map((finding) => finding.evidence),
    );
  return {
    sourceCount: assessments.length,
    coverage,
    integrity: { ok: true, issueCount: 0 },
    fasitComparison,
    oracleComparison,
    requirementResponseMetadata: metadata,
    bilag1Fallback: null,
    documentFindings,
    evaluation,
    artifactMarkdown: resolvedArtifactMarkdown,
    expectedSolutionDocumentId,
  };
}

function exactFasitComparison(count) {
  return {
    expectedCount: count,
    actualCount: count,
    rawUnorderedMatched: count,
    unorderedMatched: count,
    rawOrderedMatched: count,
    orderedMatched: count,
    workbookOrderedMatched: count,
    mismatchCount: 0,
    mismatches: [],
    sourceIssueCount: 0,
    sourceIssues: [],
    idComparable: count,
    idMatched: count,
    headingComparable: count,
    headingMatched: count,
  };
}

function strictProjectSummary({
  canonicalCount = 10,
  bilag2Count = canonicalCount,
  projectOverrides = {},
} = {}) {
  const fasitComparison = exactFasitComparison(bilag2Count);
  const input = scoringInput({
    assessments: Array(canonicalCount).fill("Godt"),
    metadata: generationMetadata(canonicalCount),
    fasitComparison,
    oracleComparison: null,
  });
  const scoring = scoreProject(input);
  return {
    id: "strict-project",
    name: "Strict Project",
    documentName: "requirements.md",
    corpus: "100-folder",
    ok: true,
    score: 100,
    scoreBand: "Strong",
    sourceRequirementCount: canonicalCount,
    canonicalRequirementCount: canonicalCount,
    bilag2RequirementCount: bilag2Count,
    customerRequirementCount: canonicalCount - bilag2Count,
    customerParsedRequirementCount: canonicalCount - bilag2Count,
    coverage: {
      total_requirements: canonicalCount,
      assessed_requirements: canonicalCount,
      good: canonicalCount,
      weak: 0,
      missing: 0,
      unclear: 0,
      itemCount: canonicalCount,
      missingSubtitles: 0,
    },
    integrity: {
      ok: true,
      sourceCount: canonicalCount,
      itemCount: canonicalCount,
      issueCount: 0,
      issues: [],
    },
    fasitComparison,
    requirementOracle: null,
    documentFindingTraceability: scoring.documentFindingTraceability,
    answerEvidenceGrounding: scoring.answerEvidenceGrounding,
    holisticEvaluation: scoring.holisticEvaluation,
    scoreComponents: scoring.components,
    acceptance: scoring.acceptance,
    durations: { totalMs: 10 },
    customerAnalysisMode: "api",
    bilag1Fallback: null,
    ...projectOverrides,
  };
}

test("local parsed titles match extensionless upload titles for PDF, DOCX and MD", () => {
  const cases = [
    ["Kravdokument.PDF", "Kravdokument", "pdf", "application/pdf"],
    [
      "Bilag 1 kunde.DOCX",
      "Bilag 1 kunde",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["generert-kravsvar.md", "generert-kravsvar", "md", "text/markdown"],
  ];

  for (const [fileName, expectedTitle, fileFormat, contentType] of cases) {
    const localDocument = projectDocumentDetailFromParsed({
      fileName,
      parsed: {
        fileFormat,
        contentType,
        parserUsed: "harness-title-test",
        rawText: "Dokumenttekst",
        fileBase64: "",
        sourceMap: [],
      },
      buffer: Buffer.from("Dokumenttekst"),
      projectId: "title-parity",
      role: "supporting_document",
    });

    assert.equal(documentTitleForUpload(fileName), expectedTitle);
    assert.equal(localDocument.title, expectedTitle);
  }
});

test("synthetic customer fallback uses the same explicit local and remote title", async () => {
  const localDocument = await buildSyntheticCustomerDocument({
    projectId: "synthetic-title-parity",
    projectName: "Testkunde",
    reason: "syntetisk parserfeil",
  });

  assert.equal(localDocument.file_name, SYNTHETIC_CUSTOMER_FILE_NAME);
  assert.equal(localDocument.title, SYNTHETIC_CUSTOMER_DOCUMENT_TITLE);
  assert.notEqual(
    localDocument.title,
    documentTitleForUpload(SYNTHETIC_CUSTOMER_FILE_NAME),
  );
});

test("selects exactly 100-folder + Petoro and partitions 101 rows without overlap", () => {
  const projects = corpusProjects();
  const full = selectProjects(
    projects,
    selectionOptions({
      corpus: "100-folder",
      includePetoro: true,
      expectSelected: 101,
    }),
  );
  assert.equal(full.length, 101);
  assert.equal(
    full.filter((project) => project.corpus === "100-folder").length,
    100,
  );
  assert.equal(full.filter((project) => project.id === "petoro").length, 1);

  const shards = [0, 1, 2].map((shardIndex) =>
    selectProjects(
      projects,
      selectionOptions({
        corpus: "100-folder",
        includePetoro: true,
        expectSelected: 101,
        shardCount: 3,
        shardIndex,
        baseUrl: "http://127.0.0.1:3222",
      }),
    ),
  );
  assert.deepEqual(
    shards.map((shard) => shard.length),
    [34, 34, 33],
  );
  const ids = shards.flatMap((shard) => shard.map((project) => project.id));
  assert.equal(ids.length, 101);
  assert.equal(new Set(ids).size, 101);
  const shardScope = selectedScope(
    shards[0],
    selectionOptions({ expectSelected: 101 }),
  );
  assert.deepEqual(
    {
      requested: shardScope.requestedProjects,
      expected: shardScope.fullScopeExpectedProjects,
    },
    { requested: 34, expected: 101 },
  );
});

test("relevant-25-v1 freezes 25 corpus rows plus Petoro in deterministic shard order", () => {
  const projects = corpusProjects();
  const profileOptions = selectionOptions({
    selectionProfile: RELEVANT_25_V1_PROFILE.name,
    expectSelected: 26,
    discoverOnly: true,
  });
  const full = selectProjects(projects, profileOptions);
  assert.deepEqual(
    full.map((project) => project.id),
    RELEVANT_25_V1_PROFILE.orderedProjectIds,
  );
  assert.equal(
    full.filter((project) => project.corpus === "100-folder").length,
    25,
  );
  assert.equal(full.filter((project) => project.id === "petoro").length, 1);
  assert.deepEqual(selectionProfileMetadata(profileOptions), {
    name: "relevant-25-v1",
    profileSha256:
      "646edc410b402f0fc14b3f9ee83527b382d328026b191089f376b05b864387bc",
    orderedProjectIds: [...RELEVANT_25_V1_PROFILE.orderedProjectIds],
    sourceHashes: {
      corpusFasitSha256:
        "01979213d1c6b3aa45eb78af4533f33b58331b92e19dc01a881719bd12c311f1",
      selectedSourceFilesSha256:
        "63d964933dd9848f4c916cd623089bb78e03c1449ad0ad7787c9f7b51f2a221a",
      petoroRequirementSha256:
        "5db6fff8eb52887361103b0ceade45916b6a3ffad76c5cba5d277d903fbf0d52",
      petoroCustomerSha256:
        "9da92696c90989c6c50778cc8a60f2a0ddda2465d7f7a2bb801ef196d5e86795",
    },
  });

  const shards = [0, 1, 2, 3].map((shardIndex) =>
    selectProjects(projects, {
      ...profileOptions,
      shardCount: 4,
      shardIndex,
    }),
  );
  assert.deepEqual(
    shards.map((shard) => shard.length),
    [7, 7, 6, 6],
  );
  assert.deepEqual(
    shards.map((shard) => shard.map((project) => project.id)),
    [
      [
        "100-folder-001",
        "100-folder-012",
        "100-folder-034",
        "100-folder-054",
        "100-folder-070",
        "100-folder-084",
        "100-folder-099",
      ],
      [
        "100-folder-002",
        "100-folder-015",
        "100-folder-038",
        "100-folder-056",
        "100-folder-071",
        "100-folder-088",
        "petoro",
      ],
      [
        "100-folder-008",
        "100-folder-021",
        "100-folder-045",
        "100-folder-058",
        "100-folder-073",
        "100-folder-093",
      ],
      [
        "100-folder-010",
        "100-folder-032",
        "100-folder-049",
        "100-folder-062",
        "100-folder-077",
        "100-folder-095",
      ],
    ],
  );
  const flattened = shards.flatMap((shard) =>
    shard.map((project) => project.id),
  );
  assert.equal(flattened.length, 26);
  assert.equal(new Set(flattened).size, 26);
  assert.deepEqual(
    RELEVANT_25_V1_PROFILE.orderedProjectIds.filter((projectId) =>
      flattened.includes(projectId),
    ),
    RELEVANT_25_V1_PROFILE.orderedProjectIds,
  );
});

test("relevant-25-v1 rejects ambiguous CLI options and corpus drift", () => {
  const projects = corpusProjects();
  const validProfileOptions = selectionOptions({
    selectionProfile: RELEVANT_25_V1_PROFILE.name,
    expectSelected: 26,
    discoverOnly: true,
  });
  assert.throws(
    () =>
      selectProjects(projects, {
        ...validProfileOptions,
        selectionProfile: "relevant-25-v2",
      }),
    /Unknown --selection-profile/u,
  );
  for (const incompatible of [
    { only: "100-folder-001" },
    { limit: 25 },
    { fromIndex: 1 },
    { toIndex: 26 },
  ]) {
    assert.throws(
      () =>
        selectProjects(projects, {
          ...validProfileOptions,
          ...incompatible,
        }),
      /--selection-profile cannot be combined/u,
    );
  }
  for (const expectSelected of [null, 25, 27]) {
    assert.throws(
      () =>
        selectProjects(projects, {
          ...validProfileOptions,
          expectSelected,
        }),
      /requires --expect-selected 26/u,
    );
  }
  assert.throws(
    () =>
      selectProjects(projects, {
        ...validProfileOptions,
        corpus: "50-folder",
      }),
    /only supports --corpus 100-folder/u,
  );
  assert.throws(
    () =>
      selectProjects(projects, {
        ...validProfileOptions,
        discoverOnly: false,
        requireProtectedPetoro: false,
      }),
    /requires --require-protected-petoro/u,
  );
  assert.throws(
    () => selectProjects(projects.slice(1), validProfileOptions),
    /requires the exact 100-folder corpus/u,
  );
  const duplicateCorpusId = corpusProjects();
  duplicateCorpusId[1] = {
    ...duplicateCorpusId[1],
    id: duplicateCorpusId[0].id,
  };
  assert.throws(
    () => selectProjects(duplicateCorpusId, validProfileOptions),
    /requires the exact 100-folder corpus/u,
  );
  const wrongPetoroCorpus = corpusProjects();
  wrongPetoroCorpus.at(-1).corpus = "100-folder";
  assert.throws(
    () => selectProjects(wrongPetoroCorpus, validProfileOptions),
    /requires the exact 100-folder corpus|requires exactly one petoro/u,
  );
});

test("relevant-25-v1 source hashes fail closed before a live run", async () => {
  const projects = corpusProjects();
  const options = selectionOptions({
    selectionProfile: RELEVANT_25_V1_PROFILE.name,
    expectSelected: 26,
    discoverOnly: true,
  });
  const expectedHashes = {
    corpusFasitSha256: RELEVANT_25_V1_PROFILE.corpusFasitSha256,
    selectedSourceFilesSha256:
      RELEVANT_25_V1_PROFILE.selectedSourceFilesSha256,
    petoroRequirementSha256:
      RELEVANT_25_V1_PROFILE.petoroRequirementSha256,
    petoroCustomerSha256: RELEVANT_25_V1_PROFILE.petoroCustomerSha256,
  };
  const verified = await validateSelectionProfileSources(options, projects, {
    computeHashes: async () => ({ ...expectedHashes }),
  });
  assert.deepEqual(verified, {
    name: RELEVANT_25_V1_PROFILE.name,
    profileSha256: RELEVANT_25_V1_PROFILE.profileSha256,
    orderedProjectIds: [...RELEVANT_25_V1_PROFILE.orderedProjectIds],
    sourceHashes: expectedHashes,
  });
  for (const field of Object.keys(expectedHashes)) {
    await assert.rejects(
      validateSelectionProfileSources(options, projects, {
        computeHashes: async () => ({
          ...expectedHashes,
          [field]: "0".repeat(64),
        }),
      }),
      new RegExp(`source hash mismatch for ${field}`, "u"),
    );
  }
});

test("selection fails closed for unknown corpus, empty rows, and count drift", () => {
  const projects = corpusProjects();
  assert.throws(
    () =>
      selectProjects(
        projects,
        selectionOptions({ corpus: "100-foldre", includePetoro: true }),
      ),
    /Unknown --corpus/,
  );
  assert.throws(
    () =>
      selectProjects(projects, selectionOptions({ only: "does-not-exist" })),
    /selection is empty/i,
  );
  assert.throws(
    () =>
      selectProjects(
        projects,
        selectionOptions({
          corpus: "100-folder",
          includePetoro: true,
          expectSelected: 100,
        }),
      ),
    /expected 100, found 101/,
  );
  assert.throws(
    () =>
      selectProjects(
        projects,
        selectionOptions({
          corpus: "100-folder",
          includePetoro: true,
          expectSelected: 101,
          shardCount: 3,
          shardIndex: 0,
        }),
      ),
    /requires an explicit --base-url/,
  );
  const duplicated = corpusProjects();
  duplicated[1] = {
    ...duplicated[1],
    id: duplicated[0].id,
    requirementPath: duplicated[0].requirementPath,
  };
  assert.throws(
    () =>
      selectProjects(
        duplicated,
        selectionOptions({ corpus: "100-folder", includePetoro: true }),
      ),
    /duplicate project id/i,
  );
});

test("canonical customer + Bilag 2 scope keeps source order and removes only formal duplicates", () => {
  const fixture = combinedScopeFixture();
  assert.deepEqual(
    fixture.canonical.sourceDocuments.map((document) => document.id),
    [fixture.customerDocument.id, fixture.formalDocument.id],
  );
  assert.deepEqual(
    fixture.canonical.ledger.map((entry) => entry.id),
    ["C-001", "K-001", "K-002"],
  );
  assert.deepEqual(
    fixture.canonical.ledger.map((entry) => entry.documentOrder),
    [0, 1, 1],
  );
  assert.deepEqual(
    fixture.canonical.ledger.map((entry) => entry.documentId),
    [
      fixture.customerDocument.id,
      fixture.formalDocument.id,
      fixture.formalDocument.id,
    ],
  );
});

test("combined evaluation scope stays separate from the Bilag 2 fasit inventory", () => {
  const fixture = combinedScopeFixture();
  const comparison = compareLedgerWithFasitRows(
    fixture.bilag2Ledger,
    fixture.bilag2Ledger.map((entry) => ({
      Kravtekst: entry.text,
      "Har brukbar ID": "Ja",
      "ID-identifikator": entry.id,
      Underoverskrift: entry.heading,
    })),
    { sourceFormat: "md" },
  );

  assert.equal(fixture.canonical.ledger.length, 3);
  assert.equal(fixture.bilag2Ledger.length, 2);
  assert.equal(comparison.expectedCount, 2);
  assert.equal(comparison.actualCount, 2);
  assert.equal(comparison.orderedMatched, 2);
  assert.equal(comparison.idMatched, 2);
  assert.equal(comparison.headingMatched, 2);
  assert.equal(comparison.mismatchCount, 0);
});

test("a missing customer answer is a real assessment gap, not an integrity cascade", async () => {
  const fixture = combinedScopeFixture();
  const answers = new Map([
    [
      "K-001",
      "Atea logger hver endring med identitet, tidspunkt, gammel verdi og ny verdi.",
    ],
    [
      "K-002",
      "Atea leverer strukturert eksport i CSV og JSON med stabile identifikatorer.",
    ],
  ]);
  const artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...fixture.bilag2Ledger.map(
      (entry) =>
        `| ${entry.id} | ${entry.text} | ${answers.get(entry.id)} | ${answers.get(entry.id)} | ${entry.sourceExcerpt} |`,
    ),
  ].join("\n");
  const mergedLedger = await buildIntegrityLedgerFromGeneratedSolutionArtifact({
    sourceLedger: fixture.canonical.ledger,
    artifactMarkdown,
    solutionFileName: "combined-scope-kravsvar.md",
    solutionDocumentId: "solution-doc",
    solutionDocumentTitle: "Generert kravbesvarelse",
  });
  const items = mergedLedger.map((entry, index) => {
    const answer = answers.get(entry.id) ?? "";
    return {
      order_index: index,
      reference: entry.id,
      source_reference: entry.sourceExcerpt,
      source_document_id: entry.documentId,
      requirement_subtitle: entry.heading,
      requirement: entry.text,
      assessment: answer ? "Godt" : "Mangler",
      rationale: answer
        ? "Svaret beskriver leveransen konkret og etterprøvbart."
        : "Kravet finnes i kundedokumentet, men mangler en svarrad.",
      evidence: answer || `Kravgrunnlag: ${entry.text}`,
      recommendation: answer
        ? "Behold det konkrete kontrollpunktet."
        : "Legg inn en egen svarrad for kundekravet.",
      answer_document_id: answer ? "solution-doc" : null,
      answer_document_title: answer ? "Generert kravbesvarelse" : null,
    };
  });
  const coverage = {
    total_requirements: 3,
    assessed_requirements: 3,
    good: 2,
    weak: 0,
    missing: 1,
    unclear: 0,
    items,
  };
  const integrity = analyzeRequirementCoverageIntegrity({
    sourceLedger: mergedLedger,
    coverage,
  });

  assert.equal(mergedLedger[0].answerExcerpt, "");
  assert.ok(mergedLedger.slice(1).every((entry) => entry.answerExcerpt));
  assert.equal(integrity.ok, true);
  assert.equal(integrity.issueCount, 0);
  assert.equal(items[0].assessment, "Mangler");
  assert.ok(items.slice(1).every((item) => item.assessment === "Godt"));
});

test("strict project gate validates raw perfect-score fields instead of trusting summary flags", () => {
  const perfect = strictProjectSummary();
  assert.deepEqual(strictProjectGate(perfect), { passed: true, issues: [] });

  const cases = [
    [
      "one weak requirement",
      (project) => {
        project.coverage.good = 9;
        project.coverage.weak = 1;
      },
      "coverage.good",
    ],
    [
      "rounded strong score",
      (project) => {
        project.score = 99;
      },
      "score",
    ],
    [
      "fasit mismatch",
      (project) => {
        project.fasitComparison.orderedMatched = 9;
      },
      "fasit.ordered_matched",
    ],
    [
      "integrity issue",
      (project) => {
        project.integrity.ok = false;
        project.integrity.issueCount = 1;
        project.integrity.issues = ["synthetic"];
      },
      "integrity.ok",
    ],
    [
      "ungrounded evidence",
      (project) => {
        project.answerEvidenceGrounding.ok = false;
      },
      "answer_evidence_grounding.ok",
    ],
    [
      "invalid holistic evaluation",
      (project) => {
        project.holisticEvaluation.ok = false;
      },
      "holistic_evaluation.ok",
    ],
    [
      "false acceptance detail",
      (project) => {
        project.acceptance.noFallbacks = false;
      },
      "acceptance.noFallbacks",
    ],
  ];
  for (const [label, mutate, expectedIssue] of cases) {
    const project = structuredClone(perfect);
    mutate(project);
    const gate = strictProjectGate(project);
    assert.equal(gate.passed, false, label);
    assert.ok(gate.issues.includes(expectedIssue), label);
  }

  for (const field of [
    "coverageRatio",
    "referenceRatio",
    "subtitleRatio",
    "actionableRatio",
    "goodRatio",
    "integrityRatio",
    "fasitRatio",
  ]) {
    const project = structuredClone(perfect);
    project.scoreComponents[field] = 0.999;
    const gate = strictProjectGate(project);
    assert.equal(gate.passed, false, field);
    assert.ok(gate.issues.includes(`score_components.${field}`), field);
  }
});

test("paid shard stops after the first execution or selected acceptance failure", () => {
  const perfect = strictProjectSummary();
  assert.equal(shardStopReason(perfect, "proposal"), null);

  const executionFailure = {
    ...perfect,
    ok: false,
    error: "Krav og svar feilet.",
  };
  assert.deepEqual(shardStopReason(executionFailure, "proposal"), {
    kind: "execution",
    issues: ["Krav og svar feilet."],
  });

  const realProposalWeakness = structuredClone(perfect);
  realProposalWeakness.ok = false;
  realProposalWeakness.coverage.good -= 1;
  realProposalWeakness.coverage.unclear = 1;
  realProposalWeakness.score = 96;
  realProposalWeakness.scoreBand = "Usable";
  realProposalWeakness.scoreComponents.goodRatio = 0.9;
  realProposalWeakness.acceptance.strongAssessment = false;
  realProposalWeakness.acceptance.strongScore = false;
  realProposalWeakness.acceptance.passed = false;

  const proposalStop = shardStopReason(realProposalWeakness, "proposal");
  assert.equal(proposalStop.kind, "acceptance");
  assert.ok(proposalStop.issues.includes("coverage.good"));
  assert.ok(proposalStop.issues.includes("coverage.unclear"));
  assert.equal(
    shardStopReason(realProposalWeakness, "pipeline"),
    null,
    "pipeline mode must not stop solely because the evaluator reports a real proposal weakness",
  );
});

test("strict project gate accepts the Petoro oracle path and rejects oracle drift", () => {
  const project = strictProjectSummary({
    projectOverrides: {
      corpus: "Petoro",
      fasitComparison: null,
      requirementOracle: {
        version: "petoro-manual-gold-v1",
        expectedCount: 10,
        actualCount: 10,
        orderedIdsMatch: true,
        missingOrChangedAnchors: [],
        ok: true,
      },
    },
  });
  assert.equal(strictProjectGate(project).passed, true);

  project.requirementOracle.missingOrChangedAnchors = ["ID 2-02"];
  const drifted = strictProjectGate(project);
  assert.equal(drifted.passed, false);
  assert.ok(drifted.issues.includes("oracle.missing_or_changed_anchors"));
});

test("pipeline acceptance preserves truthful proposal gaps without weakening proposal readiness", () => {
  const project = strictProjectSummary();
  project.coverage.good = 7;
  project.coverage.weak = 1;
  project.coverage.unclear = 2;
  project.score = 94;
  project.scoreBand = "Usable";
  project.scoreComponents.goodRatio = 0.7;
  project.acceptance.strongAssessment = false;
  project.acceptance.strongScore = false;
  project.acceptance.passed = false;
  project.ok = false;

  assert.equal(strictProjectGate(project).passed, false);
  assert.deepEqual(technicalProjectGate(project), { passed: true, issues: [] });

  const proposalAggregate = aggregateProjects([project]);
  assert.equal(proposalAggregate.ok, false);
  assert.equal(proposalAggregate.strong, 0);
  assert.equal(proposalAggregate.proposalReadinessFailures, 1);

  const pipelineAggregate = aggregateProjects([project], {
    acceptanceMode: "pipeline",
  });
  assert.equal(pipelineAggregate.ok, true);
  assert.equal(pipelineAggregate.pipelinePassed, 1);
  assert.equal(pipelineAggregate.strong, 0);
  assert.equal(pipelineAggregate.proposalReadinessFailures, 1);
  assert.equal(pipelineAggregate.acceptanceFailures, 0);
});

test("pipeline acceptance still fails missing coverage and integrity drift", () => {
  const missing = strictProjectSummary();
  missing.coverage.good = 9;
  missing.coverage.missing = 1;
  missing.score = 98;
  missing.scoreBand = "Usable";
  missing.scoreComponents.goodRatio = 0.9;
  missing.acceptance.strongAssessment = false;
  missing.acceptance.strongScore = false;
  missing.acceptance.passed = false;
  missing.ok = false;

  const missingGate = technicalProjectGate(missing);
  assert.equal(missingGate.passed, false);
  assert.ok(missingGate.issues.includes("coverage.missing"));

  const drifted = strictProjectSummary();
  drifted.integrity.ok = false;
  drifted.integrity.issueCount = 1;
  drifted.integrity.issues = ["synthetic drift"];
  const driftGate = technicalProjectGate(drifted);
  assert.equal(driftGate.passed, false);
  assert.ok(driftGate.issues.includes("integrity.ok"));

  const aggregate = aggregateProjects([missing], {
    acceptanceMode: "pipeline",
  });
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.acceptanceFailures, 1);
});

test("aggregate fails closed for fabricated 41-of-45 coverage and separates execution failures", () => {
  const perfect = strictProjectSummary({ canonicalCount: 45, bilag2Count: 44 });
  const deceptive = structuredClone(perfect);
  deceptive.coverage.good = 41;
  deceptive.coverage.weak = 4;
  deceptive.scoreComponents.goodRatio = 41 / 45;
  deceptive.ok = true;
  deceptive.acceptance.passed = true;
  deceptive.score = 100;

  const deceptiveAggregate = aggregateProjects([deceptive]);
  assert.equal(deceptiveAggregate.ok, false);
  assert.equal(deceptiveAggregate.failures, 1);
  assert.equal(deceptiveAggregate.executionFailures, 0);
  assert.equal(deceptiveAggregate.acceptanceFailures, 1);
  assert.equal(deceptiveAggregate.strong, 0);

  const mixed = aggregateProjects([
    perfect,
    deceptive,
    { id: "runtime-failure", error: "synthetic runtime failure" },
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.failures, 2);
  assert.equal(mixed.executionFailures, 1);
  assert.equal(mixed.acceptanceFailures, 1);
  assert.equal(mixed.strong, 1);
  assert.equal(mixed.averageScore, 100);
});

test("aggregate and report distinguish canonical requirements from Bilag 2 rows", async () => {
  const project = strictProjectSummary({
    canonicalCount: 3,
    bilag2Count: 2,
    projectOverrides: {
      id: "combined-scope",
      name: "Combined Scope",
      documentName: "bilag-2.md",
      customerParsedRequirementCount: 2,
    },
  });
  const aggregate = aggregateProjects([project]);
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.sourceRequirements, 3);
  assert.equal(aggregate.canonicalRequirements, 3);
  assert.equal(aggregate.bilag2Requirements, 2);
  assert.equal(aggregate.customerParsedRequirements, 2);
  assert.equal(aggregate.fasitExpected, 2);

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-combined-report-"),
  );
  try {
    const filePath = path.join(directory, "report.html");
    await writeHtmlReport({
      filePath,
      summary: {
        generatedAt: "2026-07-11T00:00:00.000Z",
        ok: true,
        aggregate,
        telemetry: { byModel: [], totalRequests: 0, note: "No requests." },
        performance: { byStage: { totalMs: null } },
        scope: { requestedProjects: 1 },
        cost: { estimatedCostUsd: 0, assumption: "Test." },
        projects: [project],
        outputPath: path.join(directory, "result.json"),
        artifactsRoot: directory,
        serverLogPath: path.join(directory, "server.log"),
        customerAnalysisMode: "api",
      },
    });
    const html = await readFile(filePath, "utf8");
    assert.match(html, /Strict status: PASS/u);
    assert.match(html, /Canonical requirements/u);
    assert.match(html, /Bilag 2 \/ oracle rows/u);
    assert.match(html, />3<\/td>\s*<td>2<\/td>/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact checkpoint provenance must declare customer and Bilag 2 in canonical order", () => {
  const expectedDocumentIds = ["customer-document", "requirement-document"];
  const artifact = {
    input_snapshot: {
      requested_source_document_ids: ["requirement-document"],
      source_document_ids: expectedDocumentIds,
      source_document_roles: expectedDocumentIds.map((id) => ({ id })),
      source_snapshot: {
        requested_source_document_ids: ["requirement-document"],
        declared_source_document_ids: expectedDocumentIds,
      },
    },
  };
  assert.deepEqual(
    assertGeneratedArtifactSourceScope({
      artifact,
      expectedRequestedDocumentIds: ["requirement-document"],
      expectedDocumentIds,
    }),
    {
      requested: ["requirement-document"],
      requestedSourceSnapshot: ["requirement-document"],
      topLevel: expectedDocumentIds,
      sourceSnapshot: expectedDocumentIds,
      roleManifest: expectedDocumentIds,
    },
  );
  assert.throws(
    () =>
      assertGeneratedArtifactSourceScope({
        artifact: {
          input_snapshot: {
            ...artifact.input_snapshot,
            source_document_ids: ["requirement-document"],
          },
        },
        expectedRequestedDocumentIds: ["requirement-document"],
        expectedDocumentIds,
      }),
    /source scope mismatch in topLevel/u,
  );
  assert.throws(
    () =>
      assertGeneratedArtifactSourceScope({
        artifact: {
          input_snapshot: {
            ...artifact.input_snapshot,
            requested_source_document_ids: expectedDocumentIds,
          },
        },
        expectedRequestedDocumentIds: ["requirement-document"],
        expectedDocumentIds,
      }),
    /requested source scope mismatch/u,
  );
  assert.throws(
    () =>
      assertGeneratedArtifactSourceScope({
        artifact: {
          input_snapshot: {
            ...artifact.input_snapshot,
            source_snapshot: {
              ...artifact.input_snapshot.source_snapshot,
              requested_source_document_ids: expectedDocumentIds,
            },
          },
        },
        expectedRequestedDocumentIds: ["requirement-document"],
        expectedDocumentIds,
      }),
    /requested source scope mismatch in requestedSourceSnapshot/u,
  );
});

test("generation metadata is mandatory and proves enforced coverage provenance", () => {
  const valid = scoringInput();
  assert.equal(scoreProject(valid).acceptance.kravSvarMetadata, true);
  assert.equal(scoreProject(valid).acceptance.templateRepairMetadata, true);
  assert.equal(scoreProject(valid).acceptance.noFallbacks, true);

  for (const field of [
    "total_requirements",
    "batch_count",
    "failed_batches",
    "deterministic_fallback_answers_after_handoff",
    "deterministic_template_repair_answers",
    "deterministic_template_repair_refs",
    "deterministic_template_repair_rows",
    "deterministic_control_repair_answers",
    "deterministic_control_repair_refs",
    "deterministic_control_repair_rows",
    "proposal_input_required_count",
    "proposal_input_required_refs",
    "proposal_input_required_rows",
    "manual_review_required",
    "unresolved_fallback_answers",
    "immutable_row_manifest",
  ]) {
    const metadata = generationMetadata(10);
    delete metadata[field];
    const result = scoreProject(scoringInput({ metadata }));
    assert.equal(result.acceptance.kravSvarMetadata, false, field);
    assert.equal(result.acceptance.passed, false, field);
  }

  for (const mutate of [
    (metadata) => {
      metadata.method = "full_document";
    },
    (metadata) => {
      metadata.coverage_enforced = false;
    },
    (metadata) => {
      metadata.source_evidence_enforced = false;
    },
    (metadata) => {
      metadata.requirement_refs.pop();
    },
    (metadata) => {
      metadata.requirement_refs[9] = "";
    },
  ]) {
    const metadata = generationMetadata(10);
    mutate(metadata);
    assert.equal(
      scoreProject(scoringInput({ metadata })).acceptance.kravSvarMetadata,
      false,
    );
  }

  const duplicateRefs = generationMetadata(10);
  duplicateRefs.requirement_refs[9] = duplicateRefs.requirement_refs[0];
  duplicateRefs.immutable_row_manifest.rows[9].ref =
    duplicateRefs.requirement_refs[0];
  assert.equal(
    scoreProject(scoringInput({ metadata: duplicateRefs })).acceptance
      .kravSvarMetadata,
    true,
  );

  const truncatedManifest = generationMetadata(10);
  truncatedManifest.immutable_row_manifest.rows.pop();
  const truncatedManifestResult = scoreProject(
    scoringInput({ metadata: truncatedManifest }),
  );
  assert.equal(truncatedManifestResult.acceptance.immutableRowManifest, false);
  assert.equal(truncatedManifestResult.acceptance.kravSvarMetadata, false);
  assert.equal(truncatedManifestResult.acceptance.passed, false);

  const validTemplateRepair = generationMetadata(10);
  validTemplateRepair.deterministic_template_repair_answers = 1;
  validTemplateRepair.deterministic_template_repair_refs = ["R-010"];
  validTemplateRepair.deterministic_template_repair_rows = [
    {
      ref: "R-010",
      order_index: 9,
      source_document_id: "requirement-document",
      source_locator: "Kildedokument, rad 10",
    },
  ];
  validTemplateRepair.manual_review_required = true;
  validTemplateRepair.manual_review_note =
    "Standardformuleringen krever manuell gjennomgang før innlevering.";
  assert.equal(
    scoreProject(scoringInput({ metadata: validTemplateRepair })).acceptance
      .templateRepairMetadata,
    true,
  );

  const validControlRepair = generationMetadata(10);
  validControlRepair.deterministic_control_repair_answers = 1;
  validControlRepair.deterministic_control_repair_refs = ["R-010"];
  validControlRepair.deterministic_control_repair_rows = [
    {
      ref: "R-010",
      pattern: "dimensioning_supplier_baseline",
      order_index: 9,
      source_document_id: "requirement-document",
      source_locator: "Kildedokument, rad 10",
    },
  ];
  validControlRepair.manual_review_required = true;
  validControlRepair.manual_review_note =
    "Deterministisk kontrolltekst krever manuell gjennomgang før innlevering.";
  const controlRepairResult = scoreProject(
    scoringInput({ metadata: validControlRepair }),
  );
  assert.equal(controlRepairResult.acceptance.controlRepairMetadata, true);
  assert.equal(controlRepairResult.acceptance.manualReviewMetadata, true);
  assert.equal(controlRepairResult.acceptance.noManualReview, false);
  assert.equal(controlRepairResult.acceptance.passed, false);

  for (const mutate of [
    (metadata) => {
      metadata.deterministic_template_repair_answers = 1;
    },
    (metadata) => {
      metadata.deterministic_template_repair_answers = 1;
      metadata.deterministic_template_repair_refs = ["R-999"];
      metadata.manual_review_required = true;
      metadata.manual_review_note = "Krever manuell gjennomgang.";
    },
    (metadata) => {
      metadata.deterministic_template_repair_answers = 1;
      metadata.deterministic_template_repair_refs = ["R-010"];
      metadata.manual_review_required = false;
    },
    (metadata) => {
      metadata.deterministic_template_repair_answers = 1;
      metadata.deterministic_template_repair_refs = ["R-010"];
      metadata.manual_review_required = true;
      metadata.manual_review_note = "";
    },
  ]) {
    const metadata = generationMetadata(10);
    mutate(metadata);
    const result = scoreProject(scoringInput({ metadata }));
    assert.equal(result.acceptance.kravSvarMetadata, false);
    assert.equal(result.acceptance.passed, false);
  }

  const validProposalInput = generationMetadata(10);
  validProposalInput.proposal_input_required_count = 1;
  validProposalInput.proposal_input_required_refs = ["R-010"];
  validProposalInput.proposal_input_required_rows = [
    {
      ref: "R-010",
      reasons: ["commercial_terms"],
      order_index: 9,
      source_document_id: "requirement-document",
      source_locator: "Kildedokument, rad 10",
    },
  ];
  validProposalInput.manual_review_required = true;
  validProposalInput.manual_review_note =
    "Kravet trenger dokumentert leverandørbevis eller kommersielle vilkår før innlevering.";
  const proposalInputResult = scoreProject(
    scoringInput({ metadata: validProposalInput }),
  );
  assert.equal(proposalInputResult.acceptance.proposalInputMetadata, true);
  assert.equal(proposalInputResult.acceptance.manualReviewMetadata, true);
  assert.equal(proposalInputResult.acceptance.noManualReview, false);
  assert.equal(proposalInputResult.acceptance.passed, false);
});

test("strict strong assessment requires every row green and no manual review", () => {
  const assessments = [...Array(9).fill("Godt"), "Mangler"];
  const falsifiedSummary = scoreProject(
    scoringInput({
      assessments,
      coverageOverrides: { good: 10, missing: 0 },
    }),
  );
  assert.equal(falsifiedSummary.acceptance.strongAssessment, false);
  assert.equal(falsifiedSummary.acceptance.assessmentCountsConsistent, false);
  assert.equal(falsifiedSummary.acceptance.passed, false);

  const metadata = generationMetadata(10);
  metadata.deterministic_template_repair_answers = 1;
  metadata.deterministic_template_repair_refs = ["R-010"];
  metadata.deterministic_template_repair_rows = [
    {
      ref: "R-010",
      order_index: 9,
      source_document_id: "requirement-document",
      source_locator: "Kildedokument, rad 10",
    },
  ];
  metadata.manual_review_required = true;
  metadata.manual_review_note =
    "Standardformuleringen krever manuell gjennomgang før innlevering.";
  const requiresReview = scoreProject(
    scoringInput({
      assessments: [...Array(9).fill("Godt"), "Uklart"],
      metadata,
    }),
  );
  assert.equal(requiresReview.score, 98);
  assert.equal(requiresReview.acceptance.strongAssessment, false);
  assert.equal(requiresReview.acceptance.noManualReview, false);
  assert.equal(requiresReview.acceptance.assessmentCountsConsistent, true);
  assert.equal(requiresReview.acceptance.strongScore, false);
  assert.equal(requiresReview.acceptance.passed, false);

  for (const assessments of [
    [...Array(9).fill("Godt"), "Dårlig"],
    [...Array(9).fill("Godt"), "Mangler"],
  ]) {
    assert.equal(
      scoreProject(scoringInput({ assessments, metadata })).acceptance
        .strongAssessment,
      false,
    );
  }

  assert.equal(
    scoreProject(
      scoringInput({ assessments: [...Array(9).fill("Godt"), "Uklart"] }),
    ).acceptance.strongAssessment,
    false,
  );

  const unmatchedMetadata = {
    ...metadata,
    deterministic_template_repair_refs: ["R-999"],
    requirement_refs: [...metadata.requirement_refs.slice(0, -1), "R-999"],
  };
  assert.equal(
    scoreProject(
      scoringInput({
        assessments: [...Array(9).fill("Godt"), "Uklart"],
        metadata: unmatchedMetadata,
      }),
    ).acceptance.strongAssessment,
    false,
  );
});

test("strict acceptance rejects blank holistic evaluation and contradictory architecture", () => {
  const blank = scoreProject(
    scoringInput({
      evaluationOverrides: {
        fit_to_customer_needs: "",
        strengths: [],
        executive_summary: "",
      },
    }),
  );
  assert.equal(blank.acceptance.holisticEvaluation, false);
  assert.equal(blank.acceptance.passed, false);

  const contradictory = scoreProject(
    scoringInput({
      evaluationOverrides: {
        architecture_comparison: {
          winner: "Systemløsning",
          architect_solution_score: 99,
          system_solution_score: 80,
          verdict:
            "Konklusjonen er utførlig formulert, men vinnerfeltet motsier de normaliserte og eksplisitte arkitekturscorene.",
          strong_critique: [
            "Scoringsgrunnlaget må samsvare med den deklarerte vinneren i konklusjonen.",
          ],
          pragmatic_reflections: [
            "En konsistent score og konklusjon er nødvendig for at beslutningen skal være etterprøvbar.",
          ],
          strategy_improvement_advice: [
            "Rekonsilier vinneren deterministisk fra de to normaliserte scorene.",
          ],
        },
      },
    }),
  );
  assert.equal(contradictory.acceptance.holisticEvaluation, false);
  assert.equal(contradictory.acceptance.passed, false);
});

test("strict acceptance grounds every green row and finding in the generated answer", () => {
  const invented = scoreProject(
    scoringInput({ artifactMarkdown: "En helt annen og kort besvarelse." }),
  );
  assert.equal(invented.acceptance.answerEvidenceGrounded, false);
  assert.equal(invented.acceptance.passed, false);
  assert.ok(invented.answerEvidenceGrounding.issueCount > 0);
});

test("real API coverage shape binds simple artifact refs with full source locators", () => {
  const input = scoringInput({
    assessments: ["Godt", "Godt"],
    metadata: generationMetadata(2),
  });
  input.coverage.items = input.coverage.items.map((item, index) => ({
    ...item,
    full_reference: `Bilag 2, Dokument ${index + 1}, Kravdel, ${item.reference}`,
    source_reference: `Bilag 2, Dokument ${index + 1}, ${item.reference}`,
    evidence: `Eksakt svarbevis for kravrad ${index + 1} med dokumentert kontrollpunkt.`,
  }));
  input.artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...input.coverage.items.map(
      (item) =>
        `| ${item.reference} | Kravtekst | ${item.evidence} | ${item.evidence} | ${item.source_reference} |`,
    ),
    "",
    ...input.documentFindings.map((finding) => finding.evidence),
  ].join("\n");

  const result = scoreProject(input);
  assert.equal(result.acceptance.answerEvidenceGrounded, true);
  assert.equal(result.answerEvidenceGrounding.issueCount, 0);
});

test("artifact binding tolerates evaluator-enriched row coordinates without crossing documents", () => {
  const input = scoringInput({
    assessments: ["Godt"],
    metadata: generationMetadata(1),
  });
  const item = {
    ...input.coverage.items[0],
    reference: "Støttedokument - Tabell 2, rad 3",
    table_id: "DOCX tabell 2",
    full_reference:
      "Kravdokument A, Kommentarer fra drift, DOCX tabell 2, rad 3, Støttedokument - tabell 2, rad 3",
    source_reference:
      "Kravdokument A, DOCX tabell 2, rad 3, Støttedokument - tabell 2, rad 3",
    evidence:
      "Atea dokumenterer ansvarsmatrisen med rolle, godkjenner og tidsstemplet endringslogg.",
  };
  input.coverage.items = [item];
  input.artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    `| Støttedokument - tabell 2, rad 3 | Kravtekst | ${item.evidence} | ${item.evidence} | Kravdokument A, DOCX tabell 2, Støttedokument - tabell 2, rad 3 |`,
    "",
    ...input.documentFindings.map((finding) => finding.evidence),
  ].join("\n");

  const correctlyBound = scoreProject(input);
  assert.equal(correctlyBound.acceptance.answerEvidenceGrounded, true);
  assert.equal(correctlyBound.answerEvidenceGrounding.issueCount, 0);

  input.artifactMarkdown = input.artifactMarkdown.replace(
    "Kravdokument A, DOCX tabell 2",
    "Kravdokument B, DOCX tabell 2",
  );
  const wrongDocument = scoreProject(input);
  assert.equal(wrongDocument.acceptance.answerEvidenceGrounded, false);
  assert.ok(
    wrongDocument.answerEvidenceGrounding.issues.some(
      (issue) => issue.code === "artifact_answer_row_not_in_coverage",
    ),
  );
});

test("integrity parses and merges the generated solution artifact before checking answer evidence", async () => {
  const requirement =
    "Leverandøren skal etablere en sporbar kontroll for alle endringer.";
  const answer =
    "Atea etablerer en auditlogg med bruker, tidspunkt, gammel verdi og ny verdi for hver endring.";
  const sourceReference = "Bilag 2, Side 4, R-001";
  const sourceLedger = [
    {
      id: "R-001",
      text: requirement,
      pages: [4],
      heading: "Sporbarhet",
      sourceExcerpt: sourceReference,
      documentId: "requirement-doc",
      documentTitle: "Bilag 2",
      documentEntryOrder: 0,
    },
  ];
  const artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    `| R-001 | ${requirement} | ${answer} | ${answer} | ${sourceReference} |`,
  ].join("\n");
  const coverage = {
    total_requirements: 1,
    assessed_requirements: 1,
    good: 1,
    weak: 0,
    missing: 0,
    unclear: 0,
    items: [
      {
        order_index: 0,
        reference: "R-001",
        full_reference: "Bilag 2, Sporbarhet, Side 4, R-001",
        source_reference: sourceReference,
        requirement,
        assessment: "Godt",
        rationale: "Svaret beskriver kontrollen konkret og etterprøvbart.",
        evidence: answer,
        recommendation: "Behold de eksplisitte auditfeltene i svaret.",
        answer_document_id: "solution-doc",
        answer_document_title: "Generert kravbesvarelse",
      },
    ],
  };

  const sourceOnly = analyzeRequirementCoverageIntegrity({
    sourceLedger,
    coverage,
  });
  assert.ok(
    sourceOnly.issues.some(
      (issue) => issue.code === "good_evidence_not_answer_bound",
    ),
  );

  const mergedLedger = await buildIntegrityLedgerFromGeneratedSolutionArtifact({
    sourceLedger,
    artifactMarkdown,
    solutionFileName: "generated-kravsvar.md",
    solutionDocumentId: "solution-doc",
    solutionDocumentTitle: "Generert kravbesvarelse",
  });
  assert.equal(mergedLedger[0].answerExcerpt, answer);
  assert.equal(mergedLedger[0].answerEvidenceExcerpt, answer);
  assert.equal(mergedLedger[0].answerDocumentId, "solution-doc");

  const merged = analyzeRequirementCoverageIntegrity({
    sourceLedger: mergedLedger,
    coverage,
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.issueCount, 0);
});

test("Strong acceptance rejects evidence found only in another requirement row", () => {
  const input = scoringInput({
    assessments: ["Godt", "Godt"],
    metadata: generationMetadata(2),
  });
  const sharedEvidence =
    "Unikt kontrollbevis som bare finnes i første kravrad.";
  input.coverage.items = input.coverage.items.map((item) => ({
    ...item,
    evidence: sharedEvidence,
  }));
  input.artifactMarkdown = artifactMarkdownForCoverage([
    input.coverage.items[0],
    {
      ...input.coverage.items[1],
      evidence: "Et annet kravspesifikt bevis med verifiserbar akseptanse.",
    },
  ]);
  const result = scoreProject(input);
  assert.equal(result.score, 100);
  assert.equal(result.acceptance.answerEvidenceGrounded, false);
  assert.ok(
    result.answerEvidenceGrounding.issues.some(
      (issue) =>
        issue.code === "good_coverage_evidence_not_in_matching_answer_row",
    ),
  );
});

test("Strong acceptance does not treat repeated requirement text as answer evidence", () => {
  const input = scoringInput({
    assessments: ["Godt"],
    metadata: generationMetadata(1),
  });
  const evidence = input.coverage.items[0].evidence;
  input.artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    `| R-001 | ${evidence} | Et annet svar uten sitatet. | Et annet grunnlag uten sitatet. | Kildedokument |`,
  ].join("\n");
  const result = scoreProject(input);
  assert.equal(result.acceptance.answerEvidenceGrounded, false);
});

test("duplicate simple refs across documents bind by ordinal and source locator without crossing", () => {
  const input = scoringInput({
    assessments: ["Godt", "Godt"],
    metadata: generationMetadataWithRefs(["R-001", "R-001"]),
  });
  input.coverage.items = input.coverage.items.map((item, index) => ({
    ...item,
    reference: "R-001",
    full_reference: `Bilag 2, Dokument ${index === 0 ? "A" : "B"}, Kravdel, R-001`,
    source_reference: `Bilag 2, Dokument ${index === 0 ? "A" : "B"}, R-001`,
    evidence: `Unikt svarbevis for dokument ${index === 0 ? "A" : "B"} med verifiserbar kontroll.`,
  }));
  const evidenceA = input.coverage.items[0].evidence;
  const evidenceB = input.coverage.items[1].evidence;
  const artifact = (firstEvidence, secondEvidence) =>
    [
      "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
      "|---|---|---|---|---|",
      `| R-001 | Krav A | ${firstEvidence} | ${firstEvidence} | ${input.coverage.items[0].source_reference} |`,
      `| R-001 | Krav B | ${secondEvidence} | ${secondEvidence} | ${input.coverage.items[1].source_reference} |`,
      "",
      ...input.documentFindings.map((finding) => finding.evidence),
    ].join("\n");

  input.artifactMarkdown = artifact(evidenceA, evidenceB);
  const correctlyBound = scoreProject(input);
  assert.equal(correctlyBound.acceptance.answerEvidenceGrounded, true);
  assert.equal(correctlyBound.answerEvidenceGrounding.issueCount, 0);

  input.artifactMarkdown = artifact(evidenceB, evidenceA);
  const crossed = scoreProject(input);
  assert.equal(crossed.acceptance.answerEvidenceGrounded, false);
  assert.ok(
    crossed.answerEvidenceGrounding.issues.filter(
      (issue) =>
        issue.code === "good_coverage_evidence_not_in_matching_answer_row",
    ).length === 2,
  );
});

test("section finding evidence in the Krav column is never answer grounding", () => {
  const input = scoringInput({
    assessments: ["Godt"],
    metadata: generationMetadata(1),
  });
  const sectionEvidence = input.documentFindings[0].evidence;
  const coverageEvidence = input.coverage.items[0].evidence;
  input.artifactMarkdown = [
    "| Kravref. | Krav | Svar | Svargrunnlag |",
    "|---|---|---|---|",
    `| R-001 | ${sectionEvidence} | ${coverageEvidence} | ${coverageEvidence} |`,
  ].join("\n");

  const result = scoreProject(input);
  assert.equal(result.acceptance.answerEvidenceGrounded, false);
  assert.ok(
    result.answerEvidenceGrounding.issues.some(
      (issue) => issue.code === "finding_evidence_not_in_answer",
    ),
  );
});

test("fasit identity binds duplicate text, ID and heading independently of workbook row order", () => {
  const expectedRows = [
    {
      Kravtekst: "Leverandøren skal dokumentere kontrollen.",
      "Har brukbar ID": "Ja",
      "ID-identifikator": "A-1",
      Underoverskrift: "Del A",
    },
    {
      Kravtekst: "Leverandøren skal dokumentere kontrollen.",
      "Har brukbar ID": "Ja",
      "ID-identifikator": "B-1",
      Underoverskrift: "Del B",
    },
  ];
  const comparison = compareLedgerWithFasitRows(
    [
      {
        id: "B-1",
        heading: "Del B",
        text: expectedRows[0].Kravtekst,
        sourceExcerpt: "Side 1",
      },
      {
        id: "A-1",
        heading: "Del A",
        text: expectedRows[1].Kravtekst,
        sourceExcerpt: "Side 2",
      },
    ],
    expectedRows,
    { sourceFormat: "pdf" },
  );

  assert.equal(comparison.orderedMatched, 2);
  assert.equal(comparison.idMatched, 2);
  assert.equal(comparison.headingMatched, 2);
  assert.equal(comparison.orderingBasis, "source_geometry");
  assert.equal(comparison.workbookOrderAuthoritative, false);
});

test("round-robin fasit inventory preserves multi-page source geometry and id-less rows", () => {
  const expectedRows = [
    {
      Kravtekst: "Krav A skal besvares.",
      "Original ID / markering": "R-001",
      Underoverskrift: "Seksjon A",
    },
    {
      Kravtekst: "Krav B skal besvares.",
      "Original ID / markering": "R-002",
      Underoverskrift: "Seksjon B",
    },
    {
      Kravtekst: "Krav uten ID skal besvares.",
      "Original ID / markering": "",
      Underoverskrift: "Seksjon A",
    },
  ];
  const comparison = compareLedgerWithFasitRows(
    [
      {
        id: "R-001",
        heading: "Seksjon A",
        text: expectedRows[0].Kravtekst,
        pages: [1],
        documentEntryOrder: 100,
      },
      {
        id: "Dokumenttekst krav 2",
        heading: "Seksjon A",
        text: expectedRows[2].Kravtekst,
        pages: [1],
        documentEntryOrder: 200,
      },
      {
        id: "R-002",
        heading: "Seksjon B",
        text: expectedRows[1].Kravtekst,
        pages: [2],
        documentEntryOrder: 300,
      },
    ],
    expectedRows,
    { sourceFormat: "pdf" },
  );

  assert.equal(comparison.orderedMatched, 3);
  assert.equal(comparison.workbookOrderedMatched, 1);
  assert.equal(comparison.idMatched, 2);
  assert.equal(comparison.headingMatched, 3);
  assert.equal(comparison.sourceGeometryComparablePairs, 2);
  assert.equal(comparison.sourceGeometryOrderedPairs, 2);
  assert.equal(comparison.sourceGeometryEnforced, true);
  assert.equal(comparison.sourceIssueCount, 0);
  assert.equal(comparison.mismatchCount, 0);
  const scored = scoreProject(
    scoringInput({
      assessments: Array(3).fill("Godt"),
      metadata: generationMetadata(3),
      fasitComparison: comparison,
    }),
  );
  assert.equal(scored.acceptance.exactFasit, true);
});

test("fasit source-order audit rejects numeric-ID reordering against geometry", () => {
  const expectedRows = [
    {
      Kravtekst: "Første fysiske rad skal besvares.",
      "Original ID / markering": "R-019",
      Underoverskrift: "Funksjonelle krav",
    },
    {
      Kravtekst: "Andre fysiske rad skal besvares.",
      "Original ID / markering": "R-002",
      Underoverskrift: "Data",
    },
  ];
  const comparison = compareLedgerWithFasitRows(
    [
      {
        id: "R-002",
        heading: "Data",
        text: expectedRows[1].Kravtekst,
        pages: [2],
        documentEntryOrder: 200,
      },
      {
        id: "R-019",
        heading: "Funksjonelle krav",
        text: expectedRows[0].Kravtekst,
        pages: [1],
        documentEntryOrder: 100,
      },
    ],
    expectedRows,
    { sourceFormat: "pdf" },
  );

  assert.equal(comparison.orderedMatched, 2);
  assert.equal(comparison.idMatched, 2);
  assert.equal(comparison.headingMatched, 2);
  assert.equal(comparison.sourceGeometryComparablePairs, 1);
  assert.equal(comparison.sourceGeometryOrderedPairs, 0);
  assert.equal(comparison.sourceIssueCount, 1);
});

test("Strong acceptance requires every green row to cite the evaluated solution document", () => {
  const input = scoringInput();
  input.coverage.items[0] = {
    ...input.coverage.items[0],
    answer_document_id: "another-document",
  };
  const result = scoreProject(input);
  assert.equal(result.acceptance.answerEvidenceGrounded, false);
  assert.ok(
    result.answerEvidenceGrounding.issues.some(
      (issue) => issue.code === "good_coverage_wrong_answer_document",
    ),
  );
});

test("independent requirement oracle rejects omissions and reordered rows", () => {
  assert.equal(PETORO_GOLDEN_REQUIREMENT_IDS_V1.length, 74);
  assert.equal(PETORO_GOLDEN_TEXT_SHA256_V1.length, 74);
  assert.equal(new Set(PETORO_GOLDEN_REQUIREMENT_IDS_V1).size, 74);
  assert.equal(PETORO_GOLDEN_TEXT_ANCHORS_V1.length, 33);
  const oracle = {
    version: "manual-gold-test",
    orderedIds: ["ID 2-01", "ID 2-02"],
    textAnchors: [["ID 2-02", "kapasitet og sikkerhet"]],
  };
  const complete = compareLedgerWithRequirementOracle(
    [
      { id: "ID 2-01", text: "Leverandøren skal dokumentere drift." },
      {
        id: "ID 2-02",
        text: "Leverandøren er ansvarlig for kapasitet og sikkerhet.",
      },
    ],
    oracle,
  );
  assert.equal(complete.ok, true);
  const exactTextOracle = {
    ...oracle,
    orderedTextSha256: [
      "Leverandøren skal dokumentere drift.",
      "Leverandøren er ansvarlig for kapasitet og sikkerhet.",
    ].map((value) =>
      createHash("sha256")
        .update(normalizeRequirementMeaning(value))
        .digest("hex"),
    ),
  };
  assert.equal(
    compareLedgerWithRequirementOracle(
      [
        { id: "ID 2-01", text: "En korrupt, men likevel nummerert rad." },
        {
          id: "ID 2-02",
          text: "Leverandøren er ansvarlig for kapasitet og sikkerhet.",
        },
      ],
      exactTextOracle,
    ).ok,
    false,
  );
  assert.equal(
    compareLedgerWithRequirementOracle(
      [
        {
          id: "ID 2-02",
          text: "Leverandøren er ansvarlig for kapasitet og sikkerhet.",
        },
      ],
      oracle,
    ).ok,
    false,
  );
  assert.equal(
    compareLedgerWithRequirementOracle(
      [
        {
          id: "ID 2-02",
          text: "Leverandøren er ansvarlig for kapasitet og sikkerhet.",
        },
        { id: "ID 2-01", text: "Leverandøren skal dokumentere drift." },
      ],
      oracle,
    ).ok,
    false,
  );
});

test("acceptance fails when the score is below the Strong threshold", () => {
  const result = scoreProject(
    scoringInput({
      fasitComparison: {
        expectedCount: 10,
        actualCount: 10,
        unorderedMatched: 10,
        orderedMatched: 10,
        mismatchCount: 0,
        idComparable: 10,
        idMatched: 0,
        headingComparable: 10,
        headingMatched: 0,
      },
    }),
  );
  assert.equal(result.score, 93);
  assert.equal(result.acceptance.exactFasit, false);
  assert.equal(result.acceptance.strongScore, false);
  assert.equal(result.acceptance.passed, false);
});

test("Strong acceptance rejects even one fasit identity mismatch that rounds to 100", () => {
  const result = scoreProject(
    scoringInput({
      fasitComparison: {
        expectedCount: 10,
        actualCount: 10,
        unorderedMatched: 10,
        orderedMatched: 10,
        mismatchCount: 0,
        idComparable: 10,
        idMatched: 9,
        headingComparable: 10,
        headingMatched: 10,
        sourceIssueCount: 0,
      },
    }),
  );
  assert.equal(result.score, 100);
  assert.equal(result.acceptance.exactFasit, false);
  assert.equal(result.acceptance.passed, false);
});

test("Strong acceptance rejects fasit rows without a source locator", () => {
  const result = scoreProject(
    scoringInput({
      fasitComparison: {
        expectedCount: 10,
        actualCount: 10,
        unorderedMatched: 10,
        orderedMatched: 10,
        mismatchCount: 0,
        idComparable: 10,
        idMatched: 10,
        headingComparable: 10,
        headingMatched: 10,
        sourceIssueCount: 1,
      },
    }),
  );
  assert.equal(result.score, 100);
  assert.equal(result.acceptance.exactFasit, false);
  assert.equal(result.acceptance.passed, false);
});

test("Strong acceptance rejects incomplete source-row binding", () => {
  const result = scoreProject(
    scoringInput({
      fasitComparison: {
        expectedCount: 10,
        actualCount: 10,
        unorderedMatched: 10,
        orderedMatched: 8,
        mismatchCount: 2,
        idComparable: 10,
        idMatched: 10,
        headingComparable: 10,
        headingMatched: 10,
        sourceIssueCount: 0,
      },
    }),
  );
  assert.equal(result.score, 100);
  assert.equal(result.acceptance.exactFasit, false);
  assert.equal(result.acceptance.passed, false);
});

test("Strong acceptance requires at least one traceable document finding", () => {
  const empty = scoreProject(scoringInput({ documentFindings: [] }));
  assert.equal(empty.acceptance.documentFindingTraceability, false);
  assert.equal(empty.acceptance.passed, false);
  assert.equal(
    empty.documentFindingTraceability.issues[0].code,
    "empty_document_findings",
  );

  const section = scoreProject(scoringInput());
  assert.equal(section.acceptance.documentFindingTraceability, true);
  assert.equal(section.documentFindingTraceability.sectionFindings, 1);
});

test("section findings cannot pass Strong acceptance with blank or decorative content", () => {
  const blank = scoreProject(
    scoringInput({
      documentFindings: [
        {
          reference: "Seksjonsfunn: tom seksjon",
          reference_match: "section",
          matched_requirement_reference: null,
          finding: "",
          evidence: "",
          recommendation: "",
        },
      ],
    }),
  );
  assert.equal(blank.acceptance.documentFindingTraceability, false);
  assert.equal(blank.acceptance.passed, false);
  assert.equal(blank.documentFindingTraceability.sectionFindings, 0);
  assert.equal(
    blank.documentFindingTraceability.issues[0].code,
    "insubstantial_section_finding",
  );

  const wrongReference = scoreProject(
    scoringInput({
      documentFindings: [
        {
          reference: "Samlet løsningsbeskrivelse",
          reference_match: "section",
          matched_requirement_reference: null,
          finding:
            "Leveransemodellen er konkret beskrevet med ansvar og kontrollpunkter.",
          evidence:
            "Samlet løsningsbeskrivelse med dokumentert leveransemodell.",
          recommendation:
            "Behold koblingen mellom ansvar, kontrollpunkt og dokumentert akseptanse.",
        },
      ],
    }),
  );
  assert.equal(wrongReference.acceptance.documentFindingTraceability, false);
  assert.equal(
    wrongReference.documentFindingTraceability.issues[0].code,
    "invalid_section_finding_reference",
  );
});

test("substantive section findings require deterministic document_exact grounding", () => {
  for (const evidenceGrounding of [
    undefined,
    "coverage_exact",
    "document_exactly",
  ]) {
    const result = scoreProject(
      scoringInput({
        documentFindings: [
          {
            reference: "Seksjonsfunn: samlet løsningsbeskrivelse",
            reference_match: "section",
            matched_requirement_reference: null,
            finding:
              "Leveransemodellen er konkret beskrevet med ansvar og kontrollpunkter.",
            evidence:
              "Samlet løsningsbeskrivelse med dokumentert leveransemodell.",
            ...(evidenceGrounding
              ? { evidence_grounding: evidenceGrounding }
              : {}),
            recommendation:
              "Behold koblingen mellom ansvar, kontrollpunkt og dokumentert akseptanse.",
          },
        ],
      }),
    );
    assert.equal(result.acceptance.documentFindingTraceability, false);
    assert.equal(result.acceptance.passed, false);
    assert.equal(
      result.documentFindingTraceability.issues[0].code,
      "invalid_section_evidence_grounding",
    );
  }
});

test("coverage findings require evidence from their matched coverage item", () => {
  const input = scoringInput();
  input.coverage.items = input.coverage.items.map((item, index) => ({
    ...item,
    evidence: `Dokumentert leveransebevis for krav ${index + 1} med unikt kontrollpunkt og akseptanse.`,
  }));
  input.documentFindings = [0, 1, 2, 3].map((evidenceIndex) => ({
    reference: "R-001",
    reference_match: "coverage",
    matched_requirement_reference: "R-001",
    evidence: input.coverage.items[evidenceIndex].evidence,
  }));

  const result = scoreProject(input);
  assert.equal(result.acceptance.documentFindingTraceability, false);
  assert.equal(result.acceptance.passed, false);
  assert.equal(result.documentFindingTraceability.coverageFindings, 4);
  assert.deepEqual(
    result.documentFindingTraceability.issues.map((issue) => issue.code),
    [
      "finding_evidence_mismatch",
      "finding_evidence_mismatch",
      "finding_evidence_mismatch",
    ],
  );
});

test("canary8 quote-wrapped evidence matches exact contained coverage evidence", () => {
  const input = scoringInput({
    assessments: ["Godt", "Godt", "Godt", "Godt"],
    metadata: generationMetadata(4),
  });
  const evidence = [
    "Idempotensnøkler lagres for sikker retry",
    "Vedvarende kø sikrer tapsfri gjenoppretting",
    "Rollebasert tilgang avgrenser autoriserte data",
    "Kapasitetsmargin dokumenteres i belastningstest",
  ];
  input.coverage.items = input.coverage.items.map((item, index) => ({
    ...item,
    evidence: `Svargrunnlaget dokumenterer at ${evidence[index]} og følger dette opp med et kontrollpunkt.`,
  }));
  input.documentFindings = evidence.map((excerpt, index) => ({
    reference: `R-${String(index + 1).padStart(3, "0")}`,
    reference_match: "coverage",
    matched_requirement_reference: `R-${String(index + 1).padStart(3, "0")}`,
    evidence: index % 2 === 0 ? `“${excerpt}.”` : `"${excerpt}."`,
  }));
  input.artifactMarkdown = artifactMarkdownForCoverage(
    input.coverage.items,
    input.documentFindings.map((finding) => finding.evidence),
  );

  const result = scoreProject(input);
  assert.equal(result.acceptance.documentFindingTraceability, true);
  assert.equal(result.documentFindingTraceability.issueCount, 0);
  assert.equal(result.acceptance.passed, true);
});

test("duplicate short IDs are disambiguated by full reference then evidence", () => {
  const input = scoringInput({
    assessments: ["Godt", "Godt"],
    metadata: generationMetadataWithRefs(["R-001", "R-001"]),
  });
  input.coverage.items = [
    {
      ...coverageItem(0),
      reference: "R-001",
      full_reference: "Dokument A / R-001",
      source_reference: "Dokument A / R-001",
      evidence:
        "Felles dokumentert kontrollpunkt med A-spesifikk logging og akseptanse.",
    },
    {
      ...coverageItem(1),
      reference: "R-001",
      full_reference: "Dokument B / R-001",
      source_reference: "Dokument B / R-001",
      evidence:
        "Felles dokumentert kontrollpunkt med B-spesifikk alarm og akseptanse.",
    },
  ];

  input.documentFindings = [
    {
      reference: "Dokument B / R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      evidence: "B-spesifikk alarm og akseptanse",
    },
  ];
  const fullReferenceResult = scoreProject(input);
  assert.equal(
    fullReferenceResult.acceptance.documentFindingTraceability,
    true,
  );

  input.documentFindings = [
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      evidence: "B-spesifikk alarm og akseptanse",
    },
  ];
  const evidenceResult = scoreProject(input);
  assert.equal(evidenceResult.acceptance.documentFindingTraceability, true);

  input.documentFindings = [
    {
      reference: "R-001",
      reference_match: "coverage",
      matched_requirement_reference: "R-001",
      evidence: "Felles dokumentert kontrollpunkt",
    },
  ];
  const ambiguous = scoreProject(input);
  assert.equal(ambiguous.acceptance.documentFindingTraceability, false);
  assert.equal(
    ambiguous.documentFindingTraceability.issues[0].code,
    "ambiguous_matched_requirement_reference",
  );
});

test("checkpoint identity fences source, code, configuration and project identity", () => {
  assert.equal(HARNESS_CHECKPOINT_SCHEMA_VERSION, 8);
  const options = selectionOptions();
  const identity = checkpointIdentity(options);
  assert.deepEqual(identity, {
    schemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
    runId: "audit-test",
    model: "gpt-5.4",
    customerAnalysisMode: "api",
    backendIdentity: identity.backendIdentity,
  });
  assert.match(identity.backendIdentity, /^[0-9a-f]{64}$/);
  const checkpoint = {
    checkpointSchemaVersion: identity.schemaVersion,
    runId: identity.runId,
    model: identity.model,
    customerAnalysisMode: identity.customerAnalysisMode,
    backendIdentity: identity.backendIdentity,
  };
  assert.equal(checkpointIdentityMismatch(checkpoint, options), null);
  assert.match(
    checkpointIdentityMismatch(
      { ...checkpoint, customerAnalysisMode: "deterministic-seed" },
      options,
    ),
    /customerAnalysisMode/,
  );
  assert.match(
    checkpointIdentityMismatch(
      { ...checkpoint, backendIdentity: "other-backend" },
      options,
    ),
    /backendIdentity/,
  );
  const context = {
    projectId: "100-folder-001",
    sourceFingerprint: "source-v1",
    codeRevision: "code-v1",
    configurationRevision: "config-v1",
  };
  const contextualIdentity = checkpointIdentity(options, context);
  const contextualCheckpoint = {
    ...checkpoint,
    checkpointProjectId: contextualIdentity.projectId,
    sourceFingerprint: contextualIdentity.sourceFingerprint,
    codeRevision: contextualIdentity.codeRevision,
    configurationRevision: contextualIdentity.configurationRevision,
  };
  assert.equal(
    checkpointIdentityMismatch(contextualCheckpoint, options, context),
    null,
  );
  assert.match(
    checkpointIdentityMismatch(
      { ...contextualCheckpoint, sourceFingerprint: "source-v0" },
      options,
      context,
    ),
    /sourceFingerprint/,
  );
  assert.match(
    checkpointIdentityMismatch(
      { ...contextualCheckpoint, codeRevision: "code-v0" },
      options,
      context,
    ),
    /codeRevision/,
  );
});

test("checkpoint and configuration identity fence selection profile source hashes", () => {
  const legacyOptions = selectionOptions();
  const profileOptions = selectionOptions({
    selectionProfile: RELEVANT_25_V1_PROFILE.name,
    expectSelected: 26,
    requireProtectedPetoro: true,
  });
  const identity = checkpointIdentity(profileOptions);
  const profileFields = {
    selectionProfile: RELEVANT_25_V1_PROFILE.name,
    selectionProfileSha256: RELEVANT_25_V1_PROFILE.profileSha256,
    selectionCorpusFasitSha256:
      RELEVANT_25_V1_PROFILE.corpusFasitSha256,
    selectionSourceFilesSha256:
      RELEVANT_25_V1_PROFILE.selectedSourceFilesSha256,
    selectionPetoroRequirementSha256:
      RELEVANT_25_V1_PROFILE.petoroRequirementSha256,
    selectionPetoroCustomerSha256:
      RELEVANT_25_V1_PROFILE.petoroCustomerSha256,
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(profileFields).map((field) => [field, identity[field]]),
    ),
    profileFields,
  );
  assert.notEqual(
    checkpointConfigurationRevision(profileOptions),
    checkpointConfigurationRevision(legacyOptions),
  );
  const checkpoint = {
    checkpointSchemaVersion: identity.schemaVersion,
    runId: identity.runId,
    model: identity.model,
    customerAnalysisMode: identity.customerAnalysisMode,
    backendIdentity: identity.backendIdentity,
    ...profileFields,
  };
  assert.equal(
    checkpointIdentityMismatch(checkpoint, profileOptions),
    null,
  );
  for (const field of Object.keys(profileFields)) {
    assert.match(
      checkpointIdentityMismatch(
        { ...checkpoint, [field]: "stale-profile-value" },
        profileOptions,
      ),
      new RegExp(field, "u"),
    );
  }
  assert.match(
    checkpointIdentityMismatch(
      {
        checkpointSchemaVersion: identity.schemaVersion,
        runId: identity.runId,
        model: identity.model,
        customerAnalysisMode: identity.customerAnalysisMode,
        backendIdentity: identity.backendIdentity,
      },
      profileOptions,
    ),
    /selectionProfile.*missing/u,
  );
});

test("checkpoint configuration identity includes ingestion and prompt-cache controls", () => {
  const keys = [
    "DOCLING_INGESTION",
    "DOCLING_FORMATS",
    "DOCLING_ASYNC_AUTO_RUN",
    "OPENAI_PROMPT_CACHE_RETENTION",
  ];
  for (const key of keys) {
    const original = process.env[key];
    try {
      delete process.env[key];
      const before = checkpointConfigurationRevision();
      process.env[key] = `regression-${key}`;
      assert.notEqual(checkpointConfigurationRevision(), before, key);
    } finally {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
});

test("error checkpoints carry full identity so retryFailures controls reuse", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-harness-error-"),
  );
  const project = {
    id: "100-folder-001",
    corpus: "100-folder",
    name: "Testkunde",
    requirementPath: path.join(directory, "krav.docx"),
    customerPath: path.join(directory, "kunde.docx"),
  };
  try {
    await writeFile(project.requirementPath, "krav", "utf8");
    await writeFile(project.customerPath, "kunde", "utf8");
    const options = selectionOptions({
      resolvedBaseUrl: "http://127.0.0.1:3210",
      selectionProfile: RELEVANT_25_V1_PROFILE.name,
      expectSelected: 26,
      requireProtectedPetoro: true,
    });
    const failure = await buildFailureCheckpoint({
      project,
      options,
      error: new Error("synthetic failure"),
      totalMs: 12,
    });
    const context = await projectCheckpointContext(project, options);
    assert.equal(checkpointIdentityMismatch(failure, options, context), null);
    assert.equal(
      failure.selectionProfileSha256,
      RELEVANT_25_V1_PROFILE.profileSha256,
    );
    assert.equal(
      failure.selectionSourceFilesSha256,
      RELEVANT_25_V1_PROFILE.selectedSourceFilesSha256,
    );
    assert.equal(failure.ok, false);
    assert.match(failure.error, /synthetic failure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mixed usage billing falls back event by event instead of undercounting", () => {
  const telemetry = summarizeTelemetry([
    {
      event: "ai_json_completion_timing",
      model: "gpt-test",
      system_chars: 400,
      user_chars: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    },
    {
      event: "ai_json_completion_timing",
      model: "gpt-test",
      system_chars: 40,
      user_chars: 60,
    },
  ]);
  assert.equal(telemetry.byModel[0].billingInputTokens, 125);
  assert.equal(telemetry.byModel[0].billingOutputTokens, 950);
  assert.equal(telemetry.exactUsageAvailable, false);
  assert.equal(telemetry.usageBasis, "mixed");
  const cost = approximateCost(telemetry);
  assert.equal(cost.byModel[0].inputTokens, 125);
  assert.equal(cost.byModel[0].outputTokens, 950);
});

test("telemetry counts failed attempts and never labels partial usage exact", () => {
  const shared = {
    model: "gpt-test",
    system_chars: 400,
    user_chars: 200,
  };
  const telemetry = summarizeTelemetry([
    {
      event: "ai_json_completion_started",
      request_id: "request-1",
      ...shared,
    },
    {
      event: "ai_json_completion_timing",
      request_id: "request-1",
      ...shared,
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
    },
    {
      event: "ai_json_completion_started",
      request_id: "request-2",
      ...shared,
    },
    {
      event: "ai_json_completion_failed",
      request_id: "request-2",
      ...shared,
      failure_type: "Error",
    },
    {
      event: "ai_json_file_input_completion_started",
      request_id: "request-3",
      ...shared,
      file_count: 2,
    },
  ]);

  assert.equal(telemetry.totalRequests, 3);
  assert.equal(telemetry.completedRequestCount, 1);
  assert.equal(telemetry.failedRequestCount, 1);
  assert.equal(telemetry.incompleteRequestCount, 1);
  assert.equal(telemetry.usageEventCount, 1);
  assert.equal(telemetry.exactUsageAvailable, false);
  assert.equal(telemetry.usageBasis, "mixed");
  assert.equal(telemetry.unknownCostInvocationCount, 1);
  assert.equal(telemetry.byModel[0].fileInputRequests, 1);
  assert.equal(telemetry.byModel[0].billingInputTokens, 420);
  assert.equal(telemetry.byModel[0].billingOutputTokens, 1_840);
  assert.match(telemetry.note, /failed or unconfirmed attempts/u);
});

test("telemetry is exact only when every correlated request has SDK usage", () => {
  const telemetry = summarizeTelemetry([
    {
      event: "ai_json_completion_started",
      request_id: "request-1",
      model: "gpt-test",
      system_chars: 40,
      user_chars: 60,
    },
    {
      event: "ai_json_completion_timing",
      request_id: "request-1",
      model: "gpt-test",
      system_chars: 40,
      user_chars: 60,
      input_tokens: 25,
      output_tokens: 10,
      total_tokens: 35,
    },
  ]);

  assert.equal(telemetry.totalRequests, 1);
  assert.equal(telemetry.completedRequestCount, 1);
  assert.equal(telemetry.failedRequestCount, 0);
  assert.equal(telemetry.incompleteRequestCount, 0);
  assert.equal(telemetry.exactUsageAvailable, true);
  assert.equal(telemetry.usageBasis, "exact");
});

test("zero-valued SDK input and output usage remains exact", () => {
  const telemetry = summarizeTelemetry([
    {
      event: "ai_json_completion_started",
      request_id: "request-zero",
      model: "gpt-test",
      system_chars: 0,
      user_chars: 0,
    },
    {
      event: "ai_json_completion_timing",
      request_id: "request-zero",
      model: "gpt-test",
      system_chars: 0,
      user_chars: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  ]);

  assert.equal(telemetry.exactUsageAvailable, true);
  assert.equal(telemetry.byModel[0].billingInputTokens, 0);
  assert.equal(telemetry.byModel[0].billingOutputTokens, 0);
});

test("Retry-After supports seconds and HTTP dates and aborts at project deadline", async () => {
  assert.equal(parseRetryAfterMs("1.5", 0), 1500);
  assert.equal(
    parseRetryAfterMs(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"),
    ),
    2000,
  );
  const client = new ApiClient("http://127.0.0.1:1", {
    projectTimeoutMs: 40,
    fetchImpl: async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  });
  const started = Date.now();
  await assert.rejects(
    client.withProjectDeadline(() => client.json("/limited")),
    /total project deadline/u,
  );
  assert.ok(Date.now() - started < 500);
});

test("atomic JSON writes leave a valid checkpoint and no temp file", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-harness-write-"),
  );
  try {
    const filePath = path.join(directory, "checkpoint.json");
    await writeJson(filePath, { version: 1 });
    await writeJson(filePath, { version: 2, ok: true });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      version: 2,
      ok: true,
    });
    assert.deepEqual(await readdir(directory), ["checkpoint.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("harness API requests abort instead of hanging indefinitely", async () => {
  const client = new ApiClient("http://127.0.0.1:1", {
    requestTimeoutMs: 5,
    fetchImpl: (_url, init) =>
      new Promise((_, reject) => {
        const keepAlive = setTimeout(
          () => reject(new Error("fake fetch did not receive abort")),
          1_000,
        );
        init.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    client.json("/never", { projectKey: "timeout-test" }),
    /API request timed out after 5 ms/u,
  );
});

test("harness supports a bounded long direct request and enforces its exact status", async () => {
  let observedTimeoutSignal = false;
  const client = new ApiClient("http://127.0.0.1:1", {
    requestTimeoutMs: 5,
    fetchImpl: async (_url, init) => {
      observedTimeoutSignal = init.signal instanceof AbortSignal;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return Response.json({ evaluation: {}, project: {} }, { status: 200 });
    },
  });

  assert.deepEqual(
    await client.json("/direct", {
      method: "POST",
      expectedStatus: 200,
      timeoutMs: 100,
    }),
    { evaluation: {}, project: {} },
  );
  assert.equal(observedTimeoutSignal, true);

  const asyncClient = new ApiClient("http://127.0.0.1:1", {
    fetchImpl: async () => Response.json({ job: {} }, { status: 202 }),
  });
  await assert.rejects(
    asyncClient.json("/direct", {
      method: "POST",
      expectedStatus: 200,
    }),
    /returnerte 202, forventet 200/u,
  );
});

test("harness retries transient GET transport failures but never replays POST", async () => {
  let getAttempts = 0;
  const getClient = new ApiClient("http://127.0.0.1:1", {
    fetchImpl: async () => {
      getAttempts += 1;
      if (getAttempts < 3) {
        throw new TypeError("fetch failed", {
          cause: { code: "UND_ERR_SOCKET" },
        });
      }
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await getClient.json("/job-status"), { ok: true });
  assert.equal(getAttempts, 3);

  let postAttempts = 0;
  const postClient = new ApiClient("http://127.0.0.1:1", {
    fetchImpl: async () => {
      postAttempts += 1;
      throw new TypeError("fetch failed", {
        cause: { code: "UND_ERR_SOCKET" },
      });
    },
  });
  await assert.rejects(
    postClient.json("/jobs", { method: "POST", body: { kind: "test" } }),
    /fetch failed/u,
  );
  assert.equal(postAttempts, 1);
});

test("health checks abort a server that accepts TCP but never responds", async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const started = Date.now();
    await assert.rejects(
      waitForHealth(`http://127.0.0.1:${address.port}`, 80),
      /Lokal server ble ikke klar/u,
    );
    assert.ok(Date.now() - started < 1_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("truncated checkpoints are retryable and merge as one row failure", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-harness-merge-"),
  );
  const project = {
    id: "100-folder-001",
    corpus: "100-folder",
    projectNumber: 1,
    sourceNumber: "001",
    name: "Testkunde",
    documentName: "krav.docx",
    requirementPath: path.join(directory, "krav.docx"),
    customerPath: path.join(directory, "kunde.docx"),
  };
  try {
    await writeFile(project.requirementPath, "krav", "utf8");
    await writeFile(project.customerPath, "kunde", "utf8");
    const projectsDirectory = path.join(directory, "projects");
    await mkdir(projectsDirectory, { recursive: true });
    await writeFile(
      path.join(projectsDirectory, `${project.id}.json`),
      '{"runId":"audit-test",',
      "utf8",
    );

    const loaded = await readJsonCheckpoint(
      path.join(projectsDirectory, `${project.id}.json`),
    );
    assert.equal(loaded.checkpoint, null);
    assert.match(loaded.error, /JSON/);

    const outputPath = path.join(directory, "merged.json");
    const previousExitCode = process.exitCode;
    await mergeExistingProjectArtifacts({
      options: {
        ...selectionOptions(),
        artifactsRoot: directory,
        outputPath,
        reportPath: path.join(directory, "report.html"),
        serverLogPath: path.join(directory, "missing-server.log"),
        cleanupManifestPath: path.join(directory, "created-projects.jsonl"),
        skipReport: true,
        baseUrl: "",
      },
      projects: [project],
      discovered: {},
    });
    process.exitCode = previousExitCode;
    const merged = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(merged.aggregate.failures, 1);
    assert.match(merged.projects[0].error, /Invalid project checkpoint/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume and merge reject stale artifacts or cleaned and foreign live projects", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-harness-reuse-"),
  );
  const project = {
    id: "100-folder-001",
    corpus: "100-folder",
    projectNumber: 1,
    sourceNumber: "001",
    name: "Testkunde",
    documentName: "krav.docx",
    requirementPath: path.join(directory, "krav.docx"),
    customerPath: path.join(directory, "kunde.docx"),
  };
  const options = {
    ...selectionOptions(),
    artifactsRoot: directory,
    outputPath: path.join(directory, "merged.json"),
    reportPath: path.join(directory, "report.html"),
    serverLogPath: path.join(directory, "missing-server.log"),
    cleanupManifestPath: path.join(directory, "created-projects.jsonl"),
    skipReport: true,
    resolvedBaseUrl: "http://127.0.0.1:3210",
  };
  const markdownPath = path.join(
    directory,
    "kravsvar",
    "100-folder-001-testkunde.md",
  );
  const evaluationPath = path.join(
    directory,
    "evaluations",
    `${project.id}.json`,
  );
  const liveProject = {
    id: "api-project-1",
    name: `[${options.runId}] ${project.name}`,
    description: `Automated full Vurdering/Krav og svar API benchmark run ${options.runId}, row ${project.id}`,
  };
  try {
    await writeFile(project.requirementPath, "krav", "utf8");
    await writeFile(project.customerPath, "kunde", "utf8");
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await mkdir(path.dirname(evaluationPath), { recursive: true });
    await writeFile(markdownPath, "# gyldig kravsvar\n", "utf8");
    await writeJson(evaluationPath, { evaluation: "valid" });
    const identity = checkpointIdentity(
      options,
      await projectCheckpointContext(project),
    );
    const checkpoint = strictProjectSummary({
      projectOverrides: {
        checkpointSchemaVersion: identity.schemaVersion,
        runId: identity.runId,
        model: identity.model,
        customerAnalysisMode: identity.customerAnalysisMode,
        checkpointProjectId: identity.projectId,
        sourceFingerprint: identity.sourceFingerprint,
        codeRevision: identity.codeRevision,
        configurationRevision: identity.configurationRevision,
        backendIdentity: identity.backendIdentity,
        ...project,
      },
    });
    Object.assign(checkpoint, {
      apiProjectId: liveProject.id,
      kravSvar: {
        markdownPath,
        customerDocumentId: "customer-document",
        sourceDocumentId: "requirement-document",
        requestedSourceDocumentIds: ["requirement-document"],
        requestedSourceSnapshotDocumentIds: ["requirement-document"],
        sourceDocumentIds: ["customer-document", "requirement-document"],
        sourceSnapshotDocumentIds: [
          "customer-document",
          "requirement-document",
        ],
        sourceRoleDocumentIds: [
          "customer-document",
          "requirement-document",
        ],
      },
      evaluationPath,
      localArtifactHashes: await checkpointArtifactHashes(project, options),
      durations: { totalMs: 1 },
    });
    assert.equal(
      await reusableCheckpointIssue({
        checkpoint,
        options,
        project,
        getLiveProject: async () => liveProject,
      }),
      null,
    );
    assert.match(
      await reusableCheckpointIssue({
        checkpoint,
        options,
        project,
        getLiveProject: async () => null,
      }),
      /no longer exists/,
    );
    assert.match(
      await reusableCheckpointIssue({
        checkpoint,
        options,
        project,
        getLiveProject: async () => ({
          ...liveProject,
          description: "foreign project",
        }),
      }),
      /is not owned by run/,
    );
    assert.match(
      await reusableCheckpointIssue({
        checkpoint: {
          ...checkpoint,
          kravSvar: {
            ...checkpoint.kravSvar,
            requestedSourceDocumentIds: [
              "customer-document",
              "requirement-document",
            ],
          },
        },
        options,
        project,
        getLiveProject: async () => liveProject,
      }),
      /formal-only requested artifact scope metadata/u,
    );
    assert.match(
      await reusableCheckpointIssue({
        checkpoint: {
          ...checkpoint,
          kravSvar: {
            ...checkpoint.kravSvar,
            sourceDocumentIds: ["requirement-document"],
          },
        },
        options,
        project,
        getLiveProject: async () => liveProject,
      }),
      /canonical artifact scope metadata/u,
    );

    await writeJson(
      path.join(directory, "projects", `${project.id}.json`),
      checkpoint,
    );
    const successfulMergePreviousExitCode = process.exitCode;
    process.exitCode = undefined;
    await mergeExistingProjectArtifacts({
      options,
      projects: [project],
      getLiveProject: async () => liveProject,
    });
    assert.equal(process.exitCode, undefined);
    process.exitCode = successfulMergePreviousExitCode;
    const successfulMerge = JSON.parse(
      await readFile(options.outputPath, "utf8"),
    );
    assert.equal(successfulMerge.ok, true);
    assert.equal(successfulMerge.aggregate.ok, true);
    assert.equal(successfulMerge.aggregate.failures, 0);
    assert.equal(successfulMerge.aggregate.strong, 1);

    await writeFile(markdownPath, "# tampered kravsvar\n", "utf8");
    assert.match(
      await reusableCheckpointIssue({
        checkpoint,
        options,
        project,
        getLiveProject: async () => liveProject,
      }),
      /hash mismatch/,
    );
    await writeJson(
      path.join(directory, "projects", `${project.id}.json`),
      checkpoint,
    );
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await mergeExistingProjectArtifacts({
      options,
      projects: [project],
      getLiveProject: async () => liveProject,
    });
    assert.equal(process.exitCode, 1);
    process.exitCode = previousExitCode;
    const merged = JSON.parse(await readFile(options.outputPath, "utf8"));
    assert.equal(merged.actualLocalApiRun, false);
    assert.equal(merged.actualFullVurderingRun, false);
    assert.equal(merged.actualKravSvarRun, false);
    assert.equal(merged.aggregate.failures, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("merge rejects a fabricated perfect checkpoint with only 41 of 45 requirements Godt", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vurdering-harness-score-"),
  );
  const project = {
    id: "100-folder-001",
    corpus: "100-folder",
    projectNumber: 1,
    sourceNumber: "001",
    name: "Testkunde",
    documentName: "krav.docx",
    requirementPath: path.join(directory, "krav.docx"),
    customerPath: path.join(directory, "kunde.docx"),
  };
  try {
    const options = {
      ...selectionOptions(),
      artifactsRoot: directory,
      outputPath: path.join(directory, "merged.json"),
      reportPath: path.join(directory, "report.html"),
      serverLogPath: path.join(directory, "missing-server.log"),
      cleanupManifestPath: path.join(directory, "created-projects.jsonl"),
      skipReport: true,
      baseUrl: "",
    };
    await writeFile(project.requirementPath, "krav", "utf8");
    await writeFile(project.customerPath, "kunde", "utf8");
    const markdownPath = path.join(
      directory,
      "kravsvar",
      "100-folder-001-testkunde.md",
    );
    const evaluationPath = path.join(
      directory,
      "evaluations",
      `${project.id}.json`,
    );
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await mkdir(path.dirname(evaluationPath), { recursive: true });
    await writeFile(markdownPath, "# kravsvar\n", "utf8");
    await writeJson(evaluationPath, { evaluation: "valid" });
    const identity = checkpointIdentity(
      options,
      await projectCheckpointContext(project),
    );
    const deceptiveCheckpoint = strictProjectSummary({
      canonicalCount: 45,
      bilag2Count: 44,
      projectOverrides: {
        checkpointSchemaVersion: HARNESS_CHECKPOINT_SCHEMA_VERSION,
        runId: options.runId,
        model: options.model,
        customerAnalysisMode: "api",
        backendIdentity: identity.backendIdentity,
        checkpointProjectId: identity.projectId,
        sourceFingerprint: identity.sourceFingerprint,
        codeRevision: identity.codeRevision,
        configurationRevision: identity.configurationRevision,
        ...project,
      },
    });
    Object.assign(deceptiveCheckpoint, {
      apiProjectId: "api-project-1",
      kravSvar: {
        markdownPath,
        customerDocumentId: "customer-document",
        sourceDocumentId: "requirement-document",
        requestedSourceDocumentIds: ["requirement-document"],
        requestedSourceSnapshotDocumentIds: ["requirement-document"],
        sourceDocumentIds: ["customer-document", "requirement-document"],
        sourceSnapshotDocumentIds: [
          "customer-document",
          "requirement-document",
        ],
        sourceRoleDocumentIds: [
          "customer-document",
          "requirement-document",
        ],
      },
      evaluationPath,
      localArtifactHashes: await checkpointArtifactHashes(project, options),
      ok: true,
      durations: { totalMs: 1 },
    });
    deceptiveCheckpoint.coverage.good = 41;
    deceptiveCheckpoint.coverage.weak = 4;
    deceptiveCheckpoint.scoreComponents.goodRatio = 41 / 45;
    await writeJson(
      path.join(directory, "projects", `${project.id}.json`),
      deceptiveCheckpoint,
    );

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    await mergeExistingProjectArtifacts({
      options,
      projects: [project],
      discovered: {},
      getLiveProject: async () => ({
        id: "api-project-1",
        name: `[${options.runId}] ${project.name}`,
        description: `Automated full Vurdering/Krav og svar API benchmark run ${options.runId}, row ${project.id}`,
      }),
    });
    assert.equal(process.exitCode, 1);
    process.exitCode = previousExitCode;
    const merged = JSON.parse(await readFile(options.outputPath, "utf8"));
    assert.equal(merged.ok, false);
    assert.equal(merged.aggregate.failures, 1);
    assert.equal(merged.aggregate.executionFailures, 1);
    assert.equal(merged.aggregate.acceptanceFailures, 0);
    assert.equal(merged.aggregate.strong, 0);
    assert.match(
      merged.projects[0].error,
      /strict quality gate failed: coverage\.good/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct-baseline cleanup targets exact run-owned orphans and protects Petoro", async () => {
  const runId = "audit-test";
  const originalPetoro = {
    id: "petoro-original",
    name: "Petoro",
    customer_name: "Petoro AS",
    description: "Production project",
  };
  const testPetoro = {
    id: "petoro-test",
    name: `[${runId}] Petoro`,
    customer_name: "Petoro",
    description: `Automated full Vurdering/Krav og svar API benchmark run ${runId}, row petoro`,
  };
  const similarlyNamed = {
    id: "not-owned",
    name: `[${runId}] Petoro`,
    customer_name: "Petoro",
    description: "Unrelated project",
  };
  assert.equal(isRunOwnedProject(testPetoro, runId), true);
  assert.equal(isRunOwnedProject(similarlyNamed, runId), false);
  assert.deepEqual(
    protectedPetoroProjectsFromBaseline(
      [originalPetoro, testPetoro, similarlyNamed],
      runId,
    ).map((project) => project.id),
    ["petoro-original", "not-owned"],
  );
  assert.equal(
    protectedPetoroProjectsFromBaseline([originalPetoro], runId)[0].description,
    "Production project",
  );

  const events = [
    {
      event: "created",
      runId,
      apiProjectId: "registered-test",
      sourceProjectId: "100-folder-001",
    },
    {
      event: "created",
      runId,
      apiProjectId: "petoro-original",
      sourceProjectId: "corrupt-manifest-entry",
    },
    {
      event: "created",
      runId,
      apiProjectId: "not-owned",
      sourceProjectId: "corrupt-manifest-entry",
    },
  ];
  const targets = await cleanupTargetsFromEventsAndDatabase(
    events,
    [
      { ...originalPetoro },
      { ...testPetoro },
      { ...similarlyNamed },
      {
        id: "registered-test",
        name: `[${runId}] Test`,
        description: `Automated full Vurdering/Krav og svar API benchmark run ${runId}, row 100-folder-001`,
      },
    ],
    runId,
    ["petoro-original"],
  );
  assert.deepEqual(
    new Set(targets.map((project) => project.apiProjectId)),
    new Set(["registered-test", "petoro-test"]),
  );

  const baselineAudit = analyzeCleanupBaseline({
    currentProjects: [
      { ...originalPetoro, name: "Petoro endret" },
      {
        id: "production-missing-replacement",
        name: "Ny rad uten run-prefix",
        customer_name: "Ukjent",
        description: "Prefixet er borte",
      },
      {
        id: "registered-test",
        name: "Omdøpt test",
        customer_name: "Test",
        description: "Run-markøren er borte",
      },
    ],
    baselineProjects: [
      {
        id: originalPetoro.id,
        name: originalPetoro.name,
        customerName: originalPetoro.customer_name,
        description: originalPetoro.description,
      },
      {
        id: "production-missing",
        name: "Produksjon",
        customerName: "Kunde",
        description: "Original",
      },
    ],
    registeredProjectIds: new Set(["registered-test"]),
    runId,
  });
  assert.deepEqual(baselineAudit.missingBaselineProjectIds, [
    "production-missing",
  ]);
  assert.deepEqual(baselineAudit.changedBaselineProjectIds, [
    "petoro-original",
  ]);
  assert.deepEqual(
    new Set(baselineAudit.unexpectedProjectIds),
    new Set(["production-missing-replacement", "registered-test"]),
  );
  assert.deepEqual(baselineAudit.remainingRegisteredProjectIds, [
    "registered-test",
  ]);
});

test("cleanup storage verification recursively paginates project prefixes", async () => {
  const calls = [];
  const entriesByPrefix = new Map([
    [
      "projects/test-project",
      [
        { name: "document-a", id: null, metadata: null },
        { name: "document-b", id: null, metadata: null },
        { name: "root.txt", id: "root-file", metadata: {} },
      ],
    ],
    [
      "projects/test-project/document-a",
      [
        { name: "a.pdf", id: "a-file", metadata: {} },
        { name: "b.pdf", id: "b-file", metadata: {} },
      ],
    ],
    ["projects/test-project/document-b", []],
  ]);
  const supabase = {
    storage: {
      from(bucket) {
        assert.equal(bucket, "anbud-documents");
        return {
          async list(prefix, options) {
            calls.push({ prefix, ...options });
            const entries = entriesByPrefix.get(prefix) ?? [];
            return {
              data: entries.slice(options.offset, options.offset + options.limit),
              error: null,
            };
          },
        };
      },
    },
  };

  const files = await listStoragePrefixFiles({
    supabase,
    prefix: "/projects/test-project/",
    pageSize: 2,
  });

  assert.deepEqual(files, [
    "projects/test-project/document-a/a.pdf",
    "projects/test-project/document-a/b.pdf",
    "projects/test-project/root.txt",
  ]);
  assert.ok(
    calls.some(
      (call) =>
        call.prefix === "projects/test-project" && call.offset === 2,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.prefix === "projects/test-project/document-a" && call.offset === 2,
    ),
  );
});
