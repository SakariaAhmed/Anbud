#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const frontendRoot = path.join(repositoryRoot, "apps", "frontend");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const OpenAI = require(path.join(frontendRoot, "node_modules", "openai")).default;

const ABSOLUTE_BUDGET_CAP_USD = 15;
const DEFAULT_BUDGET_USD = 15;
const DEFAULT_OUTPUT_PATH = path.join(
  repositoryRoot,
  "reports",
  "document-analysis-v3-eval.json",
);
const DEFAULT_MARKDOWN_PATH = path.join(
  repositoryRoot,
  "reports",
  "document-analysis-v3-eval.md",
);
const DEFAULT_FIXTURE_ROOT = path.join(repositoryRoot, "test-data", "tenders");
const DEFAULT_DOCUMENTS = [
  "tender_city_smart_mobility_data_platform",
  "tender_helio_erp_finops_managed_services",
  "tender_nordic_hybrid_cloud_2026",
];
const PRICES_PER_MILLION_USD = {
  "gpt-5.4": { input: 2.5, cached: 0.25, cacheWrite: 2.5, output: 15 },
  "gpt-5.6-terra": {
    input: 2.5,
    cached: 0.25,
    cacheWrite: 3.125,
    output: 15,
  },
  "gpt-5.6-sol": { input: 5, cached: 0.5, cacheWrite: 6.25, output: 30 },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const budgetUsd = Number(valueAfter("--budget", String(DEFAULT_BUDGET_USD)));
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > ABSOLUTE_BUDGET_CAP_USD
  ) {
    throw new Error(`--budget må være mellom 0 og ${ABSOLUTE_BUDGET_CAP_USD} USD.`);
  }
  return {
    budgetUsd,
    outputPath: path.resolve(valueAfter("--output", DEFAULT_OUTPUT_PATH)),
    markdownPath: path.resolve(
      valueAfter("--markdown", DEFAULT_MARKDOWN_PATH),
    ),
    fixtureRoot: path.resolve(
      valueAfter("--fixture-root", DEFAULT_FIXTURE_ROOT),
    ),
    documents: valueAfter("--documents", DEFAULT_DOCUMENTS.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    skipJudge: args.includes("--skip-judge"),
  };
}

async function loadEnvFile(filePath) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(['"])([\s\S]*)\1$/u, "$2");
    process.env[match[1]] = value;
  }
}

function estimateTokens(value) {
  return Math.ceil(String(value ?? "").length / 3.2);
}

function priceForModel(model) {
  const price = PRICES_PER_MILLION_USD[model];
  if (!price) throw new Error(`Mangler prisdefinisjon for ${model}.`);
  return price;
}

function usageCostUsd(model, usage = {}) {
  const price = priceForModel(model);
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
    uncached * price.input +
    cached * price.cached +
    cacheWrite * price.cacheWrite +
    output * price.output
  ) / 1_000_000;
}

function estimatedCallCostUsd({ model, system, user, schema, maxOutputTokens }) {
  const price = priceForModel(model);
  const inputTokens = estimateTokens(
    `${system}\n${user}\n${JSON.stringify(schema)}`,
  );
  return (
    inputTokens * Math.max(price.input, price.cacheWrite) +
    maxOutputTokens * price.output
  ) / 1_000_000;
}

function usageSummary(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: Number(
      usage.input_tokens_details?.cached_tokens ?? 0,
    ),
    cacheWriteTokens: Number(
      usage.input_tokens_details?.cache_write_tokens ?? 0,
    ),
    outputTokens: Number(usage.output_tokens ?? 0),
    reasoningTokens: Number(
      usage.output_tokens_details?.reasoning_tokens ?? 0,
    ),
    totalTokens: Number(usage.total_tokens ?? 0),
  };
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

function normalizeComparable(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("nb-NO")
    .replace(/\s+/gu, " ")
    .trim();
}

