#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const frontendRoot = path.join(repositoryRoot, "apps", "frontend");
const corpusPath = path.join(
  repositoryRoot,
  "test-data",
  "document-analysis-stress",
  "corpus.json",
);
const pdfDirectory = path.join(
  repositoryRoot,
  "output",
  "pdf",
  "document-analysis-stress",
);
const defaultOutputPath = path.join(
  repositoryRoot,
  "reports",
  "document-analysis-stress-eval.json",
);
const defaultMarkdownPath = path.join(
  repositoryRoot,
  "reports",
  "document-analysis-stress-eval.md",
);

const ABSOLUTE_BUDGET_CAP_USD = 15;
const ANALYSIS_MODEL = "gpt-5.6-terra";
const JUDGE_MODEL = "gpt-5.6-sol";
const PRICES_PER_MILLION_USD = {
  "gpt-5.6-terra": {
    input: 2.5,
    cached: 0.25,
    cacheWrite: 3.125,
    output: 15,
  },
  "gpt-5.6-sol": {
    input: 5,
    cached: 0.5,
    cacheWrite: 6.25,
    output: 30,
  },
};

const CATEGORY_FIELDS = {
  profile: ["customer_profile_summary", "customer_profile"],
  goals: ["customer_goals_summary", "customer_goals"],
  requirements: [
    "prioritized_requirements",
    "executive_summary",
    "high_level_solution_design",
  ],
  deadlines: null,
  commercial: null,
  evaluation: null,
  risks: ["risks", "risks_for_us", "risks_for_customer"],
  ambiguities: ["ambiguities"],
  solution_direction: [
    "high_level_solution_design",
    "expected_solution_direction",
    "positioning_recommendations",
  ],
};

const JUDGE_SCORE_FIELDS = [
  "customer_context",
  "goals_and_outcomes",
  "requirements_and_service_levels",
  "deadlines_and_deliverables",
  "commercial_and_evaluation",
  "risks_and_ambiguities",
  "solution_fit",
  "groundedness",
  "norwegian_language",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const valueAfter = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const budgetUsd = Number(valueAfter("--budget", "15"));
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > ABSOLUTE_BUDGET_CAP_USD
  ) {
    throw new Error(
      `--budget må være mellom 0 og ${ABSOLUTE_BUDGET_CAP_USD} USD.`,
    );
  }
  return {
    budgetUsd,
    dryRun: args.includes("--dry-run"),
    skipJudge: args.includes("--skip-judge"),
    reuseOutputPath: valueAfter("--reuse-output")
      ? path.resolve(valueAfter("--reuse-output"))
      : null,
    outputPath: path.resolve(valueAfter("--output", defaultOutputPath)),
    markdownPath: path.resolve(
      valueAfter("--markdown", defaultMarkdownPath),
    ),
  };
}

