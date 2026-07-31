#!/usr/bin/env node
// fallow-ignore-file unused-file

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = path.join(repoRoot, "apps", "frontend");
const outputJson = path.join(repoRoot, "reports", "document-intelligence-v2-ab.json");
const outputMarkdown = path.join(repoRoot, "docs", "document-intelligence-v2-ab.md");
const model = "gpt-5-mini";
const maximumBudgetUsd = 15;
const safetyStopUsd = 14.5;
const pricingPerMillion = { input: 0.25, output: 2 };
const priorEvaluationSpendUsd = Math.max(
  0,
  Number(process.env.DOCUMENT_INTELLIGENCE_PRIOR_EVAL_SPEND_USD ?? 0) || 0,
);

async function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const source = await readFile(filePath, "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

for (const envPath of [
  path.join(repoRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(frontendRoot, ".env"),
  path.join(frontendRoot, ".env.local"),
]) {
  await loadEnvFile(envPath);
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY mangler; A/B-evalueringen kan ikke kjøres.");
}
process.env.DOCUMENT_INTELLIGENCE_V2 = "on";

const require = createRequire(import.meta.url);
const OpenAI = require(path.join(frontendRoot, "node_modules", "openai")).default;
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "document-intelligence-ab.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { extractTextFromBuffer } = jiti(
  path.join(frontendRoot, "lib/server/documents.ts"),
);
const { compileDocumentIntelligenceArtifact } = jiti(
  path.join(
    frontendRoot,
    "lib/server/document-intelligence/evidence-compiler.ts",
  ),
);
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function shouldUseCompiledCustomerAnalysisContext(input) {
  const nativeSourceCeiling = input.isPrimaryDocument ? 18_000 : 8_000;
  if (input.rawTextLength <= nativeSourceCeiling) return false;
  const rawBudget = input.isPrimaryDocument ? 12_000 : 4_000;
  const evidenceBudget = input.isPrimaryDocument ? 8_000 : 3_000;
  const legacyContextChars = Math.min(rawBudget, input.rawTextLength);
  const compiledContextChars = Math.min(
    evidenceBudget,
    input.analysisContextLength,
  );
  return (
    compiledContextChars + 800 <= Math.max(1_600, legacyContextChars * 0.95)
  );
}

function cliArgument(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  const next = index >= 0 ? process.argv[index + 1] : "";
  return next && !next.startsWith("--") ? next.trim() : "";
}

const useHardCorpus = process.argv.includes("--hard-corpus");
const configuredHardCorpusRoot =
  cliArgument("--hard-corpus-root") ||
  process.env.DOCUMENT_INTELLIGENCE_HARD_CORPUS_ROOT?.trim() ||
  "";
if (useHardCorpus && !configuredHardCorpusRoot) {
  throw new Error(
    "--hard-corpus krever --hard-corpus-root <PDF-mappe> eller DOCUMENT_INTELLIGENCE_HARD_CORPUS_ROOT.",
  );
}
const hardCorpusRoot = configuredHardCorpusRoot
  ? path.resolve(configuredHardCorpusRoot)
  : "";
const tenderFiles = useHardCorpus
  ? [
      [
        "063_DokumentVern_Forvaltning_IKS",
        "063_Bilag_2_Krav_DokumentVern_Forvaltning_IKS.pdf",
      ],
      [
        "083_LastVindu_Terminal_SA",
        "083_Bilag_2_Krav_LastVindu_Terminal_SA.pdf",
      ],
      [
        "093_StreamArkiv_Produksjon_AS",
        "093_Bilag_2_Krav_StreamArkiv_Produksjon_AS.pdf",
      ],
    ].map((segments) => path.join(hardCorpusRoot, ...segments))
  : [
      "tender_nordic_hybrid_cloud_2026.pdf",
      "tender_city_smart_mobility_data_platform.pdf",
      "tender_helio_erp_finops_managed_services.pdf",
    ].map((fileName) => path.join(repoRoot, "test-data", "tenders", fileName));
for (const filePath of tenderFiles) {
  if (!existsSync(filePath)) throw new Error(`Evalfil mangler: ${filePath}`);
}

let inputTokens = 0;
let outputTokens = 0;
function estimatedCostUsd() {
  return (
    priorEvaluationSpendUsd +
    (inputTokens / 1_000_000) * pricingPerMillion.input +
    (outputTokens / 1_000_000) * pricingPerMillion.output
  );
}

function registerUsage(usage) {
  inputTokens += Number(usage?.prompt_tokens ?? 0);
  outputTokens += Number(usage?.completion_tokens ?? 0);
  if (estimatedCostUsd() >= safetyStopUsd) {
    throw new Error(
      `Sikkerhetsstopp: estimert kostnad ${estimatedCostUsd().toFixed(4)} USD.`,
    );
  }
}

async function jsonCompletion({ system, user, maxCompletionTokens = 10_000 }) {
  if (estimatedCostUsd() >= safetyStopUsd - 0.5) {
    throw new Error("Sikkerhetsstopp før neste modellkall.");
  }
  const startedAt = performance.now();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxCompletionTokens,
    reasoning_effort: "minimal",
  });
  registerUsage(response.usage);
  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(
      `Modellen returnerte tom JSON (${response.choices[0]?.finish_reason ?? "ukjent årsak"}).`,
    );
  }
  return {
    value: JSON.parse(content),
    latencyMs: Math.round(performance.now() - startedAt),
    usage: response.usage,
  };
}