function automaticQuality(output, sourceText) {
  const prose = collectStrings(output).join("\n");
  const normalizedSource = normalizeComparable(sourceText);
  const implicit = Array.isArray(output.implicit_requirements)
    ? output.implicit_requirements
    : [];
  const groundedExcerpts = implicit.filter((item) => {
    const excerpt = normalizeComparable(item?.source_excerpt);
    return excerpt.length >= 12 && normalizedSource.includes(excerpt);
  }).length;
  const values = Array.isArray(output.value_opportunities)
    ? output.value_opportunities
    : [];
  return {
    proseChars: prose.length,
    mojibakeCount: prose.match(/Ã[¦¸¥†˜…]|�/gu)?.length ?? 0,
    spaceBeforePunctuationCount: prose.match(/\s+[,.;:!?]/gu)?.length ?? 0,
    missingSpaceAfterPunctuationCount:
      prose.match(
        /[;!?](?=[\p{L}\p{N}])|[:,](?=\p{L})|\.(?=[\p{Lu}ÆØÅ])/gu,
      )?.length ?? 0,
    implicitRequirementCount: implicit.length,
    groundedImplicitExcerptCount: groundedExcerpts,
    valueShareTotal: values.reduce(
      (sum, item) => sum + Number(item?.profit_share_percent ?? 0),
      0,
    ),
    flatValueShare:
      values.length > 1 &&
      new Set(values.map((item) => Number(item?.profit_share_percent ?? 0)))
        .size === 1,
    recommendedServiceCount: Array.isArray(output.recommended_services)
      ? output.recommended_services.length
      : 0,
  };
}

function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length
    ? Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(3))
    : null;
}

const options = parseArgs();
await Promise.all([
  mkdir(path.dirname(options.outputPath), { recursive: true }),
  mkdir(path.dirname(options.markdownPath), { recursive: true }),
]);
await Promise.all([
  loadEnvFile(path.join(repositoryRoot, ".env")),
  loadEnvFile(path.join(frontendRoot, ".env.local")),
]);
if (!process.env.OPENAI_API_KEY?.trim()) {
  throw new Error("OPENAI_API_KEY mangler. Ingen API-kall ble utført.");
}
process.env.DOCUMENT_ANALYSIS_VERSION = "v3";

const jiti = createJiti(path.join(frontendRoot, "document-analysis-v3-eval.cjs"), {
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
  buildCustomerAnalysisCriticalFactChecklist,
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
const { normalizeCustomerAnalysisResult } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "customer-analysis-postprocess.ts",
  ),
);
const { buildCustomerAnalysisPrompt } = jiti(
  path.join(frontendRoot, "lib", "server", "prompts.ts"),
);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const spend = { actualUsd: 0, failedCallReserveUsd: 0, calls: [] };

async function structuredCall(input) {
  const estimateUsd = estimatedCallCostUsd(input);
  if (
    spend.actualUsd + spend.failedCallReserveUsd + estimateUsd >
    options.budgetUsd
  ) {
    throw new Error(
      `Budsjettvernet stoppet før ${input.label}: ` +
        `$${(spend.actualUsd + spend.failedCallReserveUsd + estimateUsd).toFixed(4)} ` +
        `ville overskride $${options.budgetUsd.toFixed(2)}.`,
    );
  }
  const startedAt = performance.now();
  let response;
  try {
    response = await client.responses.create({
      model: input.model,
      store: false,
      instructions: input.system,
      reasoning: { effort: "low" },
      max_output_tokens: input.maxOutputTokens,
        text: {
          verbosity: input.verbosity ?? "medium",
        format: {
          type: "json_schema",
          name: input.schemaName,
          strict: true,
          schema: input.schema,
        },
      },
      input: [{ role: "user", content: input.user }],
    });
  } catch (error) {
    spend.failedCallReserveUsd += estimateUsd;
    throw error;
  }
  const outputText = response.output_text?.trim();
  if (!outputText) {
    spend.failedCallReserveUsd += estimateUsd;
    throw new Error(`${input.label} returnerte tomt svar.`);
  }
  const costUsd = usageCostUsd(input.model, response.usage);
  spend.actualUsd += costUsd;
  const call = {
    label: input.label,
    model: input.model,
    latencyMs: Math.round(performance.now() - startedAt),
    estimatedMaximumCostUsd: Number(estimateUsd.toFixed(6)),
    actualCostUsd: Number(costUsd.toFixed(6)),
    usage: usageSummary(response.usage),
  };
  spend.calls.push(call);
  console.log(
    JSON.stringify({
      event: "evaluation_call_complete",
      ...call,
      cumulativeCostUsd: Number(spend.actualUsd.toFixed(6)),
      budgetUsd: options.budgetUsd,
    }),
  );
  return { output: JSON.parse(outputText), call };
}

const candidateDefinitions = [
  {
    id: "baseline",
    label: "GPT-5.4 + legacy prompt/context",
    model: "gpt-5.4",
    mode: "legacy",
  },
  {
    id: "model_only",
    label: "GPT-5.6 Terra + legacy prompt/context",
    model: "gpt-5.6-terra",
    mode: "legacy",
  },
  {
    id: "candidate_v3",
    label: "GPT-5.6 Terra + v3 prompt/context",
    model: "gpt-5.6-terra",
    mode: "v3",
  },
];

