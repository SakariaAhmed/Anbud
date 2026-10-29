import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-job-worker-budget-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const {
  PROJECT_JOB_WORKER_JOB_MARGIN_MS,
  runProjectJobsWithinBudget,
} = jiti(path.join(frontendRoot, "lib/server/project-job-worker-budget.ts"));

const minute = 60_000;
const timeouts = {
  customer_analysis: 15 * minute,
  executive_summary: 10 * minute,
  perfect_system_solution: 30 * minute,
};

/** A queue whose jobs advance a fake clock by their run time when claimed. */
function fakeQueue(jobs, { deadlineInMinutes, blocked = new Set() }) {
  let clock = 0;
  const queued = new Map(jobs.map((job) => [job.id, job]));
  const events = [];
  const runtime = {
    deadlineAt: deadlineInMinutes * minute,
    now: () => clock,
    maxJobs: 10,
    async listQueuedJobIds(limit) {
      events.push("list");
      return [...queued.keys()].slice(0, limit);
    },
    async readQueuedInput(jobId) {
      const job = queued.get(jobId);
      return job ? { kind: job.kind, projectId: job.projectId } : null;
    },
    timeoutMsFor: (kind) => timeouts[kind],
    async claimAndRun(jobId) {
      events.push(`claim:${jobId}`);
      if (blocked.has(jobId)) return false;
      const job = queued.get(jobId);
      queued.delete(jobId);
      clock += job.runMinutes * minute;
      events.push(`ran:${jobId}`);
      return true;
    },
    safeErrorMessage: () => "Jobben feilet.",
  };
  return { runtime, events, advance: (ms) => { clock += ms; } };
}

test("worker keeps claiming jobs while the remaining budget covers each full deadline", async () => {
  // Each candidate needs its 15-minute deadline plus the 1-minute margin.
  // After 3 + 16 minutes of work, 15 minutes remain and the third must wait.
  const { runtime, events } = fakeQueue([
    { id: "a", kind: "customer_analysis", projectId: "p1", runMinutes: 3 },
    { id: "b", kind: "customer_analysis", projectId: "p2", runMinutes: 16 },
    { id: "c", kind: "customer_analysis", projectId: "p3", runMinutes: 1 },
  ], { deadlineInMinutes: 34 });

  const results = await runProjectJobsWithinBudget(runtime);

  assert.deepEqual(results, [
    { job_id: "a", status: "processed" },
    { job_id: "b", status: "processed" },
    { job_id: "c", status: "skipped", reason: "insufficient_time" },
  ]);
  assert.deepEqual(events, ["list", "claim:a", "ran:a", "list", "claim:b", "ran:b", "list"]);
});

test("worker requires the job margin on top of the workflow deadline", async () => {
  const { runtime, events } = fakeQueue([
    { id: "a", kind: "executive_summary", projectId: "p1", runMinutes: 1 },
  ], { deadlineInMinutes: 10 });
  runtime.deadlineAt += PROJECT_JOB_WORKER_JOB_MARGIN_MS - 1;

  assert.deepEqual(await runProjectJobsWithinBudget(runtime), [
    { job_id: "a", status: "skipped", reason: "insufficient_time" },
  ]);
  assert.deepEqual(events, ["list"], "a job that does not fit is never claimed");

  runtime.deadlineAt += 1;
  assert.deepEqual(await runProjectJobsWithinBudget(runtime), [
    { job_id: "a", status: "processed" },
  ]);
});

test("a long head-of-line job that no longer fits does not block a shorter job", async () => {
  const { runtime } = fakeQueue([
    { id: "long", kind: "perfect_system_solution", projectId: "p1", runMinutes: 1 },
    { id: "short", kind: "executive_summary", projectId: "p2", runMinutes: 1 },
  ], { deadlineInMinutes: 20 });

  assert.deepEqual(await runProjectJobsWithinBudget(runtime), [
    { job_id: "long", status: "skipped", reason: "insufficient_time" },
    { job_id: "short", status: "processed" },
  ]);
});

