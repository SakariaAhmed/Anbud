#!/usr/bin/env node
// fallow-ignore-file unused-file

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const frontendRoot = path.join(repositoryRoot, "apps", "frontend");
const cliArgs = process.argv.slice(2);
const cliValueAfter = (name, fallback = "") => {
  const index = cliArgs.indexOf(name);
  return index >= 0 && cliArgs[index + 1] ? cliArgs[index + 1] : fallback;
};
const corpusName = cliValueAfter("--corpus", "complex-tender-corpus");
if (
  !["complex-tender-corpus", "unstructured-tender-corpus"].includes(
    corpusName,
  )
) {
  throw new Error(`Ukjent --corpus: ${corpusName}`);
}
const fixtureRoot = path.join(
  repositoryRoot,
  "output",
  "pdf",
  corpusName,
);
const scenarioPath = path.join(
  repositoryRoot,
  "test-data",
  "complex-tender-corpus",
  "scenarios.json",
);
const defaultOutputPath = path.join(
  repositoryRoot,
  "reports",
  `${corpusName}-evaluation.json`,
);
const defaultMarkdownPath = path.join(
  repositoryRoot,
  "reports",
  `${corpusName}-evaluation.md`,
);

const MODEL = "gpt-5.6-terra";
const MAXIMUM_BUDGET_USD = 15;
const PRICING_PER_MILLION_USD = {
  input: 2.5,
  cached: 0.25,
  cacheWrite: 3.125,
  output: 15,
};

function parseArgs() {
  const budgetUsd = Number(cliValueAfter("--budget", "10"));
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > MAXIMUM_BUDGET_USD
  ) {
    throw new Error(
      `--budget må være mellom 0 og ${MAXIMUM_BUDGET_USD} USD.`,
    );
  }
  return {
    budgetUsd,
    localOnly: cliArgs.includes("--local-only"),
    reprocessExisting: cliArgs.includes("--reprocess-existing"),
    allowParserFailures: cliArgs.includes("--allow-parser-failures"),
    outputPath: path.resolve(
      cliValueAfter("--output", defaultOutputPath),
    ),
    markdownPath: path.resolve(
      cliValueAfter("--markdown", defaultMarkdownPath),
    ),
  };
}

async function loadEnvFile(filePath) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/u)) {
    const match =
      /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])([\s\S]*)\1$/u, "$2");
  }
}

function normalizeComparable(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("nb-NO")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function collectStrings(value, key = "") {
  if (typeof value === "string") {
    return key === "high_level_architecture_mermaid" ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) =>
      collectStrings(child, childKey),
    );
  }
  return [];
}

function factResult(fact, text) {
  const normalized = normalizeComparable(text);
  const groups = fact.required_term_groups.map((group) =>
    group.some((term) => normalized.includes(normalizeComparable(term))),
  );
  const matched = groups.filter(Boolean).length;
  return {
    id: fact.id,
    matchedGroups: matched,
    totalGroups: groups.length,
    status:
      matched === groups.length
        ? "present"
        : matched > 0
          ? "partial"
          : "missing",
  };
}

function scoreFacts(facts, text) {
  const details = facts.map((fact) => factResult(fact, text));
  const earned = details.reduce(
    (sum, item) =>
      sum + (item.status === "present" ? 1 : item.status === "partial" ? 0.5 : 0),
    0,
  );
  return {
    scorePercent: Number(((earned / Math.max(1, details.length)) * 100).toFixed(1)),
    present: details.filter((item) => item.status === "present").length,
    partial: details.filter((item) => item.status === "partial").length,
    missing: details.filter((item) => item.status === "missing").length,
    details,
  };
}

function automaticQuality(output, sourceText) {
  const strings = collectStrings(output);
  const prose = strings.join("\n");
  const source = normalizeComparable(sourceText);
  const implicit = Array.isArray(output.implicit_requirements)
    ? output.implicit_requirements
    : [];
  const values = Array.isArray(output.value_opportunities)
    ? output.value_opportunities
    : [];
  const groundedExcerpts = implicit.filter((item) => {
    const excerpt = normalizeComparable(item?.source_excerpt);
    return excerpt.length >= 12 && source.includes(excerpt);
  }).length;
  return {
    proseChars: prose.length,
    mojibakeCount: prose.match(/Ã[¦¸¥†˜…]|�/gu)?.length ?? 0,
    punctuationSpacingErrorCount:
      (prose.match(/\s+[,.;:!?]/gu)?.length ?? 0) +
      (prose.match(/[;!?](?=[\p{L}\p{N}])|[:,](?=\p{L})|\.(?=[\p{Lu}ÆØÅ])/gu)
        ?.length ?? 0),
    implicitRequirementCount: implicit.length,
    groundedImplicitExcerptCount: groundedExcerpts,
    valueShareTotal: values.reduce(
      (sum, item) => sum + Number(item?.profit_share_percent ?? 0),
      0,
    ),
    recommendedServiceCount: Array.isArray(output.recommended_services)
      ? output.recommended_services.length
      : 0,
  };
}

