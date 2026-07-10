import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

const projectWorkflowAbortSignals = new AsyncLocalStorage<AbortSignal>();

export function runWithProjectWorkflowAbortSignal<T>(
  signal: AbortSignal,
  run: () => T,
) {
  return projectWorkflowAbortSignals.run(signal, run);
}

export function getProjectWorkflowAbortSignal() {
  return projectWorkflowAbortSignals.getStore();
}

export function assertProjectWorkflowActive() {
  getProjectWorkflowAbortSignal()?.throwIfAborted();
}
