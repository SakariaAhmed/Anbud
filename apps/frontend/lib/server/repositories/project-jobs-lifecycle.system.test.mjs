import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
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
const {
  createProjectJobLeaseGuard,
  ProjectJobLeaseLostError,
  startProjectJobHeartbeat,
} = jiti(
  path.join(frontendRoot, "lib/server/project-job-heartbeat.ts"),
);
const {
  getProjectWorkflowAbortSignal,
  runWithProjectWorkflowAbortSignal,
} = jiti(
  path.join(frontendRoot, "lib/server/project-workflow-cancellation.ts"),
);

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
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  or(expression) {
    const prefix = "locked_at.is.null,locked_at.lt.";
    assert.ok(expression.startsWith(prefix), `unexpected OR filter: ${expression}`);
    const cutoff = expression.slice(prefix.length);
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
    from() {
      return {
        async insert(payload) {
          inserts.push(payload);
          return {
            data: null,
            error: { message: "lease_token is absent from the schema cache" },
          };
        },
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

  const workflow = runWithProjectWorkflowAbortSignal(guard.signal, async () => {
    await new Promise((resolve) => {
      resumeWorkflow = resolve;
    });
    getProjectWorkflowAbortSignal().throwIfAborted();
    businessWrites += 1;
  });

  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  resumeWorkflow();

  await assert.rejects(workflow, ProjectJobLeaseLostError);
  assert.equal(guard.signal.aborted, true);
  assert.equal(businessWrites, 0);
  stop();
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

  assert.equal(
    await updatePersistedProjectJob(
      "job-failed",
      { status: "failed", message: "Feilet", error: "synthetic failure" },
      { leaseToken: claimed.leaseToken },
      { client, now: at("2026-07-10T08:03:00.000Z") },
    ),
    true,
  );
  assert.equal(client.rows[0].status, "failed");
  assert.equal(client.rows[0].lease_token, null);
  assert.equal(client.rows[0].completed_at, "2026-07-10T08:03:00.000Z");
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
  assert.deepEqual(client.rows[0].result_json, { worker: "current" });
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
  assert.deepEqual(client.rows[0].result_json, { worker: "current" });
});