function usageCostUsd(usage = {}) {
  const input = Math.max(0, Number(usage.input_tokens ?? 0));
  const output = Math.max(0, Number(usage.output_tokens ?? 0));
  const cached = Math.max(
    0,
    Number(usage.input_tokens_details?.cached_tokens ?? 0),
  );
  const cacheWrite = Math.max(
    0,
    Number(usage.input_tokens_details?.cache_write_tokens ?? 0),
  );
  const uncached = Math.max(0, input - cached - cacheWrite);
  return (
    uncached * PRICING_PER_MILLION_USD.input +
    cached * PRICING_PER_MILLION_USD.cached +
    cacheWrite * PRICING_PER_MILLION_USD.cacheWrite +
    output * PRICING_PER_MILLION_USD.output
  ) / 1_000_000;
}

function expectedMaximumCallCostUsd(inputChars, maxOutputTokens) {
  const estimatedInputTokens = Math.ceil(inputChars / 3.2);
  return (
    estimatedInputTokens * PRICING_PER_MILLION_USD.cacheWrite +
    maxOutputTokens * PRICING_PER_MILLION_USD.output
  ) / 1_000_000;
}

function minimalProjectDocument({
  scenario,
  role,
  fileName,
  fileSize,
  fileBase64,
  parsed,
}) {
  const now = "2026-07-30T00:00:00.000Z";
  return {
    id: `${scenario.id}-${role}`,
    project_id: `complex-corpus-${scenario.id}`,
    role,
    supporting_subtype: null,
    title:
      role === "primary_customer_document"
        ? `Bilag 1 - ${scenario.customer}`
        : `Bilag 2 - ${scenario.supplier}`,
    file_name: fileName,
    file_format: "pdf",
    content_type: "application/pdf",
    file_size_bytes: fileSize,
    page_count: parsed.pageCount ?? null,
    processing_status: "enhanced_ready",
    created_at: now,
    updated_at: now,
    raw_text: parsed.rawText,
    file_base64: fileBase64,
    structure_map: parsed.sourceMap,
    chunk_source_revision: 1,
  };
}

function requirementExtractionScore(
  expected,
  ledger,
  { includeAnswers = false } = {},
) {
  const expectedIds = expected.map((item) => item.id);
  const actualIds = ledger.map((item) => item.id);
  const actualSet = new Set(actualIds.map(normalizeComparable));
  const missingIds = expectedIds.filter(
    (id) => !actualSet.has(normalizeComparable(id)),
  );
  const expectedSet = new Set(expectedIds.map(normalizeComparable));
  const unexpectedIds = actualIds.filter(
    (id) => !expectedSet.has(normalizeComparable(id)),
  );
  const matchedUniqueIds = expectedIds.length - missingIds.length;
  const precisionPercent = Number(
    ((matchedUniqueIds / Math.max(1, actualIds.length)) * 100).toFixed(1),
  );
  const recallPercent = Number(
    ((matchedUniqueIds / Math.max(1, expectedIds.length)) * 100).toFixed(1),
  );
  const precision = precisionPercent / 100;
  const recall = recallPercent / 100;
  const duplicateExpectedIds = expectedIds
    .map((id) => ({
      id,
      count: actualIds.filter(
        (actualId) =>
          normalizeComparable(actualId) === normalizeComparable(id),
      ).length,
    }))
    .filter((item) => item.count > 1);
  const answerBearingIds = new Set(
    ledger
      .filter((item) => item.answerExcerpt?.trim())
      .map((item) => normalizeComparable(item.id)),
  );
  const entriesById = new Map(
    ledger.map((entry) => [normalizeComparable(entry.id), entry]),
  );
  const contentDetails = expected.map((item) => {
    const entry = entriesById.get(normalizeComparable(item.id));
    const exactRequirementText =
      Boolean(entry) &&
      normalizeComparable(entry.text) === normalizeComparable(item.text);
    const exactAnswerText = includeAnswers
      ? Boolean(entry?.answerExcerpt) &&
        normalizeComparable(entry.answerExcerpt) ===
          normalizeComparable(item.answer)
      : null;
    return {
      id: item.id,
      exactRequirementText,
      exactAnswerText,
    };
  });
  return {
    expectedCount: expectedIds.length,
    actualCount: actualIds.length,
    exactIdRecallPercent: recallPercent,
    exactRowPrecisionPercent: precisionPercent,
    exactRowF1Percent: Number(
      (
        (precision + recall
          ? (2 * precision * recall) / (precision + recall)
          : 0) * 100
      ).toFixed(1),
    ),
    missingIds,
    unexpectedIds,
    duplicateExpectedIds,
    answerBearingExpectedIdCount: expectedIds.filter((id) =>
      answerBearingIds.has(normalizeComparable(id)),
    ).length,
    exactRequirementTextCount: contentDetails.filter(
      (item) => item.exactRequirementText,
    ).length,
    exactAnswerTextCount: includeAnswers
      ? contentDetails.filter((item) => item.exactAnswerText).length
      : null,
    requirementTextMismatchIds: contentDetails
      .filter((item) => !item.exactRequirementText)
      .map((item) => item.id),
    answerTextMismatchIds: includeAnswers
      ? contentDetails
          .filter((item) => !item.exactAnswerText)
          .map((item) => item.id)
      : [],
    actualIds,
  };
}