test("a refused claim in a busy project is skipped and the next project still runs", async () => {
  const { runtime, events } = fakeQueue([
    { id: "busy-project-job", kind: "executive_summary", projectId: "p1", runMinutes: 1 },
    { id: "free-project-job", kind: "executive_summary", projectId: "p2", runMinutes: 1 },
  ], { deadlineInMinutes: 60, blocked: new Set(["busy-project-job"]) });

  const results = await runProjectJobsWithinBudget(runtime);

  assert.deepEqual(results, [
    { job_id: "busy-project-job", status: "skipped", reason: "claim_refused" },
    { job_id: "free-project-job", status: "processed" },
  ]);
  assert.equal(
    events.filter((event) => event === "claim:busy-project-job").length,
    1,
    "a refused row is not claimed again in the same invocation",
  );
});

test("a job queued while another ran is picked up after re-reading the queue", async () => {
  const queue = ["first"];
  const listed = [];
  const results = await runProjectJobsWithinBudget({
    deadlineAt: 60 * minute,
    now: () => 0,
    maxJobs: 10,
    async listQueuedJobIds() {
      listed.push([...queue]);
      return [...queue];
    },
    readQueuedInput: async (jobId) => ({ kind: "executive_summary", projectId: jobId }),
    timeoutMsFor: () => 10 * minute,
    async claimAndRun(jobId) {
      queue.splice(queue.indexOf(jobId), 1);
      // Finishing the first job lets an upload's queued job claim the project.
      if (jobId === "first") queue.push("second");
      return true;
    },
    safeErrorMessage: () => "Jobben feilet.",
  });

  assert.deepEqual(results, [
    { job_id: "first", status: "processed" },
    { job_id: "second", status: "processed" },
  ]);
  assert.deepEqual(listed, [["first"], ["second"], []]);
});

test("the scan is bounded and every row is considered at most once", async () => {
  let reads = 0;
  const results = await runProjectJobsWithinBudget({
    deadlineAt: 60 * minute,
    now: () => 0,
    maxJobs: 10,
    maxScan: 5,
    listQueuedJobIds: async () => Array.from({ length: 50 }, (_, index) => `job-${index}`),
    async readQueuedInput(jobId) {
      reads += 1;
      return { kind: "executive_summary", projectId: jobId };
    },
    timeoutMsFor: () => 10 * minute,
    claimAndRun: async () => false,
    safeErrorMessage: () => "Jobben feilet.",
  });

  assert.equal(reads, 5);
  assert.equal(results.length, 5);
  assert.ok(results.every((result) => result.reason === "claim_refused"));
});

test("the job limit stops the loop even when more budget remains", async () => {
  const { runtime } = fakeQueue([
    { id: "a", kind: "executive_summary", projectId: "p1", runMinutes: 1 },
    { id: "b", kind: "executive_summary", projectId: "p2", runMinutes: 1 },
  ], { deadlineInMinutes: 60 });
  runtime.maxJobs = 1;

  assert.deepEqual(await runProjectJobsWithinBudget(runtime), [
    { job_id: "a", status: "processed" },
  ]);
});

test("closed release claims stop the scan without exposing backend details", async () => {
  const claimed = [];
  const results = await runProjectJobsWithinBudget({
    deadlineAt: 60 * minute,
    now: () => 0,
    maxJobs: 10,
    listQueuedJobIds: async () => ["a", "b", "c"],
    readQueuedInput: async (jobId) => ({ kind: "executive_summary", projectId: jobId }),
    timeoutMsFor: () => 10 * minute,
    async claimAndRun(jobId) {
      claimed.push(jobId);
      throw new Error("PROJECT_JOB_CLAIMS_CLOSED: project-job claims are disabled for deployment cutover");
    },
    safeErrorMessage: () => "Jobben feilet.",
  });

  assert.deepEqual(claimed, ["a"]);
  assert.deepEqual(results, [{ job_id: "a", status: "failed", error: "Jobben feilet." }]);
});