function baselineContext(parsed, title) {
  const structure = parsed.sourceMap
    .slice(0, 10)
    .map((entry) => `${entry.reference}: ${entry.text.slice(0, 180)}`)
    .join("\n");
  return [
    `DOKUMENT: ${title}`,
    "RÅTEKST:",
    parsed.rawText.slice(0, 12_000),
    "STRUKTURKART:",
    structure,
  ].join("\n");
}

function evidenceContext(parsed, artifact, title) {
  const structure = parsed.sourceMap
    .slice(0, 4)
    .map((entry) => `${entry.reference}: ${entry.text.slice(0, 180)}`)
    .join("\n");
  return [
    `DOKUMENT: ${title}`,
    "KORT RÅTEKST FOR ORIENTERING:",
    parsed.rawText.slice(0, 800),
    "KORT STRUKTURKART:",
    structure,
    "FORHÅNDSKOMPILERT EVIDENS:",
    artifact.analysisContext.slice(0, 8_000),
  ].join("\n");
}

function productionParserView(parsed) {
  const sourceMap = [];
  const marker = /\[\[SIDE:(\d+)\]\]\n([\s\S]*?)(?=\n\n\[\[SIDE:\d+\]\]|$)/gu;
  for (const match of parsed.rawText.matchAll(marker)) {
    const text = match[2]?.trim() ?? "";
    if (!text) continue;
    sourceMap.push({
      reference: `Primært kundedokument – side ${match[1]}`,
      text,
    });
  }
  return {
    ...parsed,
    sourceMap,
    parserUsed: "pdf-parse",
  };
}

function adaptiveV2Context(parsed, artifact, title, baseline) {
  const candidate = evidenceContext(parsed, artifact, title);
  return shouldUseCompiledCustomerAnalysisContext({
    rawTextLength: parsed.rawText.length,
    analysisContextLength: artifact.analysisContext.length,
    isPrimaryDocument: true,
  }) &&
    candidate.length + 120 <= baseline.length * 0.95
    ? { context: candidate, mode: "compiled_evidence" }
    : {
        context: baselineContext(parsed, title),
        mode: "local_layout_native",
      };
}

const analysisSystem = `Du er en senior norsk tilbudsleder. Lag en presis kundeanalyse kun fra vedlagt dokumentkontekst. Returner gyldig JSON med feltene summary, explicit_requirements, implicit_needs, risks, clarifications og evaluation_signals. Summary skal være maksimalt 120 ord. Hver liste skal ha maksimalt seks prioriterte objekter med text på maksimalt 40 ord og source_reference. Ikke finn opp tall eller fakta.`;

function analysisPrompt(context) {
  return `Analyser dette norske anbudsdokumentet. Skill eksplisitte krav fra implisitte behov, og bevar konkrete kildehenvisninger.\n\n${context}`;
}

const judgeSystem = `Du er en streng, upartisk evaluator av norske kundeanalyser. Sammenlign kandidat A og B mot hele kildeteksten. Returner kun gyldig JSON: {"winner":"A|B|tie","a":{"coverage":1-10,"faithfulness":1-10,"specificity":1-10,"source_traceability":1-10},"b":{samme felter},"reason":"kort norsk begrunnelse"}. Straff udokumenterte påstander, feil kravkobling og generisk språk.`;

function averageScores(judgments, candidate) {
  const dimensions = ["coverage", "faithfulness", "specificity", "source_traceability"];
  return Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      Number(
        (
          judgments.reduce(
            (sum, judgment) => sum + Number(judgment[candidate]?.[dimension] ?? 0),
            0,
          ) / judgments.length
        ).toFixed(2),
      ),
    ]),
  );
}