function significantTokens(value) {
  return normalizeComparable(value)
    .split(/[^\p{L}\p{N},.%/-]+/u)
    .filter((token) => token.length >= 3 || /\d/u.test(token));
}

function tokenRecall(expectedText, parsedText) {
  const expectedTokens = significantTokens(expectedText);
  const parsedTokens = new Set(significantTokens(parsedText));
  const matched = expectedTokens.filter((token) =>
    parsedTokens.has(token),
  ).length;
  return expectedTokens.length ? matched / expectedTokens.length : 1;
}

function fullRequirementTextScore(expected, parsedText, includeAnswers) {
  const normalized = normalizeComparable(parsedText);
  const details = expected.map((item) => {
    const requirementPresent = normalized.includes(
      normalizeComparable(item.text),
    );
    const requirementTokenRecall = tokenRecall(item.text, parsedText);
    const answerPresent = includeAnswers
      ? normalized.includes(normalizeComparable(item.answer))
      : null;
    const answerTokenRecall = includeAnswers
      ? tokenRecall(item.answer, parsedText)
      : null;
    return {
      id: item.id,
      requirementPresent,
      requirementTokenRecallPercent: Number(
        (requirementTokenRecall * 100).toFixed(1),
      ),
      answerPresent,
      answerTokenRecallPercent:
        answerTokenRecall === null
          ? null
          : Number((answerTokenRecall * 100).toFixed(1)),
    };
  });
  return {
    expectedCount: details.length,
    requirementsPresent: details.filter((item) => item.requirementPresent)
      .length,
    answersPresent: includeAnswers
      ? details.filter((item) => item.answerPresent).length
      : null,
    requirementsWithAtLeast95PercentTokenRecall: details.filter(
      (item) => item.requirementTokenRecallPercent >= 95,
    ).length,
    answersWithAtLeast95PercentTokenRecall: includeAnswers
      ? details.filter((item) => item.answerTokenRecallPercent >= 95).length
      : null,
    averageRequirementTokenRecallPercent: average(
      details.map((item) => item.requirementTokenRecallPercent),
    ),
    averageAnswerTokenRecallPercent: includeAnswers
      ? average(details.map((item) => item.answerTokenRecallPercent))
      : null,
    details,
  };
}

function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length
    ? Number(
        (
          numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        ).toFixed(2),
      )
    : null;
}

const options = parseArgs();
await Promise.all([
  mkdir(path.dirname(options.outputPath), { recursive: true }),
  mkdir(path.dirname(options.markdownPath), { recursive: true }),
  loadEnvFile(path.join(repositoryRoot, ".env")),
  loadEnvFile(path.join(frontendRoot, ".env.local")),
]);
if (
  !options.localOnly &&
  !options.reprocessExisting &&
  !process.env.OPENAI_API_KEY?.trim()
) {
  throw new Error("OPENAI_API_KEY mangler. Ingen AI-analyse ble utført.");
}
process.env.DOCUMENT_ANALYSIS_VERSION = "v3";

const source = JSON.parse(await readFile(scenarioPath, "utf8"));
if (source.scenarios?.length !== 5) {
  throw new Error("Forventet nøyaktig fem scenarioer i testkorpuset.");
}
const existingReport = options.reprocessExisting
  ? JSON.parse(await readFile(options.outputPath, "utf8"))
  : null;
if (
  options.reprocessExisting &&
  (!Array.isArray(existingReport?.scenarios) ||
    existingReport.scenarios.length !== source.scenarios.length ||
    existingReport.scenarios.some((scenario) => !scenario.ai?.output))
) {
  throw new Error(
    "--reprocess-existing krever en eksisterende rapport med AI-output for alle scenarioene.",
  );
}

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "complex-corpus-eval.cjs"), {
  fsCache: false,
  moduleCache: false,
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { extractTextFromBuffer } = jiti(
  path.join(frontendRoot, "lib", "server", "documents.ts"),
);
const { compileDocumentIntelligenceArtifact } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "evidence-compiler.ts",
  ),
);
const {
  buildCustomerAnalysisV3SystemPrompt,
  buildCustomerAnalysisV3UserPrompt,
  CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
  enrichCustomerAnalysisWithCriticalFacts,
} = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "customer-analysis-v3.ts",
  ),
);
const {
  groundImplicitRequirementExcerpts,
  normalizeCustomerAnalysisResult,
} = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "customer-analysis-postprocess.ts",
  ),
);
const { extractRequirementLedgerForDocument } = jiti(
  path.join(frontendRoot, "lib", "server", "ai.ts"),
);

