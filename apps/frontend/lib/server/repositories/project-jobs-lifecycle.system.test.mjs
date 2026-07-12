import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
process.env.APP_ENCRYPTION_KEY ||= "project-job-lifecycle-test-key";
const jiti = createJiti(path.join(frontendRoot, "project-jobs-lifecycle-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  claimQueuedProjectJob,
  getQueuedProjectJobInput,
  heartbeatProjectJob,
  insertProjectJob,
  resetStaleRunningProjectJobs,
  updatePersistedProjectJob,
} = jiti(path.join(frontendRoot, "lib/server/repositories/jobs.ts"));
const { decryptJson } = jiti(
  path.join(frontendRoot, "lib/server/crypto.ts"),
);
const {
  createProjectJobLeaseGuard,
  startProjectJobHeartbeat,
} = jiti(
  path.join(frontendRoot, "lib/server/project-job-heartbeat.ts"),
);
const {
  buildProjectJobTerminalMetadata,
  ProjectWorkflowTerminalMetadataError,
  projectJobTerminalMetadataFromError,
  sanitizeProjectJobTerminalMetadata,
} = jiti(
  path.join(frontendRoot, "lib/server/project-job-terminal-metadata.ts"),
);
const {
  assertProjectWorkflowActive,
  bindProjectWorkflowTerminalMetadataReporter,
  getProjectWorkflowAbortSignal,
  runWithProjectWorkflowContext,
} = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-cancellation.ts"),
);
const {
  ProjectWorkflowDeadlineExceededError,
  projectWorkflowTimeoutMs,
  runProjectWorkflowWithDeadline,
} = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-deadline.ts"),
);
const {
  claimAndScheduleProjectJobAutorun,
  scheduleHeavyProjectJobAutorun,
} = jiti(
  path.join(frontendRoot, "lib/server/project-jobs.ts"),
);

test("heavy autorun jobs are bounded to one active task per replica by default", async () => {
  const previousConcurrency = process.env.PROJECT_JOB_AUTORUN_CONCURRENCY;
  process.env.PROJECT_JOB_AUTORUN_CONCURRENCY = "1";
  delete globalThis.__anbudHeavyProjectJobAutorunState;
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const task = () =>
    scheduleHeavyProjectJobAutorun(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    });

  try {
    const first = task();
    const second = task();
    const third = task();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 1);
    assert.equal(maximumActive, 1);
    releases.shift()();
    await first;
    await Promise.resolve();
    assert.equal(active, 1);
    releases.shift()();
    await second;
    await Promise.resolve();
    assert.equal(active, 1);
    releases.shift()();
    await third;
    assert.equal(active, 0);
    assert.equal(maximumActive, 1);
  } finally {
    delete globalThis.__anbudHeavyProjectJobAutorunState;
    if (previousConcurrency === undefined) {
      delete process.env.PROJECT_JOB_AUTORUN_CONCURRENCY;
    } else {
      process.env.PROJECT_JOB_AUTORUN_CONCURRENCY = previousConcurrency;
    }
  }
});

test("a synchronous autorun throw releases the slot and drains the next task", async () => {
  const previousConcurrency = process.env.PROJECT_JOB_AUTORUN_CONCURRENCY;
  const previousConsoleError = console.error;
  process.env.PROJECT_JOB_AUTORUN_CONCURRENCY = "1";
  delete globalThis.__anbudHeavyProjectJobAutorunState;
  const loggedErrors = [];
  let secondRuns = 0;
  console.error = (message) => loggedErrors.push(String(message));

  try {
    const first = scheduleHeavyProjectJobAutorun(() => {
      throw new Error("synthetic synchronous lease assertion failure");
    });
    const second = scheduleHeavyProjectJobAutorun(async () => {
      secondRuns += 1;
    });

    await Promise.all([first, second]);
    assert.equal(secondRuns, 1);
    assert.equal(globalThis.__anbudHeavyProjectJobAutorunState.active, 0);
    assert.equal(globalThis.__anbudHeavyProjectJobAutorunState.queued.length, 0);
    assert.equal(loggedErrors.length, 1);
    assert.match(loggedErrors[0], /project_job_autorun_failed/u);
  } finally {
    console.error = previousConsoleError;
    delete globalThis.__anbudHeavyProjectJobAutorunState;
    if (previousConcurrency === undefined) {
      delete process.env.PROJECT_JOB_AUTORUN_CONCURRENCY;
    } else {
      process.env.PROJECT_JOB_AUTORUN_CONCURRENCY = previousConcurrency;
    }
  }
});

