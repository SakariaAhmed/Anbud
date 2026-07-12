import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const frontendRoot = path.join(repoRoot, "apps/frontend");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "async-worker-boundaries.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const {
  DirectSolutionEvaluationWaitTimeoutError,
  legacySolutionEvaluationPayload,
  requestPrefersAsyncSolutionEvaluation,
  waitForDirectSolutionEvaluationJob,
  waitForDirectSolutionEvaluationTask,
} = jiti(
  path.join(frontendRoot, "lib/server/direct-solution-evaluation.ts"),
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const solutionEvaluationRoute = read(
  "apps/frontend/app/api/projects/[id]/solution-evaluation/route.ts",
);
const projectJobStatusRoute = read(
  "apps/frontend/app/api/projects/[id]/jobs/[jobId]/route.ts",
);
const projectJobEventsRoute = read(
  "apps/frontend/app/api/projects/[id]/jobs/[jobId]/events/route.ts",
);
const projectApiClient = read("apps/frontend/lib/client/project-api.ts");
const workerRoute = read(
  "apps/frontend/app/api/project-jobs/worker/route.ts",
);
const workerScript = read(
  "apps/frontend/scripts/run_project_job_worker.mjs",
);
const bicep = read("infra/azure/container-app.bicep");
const ciWorkflow = read(".github/workflows/ci.yml");
const deployWorkflow = read(".github/workflows/deploy-azure.yml");

test("direct solution-evaluation POST preserves sync compatibility with explicit async opt-in", () => {
  assert.match(solutionEvaluationRoute, /queueSolutionEvaluationJob/u);
  assert.match(solutionEvaluationRoute, /autoRun: false/u);
  assert.match(solutionEvaluationRoute, /onDisposition/u);
  assert.match(solutionEvaluationRoute, /coalesced: queueCoalesced/u);
  assert.match(solutionEvaluationRoute, /scheduleHeavyProjectJobAutorun/u);
  assert.match(solutionEvaluationRoute, /waitForDirectSolutionEvaluationTask/u);
  assert.match(
    solutionEvaluationRoute,
    /if \(!queueCoalesced \|\| queuedJob\.status === "queued"\)/u,
  );
  assert.match(solutionEvaluationRoute, /directDeadline - Date\.now\(\)/u);
  assert.match(solutionEvaluationRoute, /runQueuedProjectJob\(queuedJob\.id\)/u);
  assert.match(solutionEvaluationRoute, /getProjectJob\(id, queuedJob\.id\)/u);
  assert.match(
    solutionEvaluationRoute,
    /task: getProjectJob\(id, queuedJob\.id\)/u,
  );
  assert.match(solutionEvaluationRoute, /legacySolutionEvaluationPayload/u);
  assert.match(solutionEvaluationRoute, /requestPrefersAsyncSolutionEvaluation/u);
  assert.match(
    solutionEvaluationRoute,
    /NextResponse\.json\(\{ job: queuedJob \}, \{ status: 202 \}\)/u,
  );
  assert.match(solutionEvaluationRoute, /action: "project_job_accepted"/u);
  assert.match(solutionEvaluationRoute, /productionSafeErrorMessage/u);
  assert.match(solutionEvaluationRoute, /status: timedOut \? 504 : 500/u);
  assert.doesNotMatch(
    solutionEvaluationRoute,
    /action: "solution_evaluation_generated"/u,
  );
  assert.doesNotMatch(solutionEvaluationRoute, /runNow\s*:/u);
  assert.doesNotMatch(solutionEvaluationRoute, /runSolutionEvaluationWorkflow/u);
});

test("direct solution-evaluation runtime contract returns the legacy completed payload", () => {
  const evaluation = {
    solution_document_id: "solution-1",
    customer_document_id: "customer-1",
  };
  const project = { id: "project-1" };
  const job = {
    id: "job-1",
    project_id: "project-1",
    kind: "solution_evaluation",
    status: "completed",
    message: "Ferdig.",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:01.000Z",
    error: null,
    result: {
      evaluation,
      project,
      artifact: null,
      used_generated_solution: false,
    },
  };

  assert.deepEqual(legacySolutionEvaluationPayload(job), {
    evaluation,
    project,
    artifact: null,
    used_generated_solution: false,
  });
  assert.throws(
    () =>
      legacySolutionEvaluationPayload({
        ...job,
        status: "failed",
        error: "safe failure",
        result: null,
      }),
    /safe failure/u,
  );
});

test("direct solution-evaluation waits for a coalesced active job and honors Prefer", async () => {
  const request = new Request("http://localhost/direct", {
    headers: { Prefer: "wait=10, Respond-Async; handling=lenient" },
  });
  assert.equal(requestPrefersAsyncSolutionEvaluation(request), true);
  assert.equal(
    requestPrefersAsyncSolutionEvaluation(new Request("http://localhost/direct")),
    false,
  );

  const runningJob = {
    id: "job-1",
    project_id: "project-1",
    kind: "solution_evaluation",
    status: "running",
    message: "Kjører.",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:01.000Z",
    error: null,
    result: null,
  };
  const completedJob = {
    ...runningJob,
    status: "completed",
    result: {
      evaluation: {},
      project: {},
      artifact: null,
      used_generated_solution: false,
    },
  };
  let reads = 0;
  let delays = 0;
  const terminal = await waitForDirectSolutionEvaluationJob({
    initialJob: runningJob,
    readJob: async () => {
      reads += 1;
      return completedJob;
    },
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    runtime: {
      now: () => 0,
      delay: async () => {
        delays += 1;
      },
    },
  });

  assert.strictEqual(terminal, completedJob);
  assert.equal(reads, 1);
  assert.equal(delays, 1);

  const aborted = new AbortController();
  aborted.abort(new Error("client disconnected"));
  await assert.rejects(
    waitForDirectSolutionEvaluationJob({
      initialJob: runningJob,
      readJob: async () => completedJob,
      signal: aborted.signal,
      timeoutMs: 60_000,
    }),
    /client disconnected/u,
  );

  let clock = 0;
  await assert.rejects(
    waitForDirectSolutionEvaluationJob({
      initialJob: runningJob,
      readJob: async () => completedJob,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      runtime: {
        now: () => {
          clock += 60_001;
          return clock;
        },
        delay: async () => undefined,
      },
    }),
    (error) => error instanceof DirectSolutionEvaluationWaitTimeoutError,
  );
});

test("direct solution-evaluation includes semaphore queue time in its request budget", async () => {
  let completeTask;
  const pendingTask = new Promise((resolve) => {
    completeTask = resolve;
  });

  await assert.rejects(
    waitForDirectSolutionEvaluationTask({
      task: pendingTask,
      signal: new AbortController().signal,
      timeoutMs: 0,
    }),
    (error) => error instanceof DirectSolutionEvaluationWaitTimeoutError,
  );

  const aborted = new AbortController();
  aborted.abort(new Error("client left the queue"));
  await assert.rejects(
    waitForDirectSolutionEvaluationTask({
      task: pendingTask,
      signal: aborted.signal,
      timeoutMs: 60_000,
    }),
    /client left the queue/u,
  );

  completeTask();
  await waitForDirectSolutionEvaluationTask({
    task: Promise.resolve("done"),
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  });
});

test("direct solution-evaluation bounds a stalled status read", async () => {
  const runningJob = {
    id: "job-stalled-read",
    project_id: "project-1",
    kind: "solution_evaluation",
    status: "running",
    message: "Kjører.",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:01.000Z",
    error: null,
    result: null,
  };

  await assert.rejects(
    waitForDirectSolutionEvaluationJob({
      initialJob: runningJob,
      readJob: async () => new Promise(() => {}),
      signal: new AbortController().signal,
      timeoutMs: 10,
      pollIntervalMs: 1,
    }),
    (error) => error instanceof DirectSolutionEvaluationWaitTimeoutError,
  );
});

test("one worker invocation has a 30-minute job plus startup allowance", () => {
  const maximumJobSeconds = 30 * 60;
  const startupAndShutdownAllowanceSeconds = 5 * 60;
  const requiredReplicaSeconds =
    maximumJobSeconds + startupAndShutdownAllowanceSeconds;

  assert.match(workerRoute, /export const maxDuration = 2100;/u);
  assert.match(workerRoute, /const limit = 1;/u);
  assert.match(workerScript, /const limit = 1;/u);
  assert.match(
    workerScript,
    /PROJECT_JOB_WORKER_LIMIT must be 1\./u,
  );

  const configuredTimeout = Number(
    bicep.match(/param projectJobWorkerReplicaTimeout int = (\d+)/u)?.[1],
  );
  assert.equal(configuredTimeout, requiredReplicaSeconds);
  assert.match(bicep, /@maxValue\(1\)\s+param projectJobWorkerLimit int = 1/u);
  assert.match(
    bicep,
    /@minValue\(2100\)\s+param projectJobWorkerReplicaTimeout int = 2100/u,
  );
  assert.match(bicep, /replicaTimeout: projectJobWorkerReplicaTimeout/u);

  assert.match(deployWorkflow, /PROJECT_JOB_WORKER_LIMIT: "1"/u);
  assert.match(
    deployWorkflow,
    /PROJECT_JOB_WORKER_REPLICA_TIMEOUT: "2100"/u,
  );
  assert.match(
    deployWorkflow,
    /projectJobWorkerReplicaTimeout="\$PROJECT_JOB_WORKER_REPLICA_TIMEOUT"/u,
  );
});

test("release workflows execute the async worker boundary test", () => {
  for (const workflow of [ciWorkflow, deployWorkflow]) {
    assert.match(workflow, /scripts\/async_worker_boundaries\.test\.mjs/u);
  }
});

test("job polling routes redact failures and polling delays release abort listeners", () => {
  assert.match(projectJobStatusRoute, /productionSafeErrorMessage/u);
  assert.doesNotMatch(projectJobStatusRoute, /error\.message/u);
  assert.match(projectJobEventsRoute, /productionSafeErrorMessage/u);
  assert.doesNotMatch(projectJobEventsRoute, /error\.message/u);
  assert.match(projectJobEventsRoute, /removeEventListener\("abort", onAbort\)/u);
  assert.match(projectApiClient, /removeEventListener\("abort", onAbort\)/u);
});
