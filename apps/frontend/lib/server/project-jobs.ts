import "server-only";

import { randomUUID } from "node:crypto";

import {
  normalizeArtifactInstructions,
  normalizeSourceDocumentIds,
} from "@/lib/server/artifact-generation-input";
import {
  claimQueuedProjectJob,
  type ClaimedProjectJob,
  findProjectJob,
  getQueuedProjectJobInput,
  heartbeatProjectJob,
  insertFollowUpProjectJob,
  insertProjectJob,
  listQueuedProjectJobIds,
  resetStaleRunningProjectJobs,
  updatePersistedProjectJob,
} from "@/lib/server/repositories/jobs";
import {
  createProjectJobLeaseGuard,
  isProjectJobLeaseLostError,
  startProjectJobHeartbeat,
} from "@/lib/server/project-job-heartbeat";
import {
  getProjectWorkflowLease,
  runWithProjectWorkflowContext,
} from "@/lib/server/project-workflow-cancellation";
import {
  parseProjectWorkflowInput,
  runProjectWorkflow,
  type ProjectWorkflowInput,
} from "@/lib/server/use-cases/project-workflows";
import type {
  DocumentIngestionJobResult,
  GeneratedArtifactType,
  ProjectJobKind,
  ProjectJobRecord,
  ProjectJobResult,
} from "@/lib/types";

type JobStore = Map<string, ProjectJobRecord>;

type QueueJobOptions = {
  jobId?: string;
  skipEnqueue?: boolean;
  runNow?: boolean;
  autoRun?: boolean;
  idempotencyKey?: string;
};

type JobRunContext =
  | { persisted: false }
  | { persisted: true; leaseToken: string };

declare global {
  var __anbudProjectJobs: JobStore | undefined;
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
    case "document_ingestion":
      return "Køer dokumentindeksering ...";
    case "document_docling_enhancement":
      return "Køer Docling-forbedring ...";
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
  await insertProjectJob(record, input);
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

async function persistJobUpdate(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  context: JobRunContext,
  options: { markStarted?: boolean } = {},
) {
  if (!context.persisted) {
    return true;
  }

  return updatePersistedProjectJob(jobId, patch, {
    leaseToken: context.leaseToken,
    markStarted: options.markStarted,
  });
}

function logPersistedJobUpdateError(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  error: unknown,
) {
  console.warn(
    JSON.stringify({
      event: "project_job_persist_update_failed",
      job_id: jobId,
      status: patch.status,
      message: error instanceof Error ? error.message : "Unknown job update error",
    }),
  );
}

function updateJob(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  context: JobRunContext,
  options: { markStarted?: boolean } = {},
) {
  if (shouldThrottleProgressWrite(jobId, patch)) {
    return;
  }

  if (!context.persisted) {
    patchInMemoryJob(jobId, patch);
    return;
  }

  void persistJobUpdate(jobId, patch, context, options)
    .then((persisted) => {
      if (persisted) {
        patchInMemoryJob(jobId, patch);
      }
    })
    .catch((error: unknown) => {
      logPersistedJobUpdateError(jobId, patch, error);
    });
}

async function finishJob(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  context: JobRunContext,
) {
  getProgressWriteStore().delete(jobId);

  const persisted = await persistJobUpdate(jobId, patch, context);
  if (persisted) {
    patchInMemoryJob(jobId, patch);
  }
  if (!persisted) {
    console.warn(
      JSON.stringify({
        event: "project_job_terminal_update_skipped",
        job_id: jobId,
        status: patch.status,
        reason: "lease_or_status_mismatch",
      }),
    );
  }
}

function startJobHeartbeat(jobId: string, context: JobRunContext) {
  const guard = createProjectJobLeaseGuard(jobId);
  if (!context.persisted) {
    return {
      ...guard,
      stop: () => undefined,
    };
  }

  const stop = startProjectJobHeartbeat({
    renew: () => heartbeatProjectJob(jobId, context.leaseToken),
    onLeaseLost: () => {
      guard.abort();
      console.warn(
        JSON.stringify({
          event: "project_job_heartbeat_lease_lost",
          job_id: jobId,
        }),
      );
    },
    onError: (error: unknown) => {
      guard.abort(error);
      logPersistedJobUpdateError(jobId, { status: "running" }, error);
    },
  });

  return {
    ...guard,
    stop,
  };
}

async function enqueueProjectJob(
  input: ProjectWorkflowInput,
  options: QueueJobOptions = {},
) {
  const record = createJobRecord(input, options.jobId);
  const shouldAutoRun = options.autoRun !== false;

  if (!options.skipEnqueue) {
    const parentLease = getProjectWorkflowLease();
    const persistedRecord = parentLease
      ? await insertFollowUpProjectJob(
          record,
          input,
          parentLease,
          options.idempotencyKey ?? `${input.kind}:${record.id}`,
        )
      : (await persistJob(record, input), record);
    getStore().set(persistedRecord.id, persistedRecord);
    if (options.runNow) {
      await runQueuedProjectJob(persistedRecord.id);
    } else if (shouldAutoRun) {
      setTimeout(() => {
        void runQueuedProjectJob(persistedRecord.id);
      }, 0);
    }

    return persistedRecord;
  }

  if (options.runNow) {
    await runProjectJob(record.id, input, {
      persisted: false,
    });
  } else if (shouldAutoRun) {
    setTimeout(() => {
      void runProjectJob(record.id, input, {
        persisted: false,
      });
    }, 0);
  }

  return record;
}

function envFlag(name: string, fallback = false) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function isDocumentIngestionResult(
  result: ProjectJobResult,
): result is DocumentIngestionJobResult {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    "document_id" in result &&
    typeof (result as { document_id?: unknown }).document_id === "string"
  );
}