test("accepting server owns the durable lease before autorun is scheduled", async () => {
  const events = [];
  let scheduledTask;
  let leaseStops = 0;
  const leaseController = new AbortController();
  const activeLease = {
    signal: leaseController.signal,
    assertActive() {
      leaseController.signal.throwIfAborted();
    },
    abort(cause) {
      leaseController.abort(cause);
    },
    stop() {
      leaseStops += 1;
    },
  };
  const workflow = {
    kind: "artifact_generation",
    projectId: "00000000-0000-4000-8000-000000000001",
    artifactType: "forbedret_kravsvar",
    sourceDocumentIds: ["formal-requirement-document"],
  };

  const claimed = await claimAndScheduleProjectJobAutorun(
    "candidate-owned-job",
    workflow,
    {
      async claim(jobId) {
        events.push(`claim:${jobId}`);
        return { leaseToken: "candidate-revision-lease" };
      },
      startLease(jobId, context) {
        events.push(`heartbeat:${jobId}:${context.leaseToken}`);
        return activeLease;
      },
      schedule(input, task) {
        events.push(`schedule:${input.projectId}`);
        scheduledTask = task;
      },
      async run(jobId, input, context, handedOffLease) {
        assert.equal(handedOffLease, activeLease);
        events.push(
          `run:${jobId}:${input.sourceDocumentIds.join(",")}:${context.leaseToken}`,
        );
        handedOffLease.stop();
      },
    },
  );

  assert.deepEqual(claimed, { leaseToken: "candidate-revision-lease" });
  assert.deepEqual(events, [
    "claim:candidate-owned-job",
    "heartbeat:candidate-owned-job:candidate-revision-lease",
    `schedule:${workflow.projectId}`,
  ]);
  assert.equal(leaseStops, 0, "queue heartbeat must remain active while waiting");
  assert.equal(typeof scheduledTask, "function");

  await scheduledTask();
  assert.deepEqual(events, [
    "claim:candidate-owned-job",
    "heartbeat:candidate-owned-job:candidate-revision-lease",
    `schedule:${workflow.projectId}`,
    "run:candidate-owned-job:formal-requirement-document:candidate-revision-lease",
  ]);
  assert.equal(leaseStops, 1, "workflow owns and stops the handed-off heartbeat");
});

test("autorun fails closed without scheduling when another revision wins the claim", async () => {
  let scheduled = false;
  await assert.rejects(
    claimAndScheduleProjectJobAutorun(
      "stolen-job",
      {
        kind: "artifact_generation",
        projectId: "00000000-0000-4000-8000-000000000001",
        artifactType: "forbedret_kravsvar",
        sourceDocumentIds: ["formal-requirement-document"],
      },
      {
        async claim() {
          return null;
        },
        schedule() {
          scheduled = true;
        },
      },
    ),
    /kunne ikke reserveres av serverversjonen/u,
  );
  assert.equal(scheduled, false);
});

test("autorun fails closed before execution when its queue-wait lease is lost", async () => {
  let scheduledTask;
  let runs = 0;
  const leaseLost = new Error("synthetic queue-wait lease loss");
  const controller = new AbortController();
  await claimAndScheduleProjectJobAutorun(
    "queue-wait-lease-lost",
    {
      kind: "artifact_generation",
      projectId: "00000000-0000-4000-8000-000000000001",
      artifactType: "forbedret_kravsvar",
      sourceDocumentIds: ["formal-requirement-document"],
    },
    {
      async claim() {
        return { leaseToken: "queue-wait-lease" };
      },
      startLease() {
        return {
          signal: controller.signal,
          assertActive() {
            controller.signal.throwIfAborted();
          },
          abort(cause) {
            controller.abort(cause);
          },
          stop() {},
        };
      },
      schedule(_input, task) {
        scheduledTask = task;
      },
      async run() {
        runs += 1;
      },
    },
  );

  controller.abort(leaseLost);
  await assert.rejects(
    async () => scheduledTask(),
    (error) => error === leaseLost,
  );
  assert.equal(runs, 0);
});

