import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type ProjectWorkflowLease = {
  jobId: string;
  leaseToken: string;
  projectId: string;
};

type ProjectWorkflowContext = {
  signal: AbortSignal;
  /** Epoch ms when the workflow's total deadline aborts the job. */
  deadlineAt?: number;
  lease?: ProjectWorkflowLease;
  reportTerminalMetadata?: (metadata: Record<string, unknown>) => void;
};

const projectWorkflowContexts = new AsyncLocalStorage<ProjectWorkflowContext>();

export function runWithProjectWorkflowContext<T>(
  context: ProjectWorkflowContext,
  run: () => T,
) {
  return projectWorkflowContexts.run(context, run);
}

export function getProjectWorkflowAbortSignal() {
  return projectWorkflowContexts.getStore()?.signal;
}

export function getProjectWorkflowLease() {
  return projectWorkflowContexts.getStore()?.lease;
}

export function bindProjectWorkflowTerminalMetadataReporter() {
  const reportTerminalMetadata =
    projectWorkflowContexts.getStore()?.reportTerminalMetadata;
  return (metadata: Record<string, unknown>) => {
    reportTerminalMetadata?.(metadata);
  };
}

/** Milliseconds left before the workflow deadline; Infinity outside a job. */
export function projectWorkflowRemainingMs(now = Date.now()) {
  const deadlineAt = projectWorkflowContexts.getStore()?.deadlineAt;
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - now;
}

/**
 * Caps an AI call timeout so the call ends before the job deadline, leaving
 * `reserveMs` for later stages and persistence. Returns null when less than
 * `minimumMs` would remain: the caller must not start the call, so the job
 * can finish deliberately instead of being aborted by the deadline.
 */
export function boundedByProjectWorkflowDeadline(
  stageTimeoutMs: number,
  options: { reserveMs?: number; minimumMs?: number; now?: number } = {},
) {
  const reserveMs = options.reserveMs ?? 60_000;
  const minimumMs = options.minimumMs ?? 20_000;
  const available = projectWorkflowRemainingMs(options.now) - reserveMs;
  const timeoutMs = Math.min(stageTimeoutMs, available);
  return timeoutMs >= minimumMs ? Math.floor(timeoutMs) : null;
}

export function assertProjectWorkflowActive() {
  getProjectWorkflowAbortSignal()?.throwIfAborted();
}
