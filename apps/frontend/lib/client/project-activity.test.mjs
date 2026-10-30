import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-activity-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const {
  ACTIVE_PROJECT_POLL_MS,
  IDLE_PROJECT_POLL_MS,
  PROJECT_WAKE_DEBOUNCE_MS,
  createProjectActivityPoller,
  createProjectJobsSource,
  projectActivityPollDelayMs,
  projectWorkflowBlockingReason,
} = jiti(path.join(frontendRoot, "lib/client/project-activity.ts"));
const {
  ProjectApiError,
  fetchProjectJobs,
  invalidateProjectJobsCache,
  isProjectWorkflowBusyError,
  startProjectJob,
} = jiti(path.join(frontendRoot, "lib/client/project-api.ts"));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

/** Timers driven by an explicit clock, so a test can step through time. */
function fakeTimers() {
  let now = 0;
  let nextHandle = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, delayMs) {
        nextHandle += 1;
        pending.set(nextHandle, { callback, at: now + delayMs });
        return nextHandle;
      },
      clearTimeout(handle) { pending.delete(handle); },
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        pending.delete(handle);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = target;
    },
    delays: () => [...pending.values()].map((timer) => timer.at - now),
  };
}

const running = { kind: "customer_analysis", status: "running" };
const queuedDocling = { kind: "document_docling_enhancement", status: "queued" };
const completed = { kind: "executive_summary", status: "completed" };
const readyDocument = { processing_status: "basic_ready" };
const processingDocument = { processing_status: "processing" };

test("blocking reason mirrors the server: any active job first, then unfinished documents", () => {
  assert.equal(projectWorkflowBlockingReason({ jobs: [completed], documents: [readyDocument] }), null);
  assert.equal(
    projectWorkflowBlockingReason({ jobs: [running], documents: [processingDocument] }),
    "Kundeanalysen pågår. Ny generering kan startes når jobben er ferdig.",
  );
  assert.equal(
    projectWorkflowBlockingReason({ jobs: [queuedDocling], documents: [] }),
    "Docling-forbedringen av et dokument står i kø. Ny generering kan startes når jobben er ferdig.",
    "a queued Docling job blocks generation on the server too",
  );
  assert.match(
    projectWorkflowBlockingReason({ jobs: [running, queuedDocling], documents: [] }),
    /^2 jobber pågår eller står i kø/u,
  );
  assert.equal(
    projectWorkflowBlockingReason({ jobs: [completed], documents: [{ processing_status: "queued" }] }),
    "Dokumentbehandlingen er ikke ferdig. Generering kan startes når dokumentene er klare.",
  );
  assert.equal(
    projectWorkflowBlockingReason({ jobs: [], documents: [{ processing_status: "failed" }] }),
    null,
    "a failed document does not block generation on the server",
  );
});

test("polling is fast only while jobs or documents are processing", () => {
  assert.equal(projectActivityPollDelayMs({ jobs: [completed], documents: [readyDocument] }), IDLE_PROJECT_POLL_MS);
  assert.equal(projectActivityPollDelayMs({ jobs: [running], documents: [] }), ACTIVE_PROJECT_POLL_MS);
  assert.equal(projectActivityPollDelayMs({ jobs: [], documents: [processingDocument] }), ACTIVE_PROJECT_POLL_MS);
  assert.ok(ACTIVE_PROJECT_POLL_MS >= 3_000 && ACTIVE_PROJECT_POLL_MS <= 5_000);
  assert.equal(IDLE_PROJECT_POLL_MS, 60_000);
});

test("the poller follows the current activity and schedules after each refresh ends", async () => {
  const clock = fakeTimers();
  let active = true;
  let refreshes = 0;
  const poller = createProjectActivityPoller({
    async refresh() { refreshes += 1; },
    delayMs: () => (active ? ACTIVE_PROJECT_POLL_MS : IDLE_PROJECT_POLL_MS),
    isHidden: () => false,
    timers: clock.timers,
  });

  poller.start();
  assert.equal(refreshes, 0, "the server-rendered state needs no immediate refresh");
  await clock.advance(ACTIVE_PROJECT_POLL_MS * 3);
  assert.equal(refreshes, 3);

  active = false;
  await clock.advance(ACTIVE_PROJECT_POLL_MS);
  assert.equal(refreshes, 4);
  assert.deepEqual(clock.delays(), [IDLE_PROJECT_POLL_MS]);
  await clock.advance(IDLE_PROJECT_POLL_MS - 1);
  assert.equal(refreshes, 4, "idle polling waits for the heartbeat");

  active = true;
  poller.reschedule();
  assert.deepEqual(clock.delays(), [ACTIVE_PROJECT_POLL_MS], "new activity speeds the next run up at once");
  poller.stop();
  assert.deepEqual(clock.delays(), []);
});

test("a hidden page is not polled and one debounced refresh follows focus and visibility", async () => {
  const clock = fakeTimers();
  let hidden = false;
  let refreshes = 0;
  const poller = createProjectActivityPoller({
    async refresh() { refreshes += 1; },
    delayMs: () => ACTIVE_PROJECT_POLL_MS,
    isHidden: () => hidden,
    timers: clock.timers,
  });
  poller.start();

  hidden = true;
  poller.sleep();
  await clock.advance(10 * IDLE_PROJECT_POLL_MS);
  assert.equal(refreshes, 0);
  poller.wake();
  assert.deepEqual(clock.delays(), [], "waking while still hidden does nothing");

  hidden = false;
  poller.wake(); // visibilitychange
  poller.wake(); // focus
  await clock.advance(PROJECT_WAKE_DEBOUNCE_MS);
  assert.equal(refreshes, 1);
  assert.deepEqual(clock.delays(), [ACTIVE_PROJECT_POLL_MS], "polling resumes after the wake refresh");
  poller.stop();
});

