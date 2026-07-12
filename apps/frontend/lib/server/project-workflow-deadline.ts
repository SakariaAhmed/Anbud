import "server-only";

import type { ProjectJobKind } from "@/lib/types";

export type ProjectWorkflowDeadlineRuntime = {
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const MIN_PROJECT_WORKFLOW_TIMEOUT_MS = 60_000;
const MAX_PROJECT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60_000;

const DEFAULT_PROJECT_WORKFLOW_TIMEOUT_MS = {
  document_ingestion: 15 * 60_000,
  document_docling_enhancement: 30 * 60_000,
  customer_analysis: 15 * 60_000,
  solution_evaluation: 18 * 60_000,
  artifact_generation: 18 * 60_000,
  high_level_design: 18 * 60_000,
  perfect_system_solution: 30 * 60_000,
  executive_summary: 10 * 60_000,
} satisfies Record<ProjectJobKind, number>;

const defaultRuntime: ProjectWorkflowDeadlineRuntime = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ProjectWorkflowDeadlineExceededError extends Error {
  readonly code = "PROJECT_WORKFLOW_DEADLINE_EXCEEDED";
  readonly kind: ProjectJobKind;
  readonly timeoutMs: number;

  constructor(kind: ProjectJobKind, timeoutMs: number) {
    super(
      `Prosjektjobben ${kind} nådde totalfristen etter ${timeoutMs} ms.`,
    );
    this.name = "ProjectWorkflowDeadlineExceededError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

export function isProjectWorkflowDeadlineExceededError(
  error: unknown,
): error is ProjectWorkflowDeadlineExceededError {
  return error instanceof ProjectWorkflowDeadlineExceededError;
}

export function projectWorkflowTimeoutMs(
  kind: ProjectJobKind,
  environment: Record<string, string | undefined> = process.env,
) {
  const kindKey = `PROJECT_JOB_${kind.toUpperCase()}_TIMEOUT_MS`;
  const configured = environment[kindKey] ?? environment.PROJECT_JOB_TIMEOUT_MS;
  if (configured !== undefined && configured.trim()) {
    const parsed = Number(configured);
    if (
      Number.isSafeInteger(parsed) &&
      parsed >= MIN_PROJECT_WORKFLOW_TIMEOUT_MS &&
      parsed <= MAX_PROJECT_WORKFLOW_TIMEOUT_MS
    ) {
      return parsed;
    }
  }

  return DEFAULT_PROJECT_WORKFLOW_TIMEOUT_MS[kind];
}

function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  const error = new Error("Prosjektjobben ble avbrutt.");
  error.name = "AbortError";
  return error;
}

/**
 * Enforces a total wall-clock deadline for a project workflow. The abort signal
 * lets cooperative I/O stop early, while the Promise race also releases the job
 * runner when a parser, storage client, or other phase never settles.
 */
export async function runProjectWorkflowWithDeadline<T>(input: {
  kind: ProjectJobKind;
  workflowSignal?: AbortSignal;
  timeoutMs?: number;
  run: (signal: AbortSignal) => Promise<T>;
  runtime?: ProjectWorkflowDeadlineRuntime;
}) {
  const timeoutMs = input.timeoutMs ?? projectWorkflowTimeoutMs(input.kind);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Workflow-fristen må være større enn 0 ms.");
  }

  input.workflowSignal?.throwIfAborted();

  const runtime = input.runtime ?? defaultRuntime;
  const workflowController = new AbortController();
  const forwardWorkflowAbort = () => {
    workflowController.abort(input.workflowSignal?.reason);
  };
  input.workflowSignal?.addEventListener("abort", forwardWorkflowAbort, {
    once: true,
  });

  let rejectOnAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onWorkflowAbort = () => {
    rejectOnAbort?.(abortReason(workflowController.signal));
  };
  workflowController.signal.addEventListener("abort", onWorkflowAbort, {
    once: true,
  });

  const timeoutError = new ProjectWorkflowDeadlineExceededError(
    input.kind,
    timeoutMs,
  );
  const timeoutHandle = runtime.setTimeout(() => {
    workflowController.abort(timeoutError);
  }, timeoutMs);

  try {
    const workflow = input.run(workflowController.signal);
    return await Promise.race([workflow, aborted]);
  } finally {
    runtime.clearTimeout(timeoutHandle);
    workflowController.signal.removeEventListener("abort", onWorkflowAbort);
    input.workflowSignal?.removeEventListener("abort", forwardWorkflowAbort);
  }
}