async function loadEnvFile(filePath) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/u)) {
    const match =
      /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(['"])([\s\S]*)\1$/u, "$2");
    process.env[match[1]] = value;
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

function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length
    ? Number(
        (
          numbers.reduce((sum, value) => sum + value, 0) / numbers.length
        ).toFixed(3),
      )
    : null;
}

function authoredSourceText(document) {
  return document.pages
    .flatMap((page) =>
      page.blocks.flatMap((block) => [
        block.label ?? "",
        block.text ?? "",
        ...(block.rows ?? []).flat(),
      ]),
    )
    .join("\n");
}

function flattenFacts(answerKey) {
  return Object.entries(answerKey).flatMap(([category, facts]) =>
    category === "must_not_claim"
      ? []
      : facts.map((fact) => ({ ...fact, category })),
  );
}

function factMatch(fact, searchableText) {
  const text = normalizeComparable(searchableText);
  const groupResults = fact.required_term_groups.map((group) =>
    group.some((term) => text.includes(normalizeComparable(term))),
  );
  const matches = groupResults.filter(Boolean).length;
  return {
    id: fact.id,
    category: fact.category,
    statement: fact.statement,
    matchedGroups: matches,
    totalGroups: groupResults.length,
    status:
      matches === groupResults.length
        ? "present"
        : matches > 0
          ? "partial"
          : "missing",
  };
}

function categoryText(output, category) {
  const fields = CATEGORY_FIELDS[category];
  if (!fields) return collectStrings(output).join("\n");
  return fields.flatMap((field) => collectStrings(output[field], field)).join("\n");
}

function scoreAnswer(output, answerKey) {
  const facts = flattenFacts(answerKey).map((fact) =>
    factMatch(fact, categoryText(output, fact.category)),
  );
  const categories = Object.fromEntries(
    Object.keys(CATEGORY_FIELDS).map((category) => {
      const rows = facts.filter((fact) => fact.category === category);
      const earned = rows.reduce(
        (sum, fact) =>
          sum + (fact.status === "present" ? 1 : fact.status === "partial" ? 0.5 : 0),
        0,
      );
      return [
        category,
        {
          facts: rows.length,
          present: rows.filter((fact) => fact.status === "present").length,
          partial: rows.filter((fact) => fact.status === "partial").length,
          missing: rows.filter((fact) => fact.status === "missing").length,
          scorePercent: rows.length
            ? Number(((earned / rows.length) * 100).toFixed(1))
            : 100,
        },
      ];
    }),
  );
  const earned = facts.reduce(
    (sum, fact) =>
      sum + (fact.status === "present" ? 1 : fact.status === "partial" ? 0.5 : 0),
    0,
  );
  return {
    facts,
    categories,
    totalFacts: facts.length,
    present: facts.filter((fact) => fact.status === "present").length,
    partial: facts.filter((fact) => fact.status === "partial").length,
    missing: facts.filter((fact) => fact.status === "missing").length,
    scorePercent: Number(((earned / facts.length) * 100).toFixed(1)),
  };
}

function scoreSourceSupport(answerKey, sourceText) {
  const facts = flattenFacts(answerKey).map((fact) =>
    factMatch(fact, sourceText),
  );
  return {
    facts: facts.length,
    fullySupported: facts.filter((fact) => fact.status === "present").length,
    partiallySupported: facts.filter((fact) => fact.status === "partial").length,
    unsupported: facts.filter((fact) => fact.status === "missing").length,
    coveragePercent: Number(
      (
        (facts.filter((fact) => fact.status === "present").length /
          facts.length) *
        100
      ).toFixed(1),
    ),
    details: facts,
  };
}

function automaticQuality(output, canonicalContext) {
  const strings = collectStrings(output);
  const prose = strings.join("\n");
  const normalizedSource = normalizeComparable(canonicalContext);
  const implicit = Array.isArray(output.implicit_requirements)
    ? output.implicit_requirements
    : [];
  const groundedImplicitExcerptCount = implicit.filter((item) => {
    const excerpt = normalizeComparable(item?.source_excerpt);
    return excerpt.length >= 12 && normalizedSource.includes(excerpt);
  }).length;
  const valueOpportunities = Array.isArray(output.value_opportunities)
    ? output.value_opportunities
    : [];
  return {
    proseChars: prose.length,
    mojibakeCount: prose.match(/Ã[¦¸¥†˜…]|�/gu)?.length ?? 0,
    spaceBeforePunctuationCount: prose.match(/\s+[,.;:!?]/gu)?.length ?? 0,
    missingSpaceAfterPunctuationCount:
      prose.match(/[;,!?](?=[\p{L}\p{N}])|\.(?=[\p{Lu}ÆØÅ])/gu)?.length ?? 0,
    implicitRequirementCount: implicit.length,
    groundedImplicitExcerptCount,
    valueShareTotal: valueOpportunities.reduce(
      (sum, item) => sum + Number(item?.profit_share_percent ?? 0),
      0,
    ),
    recommendedServiceCount: Array.isArray(output.recommended_services)
      ? output.recommended_services.length
      : 0,
  };
}

function estimateTokens(value) {
  return Math.ceil(String(value ?? "").length / 3.2);
}

function priceForModel(model) {
  const price = PRICES_PER_MILLION_USD[model];
  if (!price) throw new Error(`Mangler prisdefinisjon for ${model}.`);
  return price;
}

function estimatedCallCostUsd({
  model,
  system,
  user,
  schema,
  maxOutputTokens,
}) {
  const price = priceForModel(model);
  const inputTokens = estimateTokens(
    `${system}\n${user}\n${JSON.stringify(schema)}`,
  );
  return (
    inputTokens * Math.max(price.input, price.cacheWrite) +
    maxOutputTokens * price.output
  ) / 1_000_000;
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

function buildJudgeSchema(facts) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      fact_status: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          facts.map((fact) => [
            fact.id,
            { enum: ["present", "partial", "missing"] },
          ]),
        ),
        required: facts.map((fact) => fact.id),
      },
      category_scores: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          JUDGE_SCORE_FIELDS.map((field) => [
            field,
            { type: "integer", minimum: 1, maximum: 10 },
          ]),
        ),
        required: JUDGE_SCORE_FIELDS,
      },
      critical_omissions: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
      },
      unsupported_claims: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
      },
      language_findings: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
      },
      overall_verdict: {
        enum: ["pass", "needs_improvement", "fail"],
      },
      rationale: { type: "string" },
    },
    required: [
      "fact_status",
      "category_scores",
      "critical_omissions",
      "unsupported_claims",
      "language_findings",
      "overall_verdict",
      "rationale",
    ],
  };
}

