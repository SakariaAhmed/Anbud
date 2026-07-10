#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "").trim();
  }
}

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(frontendRoot, ".env.local"));

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "requirement-quality-gate.cjs"), {
  fsCache: false,
  moduleCache: false,
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  extractTextFromBuffer,
  contentTypeForUploadFormat,
  inferUploadFileFormat,
} = jiti(path.join(frontendRoot, "lib", "server", "documents.ts"));
const {
  evaluateSolutionDocument,
  extractRequirementLedgerForDocument,
} = jiti(path.join(frontendRoot, "lib", "server", "ai.ts"));
const { analyzeRequirementCoverageIntegrity } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "requirements",
    "evaluation-coverage-integrity.ts",
  ),
);

const project = {
  id: "11",
  name: "PolarNett Feltservice AS - requirement quality gate",
  customer:
    "/Users/sakariaahmed/Downloads/sky_10_unike_ustrukturerte_prosjekter/DOCX/11_Bilag_1_PolarNett_Feltservice_AS.docx",
  requirements:
    "/Users/sakariaahmed/Downloads/sky_10_unike_ustrukturerte_prosjekter/DOCX/11_Bilag_2_Krav_PolarNett_Feltservice_AS.docx",
};

const extractionScoreThresholds = {
  overall: {
    strictTextRecall: 80,
    idAccuracy: 68,
    headingAccuracy: 84,
  },
  pdf: {
    strictTextRecall: 78,
    idAccuracy: 79,
    headingAccuracy: 88,
  },
};

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function aggregateExtractionDocuments(documents, predicate) {
  const bucket = {
    documents: 0,
    expectedRequirements: 0,
    strictTextMatches: 0,
    usableIdCorrect: 0,
    usableIdExpected: 0,
    syntheticIdTypeCorrect: 0,
    syntheticIdExpected: 0,
    headingCorrect: 0,
    headingExpected: 0,
  };

  for (const document of documents) {
    if (document.error || !predicate(document)) continue;
    bucket.documents += 1;
    bucket.expectedRequirements += document.expectedCount;
    bucket.strictTextMatches += document.strictTextMatches;
    bucket.usableIdCorrect += document.usableIdCorrect;
    bucket.usableIdExpected += document.usableIdExpected;
    bucket.syntheticIdTypeCorrect += document.syntheticIdTypeCorrect;
    bucket.syntheticIdExpected += document.syntheticIdExpected;
    bucket.headingCorrect += document.headingCorrect;
    bucket.headingExpected += document.headingExpected;
  }

  return {
    documents: bucket.documents,
    strictTextRecall: percent(
      bucket.strictTextMatches,
      bucket.expectedRequirements,
    ),
    idAccuracy: percent(
      bucket.usableIdCorrect + bucket.syntheticIdTypeCorrect,
      bucket.usableIdExpected + bucket.syntheticIdExpected,
    ),
    headingAccuracy: percent(bucket.headingCorrect, bucket.headingExpected),
  };
}

function metricGatePass(label, actual, thresholds) {
  const failures = Object.entries(thresholds).filter(
    ([metric, minimum]) => Number(actual[metric] ?? 0) < minimum,
  );
  if (!failures.length) {
    console.log(
      `EXTRACTION_SCORE ${label} strict=${actual.strictTextRecall} id=${actual.idAccuracy} heading=${actual.headingAccuracy}`,
    );
    return true;
  }

  for (const [metric, minimum] of failures) {
    console.log(
      `EXTRACTION_SCORE_FAIL ${label}.${metric}=${actual[metric] ?? 0} min=${minimum}`,
    );
  }
  return false;
}

