import type { ProjectWorkflowInput } from "@/lib/server/use-cases/project-workflows";
import type { ProjectJobRecord } from "@/lib/types";

type RequirementResponseHandoffTerminalMetadata = {
  outcome: "not_needed" | "completed" | "failed_closed";
  terminal_reason:
    | "deadline_exceeded"
    | "call_budget_exhausted"
    | "repair_unresolved"
    | null;
  configured_call_budget: number;
  configured_deadline_ms: number;
  configured_concurrency: number;
  strict_candidates: number;
  calls_started: number;
  repairs_accepted: number;
  calls_without_accepted_repair: number;
  skipped_call_budget: number;
  skipped_deadline: number;
  unresolved_after_handoff: number;
};

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function sanitizeRequirementResponseHandoffMetadata(
  value: unknown,
): RequirementResponseHandoffTerminalMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const outcome = input.outcome;
  const terminalReason = input.terminal_reason;
  if (
    outcome !== "not_needed" &&
    outcome !== "completed" &&
    outcome !== "failed_closed"
  ) {
    return null;
  }
  if (
    terminalReason !== null &&
    terminalReason !== "deadline_exceeded" &&
    terminalReason !== "call_budget_exhausted" &&
    terminalReason !== "repair_unresolved"
  ) {
    return null;
  }

  const configuredCallBudget = nonNegativeInteger(
    input.configured_call_budget,
  );
  const configuredDeadlineMs = nonNegativeInteger(
    input.configured_deadline_ms,
  );
  const configuredConcurrency = nonNegativeInteger(
    input.configured_concurrency,
  );
  const strictCandidates = nonNegativeInteger(input.strict_candidates);
  const callsStarted = nonNegativeInteger(input.calls_started);
  const repairsAccepted = nonNegativeInteger(input.repairs_accepted);
  const callsWithoutAcceptedRepair = nonNegativeInteger(
    input.calls_without_accepted_repair,
  );
  const skippedCallBudget = nonNegativeInteger(input.skipped_call_budget);
  const skippedDeadline = nonNegativeInteger(input.skipped_deadline);
  const unresolvedAfterHandoff = nonNegativeInteger(
    input.unresolved_after_handoff,
  );
  if (
    configuredCallBudget === null ||
    configuredCallBudget > 32 ||
    configuredDeadlineMs === null ||
    configuredDeadlineMs < 10_000 ||
    configuredDeadlineMs > 300_000 ||
    configuredConcurrency === null ||
    configuredConcurrency < 1 ||
    configuredConcurrency > 4 ||
    strictCandidates === null ||
    callsStarted === null ||
    repairsAccepted === null ||
    callsWithoutAcceptedRepair === null ||
    skippedCallBudget === null ||
    skippedDeadline === null ||
    unresolvedAfterHandoff === null ||
    callsStarted > configuredCallBudget ||
    repairsAccepted > callsStarted ||
    callsWithoutAcceptedRepair !== callsStarted - repairsAccepted ||
    callsStarted + skippedCallBudget + skippedDeadline > strictCandidates
  ) {
    return null;
  }

  const outcomeIsValid =
    (outcome === "not_needed" &&
      terminalReason === null &&
      strictCandidates === 0 &&
      callsStarted === 0 &&
      repairsAccepted === 0 &&
      skippedCallBudget === 0 &&
      skippedDeadline === 0 &&
      unresolvedAfterHandoff === 0) ||
    (outcome === "completed" &&
      terminalReason === null &&
      strictCandidates > 0 &&
      unresolvedAfterHandoff === 0) ||
    (outcome === "failed_closed" &&
      terminalReason !== null &&
      unresolvedAfterHandoff > 0 &&
      (terminalReason !== "call_budget_exhausted" ||
        skippedCallBudget > 0) &&
      (terminalReason !== "repair_unresolved" ||
        (skippedCallBudget === 0 && skippedDeadline === 0)));
  if (!outcomeIsValid) {
    return null;
  }

  return {
    outcome,
    terminal_reason: terminalReason,
    configured_call_budget: configuredCallBudget,
    configured_deadline_ms: configuredDeadlineMs,
    configured_concurrency: configuredConcurrency,
    strict_candidates: strictCandidates,
    calls_started: callsStarted,
    repairs_accepted: repairsAccepted,
    calls_without_accepted_repair: callsWithoutAcceptedRepair,
    skipped_call_budget: skippedCallBudget,
    skipped_deadline: skippedDeadline,
    unresolved_after_handoff: unresolvedAfterHandoff,
  };
}