function shouldQueueDoclingEnhancement(
  input: ProjectWorkflowInput,
  result: ProjectJobResult,
): result is DocumentIngestionJobResult {
  return (
    input.kind === "document_ingestion" &&
    isDocumentIngestionResult(result) &&
    result.docling_enhancement_requested === true
  );
}

async function runProjectJob(
  jobId: string,
  input: ProjectWorkflowInput,
  context: JobRunContext,
) {
  const phaseTimer = createJobPhaseTimer(jobId, input.kind);
  const lease = startJobHeartbeat(jobId, context);
  lease.assertActive();
  updateJob(jobId, { status: "running" }, context, { markStarted: true });
  let terminalPatch: Partial<ProjectJobRecord> | null = null;

  try {
    const result = await runWithProjectWorkflowContext(
      {
        signal: lease.signal,
        lease: context.persisted
          ? {
              jobId,
              leaseToken: context.leaseToken,
              projectId: input.projectId,
            }
          : undefined,
      },
      async () => {
        const workflowResult = await runProjectWorkflow(input, {
          setProgress(message) {
            lease.assertActive();
            updateJob(jobId, { message, status: "running" }, context);
          },
          onPhase(phase) {
            lease.assertActive();
            phaseTimer.mark(phase);
          },
          assertActive: lease.assertActive,
          timings: () => phaseTimer.timings(),
          totalDurationMs: () => phaseTimer.total(),
        });
        lease.assertActive();

        if (
          input.kind === "document_ingestion" &&
          shouldQueueDoclingEnhancement(input, workflowResult)
        ) {
          const queuedEnhancement = await enqueueProjectJob(
            {
              kind: "document_docling_enhancement",
              projectId: input.projectId,
              documentId: input.documentId,
            },
            {
              autoRun: envFlag("DOCLING_ASYNC_AUTO_RUN", false),
              idempotencyKey: `document_docling_enhancement:${input.documentId}`,
            },
          );
          workflowResult.docling_enhancement_job_id = queuedEnhancement.id;
        }

        return workflowResult;
      },
    );
    lease.assertActive();

    logJobPhase({
      jobId,
      kind: input.kind,
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    terminalPatch = {
      status: "completed",
      message: "Ferdig.",
      result,
      error: null,
    };
  } catch (error) {
    if (lease.signal.aborted || isProjectJobLeaseLostError(error)) {
      console.warn(
        JSON.stringify({
          event: "project_job_execution_cancelled",
          job_id: jobId,
          reason: "lease_lost",
        }),
      );
      return;
    }
    terminalPatch = {
      status: "failed",
      message: "Jobben feilet.",
      error: error instanceof Error ? error.message : "Ukjent feil.",
      result: null,
    };
  } finally {
    try {
      if (terminalPatch) {
        await finishJob(jobId, terminalPatch, context);
      }
    } finally {
      lease.stop();
    }
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
  useSolutionEvaluationContext?: boolean;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "artifact_generation",
      projectId: input.projectId,
      artifactType: input.artifactType,
      instructions: normalizeArtifactInstructions(input.instructions),
      sourceDocumentIds: normalizeSourceDocumentIds(input.sourceDocumentIds),
      useSolutionEvaluationContext: input.useSolutionEvaluationContext === true,
      model: input.model,
    },
    options,
  );
}

export async function queueDocumentIngestionJob(input: {
  projectId: string;
  documentId: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "document_ingestion",
      projectId: input.projectId,
      documentId: input.documentId,
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
  solutionDocumentId?: string;
  model?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "solution_evaluation",
      projectId: input.projectId,
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

  await runProjectJob(jobId, input, jobRunContextFromClaim(claimed));
}

function jobRunContextFromClaim(claimed: ClaimedProjectJob): JobRunContext {
  return {
    persisted: true,
    leaseToken: claimed.leaseToken,
  };
}

async function runQueuedProjectJob(jobId: string) {
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