function fakeDeadlineTimerRuntime() {
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
      assert.ok(entry, "expected a pending workflow deadline");
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback();
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

test("total workflow deadline aborts a hung phase and blocks later side effects", async () => {
  const timer = fakeDeadlineTimerRuntime();
  let workflowSignal;
  let resumeWorkflow;
  let businessWrites = 0;
  const pending = runProjectWorkflowWithDeadline({
    kind: "solution_evaluation",
    timeoutMs: 12_000,
    runtime: timer.runtime,
    run: async (signal) => {
      workflowSignal = signal;
      await new Promise((resolve) => {
        resumeWorkflow = resolve;
      });
      signal.throwIfAborted();
      businessWrites += 1;
      return "late success";
    },
  });

  timer.runNext();

  await assert.rejects(
    pending,
    (error) =>
      error instanceof ProjectWorkflowDeadlineExceededError &&
      error.code === "PROJECT_WORKFLOW_DEADLINE_EXCEEDED" &&
      error.kind === "solution_evaluation" &&
      error.timeoutMs === 12_000,
  );
  assert.equal(workflowSignal.aborted, true);
  assert.equal(
    workflowSignal.reason.name,
    "ProjectWorkflowDeadlineExceededError",
  );
  assert.equal(timer.pendingCount(), 0);

  resumeWorkflow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(businessWrites, 0);
});

test("workflow deadline preserves lease abort and uses caller-safe defaults", async () => {
  const timer = fakeDeadlineTimerRuntime();
  const lease = new AbortController();
  const leaseLost = new Error("lease lost");
  const pending = runProjectWorkflowWithDeadline({
    kind: "artifact_generation",
    workflowSignal: lease.signal,
    runtime: timer.runtime,
    run: async () => new Promise(() => {}),
  });

  lease.abort(leaseLost);

  await assert.rejects(pending, (error) => error === leaseLost);
  assert.equal(timer.pendingCount(), 0);
  assert.equal(projectWorkflowTimeoutMs("customer_analysis", {}), 15 * 60_000);
  assert.equal(projectWorkflowTimeoutMs("solution_evaluation", {}), 18 * 60_000);
  assert.equal(projectWorkflowTimeoutMs("artifact_generation", {}), 18 * 60_000);
  assert.equal(projectWorkflowTimeoutMs("executive_summary", {}), 10 * 60_000);
  assert.equal(
    projectWorkflowTimeoutMs("solution_evaluation", {
      PROJECT_JOB_SOLUTION_EVALUATION_TIMEOUT_MS: "1200000",
    }),
    1_200_000,
  );
});

test("fallback guards rethrow the active workflow lease-loss reason", async () => {
  const controller = new AbortController();
  const leaseLost = new Error("lease lost during fallback");
  controller.abort(leaseLost);

  await assert.rejects(
    runWithProjectWorkflowContext({ signal: controller.signal }, async () => {
      try {
        throw new Error("ordinary fallback candidate");
      } catch {
        assertProjectWorkflowActive();
        return "fallback";
      }
    }),
    leaseLost,
  );
});

test("bound workflow reporter survives an externally dispatched deadline abort", async () => {
  const timer = fakeDeadlineTimerRuntime();
  let reported = null;
  const pending = runProjectWorkflowWithDeadline({
    kind: "artifact_generation",
    timeoutMs: 12_000,
    runtime: timer.runtime,
    run: (signal) =>
      runWithProjectWorkflowContext(
        {
          signal,
          reportTerminalMetadata(metadata) {
            reported = structuredClone(metadata);
          },
        },
        async () => {
          const boundReporter =
            bindProjectWorkflowTerminalMetadataReporter();
          signal.addEventListener(
            "abort",
            () => {
              boundReporter({
                requirement_response_handoff: {
                  outcome: "failed_closed",
                  terminal_reason: "deadline_exceeded",
                },
              });
            },
            { once: true },
          );
          return new Promise(() => {});
        },
      ),
  });

  timer.runNext();
  await assert.rejects(
    pending,
    (error) => error instanceof ProjectWorkflowDeadlineExceededError,
  );

  assert.deepEqual(reported, {
    requirement_response_handoff: {
      outcome: "failed_closed",
      terminal_reason: "deadline_exceeded",
    },
  });
  assert.equal(getProjectWorkflowAbortSignal(), undefined);
});

function project(fields, selectedColumns) {
  if (!selectedColumns || selectedColumns === "*") {
    return { ...fields };
  }
  const output = {};
  for (const column of selectedColumns.split(",")) {
    output[column.trim()] = fields[column.trim()];
  }
  return output;
}

class FakeQuery {
  constructor(rows, operation, payload = null) {
    this.rows = rows;
    this.operation = operation;
    this.payload = payload;
    this.filters = [];
    this.selectedColumns = null;
    this.maximum = null;
    this.sort = null;
    this.requiredProjectionColumns = new Set();
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  or(expression) {
    const prefix = "locked_at.is.null,locked_at.lt.";
    assert.ok(expression.startsWith(prefix), `unexpected OR filter: ${expression}`);
    const cutoff = expression.slice(prefix.length);
    if (this.operation === "update") {
      // Mirrors PostgREST's mutation planner: columns used by an OR filter
      // must remain available in the response projection.
      this.requiredProjectionColumns.add("locked_at");
    }
    this.filters.push(
      (row) => row.locked_at === null || row.locked_at < cutoff,
    );
    return this;
  }

  order(column, options) {
    this.sort = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(maximum) {
    this.maximum = maximum;
    return this;
  }

  select(columns) {
    this.selectedColumns = columns;
    return this;
  }

  abortSignal(signal) {
    assert.ok(signal instanceof AbortSignal);
    return this;
  }

  matchingRows() {
    let matches = this.rows.filter((row) =>
      this.filters.every((filter) => filter(row)),
    );
    if (this.sort) {
      const direction = this.sort.ascending ? 1 : -1;
      matches = [...matches].sort((left, right) =>
        String(left[this.sort.column]).localeCompare(String(right[this.sort.column])) *
        direction,
      );
    }
    if (this.maximum !== null) {
      matches = matches.slice(0, this.maximum);
    }
    return matches;
  }

  execute() {
    const selectedColumns = new Set(
      String(this.selectedColumns ?? "")
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean),
    );
    if (
      this.selectedColumns !== "*" &&
      [...this.requiredProjectionColumns].some(
        (column) => !selectedColumns.has(column),
      )
    ) {
      return {
        data: null,
        error: { message: "column project_jobs.locked_at does not exist" },
      };
    }
    const matches = this.matchingRows();
    if (this.operation === "update") {
      for (const row of matches) {
        Object.assign(row, this.payload);
      }
    }
    return {
      data: matches.map((row) => project(row, this.selectedColumns)),
      error: null,
    };
  }

  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.data.length === 1 ? result.data[0] : null,
      error: null,
    });
  }

  then(onFulfilled, onRejected) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
}