function judgeSystemPrompt() {
  return [
    "Du er en uavhengig senior kvalitetssikrer for norsk tilbudsanalyse.",
    "Sammenlign systemsvaret med den manuelt forfattede fasiten og den kanoniske kilden.",
    "Fasiten var holdt helt utenfor systemets analysekall.",
    "Merk et faktum present bare når hele substansen er med, partial når noe vesentlig mangler, ellers missing.",
    "Trekk hardt for oppdiktede tall, datoer, krav, produkter eller avklarte konklusjoner der kilden er motstridende.",
    "Feltet profit_share_percent er en påkrevd intern analytisk prioritering som skal summere til 100, ikke en påstand om kundens økonomi eller kommersielle vilkår. Ikke trekk for at kilden mangler slike prosenter. Trekk bare hvis teksten feilaktig fremstiller dem som kundekrav, eller fordelingen er klart urimelig.",
    "Bruk hele skalaen konsekvent: 10 = komplett og uten vesentlige feil, 8 = sterk med mindre mangler, 6 = flere delvise mangler, 4 = minst én materiell feil eller mange mangler, 2 = upålitelig.",
    "Vurder korrekt bokmål, tegnsetting, setningsstruktur og norsk tall- og enhetsnotasjon.",
    "Returner bare JSON etter skjemaet.",
  ].join("\n");
}

