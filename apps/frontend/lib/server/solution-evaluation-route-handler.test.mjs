import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const routeDirectory = path.join(
  frontendRoot,
  "app/api/projects/[id]/solution-evaluation",
);
const supportPath = path.join(routeDirectory, "route.test-support.ts");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "solution-evaluation-route-tests.cjs"), {
  interopDefault: true,
  alias: {
    "next/server": supportPath,
    "@/lib/server/repositories/analyses": supportPath,
    "@/lib/server/observability": supportPath,
    "@/lib/server/project-ai-route": supportPath,
    "@/lib/server/project-jobs": supportPath,
    "@/lib/server/project-workflow-deadline": supportPath,
    "@/lib/server/direct-solution-evaluation": supportPath,
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  resetSolutionEvaluationRouteTestState,
  solutionEvaluationRouteTestState,
} = jiti(supportPath);
const { POST } = jiti(path.join(routeDirectory, "route.ts"));

const projectId = "project-handler-test";
const context = { params: Promise.resolve({ id: projectId }) };
const createdAt = "2026-07-12T00:00:00.000Z";

function job(status, result = null) {
  return {
    id: "job-handler-test",
    project_id: projectId,
    kind: "solution_evaluation",
    status,
    message: status === "completed" ? "Ferdig." : "Kjører.",
    created_at: createdAt,
    updated_at: createdAt,
    error: null,
    result,
  };
}

function completedJob() {
  return job("completed", {
    evaluation: {
      id: "evaluation-handler-test",
      solution_document_id: "solution-handler-test",
    },
    project: { id: projectId, title: "Handler test" },
    artifact: null,
    used_generated_solution: false,
  });
}

function postRequest(headers = {}) {
  return new Request(`http://localhost/api/projects/${projectId}/solution-evaluation`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ solution_document_id: "solution-handler-test" }),
  });
}

test("POST without Prefer returns the exact legacy 200 payload", async () => {
  const queuedJob = job("queued");
  const terminalJob = completedJob();
  resetSolutionEvaluationRouteTestState({
    queuedJob,
    getJobResults: [terminalJob],
  });

  const response = await POST(
    postRequest({ "x-openai-model": "gpt-5.4" }),
    context,
  );
  const body = await response.json();
  const state = solutionEvaluationRouteTestState();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    evaluation: terminalJob.result.evaluation,
    project: terminalJob.result.project,
    artifact: null,
    used_generated_solution: false,
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "artifact",
    "evaluation",
    "project",
    "used_generated_solution",
  ]);
  assert.deepEqual(state.queueCalls[0].input, {
    projectId,
    solutionDocumentId: "solution-handler-test",
    model: "gpt-5.4",
  });
  assert.equal(state.schedulerCalls, 1);
  assert.deepEqual(state.runCalls, [queuedJob.id]);
  assert.deepEqual(state.getJobCalls, [
    { projectId, jobId: queuedJob.id },
  ]);
  assert.equal(state.waitCalls.length, 1);
  assert.deepEqual(state.auditEvents, [
    {
      action: "project_job_accepted",
      projectId,
      entityType: "project_job",
      entityId: queuedJob.id,
      metadata: {
        route: "direct",
        kind: "solution_evaluation",
        coalesced: false,
        solution_document_id: "solution-handler-test",
        model: "gpt-5.4",
      },
    },
  ]);
});

test("Prefer respond-async returns 202 and never starts inline execution", async () => {
  const queuedJob = job("queued");
  resetSolutionEvaluationRouteTestState({
    queuedJob,
    queueCoalesced: true,
  });

  const response = await POST(
    postRequest({ Prefer: "wait=10, Respond-Async; handling=lenient" }),
    context,
  );
  const state = solutionEvaluationRouteTestState();

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job: queuedJob });
  assert.equal(state.schedulerCalls, 0);
  assert.deepEqual(state.runCalls, []);
  assert.deepEqual(state.getJobCalls, []);
  assert.deepEqual(state.waitCalls, []);
  assert.equal(state.auditEvents.length, 1);
  assert.equal(state.auditEvents[0].action, "project_job_accepted");
  assert.equal(state.auditEvents[0].metadata.coalesced, true);
});

test("a coalesced running job is polled to completion and audited as coalesced", async () => {
  const runningJob = job("running");
  const terminalJob = completedJob();
  resetSolutionEvaluationRouteTestState({
    queuedJob: runningJob,
    queueCoalesced: true,
    getJobResults: [runningJob, terminalJob],
  });

  const response = await POST(postRequest(), context);
  const state = solutionEvaluationRouteTestState();

  assert.equal(response.status, 200);
  assert.equal((await response.json()).evaluation.id, "evaluation-handler-test");
  assert.equal(state.schedulerCalls, 0);
  assert.deepEqual(state.runCalls, []);
  assert.deepEqual(state.getJobCalls, [
    { projectId, jobId: runningJob.id },
    { projectId, jobId: runningJob.id },
  ]);
  assert.strictEqual(state.waitCalls[0].initialJob, runningJob);
  assert.equal(state.auditEvents[0].metadata.coalesced, true);
});

test("a coalesced queued job is still claimed through the heavy-job semaphore", async () => {
  const queuedJob = job("queued");
  const terminalJob = completedJob();
  resetSolutionEvaluationRouteTestState({
    queuedJob,
    queueCoalesced: true,
    getJobResults: [terminalJob],
  });

  const response = await POST(postRequest(), context);
  const state = solutionEvaluationRouteTestState();

  assert.equal(response.status, 200);
  assert.equal(state.schedulerCalls, 1);
  assert.deepEqual(state.runCalls, [queuedJob.id]);
  assert.equal(state.auditEvents[0].metadata.coalesced, true);
});

test("production failures are redacted before the handler returns 500", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  resetSolutionEvaluationRouteTestState({
    queuedJob: job("queued"),
    runError: new Error("database password=do-not-leak host=internal.example"),
  });

  try {
    const response = await POST(postRequest(), context);
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.match(body.error, /^Kunne ikke generere løsningsvurdering\. Referanse:/u);
    assert.match(body.error, /Feilhash: [a-f0-9]{24}\.$/u);
    assert.doesNotMatch(body.error, /do-not-leak|internal\.example|password=/u);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("direct wait timeout returns the explicit safe 504 response", async () => {
  resetSolutionEvaluationRouteTestState({
    queuedJob: job("running"),
    getJobResults: [job("running")],
    waitTimeout: true,
  });

  const response = await POST(postRequest(), context);

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error:
      "Løsningsvurderingen fortsetter i bakgrunnen. Prøv å hente resultatet igjen om litt.",
  });
});