function inMemorySupabase() {
  const rows = [];
  return {
    rows,
    async rpc(name, args) {
      assert.equal(name, "enqueue_project_job_serialized");
      assert.equal(args.p_project_id, args.p_job.project_id);
      rows.push({ ...args.p_job });
      return { data: { ...args.p_job }, error: null };
    },
    from(table) {
      assert.equal(table, "project_jobs");
      return {
        insert(payload) {
          rows.push({ ...payload });
          return Promise.resolve({ data: null, error: null });
        },
        select(columns) {
          return new FakeQuery(rows, "select").select(columns);
        },
        update(payload) {
          return new FakeQuery(rows, "update", payload);
        },
      };
    },
  };
}

function record(id, now = "2026-07-10T08:00:00.000Z") {
  return {
    id,
    project_id: "00000000-0000-4000-8000-000000000001",
    kind: "customer_analysis",
    status: "queued",
    message: "Køet",
    error: null,
    result: null,
    created_at: now,
    updated_at: now,
  };
}

function at(iso) {
  return () => new Date(iso);
}

test("durable persistence fails closed instead of retrying a legacy payload", async () => {
  const inserts = [];
  const client = {
    async rpc(name, args) {
      assert.equal(name, "enqueue_project_job_serialized");
      inserts.push(args.p_job);
      return {
        data: null,
        error: { message: "lease_token is absent from the schema cache" },
      };
    },
  };

  await assert.rejects(
    insertProjectJob(record("job-fail-closed"), { projectId: "p" }, { client }),
    /lease_token is absent/u,
  );
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].input_json, { projectId: "p" });
  assert.equal(inserts[0].result_json, null);
});

test("queued input no longer reads the legacy result payload", async () => {
  const client = inMemorySupabase();
  client.rows.push({
    ...record("job-legacy-input"),
    input_json: null,
    result_json: { __job_input: { projectId: "legacy" } },
    locked_at: null,
    lease_token: null,
    started_at: null,
    completed_at: null,
  });

  await assert.rejects(
    getQueuedProjectJobInput("job-legacy-input", { client }),
    /mangler kjøredata/u,
  );
});

test("persisted updates require a non-empty lease token", async () => {
  await assert.rejects(
    updatePersistedProjectJob(
      "job-without-lease",
      { status: "completed" },
      { leaseToken: "" },
    ),
    /gyldig lease-token/u,
  );
});

test("terminal metadata binds real workflow result shapes to the audit marker", () => {
  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      {
        kind: "solution_evaluation",
        projectId: "project-direct",
        solutionDocumentId: "requested-document",
      },
      {
        status: "completed",
        result: {
          evaluation: { solution_document_id: "persisted-document" },
        },
      },
    ),
    {
      schema_version: 1,
      produced_solution_evaluation: true,
      solution_document_id: "persisted-document",
    },
  );
  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      {
        kind: "solution_evaluation",
        projectId: "project-direct-fallback",
        solutionDocumentId: "requested-document",
      },
      { status: "completed", result: null },
    ),
    {
      schema_version: 1,
      produced_solution_evaluation: true,
      solution_document_id: "requested-document",
    },
  );
  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      { kind: "perfect_system_solution", projectId: "project-perfect" },
      {
        status: "completed",
        result: {
          evaluation: { solution_document_id: "perfect-document" },
        },
      },
    ),
    {
      schema_version: 1,
      produced_solution_evaluation: true,
      solution_document_id: "perfect-document",
    },
  );
  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      { kind: "perfect_system_solution", projectId: "project-no-evaluation" },
      { status: "completed", result: {} },
    ),
    {
      schema_version: 1,
      produced_solution_evaluation: false,
      solution_document_id: null,
    },
  );
  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      {
        kind: "solution_evaluation",
        projectId: "project-failed",
        solutionDocumentId: "must-not-leak",
      },
      { status: "failed", result: null },
    ),
    {
      schema_version: 1,
      produced_solution_evaluation: false,
      solution_document_id: null,
    },
  );
});