const results = [];
for (const [index, filePath] of tenderFiles.entries()) {
  const buffer = await readFile(filePath);
  const parseStartedAt = performance.now();
  const parsed = await extractTextFromBuffer({
    buffer,
    fileName: path.basename(filePath),
    contentType: "application/pdf",
    role: "primary_customer_document",
    useDocling: false,
  });
  const parseLatencyMs = Math.round(performance.now() - parseStartedAt);
  const compileStartedAt = performance.now();
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    projectId: "00000000-0000-4000-8000-999999999999",
    title: path.basename(filePath),
    fileName: path.basename(filePath),
    fileFormat: "pdf",
    fileSizeBytes: buffer.length,
    sourceRevision: 1,
    parserUsed: parsed.parserUsed,
    rawText: parsed.rawText,
    structureMap: parsed.sourceMap,
    isHighImpactDocument: true,
    azureAvailable: true,
    doclingAvailable: true,
  });
  const compileLatencyMs = Number((performance.now() - compileStartedAt).toFixed(2));
  const baseline = baselineContext(
    productionParserView(parsed),
    path.basename(filePath),
  );
  const selectedV2Context = adaptiveV2Context(
    parsed,
    artifact,
    path.basename(filePath),
    baseline,
  );
  const evidence = selectedV2Context.context;

  const baselineAnswer = await jsonCompletion({
    system: analysisSystem,
    user: analysisPrompt(baseline),
  });
  const evidenceAnswer = await jsonCompletion({
    system: analysisSystem,
    user: analysisPrompt(evidence),
  });

  const firstJudge = await jsonCompletion({
    system: judgeSystem,
    user: [
      "KILDETEKST:",
      parsed.rawText.slice(0, 40_000),
      "KANDIDAT A:",
      JSON.stringify(baselineAnswer.value),
      "KANDIDAT B:",
      JSON.stringify(evidenceAnswer.value),
    ].join("\n\n"),
    maxCompletionTokens: 2500,
  });
  const swappedJudge = await jsonCompletion({
    system: judgeSystem,
    user: [
      "KILDETEKST:",
      parsed.rawText.slice(0, 40_000),
      "KANDIDAT A:",
      JSON.stringify(evidenceAnswer.value),
      "KANDIDAT B:",
      JSON.stringify(baselineAnswer.value),
    ].join("\n\n"),
    maxCompletionTokens: 2500,
  });
  const baselineJudgments = [firstJudge.value.a, swappedJudge.value.b];
  const evidenceJudgments = [firstJudge.value.b, swappedJudge.value.a];

  results.push({
    file: path.basename(filePath),
    parser: parsed.parserUsed,
    rawTextChars: parsed.rawText.length,
    parseLatencyMs,
    compileLatencyMs,
    route: artifact.routing.route,
    contextMode: selectedV2Context.mode,
    qualityScore: artifact.routing.quality.score,
    norwegianAnomalies: artifact.routing.quality.norwegianAnomalies,
    evidenceCount: artifact.evidence.length,
    baselineContextChars: baseline.length,
    v2ContextChars: evidence.length,
    contextReductionPercent: Number(
      ((1 - evidence.length / baseline.length) * 100).toFixed(1),
    ),
    baselineGenerationLatencyMs: baselineAnswer.latencyMs,
    v2GenerationLatencyMs: evidenceAnswer.latencyMs,
    reusedNativeAnswer: false,
    baselineScores: averageScores(
      baselineJudgments.map((score) => ({ candidate: score })),
      "candidate",
    ),
    v2Scores: averageScores(
      evidenceJudgments.map((score) => ({ candidate: score })),
      "candidate",
    ),
    judgeOrderOneWinner: firstJudge.value.winner,
    judgeOrderTwoWinner: swappedJudge.value.winner,
    judgeReasons: [firstJudge.value.reason, swappedJudge.value.reason],
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

const dimensions = ["coverage", "faithfulness", "specificity", "source_traceability"];
const aggregate = {
  documents: results.length,
  compiledEvidenceDocuments: results.filter(
    (item) => item.contextMode === "compiled_evidence",
  ).length,
  averageParseLatencyMs: Math.round(mean(results.map((item) => item.parseLatencyMs))),
  averageCompilerLatencyMs: Number(
    mean(results.map((item) => item.compileLatencyMs)).toFixed(2),
  ),
  averageContextReductionPercent: Number(
    mean(results.map((item) => item.contextReductionPercent)).toFixed(1),
  ),
  compiledEvidenceContextReductionPercent: Number(
    mean(
      results
        .filter((item) => item.contextMode === "compiled_evidence")
        .map((item) => item.contextReductionPercent),
    ).toFixed(1),
  ),
  averageBaselineGenerationLatencyMs: Math.round(
    mean(results.map((item) => item.baselineGenerationLatencyMs)),
  ),
  averageV2GenerationLatencyMs: Math.round(
    mean(results.map((item) => item.v2GenerationLatencyMs)),
  ),
  baselineScores: Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      Number(mean(results.map((item) => item.baselineScores[dimension])).toFixed(2)),
    ]),
  ),
  v2Scores: Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      Number(mean(results.map((item) => item.v2Scores[dimension])).toFixed(2)),
    ]),
  ),
};

