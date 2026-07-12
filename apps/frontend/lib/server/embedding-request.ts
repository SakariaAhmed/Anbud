import "server-only";

export type EmbeddingRequestRuntime = {
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const EMBEDDING_FAILURE_AT_KEY = "embedding_failure_at";
const EMBEDDING_FAILURE_REASON_KEY = "embedding_failure_reason";
const EMBEDDING_RETRY_AFTER_KEY = "embedding_retry_after";

const defaultRuntime: EmbeddingRequestRuntime = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class EmbeddingRequestTimeoutError extends Error {
  readonly code = "EMBEDDING_REQUEST_TIMEOUT";
  readonly timeoutMs: number;
  readonly scope: "request" | "operation";

  constructor(
    timeoutMs: number,
    scope: "request" | "operation" = "request",
  ) {
    super(
      scope === "operation"
        ? `Embedding-operasjonen nådde totalfristen etter ${timeoutMs} ms.`
        : `Embedding-kallet overskred fristen på ${timeoutMs} ms.`,
    );
    this.name = "EmbeddingRequestTimeoutError";
    this.timeoutMs = timeoutMs;
    this.scope = scope;
  }
}

export function createMemoizedEmbeddingRequest<T>(request: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= request();
    return pending;
  };
}

export function embeddingFallbackMetadata(input: {
  metadata: Record<string, unknown>;
  reason: string;
  failedAtMs: number;
  retryAfterMs: number;
}) {
  return {
    ...input.metadata,
    [EMBEDDING_FAILURE_AT_KEY]: new Date(input.failedAtMs).toISOString(),
    [EMBEDDING_FAILURE_REASON_KEY]: input.reason,
    [EMBEDDING_RETRY_AFTER_KEY]: new Date(input.retryAfterMs).toISOString(),
  };
}

export function isEmbeddingRetryDeferred(
  metadata: unknown,
  nowMs = Date.now(),
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const retryAfter = (metadata as Record<string, unknown>)[
    EMBEDDING_RETRY_AFTER_KEY
  ];
  if (typeof retryAfter !== "string") {
    return false;
  }
  const retryAfterMs = Date.parse(retryAfter);
  return Number.isFinite(retryAfterMs) && retryAfterMs > nowMs;
}

function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  const error = new Error("Embedding-kallet ble avbrutt.");
  error.name = "AbortError";
  return error;
}

/**
 * Enforces a wall-clock deadline independently of the OpenAI SDK's timeout.
 * The request signal is still aborted so a compliant transport can release its
 * socket, while the Promise race guarantees that an uncooperative transport
 * cannot keep document ingestion waiting.
 */
export async function runEmbeddingRequestWithDeadline<T>(input: {
  timeoutMs: number;
  timeoutScope?: "request" | "operation";
  workflowSignal?: AbortSignal;
  request: (signal: AbortSignal) => Promise<T>;
  runtime?: EmbeddingRequestRuntime;
}) {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError("Embedding-fristen må være større enn 0 ms.");
  }

  input.workflowSignal?.throwIfAborted();

  const runtime = input.runtime ?? defaultRuntime;
  const requestController = new AbortController();
  const forwardWorkflowAbort = () => {
    requestController.abort(input.workflowSignal?.reason);
  };
  input.workflowSignal?.addEventListener("abort", forwardWorkflowAbort, {
    once: true,
  });

  let rejectOnAbort: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onRequestAbort = () => {
    rejectOnAbort?.(abortReason(requestController.signal));
  };
  requestController.signal.addEventListener("abort", onRequestAbort, {
    once: true,
  });

  const timeoutError = new EmbeddingRequestTimeoutError(
    input.timeoutMs,
    input.timeoutScope,
  );
  const timeoutHandle = runtime.setTimeout(() => {
    requestController.abort(timeoutError);
  }, input.timeoutMs);

  try {
    const request = input.request(requestController.signal);
    return await Promise.race([request, aborted]);
  } finally {
    runtime.clearTimeout(timeoutHandle);
    requestController.signal.removeEventListener("abort", onRequestAbort);
    input.workflowSignal?.removeEventListener("abort", forwardWorkflowAbort);
  }
}
