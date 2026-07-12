import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "embedding-request-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  createMemoizedEmbeddingRequest,
  embeddingFallbackMetadata,
  EmbeddingRequestTimeoutError,
  isEmbeddingRetryDeferred,
  runEmbeddingRequestWithDeadline,
} = jiti(path.join(frontendRoot, "lib/server/embedding-request.ts"));
const { assertEmbeddingFallbackAllowed } = jiti(
  path.join(frontendRoot, "lib/server/document-chunks.ts"),
);
const { ProjectJobLeaseLostError } = jiti(
  path.join(frontendRoot, "lib/server/project-job-heartbeat.ts"),
);
const { runWithProjectWorkflowContext } = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-cancellation.ts"),
);

function fakeTimerRuntime() {
  let nextHandle = 0;
  const callbacks = new Map();

  return {
    runtime: {
      setTimeout(callback) {
        nextHandle += 1;
        callbacks.set(nextHandle, callback);
        return nextHandle;
      },
      clearTimeout(handle) {
        callbacks.delete(handle);
      },
    },
    runNext() {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, "expected a pending fake timer");
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback();
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

test("embedding deadline fails promptly and aborts a hung SDK request", async () => {
  const timer = fakeTimerRuntime();
  let requestSignal;
  const pending = runEmbeddingRequestWithDeadline({
    timeoutMs: 12_000,
    runtime: timer.runtime,
    request: async (signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    },
  });

  timer.runNext();

  await assert.rejects(
    pending,
    (error) =>
      error instanceof EmbeddingRequestTimeoutError &&
      error.code === "EMBEDDING_REQUEST_TIMEOUT" &&
      error.timeoutMs === 12_000,
  );
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.name, "EmbeddingRequestTimeoutError");
  assert.equal(timer.pendingCount(), 0);
});

test("embedding deadline preserves the workflow abort reason", async () => {
  const timer = fakeTimerRuntime();
  const workflow = new AbortController();
  const leaseLost = new Error("lease lost");
  let requestSignal;
  const pending = runEmbeddingRequestWithDeadline({
    timeoutMs: 12_000,
    workflowSignal: workflow.signal,
    runtime: timer.runtime,
    request: async (signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    },
  });

  workflow.abort(leaseLost);

  await assert.rejects(pending, (error) => error === leaseLost);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, leaseLost);
  assert.equal(timer.pendingCount(), 0);
});

test("embedding deadline returns a successful response and clears its timer", async () => {
  const timer = fakeTimerRuntime();
  const result = await runEmbeddingRequestWithDeadline({
    timeoutMs: 12_000,
    runtime: timer.runtime,
    request: async (signal) => {
      assert.equal(signal.aborted, false);
      return { data: [{ embedding: [0.1, 0.2] }] };
    },
  });

  assert.deepEqual(result, { data: [{ embedding: [0.1, 0.2] }] });
  assert.equal(timer.pendingCount(), 0);
});

test("query embedding request is memoized after success or failure", async () => {
  let successCalls = 0;
  const successful = createMemoizedEmbeddingRequest(async () => {
    successCalls += 1;
    return [0.1, 0.2];
  });

  const [firstSuccess, secondSuccess] = await Promise.all([
    successful(),
    successful(),
  ]);
  assert.deepEqual(firstSuccess, [0.1, 0.2]);
  assert.equal(firstSuccess, secondSuccess);
  assert.equal(successCalls, 1);

  let failureCalls = 0;
  const failure = new Error("embedding unavailable");
  const failed = createMemoizedEmbeddingRequest(async () => {
    failureCalls += 1;
    throw failure;
  });
  const firstFailure = failed();
  const secondFailure = failed();

  await assert.rejects(
    Promise.all([firstFailure, secondFailure]),
    (error) => error === failure,
  );
  await assert.rejects(failed(), (error) => error === failure);
  assert.equal(firstFailure, secondFailure);
  assert.equal(failureCalls, 1);
});

test("embedding fallback rethrows workflow and authoritative lease loss", () => {
  const workflow = new AbortController();
  const workflowAbort = new Error("workflow aborted");
  workflow.abort(workflowAbort);

  assert.throws(
    () =>
      runWithProjectWorkflowContext({ signal: workflow.signal }, () =>
        assertEmbeddingFallbackAllowed(new Error("optional failure")),
      ),
    (error) => error === workflowAbort,
  );

  const leaseLost = new ProjectJobLeaseLostError("job-1");
  assert.throws(
    () => assertEmbeddingFallbackAllowed(leaseLost),
    (error) => error === leaseLost,
  );
  assert.doesNotThrow(() =>
    assertEmbeddingFallbackAllowed(new Error("optional failure")),
  );
});

test("fresh lexical fallback metadata defers retry only until backoff expires", () => {
  const failedAtMs = Date.parse("2026-07-11T04:00:00.000Z");
  const retryAfterMs = failedAtMs + 15 * 60_000;
  const metadata = embeddingFallbackMetadata({
    metadata: { content_hash: "abc" },
    reason: "request_timeout",
    failedAtMs,
    retryAfterMs,
  });

  assert.equal(metadata.content_hash, "abc");
  assert.equal(metadata.embedding_failure_reason, "request_timeout");
  assert.equal(
    isEmbeddingRetryDeferred(metadata, retryAfterMs - 1),
    true,
  );
  assert.equal(isEmbeddingRetryDeferred(metadata, retryAfterMs), false);
  assert.equal(
    isEmbeddingRetryDeferred({ embedding_retry_after: "invalid" }, failedAtMs),
    false,
  );
});
