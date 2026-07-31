#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const frontendRoot = path.join(repositoryRoot, "apps", "frontend");
const require = createRequire(import.meta.url);
const { createJiti } = require(
  path.join(frontendRoot, "node_modules", "jiti"),
);
const jiti = createJiti(path.join(frontendRoot, "claude-fable-judge.cjs"), {
  fsCache: false,
  moduleCache: false,
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { normalizeCustomerAnalysisNorwegianProse } = jiti(
  path.join(
    frontendRoot,
    "lib",
    "server",
    "document-intelligence",
    "customer-analysis-language.ts",
  ),
);
function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fixtureRoot = path.join(
  repositoryRoot,
  "output",
  "pdf",
  "realistic-bilag",
);
const evaluationPath = path.resolve(
  repositoryRoot,
  argumentValue("--evaluation") ??
    "reports/nordhavn-customer-analysis-eval-final.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  argumentValue("--output") ?? "reports/claude-fable-medium-judge.json",
);
const analysisOutputPath = path.resolve(
  repositoryRoot,
  argumentValue("--analysis-output") ??
    "reports/nordhavn-customer-analysis-final.json",
);

const [bilag1, bilag2, evaluationText] = await Promise.all([
  readFile(
    path.join(fixtureRoot, "bilag1_nordhavn_byggesak_2026.txt"),
    "utf8",
  ),
  readFile(
    path.join(fixtureRoot, "bilag2_nordhavn_byggesak_2026.txt"),
    "utf8",
  ),
  readFile(evaluationPath, "utf8"),
]);

const evaluation = JSON.parse(evaluationText);
const candidate = evaluation.documents
  ?.flatMap((document) => document.candidates ?? [])
  .find((item) => item.id === "candidate_v3");

if (!candidate?.output) {
  throw new Error("Fant ikke candidate_v3 i evalueringsrapporten.");
}
const normalizedCustomerAnalysis =
  normalizeCustomerAnalysisNorwegianProse(candidate.output);

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    objective_language_error_count: { type: "integer", minimum: 0 },
    punctuation_error_count: { type: "integer", minimum: 0 },
    grounding_or_relevance_issue_count: { type: "integer", minimum: 0 },
    scores: {
      type: "object",
      additionalProperties: false,
      properties: {
        grammar: { type: "integer", minimum: 0, maximum: 10 },
        punctuation: { type: "integer", minimum: 0, maximum: 10 },
        terminology: { type: "integer", minimum: 0, maximum: 10 },
        grounding: { type: "integer", minimum: 0, maximum: 10 },
        specificity: { type: "integer", minimum: 0, maximum: 10 },
        relevance: { type: "integer", minimum: 0, maximum: 10 },
      },
      required: [
        "grammar",
        "punctuation",
        "terminology",
        "grounding",
        "specificity",
        "relevance",
      ],
    },
    objective_language_errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifact: {
            type: "string",
            enum: ["bilag_1", "bilag_2", "customer_analysis"],
          },
          exact_quote: { type: "string" },
          explanation: { type: "string" },
          correction: { type: "string" },
        },
        required: ["artifact", "exact_quote", "explanation", "correction"],
      },
    },
    punctuation_errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifact: {
            type: "string",
            enum: ["bilag_1", "bilag_2", "customer_analysis"],
          },
          exact_quote: { type: "string" },
          explanation: { type: "string" },
          correction: { type: "string" },
        },
        required: ["artifact", "exact_quote", "explanation", "correction"],
      },
    },
    grounding_or_relevance_issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          exact_quote: { type: "string" },
          explanation: { type: "string" },
          correction: { type: "string" },
        },
        required: ["exact_quote", "explanation", "correction"],
      },
    },
    style_suggestions_not_errors: {
      type: "array",
      items: { type: "string" },
    },
    summary: { type: "string" },
  },
  required: [
    "verdict",
    "objective_language_error_count",
    "punctuation_error_count",
    "grounding_or_relevance_issue_count",
    "scores",
    "objective_language_errors",
    "punctuation_errors",
    "grounding_or_relevance_issues",
    "style_suggestions_not_errors",
    "summary",
  ],
};

const systemPrompt = [
  "Du er en uavhengig norsk språkrevisor og anskaffelsesfaglig dommer.",
  "Vurder bokmål, tegnsetting, terminologi, kildeforankring, spesifisitet og aktualitet.",
  "Skill strengt mellom objektive feil og valgfrie stilforbedringer.",
  "Rapporter bare en objektiv språk- eller tegnsettingsfeil når du kan sitere feilen nøyaktig og gi en entydig rettelse.",
  "Godta etablerte faguttrykk, egennavn, krav-ID-er, desimalkomma og kontraktsdefinerte betegnelser.",
  "Analysen skal ikke få trekk for at testkunden er fiktiv, men den skal bruke testdokumentets konkrete tall, datoer, krav-ID-er og avgrensninger.",
  "Sett verdict til pass bare når alle tre feiltellere er 0.",
].join(" ");

const userPrompt = [
  "Vurder følgende tre artefakter. Returner bare data som følger JSON-skjemaet.",
  "",
  "=== BILAG 1 ===",
  bilag1,
  "",
  "=== BILAG 2 ===",
  bilag2,
  "",
  "=== KUNDEANALYSE ===",
  JSON.stringify(normalizedCustomerAnalysis, null, 2),
].join("\n");

function runClaude() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "--print",
        "--model",
        "claude-fable-5",
        "--effort",
        "medium",
        "--max-budget-usd",
        "2",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(schema),
        "--system-prompt",
        systemPrompt,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--no-chrome",
        "--safe-mode",
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Claude CLI avsluttet med kode ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(userPrompt);
  });
}

const { stdout, stderr } = await runClaude();
const cliResult = JSON.parse(stdout);
const judgment =
  cliResult.structured_output ??
  (typeof cliResult.result === "string"
    ? JSON.parse(cliResult.result)
    : cliResult.result);

if (!judgment || typeof judgment !== "object") {
  throw new Error("Claude CLI returnerte ikke en strukturert dom.");
}

const report = {
  generated_at: new Date().toISOString(),
  judge: {
    cli: "Claude Code",
    model: "claude-fable-5",
    effort: "medium",
    tools: "disabled",
  },
  source: {
    bilag_1: "output/pdf/realistic-bilag/bilag1_nordhavn_byggesak_2026.txt",
    bilag_2: "output/pdf/realistic-bilag/bilag2_nordhavn_byggesak_2026.txt",
    customer_analysis: path.relative(repositoryRoot, analysisOutputPath),
  },
  cli_metadata: {
    session_id: cliResult.session_id ?? null,
    total_cost_usd: cliResult.total_cost_usd ?? null,
    duration_ms: cliResult.duration_ms ?? null,
    usage: cliResult.usage ?? null,
    stderr: stderr.trim() || null,
  },
  judgment,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await Promise.all([
  writeFile(
    analysisOutputPath,
    `${JSON.stringify(normalizedCustomerAnalysis, null, 2)}\n`,
    "utf8",
  ),
  writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
]);

console.log(
  JSON.stringify({
    outputPath,
    analysisOutputPath,
    verdict: judgment.verdict,
    objectiveLanguageErrors: judgment.objective_language_error_count,
    punctuationErrors: judgment.punctuation_error_count,
    groundingOrRelevanceIssues: judgment.grounding_or_relevance_issue_count,
    scores: judgment.scores,
    costUsd: cliResult.total_cost_usd ?? null,
  }),
);
