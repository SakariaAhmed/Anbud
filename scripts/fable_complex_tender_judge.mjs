#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
function valueAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

const corpusName = valueAfter("--corpus", "complex-tender-corpus");
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

const evaluationPath = path.resolve(
  repositoryRoot,
  valueAfter(
    "--evaluation",
    `reports/${corpusName}-evaluation.json`,
  ),
);
const outputPath = path.resolve(
  repositoryRoot,
  valueAfter(
    "--output",
    `reports/${corpusName}-fable-judge.json`,
  ),
);

const [evaluationText, answerKeysText] = await Promise.all([
  readFile(evaluationPath, "utf8"),
  readFile(path.join(fixtureRoot, "answer-keys.json"), "utf8"),
]);
const evaluation = JSON.parse(evaluationText);
const answerKeys = JSON.parse(answerKeysText);

if (evaluation.scenarios?.length !== 5 || answerKeys.length !== 5) {
  throw new Error("Fable-dommeren krever fem analyser og fem fasiter.");
}

const scenarioSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scenario_id: {
      type: "string",
      enum: evaluation.scenarios.map((scenario) => scenario.scenarioId),
    },
    verdict: { type: "string", enum: ["pass", "fail"] },
    scores: {
      type: "object",
      additionalProperties: false,
      properties: {
        grammar: { type: "integer", minimum: 1, maximum: 10 },
        punctuation: { type: "integer", minimum: 1, maximum: 10 },
        terminology: { type: "integer", minimum: 1, maximum: 10 },
        grounding: { type: "integer", minimum: 1, maximum: 10 },
        completeness: { type: "integer", minimum: 1, maximum: 10 },
        specificity: { type: "integer", minimum: 1, maximum: 10 },
        solution_fit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: [
        "grammar",
        "punctuation",
        "terminology",
        "grounding",
        "completeness",
        "specificity",
        "solution_fit",
      ],
    },
    objective_language_error_count: { type: "integer", minimum: 0 },
    grounding_issue_count: { type: "integer", minimum: 0 },
    forbidden_claim_count: { type: "integer", minimum: 0 },
    missing_critical_facts: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
    },
    objective_issues: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: [
              "language",
              "grounding",
              "completeness",
              "forbidden_claim",
              "solution_fit",
            ],
          },
          exact_quote: { type: "string" },
          explanation: { type: "string" },
          correction: { type: "string" },
        },
        required: ["category", "exact_quote", "explanation", "correction"],
      },
    },
    strengths: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
    },
    guidance: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
    },
    summary: { type: "string" },
  },
  required: [
    "scenario_id",
    "verdict",
    "scores",
    "objective_language_error_count",
    "grounding_issue_count",
    "forbidden_claim_count",
    "missing_critical_facts",
    "objective_issues",
    "strengths",
    "guidance",
    "summary",
  ],
};

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall_verdict: { type: "string", enum: ["pass", "fail"] },
    overall_score: { type: "integer", minimum: 0, maximum: 100 },
    scenario_judgments: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: scenarioSchema,
    },
    cross_scenario_strengths: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
    },
    cross_scenario_guidance: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
    },
    summary: { type: "string" },
  },
  required: [
    "overall_verdict",
    "overall_score",
    "scenario_judgments",
    "cross_scenario_strengths",
    "cross_scenario_guidance",
    "summary",
  ],
};

const systemPrompt = [
  "Du er en uavhengig norsk språkrevisor, senior tilbudsleder og løsningsarkitekt.",
  "Vurder hver kundeanalyse mot Bilag 1 og scenariofasiten.",
  "Skill strengt mellom objektive feil, manglende kritisk informasjon og valgfri stilforbedring.",
  "Rapporter en språkfeil bare når du kan sitere den nøyaktig og gi en entydig rettelse.",
  "Trekk hardt for oppdiktede fakta, teknologier, valgte opsjoner eller beslutninger som fasiten sier ikke må påstås.",
  "En kundeanalyse skal fange beslutningsrelevante fakta og anbefalt retning, men trenger ikke gjengi alle tolv krav ordrett.",
  "Vurder solution_fit mot fasitens intensjon og kontroller, ikke mot leverandørens produktnavn.",
  "Sett et scenario til fail ved objektive språkfeil, vesentlig grunnlagsbrudd, forbudt påstand eller hvis kritiske fakta utelates slik at løsningsretningen blir misvisende.",
  "Overall pass krever at minst fire scenarioer passerer og at ingen forbudt påstand eller alvorlig grunnlagsfeil finnes.",
].join(" ");

const blocks = [];
for (const scenarioResult of evaluation.scenarios) {
  const answerKey = answerKeys.find(
    (item) => item.scenario_id === scenarioResult.scenarioId,
  );
  const bilag1 = await readFile(
    path.join(fixtureRoot, `${scenarioResult.scenarioId}_bilag1.txt`),
    "utf8",
  );
  blocks.push(
    [
      `=== SCENARIO ${scenarioResult.scenarioId} ===`,
      "BILAG 1:",
      bilag1,
      "FASIT:",
      JSON.stringify(answerKey, null, 2),
      "KUNDEANALYSE:",
      JSON.stringify(scenarioResult.ai?.output ?? null, null, 2),
      "DETERMINISTISK FORHÅNDSSCORE:",
      JSON.stringify(scenarioResult.ai?.answerKeyScore ?? null, null, 2),
    ].join("\n"),
  );
}
const userPrompt = [
  "Vurder de fem scenarioene. Returner bare data som følger JSON-skjemaet.",
  "Bruk den deterministiske forhåndsscoren som et signal, men kontroller selv om et påstått manglende faktum faktisk er beslutningskritisk.",
  ...blocks,
].join("\n\n");

function runFable() {
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
        "5",
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

const { stdout, stderr } = await runFable();
const cliResult = JSON.parse(stdout);
const judgment =
  cliResult.structured_output ??
  (typeof cliResult.result === "string"
    ? JSON.parse(cliResult.result)
    : cliResult.result);
if (!judgment || typeof judgment !== "object") {
  throw new Error("Claude Fable returnerte ikke en strukturert dom.");
}

const report = {
  generatedAt: new Date().toISOString(),
  judge: {
    cli: "Claude Code",
    model: "claude-fable-5",
    effort: "medium",
    tools: "disabled",
  },
  source: {
    evaluation: path.relative(repositoryRoot, evaluationPath),
    answerKeys: `output/pdf/${corpusName}/answer-keys.json`,
  },
  cliMetadata: {
    sessionId: cliResult.session_id ?? null,
    totalCostUsd: cliResult.total_cost_usd ?? null,
    durationMs: cliResult.duration_ms ?? null,
    usage: cliResult.usage ?? null,
    stderr: stderr.trim() || null,
  },
  judgment,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({
    outputPath,
    overallVerdict: judgment.overall_verdict,
    overallScore: judgment.overall_score,
    scenarioVerdicts: judgment.scenario_judgments.map((item) => ({
      scenarioId: item.scenario_id,
      verdict: item.verdict,
    })),
    costUsd: cliResult.total_cost_usd ?? null,
  }),
);