export class ProjectWorkflowTerminalMetadataError extends Error {
  readonly projectJobTerminalMetadata: Record<string, unknown>;

  constructor(
    message: string,
    metadata: { requirement_response_handoff?: unknown },
  ) {
    super(message);
    this.name = "ProjectWorkflowTerminalMetadataError";
    const requirementResponseHandoff =
      sanitizeRequirementResponseHandoffMetadata(
        metadata.requirement_response_handoff,
      );
    this.projectJobTerminalMetadata = requirementResponseHandoff
      ? { requirement_response_handoff: requirementResponseHandoff }
      : {};
  }
}

export function projectJobTerminalMetadataFromError(error: unknown) {
  if (!error || typeof error !== "object") {
    return {};
  }
  const raw = (error as { projectJobTerminalMetadata?: unknown })
    .projectJobTerminalMetadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const requirementResponseHandoff =
    sanitizeRequirementResponseHandoffMetadata(
      (raw as Record<string, unknown>).requirement_response_handoff,
    );
  return requirementResponseHandoff
    ? { requirement_response_handoff: requirementResponseHandoff }
    : {};
}

export function sanitizeProjectJobTerminalMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (
    input.schema_version !== 1 ||
    typeof input.produced_solution_evaluation !== "boolean"
  ) {
    return null;
  }
  const producedSolutionEvaluation = input.produced_solution_evaluation;
  const solutionDocumentId = input.solution_document_id;
  if (
    (producedSolutionEvaluation &&
      (typeof solutionDocumentId !== "string" ||
        !solutionDocumentId.trim())) ||
    (!producedSolutionEvaluation && solutionDocumentId !== null)
  ) {
    return null;
  }

  const hasRequirementResponseHandoff = Object.prototype.hasOwnProperty.call(
    input,
    "requirement_response_handoff",
  );
  const requirementResponseHandoff = hasRequirementResponseHandoff
    ? sanitizeRequirementResponseHandoffMetadata(
        input.requirement_response_handoff,
      )
    : null;
  if (hasRequirementResponseHandoff && !requirementResponseHandoff) {
    return null;
  }

  return {
    ...(requirementResponseHandoff
      ? { requirement_response_handoff: requirementResponseHandoff }
      : {}),
    schema_version: 1,
    produced_solution_evaluation: producedSolutionEvaluation,
    solution_document_id: producedSolutionEvaluation
      ? (solutionDocumentId as string).trim()
      : null,
  };
}

export function buildProjectJobTerminalMetadata(
  workflow: ProjectWorkflowInput,
  patch: Partial<ProjectJobRecord>,
  failureMetadata: Record<string, unknown> = {},
) {
  const completed = patch.status === "completed";
  const result = patch.result;
  const evaluation =
    completed &&
    result &&
    typeof result === "object" &&
    "evaluation" in result &&
    result.evaluation &&
    typeof result.evaluation === "object"
      ? (result.evaluation as { solution_document_id?: unknown })
      : null;
  const producedSolutionEvaluation =
    completed &&
    (workflow.kind === "solution_evaluation" ||
      (workflow.kind === "perfect_system_solution" && Boolean(evaluation)));
  const solutionDocumentId = producedSolutionEvaluation
    ? typeof evaluation?.solution_document_id === "string"
      ? evaluation.solution_document_id
      : workflow.kind === "solution_evaluation"
        ? (workflow.solutionDocumentId ?? null)
        : null
    : null;

  return {
    ...projectJobTerminalMetadataFromError({
      projectJobTerminalMetadata: failureMetadata,
    }),
    schema_version: 1,
    produced_solution_evaluation: producedSolutionEvaluation,
    solution_document_id: solutionDocumentId,
  };
}