const documentResults = [];
for (const [documentIndex, baseName] of options.documents.entries()) {
  const pdfPath = path.join(options.fixtureRoot, `${baseName}.pdf`);
  const referencePath = path.join(options.fixtureRoot, `${baseName}.txt`);
  const [buffer, referenceText] = await Promise.all([
    readFile(pdfPath),
    readFile(referencePath, "utf8"),
  ]);
  const parseStartedAt = performance.now();
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName: path.basename(pdfPath),
    contentType: "application/pdf",
    role: "primary_customer_document",
    useDocling: false,
  });
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: `eval-document-${documentIndex + 1}`,
    projectId: "eval-project",
    title: baseName,
    fileName: path.basename(pdfPath),
    fileFormat: "pdf",
    fileSizeBytes: buffer.length,
    sourceRevision: 1,
    parserUsed: parsed.parserUsed,
    rawText: parsed.rawText,
    structureMap: parsed.sourceMap,
    isHighImpactDocument: true,
    compiledAt: "2026-07-23T00:00:00.000Z",
  });
  const parseLatencyMs = Math.round(performance.now() - parseStartedAt);
  const legacySystem = buildCustomerAnalysisPrompt();
  const legacyUser = [
    `Prosjekt: ${baseName}`,
    "Analyser kilden. Returner bare JSON etter kontrakten.",
    "BEGIN_SOURCE_DOCUMENT",
    parsed.rawText.slice(0, 24_000),
    "END_SOURCE_DOCUMENT",
    "Ingen tjenestekandidater er oppgitt; recommended_services skal være [].",
  ].join("\n\n");
  const v3System = buildCustomerAnalysisV3SystemPrompt();
  const v3Documents = [
    {
      documentId: artifact.documentId,
      title: baseName,
      role: "primary_customer_document",
      context: artifact.analysisContext,
      sourceText: parsed.rawText,
    },
  ];
  const criticalFacts =
    buildCustomerAnalysisCriticalFactChecklist(v3Documents);
  const v3User = buildCustomerAnalysisV3UserPrompt({
    projectName: baseName,
    documents: v3Documents,
  });
  const candidates = [];
  for (const candidate of candidateDefinitions) {
    const system = candidate.mode === "v3" ? v3System : legacySystem;
    const user = candidate.mode === "v3" ? v3User : legacyUser;
    const generated = await structuredCall({
      label: `${baseName}:${candidate.id}`,
      model: candidate.model,
      system,
      user,
      schema: CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
      schemaName: "customer_analysis_eval",
      maxOutputTokens: 8_000,
      verbosity: candidate.mode === "v3" ? "low" : "medium",
    });
    const normalizedOutput = normalizeCustomerAnalysisResult(
      candidate.mode === "v3"
        ? enrichCustomerAnalysisWithCriticalFacts(
            generated.output,
            v3Documents,
          )
        : generated.output,
      {
        signalSourceText: referenceText,
        serviceCandidates: [],
        sourceDocuments: [
          {
            title: baseName,
            rawText: referenceText,
            structureMap: parsed.sourceMap,
          },
        ],
      },
    );
    candidates.push({
      id: candidate.id,
      label: candidate.label,
      model: candidate.model,
      contextChars: user.length,
      systemChars: system.length,
      output: normalizedOutput,
      automatic: automaticQuality(normalizedOutput, referenceText),
      call: generated.call,
    });
  }

  let judge = null;
  if (!options.skipJudge) {
    const rotations = [
      [0, 2, 1],
      [1, 0, 2],
      [2, 1, 0],
    ];
    const ordered = rotations[documentIndex % rotations.length].map(
      (index) => candidates[index],
    );
    const aliases = ordered.map((candidate, index) => ({
      alias: `Kandidat_${String.fromCharCode(65 + index)}`,
      candidate,
    }));
    const aliasNames = aliases.map((item) => item.alias);
    const judgeSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        scores: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              candidate_id: { enum: aliasNames },
              grammar: { type: "integer", minimum: 1, maximum: 10 },
              punctuation: { type: "integer", minimum: 1, maximum: 10 },
              sentence_structure: { type: "integer", minimum: 1, maximum: 10 },
              notation: { type: "integer", minimum: 1, maximum: 10 },
              groundedness: { type: "integer", minimum: 1, maximum: 10 },
              completeness: { type: "integer", minimum: 1, maximum: 10 },
              specificity: { type: "integer", minimum: 1, maximum: 10 },
              readability: { type: "integer", minimum: 1, maximum: 10 },
              traceability: { type: "integer", minimum: 1, maximum: 10 },
              critical_errors: {
                type: "array",
                items: { type: "string" },
                maxItems: 5,
              },
            },
            required: [
              "candidate_id",
              "grammar",
              "punctuation",
              "sentence_structure",
              "notation",
              "groundedness",
              "completeness",
              "specificity",
              "readability",
              "traceability",
              "critical_errors",
            ],
          },
        },
        ranking: {
          type: "array",
          items: { enum: aliasNames },
          minItems: 3,
          maxItems: 3,
        },
        rationale: { type: "string" },
      },
      required: ["scores", "ranking", "rationale"],
    };
    const judgeUser = [
      "Vurder tre anonymiserte kundeanalyser mot kilden.",
      "Skår hver dimensjon 1–10. Vekt dokumenttrohet og konkrete beslutningsfunn høyere enn lengde.",
      "For norsk språk: kontroller grammatikk, tegnsetting, setningsstruktur og faglig notasjon eksplisitt.",
      "Trekk hardt for oppdiktede fakta, tjenester, tall eller referanser.",
      "Kildehenvisninger i KANONISK PDF-KONTEKST er gyldige selv om den rene referanseteksten nedenfor ikke viser sidetall.",
      "profit_share_percent er et pålagt internt analyseestimat som skal summere til 100. Ikke trekk bare fordi kunden ikke oppgir disse prosentene; vurder om den relative vektingen er faglig rimelig.",
      `REN REFERANSETEKST\n${referenceText}`,
      `KANONISK PDF-KONTEKST MED REFERANSER\n${artifact.analysisContext}`,
      ...aliases.map(
        ({ alias, candidate }) =>
          `${alias}\n${JSON.stringify(candidate.output)}`,
      ),
    ].join("\n\n");
    const judged = await structuredCall({
      label: `${baseName}:judge`,
      model: "gpt-5.6-sol",
      system:
        "Du er en streng, språkbevisst norsk anskaffelsesredaktør og uavhengig evalueringsdommer. Kandidatrekkefølgen er tilfeldig. Returner bare skjemaet.",
      user: judgeUser,
      schema: judgeSchema,
      schemaName: "document_analysis_judge",
      maxOutputTokens: 4_000,
    });
    const aliasToId = new Map(
      aliases.map(({ alias, candidate }) => [alias, candidate.id]),
    );
    judge = {
      scores: judged.output.scores.map((score) => ({
        ...score,
        candidateId: aliasToId.get(score.candidate_id),
      })),
      ranking: judged.output.ranking.map((alias) => aliasToId.get(alias)),
      rationale: judged.output.rationale,
      call: judged.call,
    };
  }

  documentResults.push({
    document: baseName,
    parser: parsed.parserUsed,
    parseLatencyMs,
    evidenceCount: artifact.evidence.length,
    languageQuality: artifact.languageQuality,
    criticalFacts,
    candidates,
    judge,
  });
}