test("failed workflow terminal metadata persists only sanitized strict handoff diagnostics", () => {
  const error = new ProjectWorkflowTerminalMetadataError("failed closed", {
    requirement_response_handoff: {
      outcome: "failed_closed",
      terminal_reason: "call_budget_exhausted",
      configured_call_budget: 3,
      configured_deadline_ms: 120_000,
      configured_concurrency: 2,
      strict_candidates: 20,
      calls_started: 3,
      repairs_accepted: 1,
      calls_without_accepted_repair: 2,
      skipped_call_budget: 17,
      skipped_deadline: 0,
      unresolved_after_handoff: 4,
      untrusted_detail: "must-not-persist",
    },
  });
  const extracted = projectJobTerminalMetadataFromError(error);

  assert.deepEqual(
    buildProjectJobTerminalMetadata(
      {
        kind: "solution_evaluation",
        projectId: "project-failed-handoff",
        solutionDocumentId: "must-not-be-reported-as-produced",
      },
      { status: "failed", result: null },
      {
        ...extracted,
        schema_version: 999,
        produced_solution_evaluation: true,
        solution_document_id: "spoofed-document",
      },
    ),
    {
      requirement_response_handoff: {
        outcome: "failed_closed",
        terminal_reason: "call_budget_exhausted",
        configured_call_budget: 3,
        configured_deadline_ms: 120_000,
        configured_concurrency: 2,
        strict_candidates: 20,
        calls_started: 3,
        repairs_accepted: 1,
        calls_without_accepted_repair: 2,
        skipped_call_budget: 17,
        skipped_deadline: 0,
        unresolved_after_handoff: 4,
      },
      schema_version: 1,
      produced_solution_evaluation: false,
      solution_document_id: null,
    },
  );
});

test("malformed strict handoff metadata is dropped instead of coerced", () => {
  assert.deepEqual(
    projectJobTerminalMetadataFromError({
      projectJobTerminalMetadata: {
        requirement_response_handoff: {
          outcome: "completed",
          terminal_reason: "not-allowlisted",
          calls_started: "3",
        },
      },
    }),
    {},
  );
});

test("impossible strict handoff counters and outcomes are dropped fail closed", () => {
  const base = {
    outcome: "failed_closed",
    terminal_reason: "repair_unresolved",
    configured_call_budget: 3,
    configured_deadline_ms: 120_000,
    configured_concurrency: 2,
    strict_candidates: 3,
    calls_started: 3,
    repairs_accepted: 1,
    calls_without_accepted_repair: 2,
    skipped_call_budget: 0,
    skipped_deadline: 0,
    unresolved_after_handoff: 1,
  };
  for (const invalid of [
    { ...base, configured_concurrency: 0 },
    { ...base, configured_call_budget: 33 },
    { ...base, calls_started: 4 },
    { ...base, repairs_accepted: 4, calls_without_accepted_repair: 0 },
    { ...base, calls_without_accepted_repair: 1 },
    { ...base, outcome: "completed", terminal_reason: null },
    { ...base, outcome: "failed_closed", terminal_reason: null },
    { ...base, unresolved_after_handoff: "1" },
  ]) {
    assert.deepEqual(
      projectJobTerminalMetadataFromError({
        projectJobTerminalMetadata: {
          requirement_response_handoff: invalid,
        },
      }),
      {},
    );
  }
});