function requirementExtractionScoreGate() {
  const scorePath =
    process.env.REQUIREMENT_EXTRACTION_SCORE_PATH ||
    path.join(repoRoot, "reports", "requirement-extraction-fasit-score.json");
  if (!existsSync(scorePath)) {
    console.log(`EXTRACTION_SCORE_SKIP missing ${scorePath}`);
    return true;
  }

  const summary = JSON.parse(readFileSync(scorePath, "utf8"));
  const documentCount = Number(summary.metrics?.overall?.documents ?? 0);
  if (documentCount < 100) {
    console.log(
      `EXTRACTION_SCORE_SKIP expected full 100-document score, found ${documentCount}`,
    );
    return true;
  }

  const overall = {
    strictTextRecall: summary.metrics.overall.strictTextRecall,
    idAccuracy: summary.metrics.overall.idAccuracy,
    headingAccuracy: summary.metrics.overall.headingAccuracy,
  };
  const pdf = aggregateExtractionDocuments(
    summary.documents ?? [],
    (document) => String(document.format ?? "").toLowerCase() === "pdf",
  );

  return (
    metricGatePass("overall", overall, extractionScoreThresholds.overall) &&
    metricGatePass("pdf", pdf, extractionScoreThresholds.pdf)
  );
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownRow(cells) {
  return `| ${cells.map(markdownCell).join(" | ")} |`;
}

async function loadProjectDocument({ filePath, projectId, role, supportingSubtype = null }) {
  const buffer = await readFile(filePath);
  const fileName = path.basename(filePath);
  const fileFormat = inferUploadFileFormat({ fileName });
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName,
    contentType: contentTypeForUploadFormat(fileFormat),
    role,
    useDocling: false,
  });
  const now = new Date(0).toISOString();

  return {
    id: `${projectId}-${fileName}`,
    project_id: projectId,
    role,
    supporting_subtype: supportingSubtype,
    title: fileName,
    file_name: fileName,
    file_format: parsed.fileFormat,
    content_type: parsed.contentType,
    file_size_bytes: buffer.length,
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: parsed.parserUsed,
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: parsed.rawText,
    file_base64: parsed.fileBase64,
    structure_map: parsed.sourceMap,
  };
}

function markdownSolutionDocument({ projectId, markdown }) {
  const now = new Date(0).toISOString();

  return {
    id: `${projectId}-adversarial-kravbesvarelse.md`,
    project_id: projectId,
    role: "primary_solution_document",
    supporting_subtype: null,
    title: "Adversarial kravbesvarelse",
    file_name: "adversarial-kravbesvarelse.md",
    file_format: "md",
    content_type: "text/markdown",
    file_size_bytes: Buffer.byteLength(markdown),
    page_count: null,
    processing_status: "enhanced_ready",
    processing_message: null,
    processing_error: null,
    parser_used: "local-markdown",
    indexed_at: null,
    ai_summary: null,
    ai_summary_updated_at: null,
    created_at: now,
    updated_at: now,
    raw_text: markdown,
    file_base64: Buffer.from(markdown, "utf8").toString("base64"),
    structure_map: [
      {
        reference: "Adversarial kravbesvarelse",
        text: markdown,
        kind: "text",
        parser: "local-markdown",
        page: 1,
      },
    ],
  };
}