function markdownReport(report) {
  const documentRows = report.documents
    .map(
      (document) =>
        `| ${document.client} | ${document.parser} | ${document.routing.route} | ${document.deterministic?.scorePercent ?? "not run"} | ${document.judge?.averageScore ?? "n/a"} | ${document.judge?.overall_verdict ?? "not run"} | ${document.analysisCall?.latencyMs ?? "n/a"} | $${(document.analysisCall?.actualCostUsd ?? 0).toFixed(4)} |`,
    )
    .join("\n");
  const categoryRows = Object.keys(CATEGORY_FIELDS)
    .map(
      (category) =>
        `| ${category} | ${report.aggregate.deterministicByCategory[category]} |`,
    )
    .join("\n");
  return `# Document Analysis v3 - five-document stress evaluation

Generated: ${report.generatedAt}

Actual OpenAI spend: **$${report.budget.actualUsd.toFixed(4)} / $${report.budget.maximumUsd.toFixed(2)}** across ${report.budget.calls} calls.
${report.budget.priorActualUsd ? `This report reused the saved production answers; the current judging pass cost $${report.budget.currentRunActualUsd.toFixed(4)}.` : ""}

## Aggregate

- Manual answer-key facts: ${report.aggregate.totalFacts}.
- Deterministic fact score: ${report.aggregate.deterministicScorePercent}% (${report.aggregate.present} present, ${report.aggregate.partial} partial, ${report.aggregate.missing} missing).
- Sol judge average: ${report.aggregate.judgeAverage ?? "not run"}/10.
- Judge verdicts: ${JSON.stringify(report.aggregate.verdicts)}.
- Canonical parser context retained ${report.aggregate.extractedAnswerKeyCoveragePercent}% of the answer-key anchor facts.
- Exact implicit source excerpts: ${report.aggregate.groundedImplicitExcerpts}/${report.aggregate.implicitRequirements}.
- Documents with valid 100% value allocation: ${report.aggregate.validValueShareDocuments}/5.
- Documents with unexpected service recommendations: ${report.aggregate.unexpectedServiceDocuments}/5.
- Automatic punctuation or mojibake flags: ${report.aggregate.languageFlagCount}.

| Client | Parser | Route | Deterministic % | Judge /10 | Verdict | Analysis ms | Analysis cost |
|---|---|---|---:|---:|---|---:|---:|
${documentRows}

## Deterministic category coverage

| Category | Score % |
|---|---:|
${categoryRows}

## Method

- Five deterministic, visually verified Norwegian PDFs cover port operations, healthcare scheduling, cold-chain logistics, commercial-property energy management and electric-grid field work.
- Each source mixes prose, emails, notes, contradictions, pseudo-tables and two-column pages.
- The production local PDF parser, canonical evidence compiler, v3 prompt, strict schema and GPT-5.6 Terra model produce the system answer.
- The answer key is authored in the checked-in corpus and is never included in the production analysis request.
- GPT-5.6 Sol performs a secondary schema-bound comparison after generation.
- Every request uses the Responses API, low reasoning, strict JSON Schema and \`store: false\`.
`;
}

const options = parseArgs();
if (options.dryRun && options.reuseOutputPath) {
  throw new Error("--dry-run kan ikke kombineres med --reuse-output.");
}
await Promise.all([
  loadEnvFile(path.join(repositoryRoot, ".env")),
  loadEnvFile(path.join(frontendRoot, ".env.local")),
]);
if (!options.dryRun && !process.env.OPENAI_API_KEY?.trim()) {
  throw new Error("OPENAI_API_KEY mangler. Ingen API-kall ble utført.");
}
process.env.DOCUMENT_ANALYSIS_VERSION = "v3";

const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const OpenAI = require(path.join(frontendRoot, "node_modules", "openai")).default;
const jiti = createJiti(
  path.join(frontendRoot, "document-analysis-stress-eval.cjs"),
  {
    fsCache: false,
    moduleCache: false,
    interopDefault: true,
    alias: { "@": frontendRoot, "server-only": "/dev/null" },
  },
);
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
} = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "customer-analysis-v3.ts",
  ),
);

const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
if (
  corpus.version !== "document-analysis-stress.v1" ||
  corpus.documents?.length !== 5
) {
  throw new Error("Stresskorpuset må være v1 og inneholde nøyaktig fem dokumenter.");
}

const authoredSupport = corpus.documents.map((document) => ({
  id: document.id,
  ...scoreSourceSupport(document.answer_key, authoredSourceText(document)),
}));
const unsupportedAuthoredFacts = authoredSupport.flatMap((document) =>
  document.details
    .filter((fact) => fact.status !== "present")
    .map((fact) => `${document.id}:${fact.id}:${fact.status}`),
);
if (unsupportedAuthoredFacts.length) {
  throw new Error(
    `Fasiten mangler eksplisitt kildestøtte: ${unsupportedAuthoredFacts.join(", ")}`,
  );
}

