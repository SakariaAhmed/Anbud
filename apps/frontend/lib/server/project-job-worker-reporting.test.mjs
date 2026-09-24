import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Execute the current worker functions with controlled queue/workflow IO.
const source = ts.createSourceFile("project-jobs.ts", readFileSync(
  new URL("./project-jobs.ts", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true);
const names = new Set([
  "runQueuedProjectJobInput", "jobRunContextFromClaim", "runAvailableProjectJobs",
]);
const code = ts.transpileModule(source.statements
  .filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map(node => node.getText(source).replace(/^export\s+/u, "")).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function worker(overrides = {}) {
  const io = {
    resetStaleRunningProjectJobs: async () => {},
    listQueuedProjectJobIds: async () => ["job-1"],
    getQueuedProjectJobInput: async () => ({ kind: "executive_summary", projectId: "project-1" }),
    parseProjectWorkflowInput: value => value,
    claimQueuedProjectJob: async () => ({ leaseToken: "lease-1" }),
    runProjectJob: async () => {},
    productionSafeErrorMessage: (_error, fallback) => fallback,
    ...overrides,
  };
  return new Function(...Object.keys(io), `${code}\nreturn runAvailableProjectJobs;`)(...Object.values(io));
}

test("competing workers report only the acquired job as processed", async () => {
  let claimed = false;
  const executions = [];
  const run = worker({
    claimQueuedProjectJob: async () => {
      if (claimed) return null;
      claimed = true;
      return { leaseToken: "winning-lease" };
    },
    runProjectJob: async (...args) => { executions.push(args); },
  });
  const results = (await Promise.all([run(), run()])).flat();
  assert.equal(results.filter(result => result.status === "processed").length, 1);
  assert.equal(results.filter(result => result.status === "skipped").length, 1);
  assert.deepEqual(executions, [["job-1", { kind: "executive_summary", projectId: "project-1" }, {
    persisted: true, leaseToken: "winning-lease",
  }]]);
});

test("missing queue input is skipped without claiming or running it", async () => {
  const run = worker({
    getQueuedProjectJobInput: async () => null,
    claimQueuedProjectJob: async () => assert.fail("must not claim missing input"),
    runProjectJob: async () => assert.fail("must not execute missing input"),
  });
  assert.deepEqual(await run(), [{ job_id: "job-1", status: "skipped" }]);
});

test("claim failure remains failed and does not expose backend details", async () => {
  const run = worker({
    claimQueuedProjectJob: async () => { throw new Error("private backend details"); },
    runProjectJob: async () => assert.fail("must not execute after failed claim"),
  });
  const [result] = await run();
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.error, /private backend details/u);
});