test("a refresh requested mid-flight runs once more after the current one", async () => {
  const clock = fakeTimers();
  const reads = [];
  const poller = createProjectActivityPoller({
    refresh() {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    delayMs: () => ACTIVE_PROJECT_POLL_MS,
    isHidden: () => false,
    timers: clock.timers,
  });

  const first = poller.refreshNow();
  void poller.refreshNow();
  void poller.refreshNow();
  assert.equal(reads.length, 1, "no overlapping refreshes");
  reads[0].reject(new Error("offline"));
  await flush();
  assert.equal(reads.length, 2, "one follow-up refresh, not one per request");
  reads[1].resolve();
  await first;
  assert.deepEqual(clock.delays(), [ACTIVE_PROJECT_POLL_MS]);
  poller.stop();
});

test("an older job-list read cannot overwrite a job the user just started or a newer read", async () => {
  const reads = [];
  const applied = [];
  const source = createProjectJobsSource({
    read() {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    invalidate() {},
    onChange: (jobs) => applied.push(jobs.map((job) => `${job.id}:${job.status}`)),
  });

  const staleRead = source.refresh();
  source.record({ id: "started", status: "queued" });
  reads[0].resolve([]);
  assert.equal(await staleRead, false);
  assert.deepEqual(applied, [["started:queued"]]);

  const olderRead = source.refresh();
  const newerRead = source.refresh();
  reads[2].resolve([{ id: "started", status: "running" }]);
  assert.equal(await newerRead, true);
  reads[1].resolve([{ id: "started", status: "queued" }]);
  assert.equal(await olderRead, false);
  assert.deepEqual(applied.at(-1), ["started:running"]);
});

test("job-list reads share one request through the client cache", async () => {
  const originalFetch = globalThis.fetch;
  const response = deferred();
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests += 1;
    assert.equal(String(url), "/api/projects/shared-project/jobs");
    return response.promise;
  };
  try {
    const first = fetchProjectJobs("shared-project");
    const second = fetchProjectJobs("shared-project");
    response.resolve(new Response(JSON.stringify({ jobs: [{ id: "job-1" }] }), {
      headers: { "content-type": "application/json" },
    }));
    assert.deepEqual(await Promise.all([first, second]), [[{ id: "job-1" }], [{ id: "job-1" }]]);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a busy refusal carries the server's workflow code to the client", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "Prosjektet har en jobb som fortsatt pågår. Vent til den er ferdig før du starter en ny generering.",
    code: "PROJECT_WORKFLOW_BUSY",
  }), { status: 409, headers: { "content-type": "application/json" } });
  try {
    const error = await startProjectJob({
      projectId: "busy-project",
      body: { kind: "customer_analysis" },
      fallbackMessage: "Kunne ikke starte kundeanalysen.",
    }).catch((caught) => caught);
    assert.ok(error instanceof ProjectApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "PROJECT_WORKFLOW_BUSY");
    assert.equal(isProjectWorkflowBusyError(error), true);
    assert.match(error.message, /fortsatt pågår/u);
    assert.equal(isProjectWorkflowBusyError(new Error("PROJECT_WORKFLOW_BUSY")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cached job list read before a recorded status cannot bring the old status back", async () => {
  const originalFetch = globalThis.fetch;
  const served = [
    [{ id: "job-1", status: "running" }],
    [{ id: "job-1", status: "completed" }],
  ];
  let requests = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ jobs: served[requests++] }), {
    headers: { "content-type": "application/json" },
  });
  const applied = [];
  const source = createProjectJobsSource({
    read: () => fetchProjectJobs("recorded-project"),
    invalidate: () => invalidateProjectJobsCache("recorded-project"),
    onChange: (jobs) => applied.push(jobs.map((job) => job.status).join(",")),
  });
  try {
    await source.refresh();
    // The page's own job watcher sees completion before the next poll.
    source.record({ id: "job-1", status: "completed" });
    await source.refresh();
    assert.deepEqual(applied, ["running", "completed", "completed"]);
    assert.equal(requests, 2, "the poll after a recorded status reads the server again");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hiding the page cancels a pending follow-up refresh until the page is shown again", async () => {
  const clock = fakeTimers();
  let hidden = false;
  const reads = [];
  const poller = createProjectActivityPoller({
    refresh() {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
    delayMs: () => ACTIVE_PROJECT_POLL_MS,
    isHidden: () => hidden,
    timers: clock.timers,
  });

  void poller.refreshNow();
  void poller.refreshNow(); // follow-up requested while the first is in flight
  hidden = true;
  poller.sleep();
  reads[0].resolve();
  await flush();
  assert.equal(reads.length, 1, "no refresh runs while the page is hidden");
  void poller.refreshNow();
  await flush();
  assert.equal(reads.length, 1, "explicit refreshes also wait for the page");
  assert.deepEqual(clock.delays(), []);

  hidden = false;
  poller.wake();
  await clock.advance(PROJECT_WAKE_DEBOUNCE_MS);
  assert.equal(reads.length, 2, "showing the page runs the deferred refresh once");
  reads[1].resolve();
  await flush();
  assert.deepEqual(clock.delays(), [ACTIVE_PROJECT_POLL_MS]);
  poller.stop();
});