test("terminal persistence strips unknown fields and rejects impossible nested metadata", async () => {
  const valid = {
    schema_version: 1,
    produced_solution_evaluation: false,
    solution_document_id: null,
    untrusted_top_level: "must-not-persist",
    requirement_response_handoff: {
      outcome: "failed_closed",
      terminal_reason: "repair_unresolved",
      configured_call_budget: 12,
      configured_deadline_ms: 120_000,
      configured_concurrency: 2,
      strict_candidates: 2,
      calls_started: 2,
      repairs_accepted: 1,
      calls_without_accepted_repair: 1,
      skipped_call_budget: 0,
      skipped_deadline: 0,
      unresolved_after_handoff: 1,
      untrusted_nested: "must-not-persist",
    },
  };
  const sanitized = sanitizeProjectJobTerminalMetadata(valid);
  assert.ok(sanitized);
  assert.equal("untrusted_top_level" in sanitized, false);
  assert.equal(
    "untrusted_nested" in sanitized.requirement_response_handoff,
    false,
  );

  const client = inMemorySupabase();
  await insertProjectJob(record("job-terminal-boundary"), { projectId: "p" }, {
    client,
  });
  const claimed = await claimQueuedProjectJob("job-terminal-boundary", {
    client,
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
  });
  assert.equal(
    await updatePersistedProjectJob(
      "job-terminal-boundary",
      { status: "failed", result: null },
      { leaseToken: claimed.leaseToken, terminalMetadata: valid },
      { client },
    ),
    true,
  );
  assert.deepEqual(client.rows[0].terminal_metadata, sanitized);

  const invalidClient = inMemorySupabase();
  await insertProjectJob(record("job-terminal-invalid"), { projectId: "p" }, {
    client: invalidClient,
  });
  const invalidClaim = await claimQueuedProjectJob("job-terminal-invalid", {
    client: invalidClient,
    randomUUID: () => "66666666-6666-4666-8666-666666666666",
  });
  await assert.rejects(
    updatePersistedProjectJob(
      "job-terminal-invalid",
      { status: "failed", result: null },
      {
        leaseToken: invalidClaim.leaseToken,
        terminalMetadata: {
          ...valid,
          requirement_response_handoff: {
            ...valid.requirement_response_handoff,
            repairs_accepted: 3,
          },
        },
      },
      { client: invalidClient },
    ),
    /ugyldig terminalmetadata/u,
  );
  assert.equal(invalidClient.rows[0].status, "running");
});

test("heartbeat scheduler renews every 30 seconds and can be stopped", async () => {
  let scheduled;
  let cancelled;
  let renewals = 0;
  const stop = startProjectJobHeartbeat(
    {
      async renew() {
        renewals += 1;
        return true;
      },
      onLeaseLost() {
        assert.fail("healthy lease should not be lost");
      },
      onError(error) {
        assert.fail(error);
      },
    },
    {
      setInterval(callback, intervalMs) {
        scheduled = { callback, intervalMs };
        return "timer-1";
      },
      clearInterval(timer) {
        cancelled = timer;
      },
    },
  );

  assert.equal(scheduled.intervalMs, 30_000);
  scheduled.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 1);
  stop();
  assert.equal(cancelled, "timer-1");
});