function requirementLedgerContext({ document, ledger }) {
  const rows = ledger.map((entry, index) => {
    const source = [
      entry.pages?.length ? `Side ${entry.pages.join(",")}` : "",
      entry.heading,
      entry.tableId,
      entry.id,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${index + 1}. ${entry.id} | ${source} | ${entry.text}`;
  });

  return [
    "### Presis kravledger for vurdering",
    "Bruk denne deterministiske kravledgeren som kontrolliste for kravdekning. Ikke legg til, fjern eller slå sammen krav.",
    `Dokument: ${document.title}`,
    `Krav funnet: ${ledger.length}`,
    ...rows,
  ].join("\n");
}

const cases = [
  {
    expected: "Godt",
    kind: "concrete_good",
    answer: () =>
      "Atea tar høyde for mindre nedetid i felt ved at brukerflaten støtter lokal mellomlagring, kø av registreringer og automatisk synkronisering med retry når nettet er tilbake. Leveransen har navngitt driftsansvarlig, overvåking av synkfeil, akseptansekriterier, testprotokoll for offline/online-scenarioer og månedlig rapportering på tilgjengelighet.",
  },
  {
    expected: "Dårlig",
    kind: "generic",
    answer: () =>
      "Atea oppfyller kravet i tråd med beste praksis og tilpasser løsningen etter behov. Detaljer avklares i prosjektet.",
  },
  {
    expected: "Mangler",
    kind: "omitted_row",
    omitRow: true,
    answer: () => "",
  },
  {
    expected: "Dårlig",
    kind: "restates_requirement",
    answer: (entry) => entry.text,
  },
  {
    expected: "Dårlig",
    kind: "explicitly_not_included",
    answer: () =>
      "Dette inngår ikke i Atea sitt tilbud og må håndteres av kunden eller en annen leverandør.",
  },
  {
    expected: "Godt",
    kind: "attachment_reference",
    answer: () =>
      "Se vedlegg B for komplett løsningsbeskrivelse, testbevis og kontrollmatrise. Kravet er besvart i vedlagt dokumentasjon.",
  },
  {
    expected: "Dårlig",
    kind: "wrong_domain",
    answer: () =>
      "Atea leverer en løsning for kantinedrift og betalingsterminaler gjennom kassasystem, menyer og lagerstyring.",
  },
  {
    expected: "Godt",
    kind: "domain_specific_good",
    answer: () =>
      "Atea ivaretar personvern for posisjonsdata ved dataminimering, tydelig formålsavgrensing, rollebasert tilgang, kryptert lagring og sletting etter avtalt retensjon. Løsningen inkluderer revisjonslogg, DPIA/ROS-bidrag, dokumenterte behandlingsaktiviteter, testbevis for tilgangskontroller og månedlig kontrollrapport etter produksjonssetting.",
  },
  {
    expected: "Uklart",
    kind: "deferred_clarification",
    answer: () =>
      "Atea kan trolig støtte dette, men endelig omfang, ansvar og løsning må avklares i designfasen før vi kan bekrefte leveransen.",
  },
  {
    expected: "Dårlig",
    kind: "irrelevant_yes",
    answer: () => "Ja.",
  },
];

function expectedByReference(ledger) {
  return new Map(
    ledger.map((entry, index) => [
      normalizeRef(entry.id),
      {
        ...cases[index],
        reference: entry.id,
      },
    ]),
  );
}

function normalizeRef(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.-]/g, "");
}

function buildAdversarialMarkdown(ledger) {
  const lines = [
    "## Kravbesvarelse",
    "",
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
  ];

  ledger.forEach((entry, index) => {
    const testCase = cases[index];
    if (testCase.omitRow) return;
    lines.push(
      markdownRow([
        entry.id,
        entry.text,
        testCase.answer(entry),
        entry.sourceExcerpt || entry.text,
        `Testkilde, rad ${index + 1}, ${entry.id}`,
      ]),
    );
  });

  return lines.join("\n");
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY mangler. Legg nøkkelen i .env eller apps/frontend/.env.local.");
}

const projectId = "local-requirement-quality-gate";
const [customerDocument, requirementDocument, customerAnalysisRaw] = await Promise.all([
  loadProjectDocument({
    filePath: project.customer,
    projectId,
    role: "primary_customer_document",
  }),
  loadProjectDocument({
    filePath: project.requirements,
    projectId,
    role: "supporting_document",
    supportingSubtype: "kravdokument",
  }),
  readFile(
    path.join(repoRoot, "test-data", "requirement-generation-smoke", "11", "customer-analysis.json"),
    "utf8",
  ),
]);
const customerAnalysis = JSON.parse(customerAnalysisRaw);
const sourceLedger = (await extractRequirementLedgerForDocument(requirementDocument)).slice(
  0,
  cases.length,
);
const expected = expectedByReference(sourceLedger);
const solutionDocument = markdownSolutionDocument({
  projectId,
  markdown: buildAdversarialMarkdown(sourceLedger),
});
const result = await evaluateSolutionDocument({
  projectName: project.name,
  customerDocument,
  solutionDocument,
  supportingDocuments: [requirementDocument],
  sourceRequirementLedger: sourceLedger,
  customerAnalysis,
  model: process.env.REQUIREMENT_QUALITY_MODEL || "gpt-5.4-mini",
  documentLedgerContext: requirementLedgerContext({
    document: requirementDocument,
    ledger: sourceLedger,
  }),
  onProgress: (message) => console.log(`  ${message}`),
});

const items = result.requirement_coverage?.items ?? [];
const integrity = analyzeRequirementCoverageIntegrity({
  sourceLedger,
  coverage: result.requirement_coverage,
});
const malformedReferencePatterns = [
  /^ID\s+\d{1,3}-\d{1,3}[A-Z]?$/i,
  /\bTabell\s+ID\s+\d{1,3}-\d{1,3}\s+-\s+(?:Der|Sikker|Konfigurasjons|Dokumentasjo)\b/i,
  /\bLeveransen og som\b/i,
  /\bendringshåndtering ering\b/i,
  /\bRapportene vil gi\b/i,
  /\bPetoro løpende\b/i,
  /\bTredjepart\s+s-leverandører\b/i,
  /\bTredjepartsprogramvare og -løsninger\b/i,
];
const malformedReferenceItems = items.filter((item) =>
  [
    item.reference,
    item.full_reference,
    item.source_reference,
    item.requirement_subtitle,
    item.table_id,
  ]
    .filter(Boolean)
    .some((value) =>
      malformedReferencePatterns.some((pattern) => pattern.test(String(value))),
    ),
);
const malformedRequirementPatterns = [
  /^Redegjør for kontrollmekanismer ved$/i,
  /^Leverandøren skal beskrive$/i,
  /^Leverandøren bes beskrive løsning for$/i,
  /^resultatet\./i,
];
const malformedRequirementItems = items.filter((item) =>
  malformedRequirementPatterns.some((pattern) =>
    pattern.test(String(item.requirement ?? "").trim()),
  ),
);
let strictHits = 0;
let knownItems = 0;
for (const item of items) {
  const testCase = expected.get(normalizeRef(item.reference));
  if (!testCase) {
    continue;
  }
  knownItems += 1;
  const strict = Boolean(testCase && item.assessment === testCase.expected);
  if (strict) strictHits += 1;
  console.log(
    JSON.stringify({
      ref: item.reference,
      kind: testCase?.kind ?? "unknown",
      expected: testCase?.expected ?? "unknown",
      actual: item.assessment,
      strict,
      rationale: item.rationale,
    }),
  );
}

const missingItems = cases.length - knownItems;
const extractionScorePass = requirementExtractionScoreGate();
const strictPass =
  strictHits >= 9 &&
  missingItems === 0 &&
  malformedReferenceItems.length === 0 &&
  malformedRequirementItems.length === 0 &&
  integrity.ok &&
  extractionScorePass;
console.log(
  `SUMMARY strict=${strictHits}/${cases.length}, known_items=${knownItems}/${cases.length}, total_items=${items.length}, missing_items=${missingItems}, malformed_refs=${malformedReferenceItems.length}, malformed_requirements=${malformedRequirementItems.length}, integrity=${integrity.ok ? "OK" : integrity.issueCount}`,
);

for (const item of malformedReferenceItems.slice(0, 5)) {
  console.log(
    JSON.stringify({
      malformed_ref: item.reference,
      full_reference: item.full_reference,
      source_reference: item.source_reference,
    }),
  );
}
for (const item of malformedRequirementItems.slice(0, 5)) {
  console.log(
    JSON.stringify({
      malformed_requirement: item.reference,
      requirement: item.requirement,
    }),
  );
}
for (const issue of integrity.issues.slice(0, 10)) {
  console.log(JSON.stringify({ integrity_issue: issue }));
}

if (!strictPass) {
  process.exitCode = 1;
}