const report = {
  generatedAt: new Date().toISOString(),
  comparison: "production local parser context vs local layout v2 context",
  model,
  budget: {
    maximumUsd: maximumBudgetUsd,
    estimatedSpentUsd: Number(estimatedCostUsd().toFixed(6)),
    priorEvaluationSpendUsd,
    inputTokens,
    outputTokens,
    pricingPerMillion,
    pricingSource: "https://developers.openai.com/api/docs/models/gpt-5-mini",
  },
  limitations: [
    "Azure Document Intelligence was not called because no local endpoint/key was configured.",
    "The same GPT-5 mini model generated both candidates and judged two counterbalanced orders.",
    "The raw PDF text is intentionally identical; the comparison isolates the local parser structure map and adaptive evidence selection.",
    useHardCorpus
      ? "The corpus contains three known low-scoring Norwegian PDFs from the existing 50-document parser bake-off."
      : "The three checked-in tender PDFs are an engineering canary, not a production-representative corpus.",
  ],
  aggregate,
  documents: results,
};

const scoreRows = dimensions
  .map(
    (dimension) =>
      `| ${dimension} | ${aggregate.baselineScores[dimension]} | ${aggregate.v2Scores[dimension]} | ${(aggregate.v2Scores[dimension] - aggregate.baselineScores[dimension]).toFixed(2)} |`,
  )
  .join("\n");
const documentRows = results
  .map(
    (item) =>
      `| ${item.file} | ${item.contextMode} | ${item.evidenceCount} | ${item.contextReductionPercent}% | ${item.baselineGenerationLatencyMs} ms | ${item.v2GenerationLatencyMs} ms |`,
  )
  .join("\n");
const contextChangeDescription =
  aggregate.averageContextReductionPercent < 0
    ? `${Math.abs(aggregate.averageContextReductionPercent)}% larger because it retained source-rich local table structure`
    : `${aggregate.averageContextReductionPercent}% smaller`;
const markdown = `# Document Intelligence v2 A/B\n\nGenerated: ${report.generatedAt}\n\nModel: \`${model}\`\n\nEstimated cumulative OpenAI spend: **$${report.budget.estimatedSpentUsd.toFixed(4)} / $${maximumBudgetUsd.toFixed(2)}** (${inputTokens} new input, ${outputTokens} new output tokens), based on [official GPT-5 mini pricing](${report.budget.pricingSource}).\n\nThis run compares the production page-level structure map with identical raw text and local layout v2. Primary documents up to 18,000 characters keep source-rich local context; compiled evidence is reserved for larger sources.\n\n## Aggregate\n\n- Local layout v2 parse: ${aggregate.averageParseLatencyMs} ms average.\n- Evidence compile overhead: ${aggregate.averageCompilerLatencyMs} ms average.\n- Local v2 context was ${contextChangeDescription}.\n- Compiled evidence selected: ${aggregate.compiledEvidenceDocuments}/${aggregate.documents} documents.\n- Generation latency: prod ${aggregate.averageBaselineGenerationLatencyMs} ms, local v2 ${aggregate.averageV2GenerationLatencyMs} ms.\n\n| Judge dimension | Prod | Local v2 | Delta |\n|---|---:|---:|---:|\n${scoreRows}\n\n## Documents\n\n| File | Mode | Evidence | Context change | Prod generation | Local v2 generation |\n|---|---|---:|---:|---:|---:|\n${documentRows}\n\n## Method\n\n- The production side reconstructs the previous page-level PDF structure map.\n- Local v2 receives the same raw text plus the new local line/table structure.\n- The same model and output contract generated both candidates.\n- Two counterbalanced judge orders reduce position bias.\n\nRun the checked-in canary with \`node scripts/document_intelligence_ab_eval.mjs\`. For the private hard corpus, set \`DOCUMENT_INTELLIGENCE_HARD_CORPUS_ROOT\` to its \`PDF\` directory and add \`--hard-corpus\`.\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`;

await mkdir(path.dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(outputMarkdown, markdown, "utf8");
console.log(
  JSON.stringify(
    {
      outputJson,
      outputMarkdown,
      estimatedSpentUsd: report.budget.estimatedSpentUsd,
      aggregate,
    },
    null,
    2,
  ),
);