let client = null;
if (!options.localOnly && !options.reprocessExisting) {
  const OpenAI = require(path.join(frontendRoot, "node_modules", "openai")).default;
  client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const spend = {
  actualUsd: options.reprocessExisting
    ? Number(existingReport?.budget?.actualUsd ?? 0)
    : 0,
  failedCallReserveUsd: options.reprocessExisting
    ? Number(existingReport?.budget?.failedCallReserveUsd ?? 0)
    : 0,
  calls: options.reprocessExisting
    ? [...(existingReport?.budget?.calls ?? [])]
    : [],
};

async function analyzeWithProductionV3({
  scenario,
  artifact,
  parsed,
  referenceText,
}) {
  const promptDocuments = [
    {
      documentId: artifact.documentId,
      title: `Bilag 1 - ${scenario.customer}`,
      role: "primary_customer_document",
      context: artifact.analysisContext,
      sourceText: parsed.rawText,
    },
  ];
  const system = buildCustomerAnalysisV3SystemPrompt();
  const user = buildCustomerAnalysisV3UserPrompt({
    projectName: scenario.project_name,
    documents: promptDocuments,
  });
  const maxOutputTokens = 8_000;
  const estimateUsd = expectedMaximumCallCostUsd(
    system.length + user.length + JSON.stringify(CUSTOMER_ANALYSIS_V3_JSON_SCHEMA).length,
    maxOutputTokens,
  );
  if (
    spend.actualUsd + spend.failedCallReserveUsd + estimateUsd >
    options.budgetUsd
  ) {
    throw new Error(
      `Budsjettvernet stoppet før ${scenario.id}: ` +
        `$${(spend.actualUsd + spend.failedCallReserveUsd + estimateUsd).toFixed(4)} ` +
        `ville overskride $${options.budgetUsd.toFixed(2)}.`,
    );
  }

  const startedAt = performance.now();
  let response;
  try {
    response = await client.responses.create({
      model: MODEL,
      store: false,
      instructions: system,
      reasoning: { effort: "low" },
      max_output_tokens: maxOutputTokens,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "complex_tender_customer_analysis",
          strict: true,
          schema: CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
        },
      },
      input: [{ role: "user", content: user }],
    });
  } catch (error) {
    spend.failedCallReserveUsd += estimateUsd;
    throw error;
  }
  if (!response.output_text?.trim()) {
    spend.failedCallReserveUsd += estimateUsd;
    throw new Error(`${scenario.id} returnerte tom AI-analyse.`);
  }
  const costUsd = usageCostUsd(response.usage);
  spend.actualUsd += costUsd;
  const call = {
    scenarioId: scenario.id,
    model: MODEL,
    latencyMs: Math.round(performance.now() - startedAt),
    inputTokens: Number(response.usage?.input_tokens ?? 0),
    cachedInputTokens: Number(
      response.usage?.input_tokens_details?.cached_tokens ?? 0,
    ),
    outputTokens: Number(response.usage?.output_tokens ?? 0),
    costUsd: Number(costUsd.toFixed(6)),
  };
  spend.calls.push(call);
  console.log(
    JSON.stringify({
      event: "complex_tender_analysis_complete",
      ...call,
      cumulativeCostUsd: Number(spend.actualUsd.toFixed(6)),
    }),
  );
  const generated = JSON.parse(response.output_text);
  return {
    output: normalizeCustomerAnalysisResult(
      enrichCustomerAnalysisWithCriticalFacts(generated, promptDocuments),
      {
        signalSourceText: referenceText,
        serviceCandidates: [],
        sourceDocuments: [
          {
            title: `Bilag 1 - ${scenario.customer}`,
            rawText: referenceText,
            structureMap: parsed.sourceMap,
          },
        ],
      },
    ),
    call,
    promptChars: system.length + user.length,
  };
}