const reusedReport = options.reuseOutputPath
  ? JSON.parse(await readFile(options.reuseOutputPath, "utf8"))
  : null;
if (reusedReport) {
  const reusableIds = new Set(
    reusedReport.documents
      ?.filter((document) => document.systemOutput)
      .map((document) => document.id) ?? [],
  );
  const missingReusableIds = corpus.documents
    .map((document) => document.id)
    .filter((id) => !reusableIds.has(id));
  if (missingReusableIds.length) {
    throw new Error(
      `Gjenbruksrapporten mangler systemsvar for: ${missingReusableIds.join(", ")}`,
    );
  }
}

const client = options.dryRun
  ? null
  : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const priorSpend = {
  actualUsd: Number(reusedReport?.budget?.actualUsd ?? 0),
  failedCallReserveUsd: Number(
    reusedReport?.budget?.failedCallReserveUsd ?? 0,
  ),
  calls: Number(reusedReport?.budget?.calls ?? 0),
};
const spend = {
  actualUsd: priorSpend.actualUsd,
  failedCallReserveUsd: priorSpend.failedCallReserveUsd,
  calls: [],
};

async function structuredCall(input) {
  if (!client) throw new Error("API-kall er deaktivert i --dry-run.");
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
    response = await client.responses.create(
      {
        model: input.model,
        store: false,
        prompt_cache_key: `anbud:document-analysis-stress:${input.cacheFamily}`,
        instructions: input.system,
        reasoning: { effort: "low" },
        max_output_tokens: input.maxOutputTokens,
        text: {
          verbosity: "medium",
          format: {
            type: "json_schema",
            name: input.schemaName,
            strict: true,
            schema: input.schema,
          },
        },
        input: [{ role: "user", content: input.user }],
      },
      { timeout: 180_000, maxRetries: 1 },
    );
  } catch (error) {
    spend.failedCallReserveUsd += estimateUsd;
    throw error;
  }
  const outputText = response.output_text?.trim();
  if (!outputText) {
    spend.failedCallReserveUsd += estimateUsd;
    throw new Error(`${input.label} returnerte tomt svar.`);
  }
  const actualCostUsd = usageCostUsd(input.model, response.usage);
  spend.actualUsd += actualCostUsd;
  const call = {
    label: input.label,
    model: input.model,
    latencyMs: Math.round(performance.now() - startedAt),
    estimatedMaximumCostUsd: Number(estimateUsd.toFixed(6)),
    actualCostUsd: Number(actualCostUsd.toFixed(6)),
    usage: usageSummary(response.usage),
  };
  spend.calls.push(call);
  console.log(
    JSON.stringify({
      event: "document_analysis_stress_call_complete",
      ...call,
      cumulativeCostUsd: Number(spend.actualUsd.toFixed(6)),
      budgetUsd: options.budgetUsd,
    }),
  );
  return { output: JSON.parse(outputText), call };
}