const dimensions = [
  "grammar",
  "punctuation",
  "sentence_structure",
  "notation",
  "groundedness",
  "completeness",
  "specificity",
  "readability",
  "traceability",
];
const aggregate = Object.fromEntries(
  candidateDefinitions.map((candidate) => {
    const rows = documentResults.map((document) =>
      document.candidates.find((item) => item.id === candidate.id),
    );
    const judgeRows = documentResults.flatMap(
      (document) =>
        document.judge?.scores.filter(
          (score) => score.candidateId === candidate.id,
        ) ?? [],
    );
    return [
      candidate.id,
      {
        label: candidate.label,
        model: candidate.model,
        averageLatencyMs: average(rows.map((row) => row.call.latencyMs)),
        averageContextChars: average(rows.map((row) => row.contextChars)),
        inputTokens: rows.reduce(
          (sum, row) => sum + row.call.usage.inputTokens,
          0,
        ),
        outputTokens: rows.reduce(
          (sum, row) => sum + row.call.usage.outputTokens,
          0,
        ),
        costUsd: Number(
          rows.reduce((sum, row) => sum + row.call.actualCostUsd, 0).toFixed(6),
        ),
        automatic: {
          groundedImplicitExcerptRate: average(
            rows.map((row) =>
              row.automatic.implicitRequirementCount
                ? row.automatic.groundedImplicitExcerptCount /
                  row.automatic.implicitRequirementCount
                : 0,
            ),
          ),
          punctuationIssueCount: rows.reduce(
            (sum, row) =>
              sum +
              row.automatic.spaceBeforePunctuationCount +
              row.automatic.missingSpaceAfterPunctuationCount,
            0,
          ),
          valueShareValidDocuments: rows.filter(
            (row) => row.automatic.valueShareTotal === 100,
          ).length,
          flatValueShareDocuments: rows.filter(
            (row) => row.automatic.flatValueShare,
          ).length,
          unexpectedServiceDocuments: rows.filter(
            (row) => row.automatic.recommendedServiceCount > 0,
          ).length,
        },
        judge: Object.fromEntries(
          dimensions.map((dimension) => [
            dimension,
            average(judgeRows.map((row) => row[dimension])),
          ]),
        ),
        firstPlaceCount: documentResults.filter(
          (document) => document.judge?.ranking[0] === candidate.id,
        ).length,
      },
    ];
  }),
);

