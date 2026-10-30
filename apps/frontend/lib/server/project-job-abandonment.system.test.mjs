import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Drives the real runProjectJob, worker budget loop and autorun task. Only
// their I/O is replaced: the job repository, the checkpoint reader and the
// workflow body. The real deadline race runs with a 30 ms deadline.
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const fakes = mkdtempSync(path.join(tmpdir(), "anbud-abandonment-"));
process.on("exit", () => rmSync(fakes, { recursive: true, force: true }));

writeFileSync(path.join(fakes, "jobs.cjs"), `
const state = () => globalThis.__abandonmentTest;
exports.claimQueuedProjectJob = async (jobId) => {
  state().claims.push(jobId);
  return { leaseToken: "lease-" + jobId };
};
exports.findOldestQueuedProjectJob = async () => { state().drainLookups += 1; return null; };
exports.findProjectJob = async () => null;
exports.getQueuedProjectJobInput = async (jobId) =>
  state().claims.includes(jobId) ? null : state().queue.get(jobId) ?? null;
exports.heartbeatProjectJob = async () => true;
exports.insertFollowUpProjectJob = async () => { throw new Error("unexpected follow-up job"); };
exports.insertProjectJob = async () => { throw new Error("unexpected job insert"); };
exports.listQueuedProjectJobIds = async (limit) =>
  [...state().queue.keys()].filter((jobId) => !state().claims.includes(jobId)).slice(0, limit);
exports.resetStaleRunningProjectJobs = async () => 0;
exports.updatePersistedProjectJob = async (jobId, patch) => {
  if (patch.status === "completed" || patch.status === "failed") {
    state().terminalWrites.push(jobId + ":" + patch.status);
    if (state().failTerminalWrite) throw new Error("terminal write failed");
  }
  return true;
};
`);
writeFileSync(path.join(fakes, "results.cjs"), `
exports.recoverCommittedProjectJobResult = async () => globalThis.__abandonmentTest.checkpoint;
`);
writeFileSync(path.join(fakes, "workflows.cjs"), `
exports.parseProjectWorkflowInput = (value) => value;
exports.runProjectWorkflow = (input) => {
  globalThis.__abandonmentTest.started.push(input.kind);
  // A hung workflow keeps running after the deadline releases the runner.
  return globalThis.__abandonmentTest.hang ? new Promise(() => {}) : Promise.resolve({});
};
`);
const realDeadline = path.join(frontendRoot, "lib/server/project-workflow-deadline.ts");
writeFileSync(path.join(fakes, "deadline.ts"), `
export * from ${JSON.stringify(realDeadline)};
import { runProjectWorkflowWithDeadline as runReal } from ${JSON.stringify(realDeadline)};
export function runProjectWorkflowWithDeadline(input: Parameters<typeof runReal>[0]) {
  return runReal({ ...input, timeoutMs: 30 });
}
`);

const jiti = createJiti(path.join(fakes, "abandonment-tests.cjs"), {
  interopDefault: true,
  moduleCache: false,
  alias: {
    "@/lib/server/repositories/jobs": path.join(fakes, "jobs.cjs"),
    "@/lib/server/project-job-results": path.join(fakes, "results.cjs"),
    "@/lib/server/use-cases/project-workflows": path.join(fakes, "workflows.cjs"),
    "@/lib/server/project-workflow-deadline": path.join(fakes, "deadline.ts"),
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});
const { claimAndScheduleProjectJobAutorun, runAvailableProjectJobs } = jiti(
  path.join(frontendRoot, "lib/server/project-jobs.ts"),
);

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "00000000-0000-4000-8000-000000000002";
const draftCheckpoint = {
  completion_status: "evaluation_pending",
  artifact: { id: "draft" },
  resume_request: { kind: "perfect_system_solution", resume_artifact_id: "draft" },
};

function resetState(overrides) {
  globalThis.__abandonmentTest = {
    queue: new Map([
      ["first", { kind: "perfect_system_solution", projectId: PROJECT }],
      ["next", { kind: "executive_summary", projectId: OTHER_PROJECT }],
    ]),
    claims: [],
    terminalWrites: [],
    started: [],
    drainLookups: 0,
    checkpoint: null,
    hang: true,
    failTerminalWrite: false,
    ...overrides,
  };
  return globalThis.__abandonmentTest;
}

async function quietly(run) {
  const { warn, error } = console;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

const runWorker = () => quietly(() =>
  runAvailableProjectJobs({ limit: 10, deadlineAt: Date.now() + 60 * 60_000 }));

async function runAutorun() {
  let task;
  let drained = 0;
  await claimAndScheduleProjectJobAutorun("first", globalThis.__abandonmentTest.queue.get("first"), {
    schedule(_input, scheduled) { task = scheduled; },
    async drain() { drained += 1; },
  });
  const outcome = await quietly(() => task().then(() => "resolved", (error) => error));
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  return { outcome, drained };
}

test("control: a finished job lets the worker claim the next one", async () => {
  const state = resetState({ hang: false });
  const results = await runWorker();
  assert.deepEqual(results.map((result) => [result.job_id, result.status]), [
    ["first", "processed"],
    ["next", "processed"],
  ]);
  assert.deepEqual(state.claims, ["first", "next"]);
});

test("a workflow that saved a checkpoint and then hit its deadline stops further claims", async () => {
  const state = resetState({ checkpoint: draftCheckpoint });
  const results = await runWorker();

  assert.deepEqual(results, [{ job_id: "first", status: "processed", reason: "workflow_abandoned" }]);
  assert.deepEqual(state.terminalWrites, ["first:completed"], "the saved draft is still recorded");
  assert.deepEqual(state.claims, ["first"], "no job is claimed while the hung workflow runs");
  assert.deepEqual(state.started, ["perfect_system_solution"]);
});

test("a checkpointed workflow released at its deadline is not followed by a web drain", async () => {
  const state = resetState({ checkpoint: draftCheckpoint });
  const { outcome, drained } = await runAutorun();

  assert.equal(outcome, "resolved");
  assert.deepEqual(state.terminalWrites, ["first:completed"]);
  assert.equal(drained, 0);
  assert.deepEqual(state.claims, ["first"]);
});

test("a failed terminal write after a deadline still stops further claims", async () => {
  const state = resetState({ failTerminalWrite: true });
  const results = await runWorker();

  assert.equal(results.length, 1);
  assert.equal(results[0].job_id, "first");
  assert.equal(results[0].status, "failed");
  assert.deepEqual(state.terminalWrites, ["first:failed"]);
  assert.deepEqual(state.claims, ["first"], "no job is claimed while the hung workflow runs");
});

test("a failed terminal write after a deadline is not followed by a web drain", async () => {
  const state = resetState({ failTerminalWrite: true });
  const { outcome, drained } = await runAutorun();

  assert.ok(outcome instanceof Error);
  assert.equal(outcome.outcome?.workflowAbandoned, true, "the failure carries the abandoned outcome");
  assert.equal(drained, 0);
  assert.equal(state.drainLookups, 0);
  assert.deepEqual(state.claims, ["first"]);
});