const results = [];
for (const scenario of source.scenarios) {
  const bilag1Path = path.join(fixtureRoot, `${scenario.id}_bilag1.pdf`);
  const bilag2Path = path.join(fixtureRoot, `${scenario.id}_bilag2.pdf`);
  const referencePath = path.join(fixtureRoot, `${scenario.id}_bilag1.txt`);
  const [bilag1Buffer, bilag2Buffer, referenceText] = await Promise.all([
    readFile(bilag1Path),
    readFile(bilag2Path),
    readFile(referencePath, "utf8"),
  ]);
  const parseStartedAt = performance.now();
  const [bilag1Parsed, bilag2Parsed] = await Promise.all([
    extractTextFromBuffer({
      buffer: bilag1Buffer,
      fileName: path.basename(bilag1Path),
      contentType: "application/pdf",
      role: "primary_customer_document",
      useDocling: false,
    }),
    extractTextFromBuffer({
      buffer: bilag2Buffer,
      fileName: path.basename(bilag2Path),
      contentType: "application/pdf",
      role: "primary_solution_document",
      useDocling: false,
    }),
  ]);
  const parseLatencyMs = Math.round(performance.now() - parseStartedAt);
  const bilag1Document = minimalProjectDocument({
    scenario,
    role: "primary_customer_document",
    fileName: path.basename(bilag1Path),
    fileSize: bilag1Buffer.length,
    fileBase64: bilag1Buffer.toString("base64"),
    parsed: bilag1Parsed,
  });
  const bilag2Document = minimalProjectDocument({
    scenario,
    role: "primary_solution_document",
    fileName: path.basename(bilag2Path),
    fileSize: bilag2Buffer.length,
    fileBase64: bilag2Buffer.toString("base64"),
    parsed: bilag2Parsed,
  });
  const [bilag1Ledger, bilag2Ledger] = await Promise.all([
    extractRequirementLedgerForDocument(bilag1Document),
    extractRequirementLedgerForDocument(bilag2Document),
  ]);
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: bilag1Document.id,
    projectId: bilag1Document.project_id,
    title: bilag1Document.title,
    fileName: bilag1Document.file_name,
    fileFormat: "pdf",
    fileSizeBytes: bilag1Buffer.length,
    sourceRevision: 1,
    parserUsed: bilag1Parsed.parserUsed,
    rawText: bilag1Parsed.rawText,
    structureMap: bilag1Parsed.sourceMap,
    isHighImpactDocument: true,
    compiledAt: "2026-07-30T00:00:00.000Z",
  });

  const local = {
    parseLatencyMs,
    customerParser: bilag1Parsed.parserUsed,
    solutionParser: bilag2Parsed.parserUsed,
    customerChars: bilag1Parsed.rawText.length,
    solutionChars: bilag2Parsed.rawText.length,
    customerFactSourceCoverage: scoreFacts(
      scenario.answer_key.must_cover,
      bilag1Parsed.rawText,
    ),
    customerRequirementExtraction: requirementExtractionScore(
      scenario.requirements,
      bilag1Ledger,
    ),
    solutionRequirementExtraction: requirementExtractionScore(
      scenario.requirements,
      bilag2Ledger,
      { includeAnswers: true },
    ),
    customerTextFidelity: fullRequirementTextScore(
      scenario.requirements,
      bilag1Parsed.rawText,
      false,
    ),
    solutionTextFidelity: fullRequirementTextScore(
      scenario.requirements,
      bilag2Parsed.rawText,
      true,
    ),
    evidenceCount: artifact.evidence.length,
    languageQuality: artifact.languageQuality,
  };

  let ai = null;
  if (options.reprocessExisting) {
    const previousScenario = existingReport.scenarios.find(
      (item) => item.scenarioId === scenario.id,
    );
    const promptDocuments = [
      {
        documentId: artifact.documentId,
        title: `Bilag 1 - ${scenario.customer}`,
        role: "primary_customer_document",
        context: artifact.analysisContext,
        sourceText: bilag1Parsed.rawText,
      },
    ];
    const normalizedOutput = normalizeCustomerAnalysisResult(
      enrichCustomerAnalysisWithCriticalFacts(
        previousScenario.ai.output,
        promptDocuments,
      ),
      {
        signalSourceText: referenceText,
        serviceCandidates: [],
        sourceDocuments: [
          {
            title: `Bilag 1 - ${scenario.customer}`,
            rawText: referenceText,
            structureMap: bilag1Parsed.sourceMap,
          },
        ],
      },
    );
    const sourceDocuments = [
      {
        title: `Bilag 1 - ${scenario.customer}`,
        rawText: referenceText,
        structureMap: bilag1Parsed.sourceMap,
      },
    ];
    const output = {
      ...normalizedOutput,
      implicit_requirements: groundImplicitRequirementExcerpts({
        requirements: normalizedOutput.implicit_requirements,
        sourceDocuments,
      }),
    };
    const searchableOutput = collectStrings(output).join("\n");
    ai = {
      ...previousScenario.ai,
      reprocessedWithCurrentProductionPostprocessing: true,
      answerKeyScore: scoreFacts(
        scenario.answer_key.must_cover,
        searchableOutput,
      ),
      automaticQuality: automaticQuality(output, bilag1Parsed.rawText),
      output,
    };
  } else if (!options.localOnly) {
    const generated = await analyzeWithProductionV3({
      scenario,
      artifact,
      parsed: bilag1Parsed,
      referenceText,
    });
    const searchableOutput = collectStrings(generated.output).join("\n");
    ai = {
      model: MODEL,
      promptChars: generated.promptChars,
      call: generated.call,
      answerKeyScore: scoreFacts(
        scenario.answer_key.must_cover,
        searchableOutput,
      ),
      automaticQuality: automaticQuality(
        generated.output,
        bilag1Parsed.rawText,
      ),
      output: generated.output,
    };
  }

  results.push({
    scenarioId: scenario.id,
    projectName: scenario.project_name,
    expectedRequirementCount: scenario.requirements.length,
    local,
    ai,
  });
}