const documents = [];
for (const [index, document] of corpus.documents.entries()) {
  const buffer = await readFile(path.join(pdfDirectory, `${document.id}.pdf`));
  const parseStartedAt = performance.now();
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName: `${document.id}.pdf`,
    contentType: "application/pdf",
    role: "primary_customer_document",
    useDocling: false,
  });
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: `stress-document-${index + 1}`,
    projectId: "document-analysis-stress-project",
    title: document.title,
    fileName: `${document.id}.pdf`,
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
  const extractedSupport = scoreSourceSupport(
    document.answer_key,
    artifact.analysisContext,
  );
  const system = buildCustomerAnalysisV3SystemPrompt();
  const user = buildCustomerAnalysisV3UserPrompt({
    projectName: document.client,
    documents: [
      {
        documentId: `stress-document-${index + 1}`,
        title: document.title,
        role: "primary_customer_document",
        context: artifact.analysisContext,
      },
    ],
  });

  if (options.dryRun) {
    documents.push({
      id: document.id,
      client: document.client,
      parser: parsed.parserUsed,
      routing: artifact.routing,
      languageQuality: artifact.languageQuality,
      parseLatencyMs,
      rawTextChars: parsed.rawText.length,
      canonicalContextChars: artifact.analysisContext.length,
      authoredSupport: authoredSupport[index],
      extractedSupport,
      promptChars: system.length + user.length,
      deterministic: null,
      automatic: null,
      analysisCall: null,
      judge: null,
      systemOutput: null,
    });
    continue;
  }

  const reusedDocument = reusedReport?.documents?.find(
    (candidate) => candidate.id === document.id,
  );
  const analysis = reusedDocument
    ? {
        output: reusedDocument.systemOutput,
        call: reusedDocument.analysisCall,
      }
    : await structuredCall({
        label: `${document.id}:production-analysis`,
        cacheFamily: "production-analysis",
        model: ANALYSIS_MODEL,
        system,
        user,
        schemaName: "customer_analysis_v3",
        schema: CUSTOMER_ANALYSIS_V3_JSON_SCHEMA,
        maxOutputTokens: 9_000,
      });
  const deterministic = scoreAnswer(analysis.output, document.answer_key);
  const automatic = automaticQuality(
    analysis.output,
    artifact.analysisContext,
  );
  let judge = null;
  if (!options.skipJudge) {
    const facts = flattenFacts(document.answer_key);
    const judgeResult = await structuredCall({
      label: `${document.id}:answer-key-judge`,
      cacheFamily: "answer-key-judge",
      model: JUDGE_MODEL,
      system: judgeSystemPrompt(),
      user: [
        `DOKUMENT: ${document.client}`,
        `MANUELL FASIT\n${JSON.stringify(document.answer_key, null, 2)}`,
        `KANONISK KILDE\n${artifact.analysisContext}`,
        `SYSTEMSVAR\n${JSON.stringify(analysis.output, null, 2)}`,
      ].join("\n\n"),
      schemaName: "document_analysis_stress_judge",
      schema: buildJudgeSchema(facts),
      maxOutputTokens: 3_500,
    });
    judge = {
      ...judgeResult.output,
      averageScore: average(
        Object.values(judgeResult.output.category_scores),
      ),
      call: judgeResult.call,
    };
  }
  documents.push({
    id: document.id,
    client: document.client,
    parser: parsed.parserUsed,
    routing: artifact.routing,
    languageQuality: artifact.languageQuality,
    parseLatencyMs,
    rawTextChars: parsed.rawText.length,
    canonicalContextChars: artifact.analysisContext.length,
    authoredSupport: authoredSupport[index],
    extractedSupport,
    promptChars: system.length + user.length,
    deterministic,
    automatic,
    analysisCall: analysis.call,
    analysisReused: Boolean(reusedDocument),
    judge,
    systemOutput: analysis.output,
  });
}

const completedDocuments = documents.filter(
  (document) => document.deterministic,
);
const categoryScores = Object.fromEntries(
  Object.keys(CATEGORY_FIELDS).map((category) => [
    category,
    average(
      completedDocuments.map(
        (document) =>
          document.deterministic.categories[category].scorePercent,
      ),
    ),
  ]),
);
const allFactRows = completedDocuments.flatMap(
  (document) => document.deterministic.facts,
);
const automaticRows = completedDocuments
  .map((document) => document.automatic)
  .filter(Boolean);
