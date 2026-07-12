import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));

const jiti = createJiti(path.join(frontendRoot, "project-api-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
  },
});

const {
  fetchCustomerAnalysis,
  fetchGeneratedArtifacts,
  fetchProjectServices,
  fetchSolutionEvaluation,
  readJsonPayload,
  watchProjectJob,
} = jiti(path.join(frontendRoot, "lib/client/project-api.ts"));
const { isDocumentReadyForEvaluation } = jiti(
  path.join(frontendRoot, "lib/document-processing.ts"),
);

test("readJsonPayload maps JSON detail errors to the shared error field", async () => {
  const payload = await readJsonPayload(
    new Response(JSON.stringify({ detail: "Unsupported content type" }), {
      status: 415,
      headers: { "content-type": "application/json" },
    }),
    "Kunne ikke starte jobben.",
  );

  assert.equal(
    payload.error,
    "Kunne ikke starte jobben. Serveren mottok en forespørsel med feil innholdstype. Last siden på nytt og prøv igjen.",
  );
});

test("readJsonPayload parses non-json JSON text errors", async () => {
  const payload = await readJsonPayload(
    new Response('{"detail":"Unsupported content type"}', {
      status: 415,
      headers: { "content-type": "text/plain" },
    }),
    "Kunne ikke laste opp dokumentet.",
  );

  assert.equal(
    payload.error,
    "Kunne ikke laste opp dokumentet. Serveren mottok en forespørsel med feil innholdstype. Last siden på nytt og prøv igjen.",
  );
});