const aggregate = {
  scenarioCount: results.length,
  local: {
    averageCustomerFactSourceCoveragePercent: average(
      results.map(
        (item) => item.local.customerFactSourceCoverage.scorePercent,
      ),
    ),
    averageCustomerRequirementIdRecallPercent: average(
      results.map(
        (item) =>
          item.local.customerRequirementExtraction.exactIdRecallPercent,
      ),
    ),
    averageCustomerRequirementRowPrecisionPercent: average(
      results.map(
        (item) =>
          item.local.customerRequirementExtraction.exactRowPrecisionPercent,
      ),
    ),
    averageSolutionRequirementIdRecallPercent: average(
      results.map(
        (item) =>
          item.local.solutionRequirementExtraction.exactIdRecallPercent,
      ),
    ),
    averageSolutionRequirementRowPrecisionPercent: average(
      results.map(
        (item) =>
          item.local.solutionRequirementExtraction.exactRowPrecisionPercent,
      ),
    ),
    fullCustomerRequirementTextDocuments: results.filter(
      (item) =>
        item.local.customerTextFidelity.requirementsPresent ===
        item.expectedRequirementCount,
    ).length,
    fullSolutionRequirementAndAnswerTextDocuments: results.filter(
      (item) =>
        item.local.solutionTextFidelity
          .requirementsWithAtLeast95PercentTokenRecall ===
          item.expectedRequirementCount &&
        item.local.solutionTextFidelity.answersWithAtLeast95PercentTokenRecall ===
          item.expectedRequirementCount,
    ).length,
    exactCustomerLedgerDocuments: results.filter(
      (item) =>
        item.local.customerRequirementExtraction.exactRequirementTextCount ===
        item.expectedRequirementCount,
    ).length,
    exactSolutionLedgerDocuments: results.filter(
      (item) =>
        item.local.solutionRequirementExtraction.exactRequirementTextCount ===
          item.expectedRequirementCount &&
        item.local.solutionRequirementExtraction.exactAnswerTextCount ===
          item.expectedRequirementCount,
    ).length,
    totalExpectedRequirements: results.reduce(
      (sum, item) => sum + item.expectedRequirementCount,
      0,
    ),
    totalCustomerLedgerRows: results.reduce(
      (sum, item) =>
        sum + item.local.customerRequirementExtraction.actualCount,
      0,
    ),
    totalSolutionLedgerRows: results.reduce(
      (sum, item) =>
        sum + item.local.solutionRequirementExtraction.actualCount,
      0,
    ),
    totalBoundSolutionAnswers: results.reduce(
      (sum, item) =>
        sum +
        item.local.solutionRequirementExtraction
          .answerBearingExpectedIdCount,
      0,
    ),
    totalUnexpectedIds: results.reduce(
      (sum, item) =>
        sum +
        item.local.customerRequirementExtraction.unexpectedIds.length +
        item.local.solutionRequirementExtraction.unexpectedIds.length,
      0,
    ),
    totalDuplicateExpectedIds: results.reduce(
      (sum, item) =>
        sum +
        item.local.customerRequirementExtraction.duplicateExpectedIds.length +
        item.local.solutionRequirementExtraction.duplicateExpectedIds.length,
      0,
    ),
    totalRequirementTextMismatches: results.reduce(
      (sum, item) =>
        sum +
        item.local.customerRequirementExtraction.requirementTextMismatchIds
          .length +
        item.local.solutionRequirementExtraction.requirementTextMismatchIds
          .length,
      0,
    ),
    totalAnswerTextMismatches: results.reduce(
      (sum, item) =>
        sum +
        item.local.solutionRequirementExtraction.answerTextMismatchIds.length,
      0,
    ),
  },
    ai: options.localOnly
    ? null
    : {
        model: MODEL,
        averageAnswerKeyScorePercent: average(
          results.map((item) => item.ai?.answerKeyScore.scorePercent),
        ),
        fullAnswerKeyDocuments: results.filter(
          (item) => item.ai?.answerKeyScore.scorePercent === 100,
        ).length,
        mojibakeCount: results.reduce(
          (sum, item) => sum + (item.ai?.automaticQuality.mojibakeCount ?? 0),
          0,
        ),
        punctuationSpacingErrorCount: results.reduce(
          (sum, item) =>
            sum +
            (item.ai?.automaticQuality.punctuationSpacingErrorCount ?? 0),
          0,
        ),
        valueShareValidDocuments: results.filter(
          (item) => item.ai?.automaticQuality.valueShareTotal === 100,
        ).length,
        unexpectedServiceDocuments: results.filter(
          (item) =>
            (item.ai?.automaticQuality.recommendedServiceCount ?? 0) > 0,
        ).length,
      },
};

