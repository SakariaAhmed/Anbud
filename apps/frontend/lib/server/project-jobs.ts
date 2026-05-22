import "server-only";

import { randomUUID } from "node:crypto";

import {
  claimQueuedProjectJob,
  findProjectJob,
  getQueuedProjectJobInput,
  insertProjectJob,
  listQueuedProjectJobIds,
  resetStaleRunningProjectJobs,
  updatePersistedProjectJob,
} from "@/lib/server/repositories/jobs";
import {
  parseProjectWorkflowInput,
  runProjectWorkflow,
  type ProjectWorkflowInput,
} from "@/lib/server/use-cases/project-workflows";
import type {
  GeneratedArtifactType,
  ProjectJobKind,
  ProjectJobRecord,
} from "@/lib/types";

type JobStore = Map<string, ProjectJobRecord>;

type QueueJobOptions = {
  jobId?: string;
  skipEnqueue?: boolean;
  runNow?: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __anbudProjectJobs: JobStore | undefined;
  // eslint-disable-next-line no-var
  var __anbudProjectJobProgressWrites:
    | Map<string, { message: string; writtenAt: number }>
    | undefined;
}

function getStore() {
  if (!globalThis.__anbudProjectJobs) {
    globalThis.__anbudProjectJobs = new Map<string, ProjectJobRecord>();
  }

  return globalThis.__anbudProjectJobs;
}

function getProgressWriteStore() {
  if (!globalThis.__anbudProjectJobProgressWrites) {
    globalThis.__anbudProjectJobProgressWrites = new Map<
      string,
      { message: string; writtenAt: number }
    >();
  }

  return globalThis.__anbudProjectJobProgressWrites;
}

function initialMessageForKind(kind: ProjectJobKind) {
  switch (kind) {
    case "customer_analysis":
      return "Køer kundeanalysen ...";
    case "solution_evaluation":
      return "Køer løsningsvurderingen ...";
    case "artifact_generation":
      return "Køer generatorjobben ...";
    case "high_level_design":
      return "Køer high-level design ...";
    case "perfect_system_solution":
      return "Køer forbedring av systemløsningen ...";
    case "executive_summary":
      return "Køer lederoppsummering ...";
  }
}

function createJobRecord(input: ProjectWorkflowInput, jobId?: string) {
  const now = new Date().toISOString();
  return {
    id: jobId ?? randomUUID(),
    project_id: input.projectId,
    kind: input.kind,
    status: "queued",
    message: initialMessageForKind(input.kind),
    created_at: now,
    updated_at: now,
    error: null,
    result: null,
  } satisfies ProjectJobRecord;
}

function logJobPhase(input: {
  jobId: string;
  kind: ProjectJobRecord["kind"];
  phase: string;
  durationMs: number;
}) {
  console.info(
    JSON.stringify({
      event: "project_job_phase_timing",
      job_id: input.jobId,
      kind: input.kind,
      phase: input.phase,
      duration_ms: input.durationMs,
    }),
  );
}

function createJobPhaseTimer(jobId: string, kind: ProjectJobRecord["kind"]) {
  const totalStartedAt = Date.now();
  let phaseStartedAt = totalStartedAt;
  const timings: Array<{ phase: string; duration_ms: number }> = [];

  return {
    mark(phase: string) {
      const now = Date.now();
      const durationMs = now - phaseStartedAt;
      timings.push({ phase, duration_ms: durationMs });
      logJobPhase({ jobId, kind, phase, durationMs });
      phaseStartedAt = now;
    },
    total() {
      return Date.now() - totalStartedAt;
    },
    timings() {
      return timings;
    },
  };
}

async function persistJob(record: ProjectJobRecord, input: ProjectWorkflowInput) {
  try {
    await insertProjectJob(record, input);
  } catch {
    // Keep local development and older databases working with in-memory jobs.
  }
}

function patchInMemoryJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  const store = getStore();
  const current = store.get(jobId);
  const updatedAt = new Date().toISOString();

  if (current) {
    store.set(jobId, {
      ...current,
      ...patch,
      updated_at: updatedAt,
    });
  }
}

function shouldThrottleProgressWrite(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
) {
  if (
    patch.status !== "running" ||
    !patch.message ||
    patch.result !== undefined ||
    patch.error !== undefined
  ) {
    return false;
  }

  const writes = getProgressWriteStore();
  const previous = writes.get(jobId);
  const now = Date.now();
  if (
    previous &&
    previous.message === patch.message &&
    now - previous.writtenAt < 500
  ) {
    return true;
  }

  writes.set(jobId, { message: patch.message, writtenAt: now });
  return false;
}

function updateJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  patchInMemoryJob(jobId, patch);

  if (shouldThrottleProgressWrite(jobId, patch)) {
    return;
  }

  void updatePersistedProjectJob(jobId, patch).catch(() => undefined);
}

async function enqueueProjectJob(
  input: ProjectWorkflowInput,
  options: QueueJobOptions = {},
) {
  const record = createJobRecord(input, options.jobId);

  if (!options.skipEnqueue) {
    getStore().set(record.id, record);
    await persistJob(record, input);
  }

  if (options.runNow) {
    await runProjectJob(record.id, input);
  } else {
    setTimeout(() => {
      void runProjectJob(record.id, input);
    }, 0);
  }

  return record;
}

async function runProjectJob(jobId: string, input: ProjectWorkflowInput) {
  const phaseTimer = createJobPhaseTimer(jobId, input.kind);
  updateJob(jobId, { status: "running" });

  try {
    const result = await runProjectWorkflow(input, {
      setProgress(message) {
        updateJob(jobId, { message, status: "running" });
      },
      onPhase(phase) {
        phaseTimer.mark(phase);
      },
      timings: () => phaseTimer.timings(),
      totalDurationMs: () => phaseTimer.total(),
    });

    logJobPhase({
      jobId,
      kind: input.kind,
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    updateJob(jobId, {
      status: "completed",
      message: "Ferdig.",
      result,
      error: null,
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      message: "Jobben feilet.",
      error: error instanceof Error ? error.message : "Ukjent feil.",
      result: null,
    });
  }
}

export async function getProjectJob(projectId: string, jobId: string) {
  const record = getStore().get(jobId) ?? null;
  if (record?.project_id === projectId) {
    return record;
  }

  try {
    return await findProjectJob(projectId, jobId);
  } catch {
    return null;
  }
}

export async function queueArtifactGenerationJob(input: {
  projectId: string;
  artifactType: GeneratedArtifactType;
  instructions?: string;
  sourceDocumentIds?: string[];
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "artifact_generation",
      projectId: input.projectId,
      artifactType: input.artifactType,
      instructions: input.instructions,
      sourceDocumentIds: input.sourceDocumentIds,
      model: input.model,
    },
    options,
  );
}

export async function queueCustomerAnalysisJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "customer_analysis",
      projectId: input.projectId,
      model: input.model,
    },
    options,
  );
}

export async function queuePerfectSystemSolutionJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "perfect_system_solution",
      projectId: input.projectId,
      model: input.model,
    },
    options,
  );
}

export async function queueSolutionEvaluationJob(input: {
  projectId: string;
  allowGeneratedSolution: boolean;
  solutionDocumentId?: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "solution_evaluation",
      projectId: input.projectId,
      allowGeneratedSolution: input.allowGeneratedSolution,
      solutionDocumentId: input.solutionDocumentId,
      model: input.model,
    },
    options,
  );
}

export async function queueHighLevelDesignJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "high_level_design",
      projectId: input.projectId,
      model: input.model,
    },
    options,
  );
}

export async function queueExecutiveSummaryJob(input: {
  projectId: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "executive_summary",
      projectId: input.projectId,
      model: input.model,
    },
    options,
  );
}

async function runQueuedProjectJobInput(jobId: string, queuedInput: unknown) {
  const input = parseProjectWorkflowInput(queuedInput);
  const claimed = await claimQueuedProjectJob(jobId);
  if (!claimed) {
    return;
  }

  await runProjectJob(jobId, input);
}

export async function runQueuedProjectJob(jobId: string) {
  const queuedInput = await getQueuedProjectJobInput(jobId);
  if (!queuedInput) {
    return;
  }

  await runQueuedProjectJobInput(jobId, queuedInput);
}

export async function runAvailableProjectJobs(options?: {
  limit?: number;
  staleAfterMs?: number;
}) {
  await resetStaleRunningProjectJobs(options?.staleAfterMs);
  const jobIds = await listQueuedProjectJobIds(options?.limit ?? 1);
  const results: Array<{
    job_id: string;
    status: "processed" | "skipped" | "failed";
    error?: string;
  }> = [];

  for (const jobId of jobIds) {
    try {
      const queuedInput = await getQueuedProjectJobInput(jobId);
      if (!queuedInput) {
        results.push({ job_id: jobId, status: "skipped" });
        continue;
      }

      await runQueuedProjectJobInput(jobId, queuedInput);
      results.push({ job_id: jobId, status: "processed" });
    } catch (error) {
      results.push({
        job_id: jobId,
        status: "failed",
        error: error instanceof Error ? error.message : "Ukjent feil.",
      });
    }
  }

  return results;
}