const verdicts = Object.fromEntries(
  ["pass", "needs_improvement", "fail"].map((verdict) => [
    verdict,
    documents.filter(
      (document) => document.judge?.overall_verdict === verdict,
    ).length,
  ]),
);
const extractedFacts = documents.reduce(
  (sum, document) => sum + document.extractedSupport.facts,
  0,
);
const extractedSupported = documents.reduce(
  (sum, document) => sum + document.extractedSupport.fullySupported,
  0,
);
const report = {
  generatedAt: new Date().toISOString(),
  corpus: {
    version: corpus.version,
    documents: corpus.documents.length,
    answerKeyFacts: authoredSupport.reduce(
      (sum, document) => sum + document.facts,
      0,
    ),
    authoredSupportPercent: 100,
    clientPdfDirectory: path.relative(repositoryRoot, pdfDirectory),
    answerKeyPdf: path.relative(
      repositoryRoot,
      path.join(pdfDirectory, "document-analysis-stress-answer-key.pdf"),
    ),
  },
  method: {
    dryRun: options.dryRun,
    analysisModel: options.dryRun ? null : ANALYSIS_MODEL,
    judgeModel: options.dryRun || options.skipJudge ? null : JUDGE_MODEL,
    reusedProductionAnswers: Boolean(reusedReport),
    reusedOutputPath: options.reuseOutputPath
      ? path.relative(repositoryRoot, options.reuseOutputPath)
      : null,
    responsesApi: !options.dryRun,
    strictJsonSchema: !options.dryRun,
    reasoningEffort: options.dryRun ? null : "low",
    store: options.dryRun ? null : false,
  },
  budget: {
    maximumUsd: options.budgetUsd,
    actualUsd: Number(spend.actualUsd.toFixed(6)),
    priorActualUsd: Number(priorSpend.actualUsd.toFixed(6)),
    currentRunActualUsd: Number(
      (spend.actualUsd - priorSpend.actualUsd).toFixed(6),
    ),
    failedCallReserveUsd: Number(spend.failedCallReserveUsd.toFixed(6)),
    calls: priorSpend.calls + spend.calls.length,
    priorCalls: priorSpend.calls,
    currentRunCalls: spend.calls.length,
    pricingPerMillionUsd: PRICES_PER_MILLION_USD,
    pricingSource: "https://developers.openai.com/api/docs/pricing",
  },
  aggregate: {
    totalFacts: allFactRows.length,
    present: allFactRows.filter((fact) => fact.status === "present").length,
    partial: allFactRows.filter((fact) => fact.status === "partial").length,
    missing: allFactRows.filter((fact) => fact.status === "missing").length,
    deterministicScorePercent: allFactRows.length
      ? Number(
          (
            (allFactRows.reduce(
              (sum, fact) =>
                sum +
                (fact.status === "present"
                  ? 1
                  : fact.status === "partial"
                    ? 0.5
                    : 0),
              0,
            ) /
              allFactRows.length) *
            100
          ).toFixed(1),
        )
      : null,
    deterministicByCategory: categoryScores,
    judgeAverage: average(
      documents.map((document) => document.judge?.averageScore),
    ),
    verdicts,
    extractedAnswerKeyCoveragePercent: extractedFacts
      ? Number(((extractedSupported / extractedFacts) * 100).toFixed(1))
      : null,
    groundedImplicitExcerpts: automaticRows.reduce(
      (sum, row) => sum + row.groundedImplicitExcerptCount,
      0,
    ),
    implicitRequirements: automaticRows.reduce(
      (sum, row) => sum + row.implicitRequirementCount,
      0,
    ),
    validValueShareDocuments: automaticRows.filter(
      (row) => row.valueShareTotal === 100,
    ).length,
    unexpectedServiceDocuments: automaticRows.filter(
      (row) => row.recommendedServiceCount > 0,
    ).length,
    languageFlagCount: automaticRows.reduce(
      (sum, row) =>
        sum +
        row.mojibakeCount +
        row.spaceBeforePunctuationCount +
        row.missingSpaceAfterPunctuationCount,
      0,
    ),
  },
  documents,
};

await Promise.all([
  mkdir(path.dirname(options.outputPath), { recursive: true }),
  mkdir(path.dirname(options.markdownPath), { recursive: true }),
]);
await Promise.all([
  writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(options.markdownPath, markdownReport(report)),
]);
console.log(
  JSON.stringify({
    event: "document_analysis_stress_eval_complete",
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
    actualCostUsd: report.budget.actualUsd,
    budgetUsd: report.budget.maximumUsd,
    aggregate: report.aggregate,
  }),
);
