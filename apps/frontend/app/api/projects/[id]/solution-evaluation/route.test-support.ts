type TestJob = {
  id: string;
  project_id: string;
  kind: "solution_evaluation";
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  result: unknown;
};

type TestState = {
  auditEvents: Array<Record<string, unknown>>;
  customerAnalysis: unknown;
  getJobCalls: Array<{ projectId: string; jobId: string }>;
  getJobResults: Array<TestJob | null>;
  preflightResponse: Response | null;
  queueCalls: Array<{
    input: Record<string, unknown>;
    options: Record<string, unknown>;
  }>;
  queueCoalesced: boolean;
  queuedJob: TestJob;
  runCalls: string[];
  runError: unknown;
  schedulerCalls: number;
  waitCalls: Array<{ initialJob: TestJob; timeoutMs: number }>;
  waitTimeout: boolean;
};

const createdAt = "2026-07-12T00:00:00.000Z";

function defaultJob(): TestJob {
  return {
    id: "job-default",
    project_id: "project-default",
    kind: "solution_evaluation",
    status: "queued",
    message: "I kø.",
    created_at: createdAt,
    updated_at: createdAt,
    error: null,
    result: null,
  };
}

let state: TestState;

export function resetSolutionEvaluationRouteTestState(
  overrides: Partial<TestState> = {},
) {
  state = {
    auditEvents: [],
    customerAnalysis: { id: "analysis-default" },
    getJobCalls: [],
    getJobResults: [],
    preflightResponse: null,
    queueCalls: [],
    queueCoalesced: false,
    queuedJob: defaultJob(),
    runCalls: [],
    runError: null,
    schedulerCalls: 0,
    waitCalls: [],
    waitTimeout: false,
    ...overrides,
  };
  return state;
}

export function solutionEvaluationRouteTestState() {
  return state;
}

resetSolutionEvaluationRouteTestState();

export const NextResponse = {
  json(body: unknown, init?: ResponseInit) {
    return Response.json(body, init);
  },
};

export async function prepareProjectAiJsonRoute(
  request: Request,
  context: { params: Promise<{ id: string }> },
  input: { fallbackBody?: unknown },
) {
  const { id } = await context.params;
  if (state.preflightResponse) {
    return {
      id,
      model: undefined,
      body: undefined,
      response: state.preflightResponse,
    };
  }
  const body = await request.json().catch(() => input.fallbackBody ?? {});
  return {
    id,
    model: request.headers.get("x-openai-model") ?? undefined,
    body,
    response: null,
  };
}

export async function getFreshCustomerAnalysis() {
  return state.customerAnalysis;
}

export async function getFreshSolutionEvaluation() {
  return null;
}

export async function auditEvent(input: Record<string, unknown>) {
  state.auditEvents.push(structuredClone(input));
  return { persisted: true, eventId: `audit-${state.auditEvents.length}` };
}

export async function queueSolutionEvaluationJob(
  input: Record<string, unknown>,
  options: {
    onDisposition?: (input: {
      coalesced: boolean;
      jobId: string;
      requestedJobId: string;
    }) => void;
  },
) {
  state.queueCalls.push({ input: structuredClone(input), options });
  options.onDisposition?.({
    coalesced: state.queueCoalesced,
    jobId: state.queuedJob.id,
    requestedJobId: state.queueCoalesced
      ? "requested-job-that-was-coalesced"
      : state.queuedJob.id,
  });
  return state.queuedJob;
}

export async function scheduleHeavyProjectJobAutorun(
  run: () => Promise<void>,
) {
  state.schedulerCalls += 1;
  await run();
}

export async function runQueuedProjectJob(jobId: string) {
  state.runCalls.push(jobId);
  if (state.runError) {
    throw state.runError;
  }
}

export async function getProjectJob(projectId: string, jobId: string) {
  state.getJobCalls.push({ projectId, jobId });
  return state.getJobResults.length > 0
    ? (state.getJobResults.shift() ?? null)
    : state.queuedJob;
}

export function projectWorkflowTimeoutMs() {
  return 60_000;
}

export class DirectSolutionEvaluationWaitTimeoutError extends Error {
  constructor() {
    super("Tidsgrensen for direkte løsningsvurdering ble nådd.");
    this.name = "DirectSolutionEvaluationWaitTimeoutError";
  }
}

export function requestPrefersAsyncSolutionEvaluation(request: Request) {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .map((token) => token.split(";", 1)[0]?.trim().toLowerCase())
    .some((token) => token === "respond-async");
}

export async function waitForDirectSolutionEvaluationTask(input: {
  task: Promise<unknown>;
}) {
  return input.task;
}

export async function waitForDirectSolutionEvaluationJob(input: {
  initialJob: TestJob;
  readJob: () => Promise<TestJob | null>;
  timeoutMs: number;
}) {
  state.waitCalls.push({
    initialJob: input.initialJob,
    timeoutMs: input.timeoutMs,
  });
  if (state.waitTimeout) {
    throw new DirectSolutionEvaluationWaitTimeoutError();
  }

  let job = input.initialJob;
  for (let poll = 0; poll < 10; poll += 1) {
    if (job.status !== "queued" && job.status !== "running") {
      return job;
    }
    const refreshed = await input.readJob();
    if (!refreshed) {
      throw new Error("Fant ikke den køede løsningsvurderingen.");
    }
    job = refreshed;
  }
  throw new Error("Testjobben nådde ikke terminal status.");
}

export function legacySolutionEvaluationPayload(job: TestJob) {
  if (job.status === "failed") {
    throw new Error(job.error || "Kunne ikke generere løsningsvurdering.");
  }
  if (
    job.status !== "completed" ||
    !job.result ||
    typeof job.result !== "object"
  ) {
    throw new Error("Løsningsvurderingen fullførte uten et gyldig resultat.");
  }
  const result = job.result as Record<string, unknown>;
  if (
    !result.evaluation ||
    typeof result.evaluation !== "object" ||
    !result.project ||
    typeof result.project !== "object" ||
    result.artifact !== null ||
    result.used_generated_solution !== false
  ) {
    throw new Error("Løsningsvurderingen fullførte uten et gyldig resultat.");
  }
  return {
    evaluation: result.evaluation,
    project: result.project,
    artifact: result.artifact,
    used_generated_solution: result.used_generated_solution,
  };
}