test("stopping heartbeat suppresses an in-flight terminal lease result", async () => {
  let scheduled;
  let finishRenewal;
  let leaseLosses = 0;
  let errors = 0;
  const stop = startProjectJobHeartbeat(
    {
      renew: () =>
        new Promise((resolve) => {
          finishRenewal = resolve;
        }),
      onLeaseLost() {
        leaseLosses += 1;
      },
      onError() {
        errors += 1;
      },
    },
    {
      setInterval(callback) {
        scheduled = callback;
        return "timer-in-flight";
      },
      clearInterval() {},
    },
  );

  scheduled();
  stop();
  finishRenewal(false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(leaseLosses, 0);
  assert.equal(errors, 0);
});

test("heartbeat renewal is single-flight when the database is slow", async () => {
  let scheduled;
  let finishRenewal;
  let renewals = 0;
  const stop = startProjectJobHeartbeat(
    {
      renew: () => {
        renewals += 1;
        return new Promise((resolve) => {
          finishRenewal = resolve;
        });
      },
      onLeaseLost() {
        assert.fail("single-flight renewal should remain active");
      },
      onError(error) {
        assert.fail(error);
      },
    },
    {
      setInterval(callback) {
        scheduled = callback;
        return "timer-single-flight";
      },
      clearInterval() {},
    },
  );

  scheduled();
  scheduled();
  assert.equal(renewals, 1);
  finishRenewal(true);
  await new Promise((resolve) => setImmediate(resolve));
  scheduled();
  assert.equal(renewals, 2);
  stop();
  finishRenewal(true);
});

test("a hung heartbeat times out, aborts its request, and fails closed", async () => {
  let scheduled;
  let timeout;
  let renewalSignal;
  let heartbeatError;
  const stop = startProjectJobHeartbeat(
    {
      renew: (signal) => {
        renewalSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      onLeaseLost() {
        assert.fail("a timeout is an error, not a proven lease takeover");
      },
      onError(error) {
        heartbeatError = error;
      },
    },
    {
      setInterval(callback) {
        scheduled = callback;
        return "timer-timeout";
      },
      clearInterval() {},
      setTimeout(callback, timeoutMs) {
        timeout = { callback, timeoutMs };
        return "renewal-timeout";
      },
      clearTimeout() {},
    },
  );

  scheduled();
  assert.equal(timeout.timeoutMs, 10_000);
  timeout.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(renewalSignal.aborted, true);
  assert.equal(heartbeatError?.name, "ProjectJobHeartbeatTimeoutError");
  stop();
});

test("lease takeover aborts the old workflow before its next business side effect", async () => {
  let scheduled;
  let resumeWorkflow;
  let businessWrites = 0;
  const guard = createProjectJobLeaseGuard("job-taken-over");
  const stop = startProjectJobHeartbeat(
    {
      async renew() {
        return false;
      },
      onLeaseLost() {
        guard.abort();
      },
      onError(error) {
        guard.abort(error);
      },
    },
    {
      setInterval(callback) {
        scheduled = callback;
        return "timer-takeover";
      },
      clearInterval() {},
    },
  );

  const workflow = runWithProjectWorkflowContext({ signal: guard.signal }, async () => {
    await new Promise((resolve) => {
      resumeWorkflow = resolve;
    });
    getProjectWorkflowAbortSignal().throwIfAborted();
    businessWrites += 1;
  });

  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  resumeWorkflow();

  await assert.rejects(workflow, { name: "ProjectJobLeaseLostError" });
  assert.equal(guard.signal.aborted, true);
  assert.equal(businessWrites, 0);
  stop();
});

test("queue-wait heartbeat prevents stale reset and foreign claim after 15 minutes", async () => {
  const client = inMemorySupabase();
  const queuedInput = {
    kind: "artifact_generation",
    projectId: "00000000-0000-4000-8000-000000000001",
    artifactType: "forbedret_kravsvar",
    sourceDocumentIds: ["formal-requirement-document"],
  };
  await insertProjectJob(
    record("job-waits-over-stale-window", "2026-07-10T08:00:00.000Z"),
    queuedInput,
    { client },
  );
  const owner = await claimQueuedProjectJob("job-waits-over-stale-window", {
    client,
    now: at("2026-07-10T08:00:00.000Z"),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.ok(owner);

  let intervalCallback;
  let cancelled = false;
  let nowMs = Date.parse("2026-07-10T08:00:00.000Z");
  const stop = startProjectJobHeartbeat(
    {
      renew: (signal) =>
        heartbeatProjectJob(
          "job-waits-over-stale-window",
          owner.leaseToken,
          {
            client,
            now: () => new Date(nowMs),
            signal,
          },
        ),
      onLeaseLost() {
        assert.fail("the queue-wait owner must retain its lease");
      },
      onError(error) {
        assert.fail(error);
      },
    },
    {
      setInterval(callback, intervalMs) {
        assert.equal(intervalMs, 30_000);
        intervalCallback = callback;
        return "queue-wait-heartbeat";
      },
      clearInterval(timer) {
        assert.equal(timer, "queue-wait-heartbeat");
        cancelled = true;
      },
    },
  );

  for (let heartbeat = 1; heartbeat <= 31; heartbeat += 1) {
    nowMs += 30_000;
    intervalCallback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    client.rows[0].locked_at,
    "2026-07-10T08:15:30.000Z",
  );

  nowMs = Date.parse("2026-07-10T08:16:00.000Z");
  assert.equal(
    await resetStaleRunningProjectJobs(15 * 60_000, {
      client,
      now: () => new Date(nowMs),
    }),
    0,
  );
  assert.equal(client.rows[0].status, "running");
  assert.equal(client.rows[0].lease_token, owner.leaseToken);
  assert.deepEqual(client.rows[0].input_json, queuedInput);
  assert.equal(
    await claimQueuedProjectJob("job-waits-over-stale-window", {
      client,
      now: () => new Date(nowMs),
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    }),
    null,
  );

  stop();
  assert.equal(cancelled, true);
});

test("atomic claim grants exactly one lease and rejects foreign ownership", async () => {
  const client = inMemorySupabase();
  await insertProjectJob(record("job-atomic"), { projectId: "p" }, { client });

  const [first, second] = await Promise.all([
    claimQueuedProjectJob("job-atomic", {
      client,
      now: at("2026-07-10T08:01:00.000Z"),
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
    }),
    claimQueuedProjectJob("job-atomic", {
      client,
      now: at("2026-07-10T08:01:00.000Z"),
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    }),
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
  const owner = first?.leaseToken ?? second?.leaseToken;
  assert.equal(client.rows[0].lease_token, owner);
  assert.equal(
    await heartbeatProjectJob(
      "job-atomic",
      "33333333-3333-4333-8333-333333333333",
      { client, now: at("2026-07-10T08:01:30.000Z") },
    ),
    false,
  );
  assert.equal(client.rows[0].locked_at, "2026-07-10T08:01:00.000Z");
});

test("failed completion clears the owned lease and blocks later writes", async () => {
  const client = inMemorySupabase();
  await insertProjectJob(record("job-failed"), { projectId: "p" }, { client });
  const claimed = await claimQueuedProjectJob("job-failed", {
    client,
    now: at("2026-07-10T08:02:00.000Z"),
    randomUUID: () => "44444444-4444-4444-8444-444444444444",
  });
  const workflowError = new ProjectWorkflowTerminalMetadataError(
    "strict handoff failed closed",
    {
      requirement_response_handoff: {
        outcome: "failed_closed",
        terminal_reason: "repair_unresolved",
        configured_call_budget: 12,
        configured_deadline_ms: 120_000,
        configured_concurrency: 2,
        strict_candidates: 2,
        calls_started: 2,
        repairs_accepted: 1,
        calls_without_accepted_repair: 1,
        skipped_call_budget: 0,
        skipped_deadline: 0,
        unresolved_after_handoff: 1,
      },
    },
  );
  const terminalMetadata = buildProjectJobTerminalMetadata(
    {
      kind: "artifact_generation",
      projectId: "p",
      artifactType: "forbedret_kravsvar",
    },
    { status: "failed", result: null },
    projectJobTerminalMetadataFromError(workflowError),
  );

  assert.equal(
    await updatePersistedProjectJob(
      "job-failed",
      { status: "failed", message: "Feilet", error: "synthetic failure" },
      { leaseToken: claimed.leaseToken, terminalMetadata },
      { client, now: at("2026-07-10T08:03:00.000Z") },
    ),
    true,
  );
  assert.equal(client.rows[0].status, "failed");
  assert.equal(client.rows[0].lease_token, null);
  assert.equal(client.rows[0].completed_at, "2026-07-10T08:03:00.000Z");
  assert.deepEqual(client.rows[0].terminal_metadata, terminalMetadata);
  assert.deepEqual(
    client.rows[0].terminal_metadata.requirement_response_handoff,
    workflowError.projectJobTerminalMetadata.requirement_response_handoff,
  );
  assert.equal(
    await heartbeatProjectJob("job-failed", claimed.leaseToken, {
      client,
      now: at("2026-07-10T08:03:30.000Z"),
    }),
    false,
  );
});

test("system: queued input survives lease heartbeat, expiry, takeover, and stale-worker rejection", async () => {
  const client = inMemorySupabase();
  const input = {
    kind: "customer_analysis",
    projectId: "00000000-0000-4000-8000-000000000001",
  };
  await insertProjectJob(record("job-system"), input, { client });
  assert.deepEqual(await getQueuedProjectJobInput("job-system", { client }), input);

  const oldWorker = await claimQueuedProjectJob("job-system", {
    client,
    now: at("2026-07-10T08:00:00.000Z"),
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.ok(oldWorker?.leaseToken);

  assert.equal(
    await heartbeatProjectJob("job-system", oldWorker.leaseToken, {
      client,
      now: at("2026-07-10T08:00:30.000Z"),
    }),
    true,
  );
  assert.equal(
    await resetStaleRunningProjectJobs(60_000, {
      client,
      now: at("2026-07-10T08:01:20.000Z"),
    }),
    0,
    "a healthy heartbeat excludes stale recovery",
  );
  assert.equal(client.rows[0].status, "running");

  assert.equal(
    await resetStaleRunningProjectJobs(60_000, {
      client,
      now: at("2026-07-10T08:01:31.000Z"),
    }),
    1,
    "takeover becomes possible only after the lease expires",
  );
  assert.equal(client.rows[0].status, "queued");

  const currentWorker = await claimQueuedProjectJob("job-system", {
    client,
    now: at("2026-07-10T08:01:31.000Z"),
    randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.ok(currentWorker?.leaseToken);
  assert.notEqual(currentWorker.leaseToken, oldWorker.leaseToken);

  assert.equal(
    await updatePersistedProjectJob(
      "job-system",
      { status: "completed", message: "stale", result: { worker: "old" } },
      { leaseToken: oldWorker.leaseToken },
      { client, now: at("2026-07-10T08:02:00.000Z") },
    ),
    false,
    "the old worker cannot complete after takeover",
  );
  assert.equal(
    await updatePersistedProjectJob(
      "job-system",
      { status: "completed", message: "Ferdig", result: { worker: "current" } },
      { leaseToken: currentWorker.leaseToken },
      { client, now: at("2026-07-10T08:02:01.000Z") },
    ),
    true,
  );
  assert.equal(client.rows[0].status, "completed");
  assert.deepEqual(decryptJson(client.rows[0].result_json, null), {
    worker: "current",
  });
  assert.equal(client.rows[0].lease_token, null);
  assert.equal(
    await updatePersistedProjectJob(
      "job-system",
      { status: "completed", result: { worker: "duplicate" } },
      { leaseToken: currentWorker.leaseToken },
      { client, now: at("2026-07-10T08:02:02.000Z") },
    ),
    false,
    "terminal writes cannot be duplicated",
  );
  assert.deepEqual(decryptJson(client.rows[0].result_json, null), {
    worker: "current",
  });
});
