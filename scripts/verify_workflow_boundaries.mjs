#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${JSON.stringify(needle)}`);
  }
}

const generateArtifact = read("apps/frontend/lib/server/use-cases/generate-artifact.ts");
const projectWorkflows = read("apps/frontend/lib/server/use-cases/project-workflows.ts");
const projectJobs = read("apps/frontend/lib/server/project-jobs.ts");
const jobsRoute = read("apps/frontend/app/api/projects/[id]/jobs/route.ts");
const generateRoute = read("apps/frontend/app/api/projects/[id]/generate/route.ts");
const solutionEvaluationRoute = read(
  "apps/frontend/app/api/projects/[id]/solution-evaluation/route.ts",
);
const ai = read("apps/frontend/lib/server/ai.ts");
const types = read("apps/frontend/lib/types.ts");
const workflowBoundaries = read("apps/frontend/lib/server/workflow-boundaries.ts");

assertIncludes(
  workflowBoundaries,
  "export function shouldUseSolutionEvaluationForArtifact",
  "requirement answers exclude evaluation by default",
);
assertIncludes(
  workflowBoundaries,
  'input.artifactType !== "forbedret_kravsvar"',
  "requirement answers keep evaluation context out unless explicitly requested",
);
assertIncludes(
  workflowBoundaries,
  "input.useSolutionEvaluationContext === true",
  "requirement answers require explicit evaluation-feedback opt-in",
);
assertIncludes(
  workflowBoundaries,
  "export function solutionEvaluationContextModeForArtifact",
  "workflow boundary exposes evaluation-context mode",
);
assertIncludes(
  generateArtifact,
  "shouldUseSolutionEvaluationForArtifact",
  "artifact generation uses workflow boundary for evaluation context",
);
assertIncludes(
  generateArtifact,
  "solutionEvaluationContextModeForArtifact",
  "artifact generation uses workflow boundary for context mode",
);
assertIncludes(
  generateArtifact,
  "solutionEvaluation: solutionEvaluationForGeneration",
  "artifact generation passes scoped evaluation context",
);
assertIncludes(
  generateArtifact,
  "solution_evaluation_used_as_context",
  "artifact snapshot records evaluation-context usage",
);
assertIncludes(
  generateArtifact,
  "solution_evaluation_context_mode",
  "artifact snapshot records evaluation-context mode",
);

assertIncludes(
  projectWorkflows,
  "function workflowInputRecord(value: unknown): Record<string, unknown>",
  "project workflow inputs are parsed from unknown",
);
assertIncludes(
  projectWorkflows,
  "parseWorkflowArtifactType(input.artifactType)",
  "artifact job parser validates artifact type",
);
assertIncludes(
  projectWorkflows,
  "normalizeSourceDocumentIds(input.sourceDocumentIds)",
  "artifact job parser normalizes source document IDs",
);
const workflowParserBlock = projectWorkflows.slice(
  projectWorkflows.indexOf("export function parseProjectWorkflowInput"),
  projectWorkflows.indexOf("const DEFAULT_DOCLING_COMPLEXITY_MIN_CHARS"),
);
assertNotIncludes(
  workflowParserBlock,
  "return value;",
  "project workflow parser must not trust queued input wholesale",
);
assertNotIncludes(
  projectWorkflows,
  "synthesizeAndEvaluateSolution",
  "solution evaluation must not synthesize a generated solution document",
);
assertNotIncludes(
  projectWorkflows,
  "listGeneratedArtifacts",
  "solution evaluation must not load generated solution artifacts",
);
assertNotIncludes(
  projectWorkflows,
  "systemSolutionArtifact: getLatestSolutionDraft",
  "solution evaluation must not pass a generated solution artifact",
);
assertNotIncludes(
  projectWorkflows,
  "generated_for: \"solution_evaluation_fallback\"",
  "solution evaluation must not save generated fallback solution artifacts",
);
assertNotIncludes(
  projectWorkflows,
  "used_generated_solution: true",
  "solution evaluation result must not report generated solution usage",
);
assertNotIncludes(
  projectWorkflows,
  "allowGeneratedSolution",
  "solution evaluation workflow must not expose generated-solution opt-in",
);
for (const [label, source] of [
  ["project job queue", projectJobs],
  ["jobs API", jobsRoute],
  ["direct solution-evaluation API", solutionEvaluationRoute],
]) {
  assertNotIncludes(
    source,
    "allowGeneratedSolution",
    `${label} must not expose generated-solution opt-in`,
  );
  assertNotIncludes(
    source,
    "allow_generated_solution",
    `${label} must not accept generated-solution opt-in`,
  );
}

for (const [label, source] of [
  ["project job queue", projectJobs],
  ["jobs API", jobsRoute],
  ["direct generate API", generateRoute],
]) {
  assertIncludes(
    source,
    "useSolutionEvaluationContext",
    `${label} exposes explicit evaluation-feedback mode`,
  );
}
assertIncludes(
  jobsRoute,
  "use_solution_evaluation_context",
  "jobs API accepts explicit snake_case feedback flag",
);
assertIncludes(
  generateRoute,
  "use_solution_evaluation_context",
  "direct generate API accepts explicit snake_case feedback flag",
);

assertIncludes(
  types,
  "evaluation_context?:",
  "solution evaluation type carries provenance",
);
assertIncludes(
  workflowBoundaries,
  "export function buildSolutionEvaluationProvenance",
  "workflow boundary builds solution evaluation provenance",
);
assertIncludes(
  ai,
  "buildSolutionEvaluationProvenance",
  "solution evaluation uses shared provenance builder",
);
assertIncludes(
  workflowBoundaries,
  "system_solution_artifact_id: input.systemSolutionArtifact?.id ?? null",
  "solution evaluation pins system-solution artifact provenance",
);
assertIncludes(
  workflowBoundaries,
  "customer_document_id: input.customerDocument.id",
  "solution evaluation pins customer document provenance",
);
assertIncludes(
  workflowBoundaries,
  "solution_document_id: input.solutionDocument.id",
  "solution evaluation pins solution document provenance",
);

console.log(
  JSON.stringify(
    {
      workflow_boundary_checks: "passed",
      checks: [
        "requirement_answer_evaluation_context_opt_in",
        "artifact_snapshot_context_mode",
        "strict_project_workflow_input_parser",
        "solution_evaluation_requires_real_solution_document",
        "evaluation_provenance",
      ],
    },
    null,
    2,
  ),
);