const report = {
  generatedAt: new Date().toISOString(),
  method: {
    corpus: corpusName,
    parser: "production extractTextFromBuffer with useDocling=false",
    requirementLedger: "production extractRequirementLedgerForDocument",
    aiPipeline: options.localOnly
      ? null
      : options.reprocessExisting
        ? "existing document-analysis.v3 AI output with current production postprocessing"
        : "document-analysis.v3 production prompt, schema and postprocessing",
    model: options.localOnly ? null : MODEL,
    responseApi: !options.localOnly && !options.reprocessExisting,
    reprocessedExistingAiOutput: options.reprocessExisting,
    store: false,
  },
  budget: {
    maximumUsd: options.localOnly
      ? 0
      : options.reprocessExisting
        ? Number(existingReport?.budget?.maximumUsd ?? options.budgetUsd)
        : options.budgetUsd,
    actualUsd: Number(spend.actualUsd.toFixed(6)),
    failedCallReserveUsd: Number(spend.failedCallReserveUsd.toFixed(6)),
    calls: spend.calls,
  },
  aggregate,
  scenarios: results,
};

const parserFailures = results.flatMap((item) => {
  const customer = item.local.customerRequirementExtraction;
  const solution = item.local.solutionRequirementExtraction;
  const failures = [];
  if (
    customer.exactRowPrecisionPercent < 99 ||
    customer.exactIdRecallPercent !== 100 ||
    customer.exactRequirementTextCount !== item.expectedRequirementCount ||
    customer.unexpectedIds.length ||
    customer.duplicateExpectedIds.length
  ) {
    failures.push(`${item.scenarioId}: Bilag 1`);
  }
  if (
    solution.exactRowPrecisionPercent < 99 ||
    solution.exactIdRecallPercent !== 100 ||
    solution.answerBearingExpectedIdCount !== item.expectedRequirementCount ||
    solution.exactRequirementTextCount !== item.expectedRequirementCount ||
    solution.exactAnswerTextCount !== item.expectedRequirementCount ||
    solution.unexpectedIds.length ||
    solution.duplicateExpectedIds.length
  ) {
    failures.push(`${item.scenarioId}: Bilag 2`);
  }
  return failures;
});
if (parserFailures.length && !options.allowParserFailures) {
  throw new Error(
    `Kravparser-gaten feilet for ${parserFailures.join(", ")}. ` +
      "Krever minst 99 % radpresisjon, 100 % ID-recall, eksakt kravtekst, " +
      "eksakt Bilag 2-svarbinding og ingen duplikater eller falske ID-er.",
  );
}

const scenarioRows = results
  .map(
    (item) =>
      `| ${item.projectName} | ${item.local.customerFactSourceCoverage.scorePercent} | ` +
      `${item.local.customerRequirementExtraction.exactIdRecallPercent} | ` +
      `${item.local.customerRequirementExtraction.exactRowPrecisionPercent} | ` +
      `${item.local.solutionRequirementExtraction.exactRowPrecisionPercent} | ` +
      `${item.ai?.answerKeyScore.scorePercent ?? "ikke kjørt"} |`,
  )
  .join("\n");
const missingDetails = results
  .map((item) => {
    const missingCustomerIds =
      item.local.customerRequirementExtraction.missingIds.join(", ") || "ingen";
    const missingSolutionIds =
      item.local.solutionRequirementExtraction.missingIds.join(", ") || "ingen";
    const missingFacts =
      item.ai?.answerKeyScore.details
        .filter((fact) => fact.status !== "present")
        .map((fact) => `${fact.id} (${fact.status})`)
        .join(", ") || "ingen";
    const duplicateCustomerIds =
      item.local.customerRequirementExtraction.duplicateExpectedIds
        .map((entry) => `${entry.id} x${entry.count}`)
        .join(", ") || "ingen";
    const duplicateSolutionIds =
      item.local.solutionRequirementExtraction.duplicateExpectedIds
        .map((entry) => `${entry.id} x${entry.count}`)
        .join(", ") || "ingen";
    const unexpectedCustomerIds =
      item.local.customerRequirementExtraction.unexpectedIds.join(", ") ||
      "ingen";
    const unexpectedSolutionIds =
      item.local.solutionRequirementExtraction.unexpectedIds.join(", ") ||
      "ingen";
    const requirementTextMismatches = [
      ...item.local.customerRequirementExtraction.requirementTextMismatchIds,
      ...item.local.solutionRequirementExtraction.requirementTextMismatchIds,
    ].join(", ") || "ingen";
    const answerTextMismatches =
      item.local.solutionRequirementExtraction.answerTextMismatchIds.join(
        ", ",
      ) || "ingen";
    const aiFactStatus = item.ai
      ? `- Manglende eller delvise fasitfakta i AI-analysen: ${missingFacts}`
      : "- AI-analyse: ikke kjørt i lokal parsermodus";
    return `### ${item.projectName}

- Manglende krav-ID-er i lokal Bilag 1-parser: ${missingCustomerIds}
- Manglende krav-ID-er i lokal Bilag 2-parser: ${missingSolutionIds}
- Uventede krav-ID-er i Bilag 1-ledger: ${unexpectedCustomerIds}
- Uventede krav-ID-er i Bilag 2-ledger: ${unexpectedSolutionIds}
- Dupliserte forventede ID-er i Bilag 1-ledger: ${duplicateCustomerIds}
- Dupliserte forventede ID-er i Bilag 2-ledger: ${duplicateSolutionIds}
- Avvik i eksakt kravtekst: ${requirementTextMismatches}
- Avvik i eksakt Bilag 2-svarbinding: ${answerTextMismatches}
${aiFactStatus}
`;
  })
  .join("\n");
