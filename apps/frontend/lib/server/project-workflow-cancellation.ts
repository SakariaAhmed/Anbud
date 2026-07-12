import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

export type ProjectWorkflowLease = {
  jobId: string;
  leaseToken: string;
  projectId: string;
};

type ProjectWorkflowContext = {
  signal: AbortSignal;
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

export function assertProjectWorkflowActive() {
  getProjectWorkflowAbortSignal()?.throwIfAborted();
}