test("signal-bound project reads bypass shared pending requests", async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  const cacheModes = [];
  globalThis.fetch = async (_url, init) => {
    signals.push(init?.signal);
    cacheModes.push(init?.cache);
    return new Response(JSON.stringify({ analysis: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const first = new AbortController();
    const second = new AbortController();
    await Promise.all([
      fetchCustomerAnalysis("signal-project", { signal: first.signal }),
      fetchCustomerAnalysis("signal-project", { signal: second.signal }),
    ]);

    assert.equal(signals.length, 2);
    assert.equal(signals[0], first.signal);
    assert.equal(signals[1], second.signal);
    assert.deepEqual(cacheModes, ["no-store", "no-store"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signal-bound project reads reuse an existing unsignaled prefetch", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return new Response(JSON.stringify({ analysis: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const prefetched = fetchCustomerAnalysis("dedupe-prefetch-project");
    const controller = new AbortController();
    const activeRead = fetchCustomerAnalysis("dedupe-prefetch-project", {
      signal: controller.signal,
    });

    assert.equal(fetchCount, 1);
    resolveFetch();
    assert.deepEqual(await Promise.all([prefetched, activeRead]), [null, null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service reads reuse an existing unsignaled prefetch", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  let fetchCount = 0;
  const requestOptions = [];
  globalThis.fetch = async (_url, init) => {
    fetchCount += 1;
    requestOptions.push(init);
    await new Promise((resolve) => {
      resolveFetch = resolve;
    });
    return new Response(JSON.stringify({ services: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const prefetched = fetchProjectServices("service-prefetch-project");
    const controller = new AbortController();
    const activeRead = fetchProjectServices("service-prefetch-project", {
      signal: controller.signal,
    });

    assert.equal(fetchCount, 1);
    assert.equal(requestOptions[0]?.cache, "no-store");
    resolveFetch();
    assert.deepEqual(await Promise.all([prefetched, activeRead]), [[], []]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated artifact reads request only the selected artifact type", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ artifacts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await fetchGeneratedArtifacts("artifact-type-project", {
      artifactType: "bilag1_rekonstruksjon",
    });

    assert.match(
      requestedUrl,
      /\/api\/projects\/artifact-type-project\/generate\?artifact_type=bilag1_rekonstruksjon$/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forced generated artifact refresh bypasses the 30 second client cache", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        artifacts: [{ id: `artifact-v${fetchCount}` }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const first = await fetchGeneratedArtifacts("force-artifact-project", {
      artifactType: "forbedret_kravsvar",
    });
    const cached = await fetchGeneratedArtifacts("force-artifact-project", {
      artifactType: "forbedret_kravsvar",
    });
    const refreshed = await fetchGeneratedArtifacts("force-artifact-project", {
      artifactType: "forbedret_kravsvar",
      forceRefresh: true,
    });

    assert.equal(fetchCount, 2);
    assert.equal(first[0].id, "artifact-v1");
    assert.equal(cached[0].id, "artifact-v1");
    assert.equal(refreshed[0].id, "artifact-v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("older prefetch cannot overwrite or detach a newer forced artifact refresh", async () => {
  const originalFetch = globalThis.fetch;
  const resolvers = [];
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    const requestNumber = fetchCount;
    await new Promise((resolve) => resolvers.push(resolve));
    return new Response(
      JSON.stringify({
        artifacts: [
          {
            id: `artifact-v${requestNumber}`,
            artifact_type: "forbedret_kravsvar",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const projectId = "artifact-latest-response-project";
    const oldPrefetch = fetchGeneratedArtifacts(projectId, {
      artifactType: "forbedret_kravsvar",
    });
    const forcedRefresh = fetchGeneratedArtifacts(projectId, {
      artifactType: "forbedret_kravsvar",
      forceRefresh: true,
    });
    assert.equal(fetchCount, 2);

    resolvers[0]();
    assert.equal((await oldPrefetch)[0].id, "artifact-v1");

    const readWhileForcedRefreshIsPending = fetchGeneratedArtifacts(projectId, {
      artifactType: "forbedret_kravsvar",
    });
    assert.equal(fetchCount, 2);
    resolvers[1]();
    const [forced, shared] = await Promise.all([
      forcedRefresh,
      readWhileForcedRefreshIsPending,
    ]);
    assert.equal(forced[0].id, "artifact-v2");
    assert.equal(shared[0].id, "artifact-v2");

    const cached = await fetchGeneratedArtifacts(projectId, {
      artifactType: "forbedret_kravsvar",
    });
    assert.equal(fetchCount, 2);
    assert.equal(cached[0].id, "artifact-v2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only RAG-ready documents can start solution evaluation", () => {
  assert.equal(
    isDocumentReadyForEvaluation({ processing_status: "queued" }),
    false,
  );
  assert.equal(
    isDocumentReadyForEvaluation({ processing_status: "processing" }),
    false,
  );
  assert.equal(
    isDocumentReadyForEvaluation({ processing_status: "failed" }),
    false,
  );
  assert.equal(
    isDocumentReadyForEvaluation({ processing_status: "basic_ready" }),
    true,
  );
  assert.equal(
    isDocumentReadyForEvaluation({ processing_status: "enhanced_ready" }),
    true,
  );
});

test("a failed solution evaluation GET remains retryable", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(JSON.stringify({ error: "Midlertidig feil" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ evaluation: { summary: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      fetchSolutionEvaluation("retryable-evaluation-project"),
      /Midlertidig feil/,
    );
    assert.deepEqual(
      await fetchSolutionEvaluation("retryable-evaluation-project"),
      { summary: "ok" },
    );
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal job states invalidate cached and pending project reads", async () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  const originalWindow = globalThis.window;

  class FakeEventSource {
    static CLOSED = 2;
    static instances = [];

    constructor() {
      this.listeners = new Map();
      this.readyState = 1;
      FakeEventSource.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }

    emitJob(job) {
      for (const listener of this.listeners.get("job") ?? []) {
        listener({ data: JSON.stringify({ job }) });
      }
    }

    emitError() {
      for (const listener of this.listeners.get("error") ?? []) {
        listener({});
      }
    }
  }

  globalThis.EventSource = FakeEventSource;
  globalThis.window = { EventSource: FakeEventSource };

  try {
    for (const status of ["completed", "failed"]) {
      const projectId = `terminal-${status}-project`;
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(
          JSON.stringify({ evaluation: { revision: fetchCount } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      assert.deepEqual(await fetchSolutionEvaluation(projectId), { revision: 1 });
      assert.deepEqual(await fetchSolutionEvaluation(projectId), { revision: 1 });
      assert.equal(fetchCount, 1);

      const watched = watchProjectJob({
        projectId,
        jobId: `job-${status}`,
        onStatus() {},
      });
      const source = FakeEventSource.instances.at(-1);
      source.emitJob({
        id: `job-${status}`,
        kind: "solution_evaluation",
        status,
        message: status,
        error: status === "failed" ? "Jobben feilet" : null,
        result: status === "completed" ? { evaluation: {} } : null,
      });

      if (status === "failed") {
        await assert.rejects(watched, /Jobben feilet/);
      } else {
        await watched;
      }

      assert.deepEqual(await fetchSolutionEvaluation(projectId), { revision: 2 });
      assert.equal(fetchCount, 2);
    }

    const pollingProjectId = "terminal-polling-project";
    let evaluationFetchCount = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/jobs/")) {
        return new Response(
          JSON.stringify({
            job: {
              id: "job-polling",
              kind: "solution_evaluation",
              status: "completed",
              message: "completed",
              error: null,
              result: { evaluation: {} },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      evaluationFetchCount += 1;
      return new Response(
        JSON.stringify({ evaluation: { revision: evaluationFetchCount } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.window = {
      EventSource: FakeEventSource,
      setTimeout(callback) {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout() {},
    };

    assert.deepEqual(await fetchSolutionEvaluation(pollingProjectId), {
      revision: 1,
    });
    const polled = watchProjectJob({
      projectId: pollingProjectId,
      jobId: "job-polling",
      onStatus() {},
    });
    FakeEventSource.instances.at(-1).emitError();
    await polled;
    assert.deepEqual(await fetchSolutionEvaluation(pollingProjectId), {
      revision: 2,
    });
    assert.equal(evaluationFetchCount, 2);

    const pendingProjectId = "terminal-pending-read-project";
    let releasePendingRead;
    let pendingFetchCount = 0;
    globalThis.fetch = async () => {
      pendingFetchCount += 1;
      if (pendingFetchCount === 1) {
        await new Promise((resolve) => {
          releasePendingRead = resolve;
        });
      }
      return new Response(
        JSON.stringify({ evaluation: { revision: pendingFetchCount } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.window = { EventSource: FakeEventSource };

    const staleRead = fetchSolutionEvaluation(pendingProjectId);
    const pendingTerminalJob = watchProjectJob({
      projectId: pendingProjectId,
      jobId: "job-pending-read",
      onStatus() {},
    });
    FakeEventSource.instances.at(-1).emitJob({
      id: "job-pending-read",
      kind: "solution_evaluation",
      status: "completed",
      message: "completed",
      error: null,
      result: { evaluation: {} },
    });
    await pendingTerminalJob;
    releasePendingRead();
    assert.deepEqual(await staleRead, { revision: 1 });
    assert.deepEqual(await fetchSolutionEvaluation(pendingProjectId), {
      revision: 2,
    });
    assert.equal(pendingFetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) {
      delete globalThis.EventSource;
    } else {
      globalThis.EventSource = originalEventSource;
    }
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});