const methodDescription = options.localOnly
  ? "produksjonsparser uten Docling, produksjonens kravledger og deterministisk sammenligning mot scenariofasit. AI-analyse ble ikke kjørt i denne parserregresjonen."
  : options.reprocessExisting
    ? "produksjonsparser uten Docling og eksisterende GPT-5.6 Terra-output, behandlet på nytt med gjeldende produksjons-postprosessering og sammenlignet deterministisk mot scenariofasit."
    : "produksjonsparser uten Docling, produksjonens document-analysis.v3-prompt, strengt JSON-skjema, GPT-5.6 Terra, `store: false` og deterministisk sammenligning mot scenariofasit.";
const markdown = `# Evaluering av ${corpusName}

Generert: ${report.generatedAt}

Metode: ${methodDescription}

AI-kostnad: **$${report.budget.actualUsd.toFixed(4)} / $${report.budget.maximumUsd.toFixed(2)}**
fordelt på ${report.budget.calls.length} kall.

| Scenario | Lokal fakta-dekning % | Bilag 1 ID recall % | Bilag 1 radpresisjon % | Bilag 2 radpresisjon % | AI mot fasit % |
|---|---:|---:|---:|---:|---:|
${scenarioRows}

## Aggregat

- Lokal fakta-dekning: ${aggregate.local.averageCustomerFactSourceCoveragePercent} prosent.
- Lokal Bilag 1 krav-ID recall: ${aggregate.local.averageCustomerRequirementIdRecallPercent} prosent.
- Lokal Bilag 1 kravradpresisjon: ${aggregate.local.averageCustomerRequirementRowPrecisionPercent} prosent.
- Lokal Bilag 2 krav-ID recall: ${aggregate.local.averageSolutionRequirementIdRecallPercent} prosent.
- Lokal Bilag 2 kravradpresisjon: ${aggregate.local.averageSolutionRequirementRowPrecisionPercent} prosent.
- Full kravtekst i Bilag 1: ${aggregate.local.fullCustomerRequirementTextDocuments} av 5 dokumenter.
- Full kravtekst og alle svar i Bilag 2: ${aggregate.local.fullSolutionRequirementAndAnswerTextDocuments} av 5 dokumenter.
- Eksakte Bilag 1-ledgerrader: ${aggregate.local.totalCustomerLedgerRows} av ${aggregate.local.totalExpectedRequirements}.
- Eksakte Bilag 2-ledgerrader: ${aggregate.local.totalSolutionLedgerRows} av ${aggregate.local.totalExpectedRequirements}.
- Bilag 2-svar bundet til forventet krav-ID: ${aggregate.local.totalBoundSolutionAnswers} av ${aggregate.local.totalExpectedRequirements}.
- Uventede krav-ID-er: ${aggregate.local.totalUnexpectedIds}.
- Dupliserte forventede krav-ID-er: ${aggregate.local.totalDuplicateExpectedIds}.
- Kravtekst-avvik: ${aggregate.local.totalRequirementTextMismatches}.
- Svartekst-avvik: ${aggregate.local.totalAnswerTextMismatches}.
- AI-analyse mot fasit: ${aggregate.ai?.averageAnswerKeyScorePercent ?? "ikke kjørt"} prosent i snitt.
- AI-analyser med 100 prosent fasitdekning: ${aggregate.ai?.fullAnswerKeyDocuments ?? "ikke kjørt"} av 5.
- Mojibake: ${aggregate.ai?.mojibakeCount ?? "ikke kjørt"}.
- Tegnsettingsavvik: ${aggregate.ai?.punctuationSpacingErrorCount ?? "ikke kjørt"}.

## Avvik per scenario

${missingDetails}
`;

await Promise.all([
  writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(options.markdownPath, markdown, "utf8"),
]);

console.log(
  JSON.stringify({
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
    aggregate,
    actualCostUsd: report.budget.actualUsd,
  }),
);
