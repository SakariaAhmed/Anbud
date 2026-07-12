import "server-only";

import type {
  ProjectJobRecord,
  SolutionEvaluationJobResult,
} from "@/lib/types";

type DirectSolutionEvaluationWaitRuntime = {
  now: () => number;
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const defaultWaitRuntime: DirectSolutionEvaluationWaitRuntime = {
  now: Date.now,
  delay: (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new DOMException("Avbrutt", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
};

export class DirectSolutionEvaluationWaitTimeoutError extends Error {
  constructor() {
    super("Tidsgrensen for direkte løsningsvurdering ble nådd.");
    this.name = "DirectSolutionEvaluationWaitTimeoutError";
  }
}

export async function waitForDirectSolutionEvaluationTask<T>(input: {
  task: Promise<T>;
  signal: AbortSignal;
  timeoutMs: number;
}) {
  input.signal.throwIfAborted();
  if (input.timeoutMs <= 0) {
    return Promise.reject(new DirectSolutionEvaluationWaitTimeoutError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() =>
        reject(input.signal.reason ?? new DOMException("Avbrutt", "AbortError")),
      );
    const timer = setTimeout(
      () => settle(() => reject(new DirectSolutionEvaluationWaitTimeoutError())),
      input.timeoutMs,
    );

    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    void input.task.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export function requestPrefersAsyncSolutionEvaluation(request: Request) {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .map((token) => token.split(";", 1)[0]?.trim().toLowerCase())
    .some((token) => token === "respond-async");
}

export async function waitForDirectSolutionEvaluationJob(input: {
  initialJob: ProjectJobRecord;
  readJob: () => Promise<ProjectJobRecord | null>;
  signal: AbortSignal;
  timeoutMs: number;
  pollIntervalMs?: number;
  runtime?: DirectSolutionEvaluationWaitRuntime;
}) {
  const runtime = input.runtime ?? defaultWaitRuntime;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const deadline = runtime.now() + input.timeoutMs;
  let job = input.initialJob;

  while (job.status === "queued" || job.status === "running") {
    input.signal.throwIfAborted();
    if (runtime.now() >= deadline) {
      throw new DirectSolutionEvaluationWaitTimeoutError();
    }
    await runtime.delay(pollIntervalMs, input.signal);
    const remainingMs = deadline - runtime.now();
    if (remainingMs <= 0) {
      throw new DirectSolutionEvaluationWaitTimeoutError();
    }
    const refreshed = await waitForDirectSolutionEvaluationTask({
      task: input.readJob(),
      signal: input.signal,
      timeoutMs: remainingMs,
    });
    if (!refreshed) {
      throw new Error("Fant ikke den køede løsningsvurderingen.");
    }
    job = refreshed;
  }

  return job;
}

function isSolutionEvaluationJobResult(
  value: unknown,
): value is SolutionEvaluationJobResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<SolutionEvaluationJobResult>;
  return (
    Boolean(result.evaluation && typeof result.evaluation === "object") &&
    Boolean(result.project && typeof result.project === "object") &&
    result.artifact === null &&
    result.used_generated_solution === false
  );
}

export function legacySolutionEvaluationPayload(job: ProjectJobRecord) {
  if (job.status === "failed") {
    throw new Error(job.error || "Kunne ikke generere løsningsvurdering.");
  }
  if (job.status !== "completed" || !isSolutionEvaluationJobResult(job.result)) {
    throw new Error("Løsningsvurderingen fullførte uten et gyldig resultat.");
  }

  return {
    evaluation: job.result.evaluation,
    project: job.result.project,
    artifact: job.result.artifact,
    used_generated_solution: job.result.used_generated_solution,
  };
}