const report = {
  generatedAt: new Date().toISOString(),
  method: {
    documents: options.documents,
    candidates: candidateDefinitions,
    judgeModel: options.skipJudge ? null : "gpt-5.6-sol",
    reasoningEffort: "low",
    responseApi: true,
    strictJsonSchema: true,
    store: false,
  },
  budget: {
    maximumUsd: options.budgetUsd,
    actualUsd: Number(spend.actualUsd.toFixed(6)),
    failedCallReserveUsd: Number(spend.failedCallReserveUsd.toFixed(6)),
    calls: spend.calls.length,
    pricingPerMillionUsd: PRICES_PER_MILLION_USD,
    pricingSource: "https://developers.openai.com/api/docs/pricing",
  },
  aggregate,
  documents: documentResults,
};

const metricRows = candidateDefinitions
  .map((candidate) => {
    const item = aggregate[candidate.id];
    const judgeAverage = average(
      dimensions.map((dimension) => item.judge[dimension]),
    );
    return `| ${item.label} | ${item.averageContextChars} | ${item.inputTokens} | ${item.outputTokens} | ${item.averageLatencyMs} | ${judgeAverage ?? "n/a"} | ${item.firstPlaceCount} | $${item.costUsd.toFixed(4)} |`;
  })
  .join("\n");
const dimensionRows = dimensions
  .map(
    (dimension) =>
      `| ${dimension} | ${aggregate.baseline.judge[dimension] ?? "n/a"} | ${aggregate.model_only.judge[dimension] ?? "n/a"} | ${aggregate.candidate_v3.judge[dimension] ?? "n/a"} |`,
  )
  .join("\n");
const markdown = `# Document Analysis v3 evaluation

Generated: ${report.generatedAt}

Actual OpenAI spend: **$${report.budget.actualUsd.toFixed(4)} / $${report.budget.maximumUsd.toFixed(2)}** across ${report.budget.calls} calls. Requests used the Responses API, low reasoning, strict JSON Schema and \`store: false\`.

## Aggregate

| Candidate | Avg context chars | Input tokens | Output tokens | Avg latency ms | Avg judge score | First place | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
${metricRows}

## Judge dimensions

| Dimension | GPT-5.4 legacy | Terra legacy | Terra v3 |
|---|---:|---:|---:|
${dimensionRows}

## Deterministic checks

- Parser: ${documentResults.map((item) => `${item.document}: ${item.parser}`).join("; ")}.
- Candidate v3 grounded implicit excerpt rate: ${aggregate.candidate_v3.automatic.groundedImplicitExcerptRate}.
- Candidate v3 punctuation diagnostics: ${aggregate.candidate_v3.automatic.punctuationIssueCount}.
- Candidate v3 valid 100% value allocations: ${aggregate.candidate_v3.automatic.valueShareValidDocuments}/${documentResults.length} documents.
- Candidate v3 flat value allocations: ${aggregate.candidate_v3.automatic.flatValueShareDocuments}/${documentResults.length} documents.
- Candidate v3 unexpected service recommendations without candidates: ${aggregate.candidate_v3.automatic.unexpectedServiceDocuments}/${documentResults.length} documents.

## Method

- The model-only candidate changes GPT-5.4 to GPT-5.6 Terra while retaining the legacy prompt and raw-text context.
- The full candidate uses GPT-5.6 Terra with the concise v3 prompt and compiled canonical evidence.
- GPT-5.6 Sol judges anonymized, counterbalanced outputs against the checked-in source text.
- Automatic checks validate punctuation artifacts, exact implicit source excerpts, value allocation and service-catalog discipline.
`;

await Promise.all([
  mkdir(path.dirname(options.outputPath), { recursive: true }),
  mkdir(path.dirname(options.markdownPath), { recursive: true }),
]);
await Promise.all([
  writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(options.markdownPath, markdown),
]);
console.log(
  JSON.stringify({
    event: "document_analysis_v3_eval_complete",
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
    actualCostUsd: report.budget.actualUsd,
    budgetUsd: report.budget.maximumUsd,
    aggregate,
  }),
);
