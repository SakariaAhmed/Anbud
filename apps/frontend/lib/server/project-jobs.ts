import "server-only";
import { projectJobResultForRead } from "@/lib/server/project-job-result-projection";
import { recoverCommittedProjectJobResult } from "@/lib/server/project-job-results";

import { randomUUID } from "node:crypto";

import {
  normalizeArtifactInstructions,
  normalizeSourceDocumentIds,
} from "@/lib/server/artifact-generation-input";
import {
  claimQueuedProjectJob,
  type ClaimedProjectJob,
  findOldestQueuedProjectJob,
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
  evictCachedProjectJob,
  pruneTerminalProjectJobCache,
  readProjectJobAuthoritatively,
  reconcilePersistedProjectJobCachePatch,
  reconcileTerminalProjectJobCache,
} from "@/lib/server/project-job-cache";
import {
  createProjectJobLeaseGuard,
  isProjectJobLeaseLostError,
  startProjectJobHeartbeat,
  type ProjectJobLeaseGuard,
} from "@/lib/server/project-job-heartbeat";
import {
  buildProjectJobTerminalMetadata,
  projectJobTerminalMetadataFromError,
} from "@/lib/server/project-job-terminal-metadata";
import {
  getProjectWorkflowLease,
  runWithProjectWorkflowContext,
} from "@/lib/server/project-workflow-cancellation";
import {
  isProjectWorkflowDeadlineExceededError,
  projectWorkflowTimeoutMs,
  runProjectWorkflowWithDeadline,
} from "@/lib/server/project-workflow-deadline";
import {
  isProjectJobClaimsClosedError,
  runProjectJobsWithinBudget,
} from "@/lib/server/project-job-worker-budget";
import {
  productionSafeErrorMessage,
  safeErrorTelemetry,
} from "@/lib/server/safe-errors";
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
  onDisposition?: (input: {
    coalesced: boolean;
    jobId: string;
    requestedJobId: string;
  }) => void;
};

type JobRunContext =
  | { persisted: false }
  | { persisted: true; leaseToken: string };

type ActiveProjectJobLease = ProjectJobLeaseGuard & {
  stop: () => void;
};

export type ProjectJobRunOutcome = {
  /** The terminal status was written under this run's lease. */
  terminalPersisted: boolean;
  /**
   * The deadline or a lost lease released the runner while the workflow may
   * still be running in this process (runProjectWorkflowWithDeadline races it).
   */
  workflowAbandoned: boolean;
};

declare global {
  var __anbudProjectJobs: JobStore | undefined;
  var __anbudProjectJobProgressWrites:
    | Map<string, { message: string; writtenAt: number }>
    | undefined;
  var __anbudLocalProjectJobIds: Set<string> | undefined;
  var __anbudLocallyManagedPersistedProjectJobIds: Set<string> | undefined;
  var __anbudHeavyProjectJobAutorunState:
    | {
        active: number;
        queued: Array<{
          task: () => Promise<void>;
          resolve: () => void;
          queuedAt: number;
          workflow?: Pick<ProjectWorkflowInput, "projectId" | "kind">;
        }>;
      }
    | undefined;
}

function heavyProjectJobAutorunConcurrency() {
  const configured = Number(
    process.env.PROJECT_JOB_AUTORUN_CONCURRENCY?.trim() || "1",
  );
  return Number.isSafeInteger(configured) && configured >= 1
    ? Math.min(configured, 4)
    : 1;
}

function heavyProjectJobAutorunState() {
  globalThis.__anbudHeavyProjectJobAutorunState ??= {
    active: 0,
    queued: [],
  };
  return globalThis.__anbudHeavyProjectJobAutorunState;
}

function drainHeavyProjectJobAutorunQueue() {
  const state = heavyProjectJobAutorunState();
  const concurrency = heavyProjectJobAutorunConcurrency();
  while (state.active < concurrency && state.queued.length) {
    const next = state.queued.shift();
    if (!next) break;
    state.active += 1;
    console.info(JSON.stringify({
      event: "project_job_autorun_started",
      project_id: next.workflow?.projectId,
      kind: next.workflow?.kind,
      queue_wait_ms: Math.max(0, Date.now() - next.queuedAt),
      active_jobs: state.active,
      concurrency,
    }));
    void Promise.resolve()
      .then(next.task)
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "project_job_autorun_failed",
            ...safeErrorTelemetry(error),
          }),
        );
      })
      .finally(() => {
        state.active -= 1;
        next.resolve();
        drainHeavyProjectJobAutorunQueue();
      });
  }
}

export function scheduleHeavyProjectJobAutorun(
  task: () => Promise<void>,
  workflow?: Pick<ProjectWorkflowInput, "projectId" | "kind">,
) {
  return new Promise<void>((resolve) => {
    heavyProjectJobAutorunState().queued.push({ task, resolve, queuedAt: Date.now(), workflow });
    drainHeavyProjectJobAutorunQueue();
  });
}

function autoRunProjectJob(
  input: ProjectWorkflowInput,
  task: () => Promise<void>,
) {
  setTimeout(() => {
    void scheduleHeavyProjectJobAutorun(task, input);
  }, 0);
}

type AutorunClaimRuntime = {
  claim?: (jobId: string) => Promise<ClaimedProjectJob | null>;
  startLease?: (
    jobId: string,
    context: JobRunContext,
  ) => ActiveProjectJobLease;
  schedule?: (
    input: ProjectWorkflowInput,
    task: () => Promise<void>,
  ) => void;
  run?: (
    jobId: string,
    input: ProjectWorkflowInput,
    context: JobRunContext,
    activeLease?: ActiveProjectJobLease,
  ) => Promise<ProjectJobRunOutcome>;
  drain?: (projectId: string) => Promise<unknown>;
};

/**
 * Hand the project's next queued job to this process once the finished job's
 * terminal status is persisted, which frees the project for the database
 * claim. After lease loss, a rejected terminal write or an abandoned workflow
 * the next job is left to the durable worker. The drain gets no signal from
 * the finished job.
 */
function drainAfterRun(
  projectId: string,
  outcome: ProjectJobRunOutcome,
  drain: (projectId: string) => Promise<unknown> = drainNextQueuedProjectJob,
) {
  if (!outcome.terminalPersisted || outcome.workflowAbandoned) return;
  void Promise.resolve()
    .then(() => drain(projectId))
    .catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "project_job_autorun_drain_failed",
        project_id: projectId,
        ...safeErrorTelemetry(error),
      }));
    });
}

/**
 * Reserve an autorun job before the accepting API request returns. The
 * project-job table is shared by every running application revision, so
 * leaving a newly accepted row queued allows an older deployment worker to
 * execute it with an incompatible workflow contract.
 */
export async function claimAndScheduleProjectJobAutorun(
  jobId: string,
  input: ProjectWorkflowInput,
  runtime: AutorunClaimRuntime = {},
) {
  const claim = runtime.claim ?? claimQueuedProjectJob;
  let claimed: ClaimedProjectJob | null;
  try {
    claimed = await claim(jobId);
  } catch (error) {
    // The job is already durable. During release cutover, keep it queued for
    // the aligned worker instead of reporting a failed submission to the UI.
    if (isProjectJobClaimsClosedError(error)) return;
    throw error;
  }
  if (!claimed) return; // Another job owns the project; the durable worker will retry.

  const schedule = runtime.schedule ?? autoRunProjectJob;
  const run = runtime.run ?? runProjectJob;
  const context = jobRunContextFromClaim(claimed);
  const startLease = runtime.startLease ?? startJobHeartbeat;
  const activeLease = startLease(jobId, context);
  const drain = runtime.drain ?? drainNextQueuedProjectJob;
  try {
    schedule(input, async () => {
      activeLease.assertActive();
      // Handoff the same guard and heartbeat to execution. runProjectJob owns
      // the single stop call, so there is no unprotected stop/start window.
      drainAfterRun(
        input.projectId,
        await run(jobId, input, context, activeLease),
        drain,
      );
    });
  } catch (error) {
    activeLease.stop();
    throw error;
  }
  return claimed;
}

type QueuedProjectJobDrainRuntime = {
  findNext?: typeof findOldestQueuedProjectJob;
  autorun?: (
    jobId: string,
    input: ProjectWorkflowInput,
  ) => Promise<ClaimedProjectJob | null | undefined>;
};

/**
 * Start the oldest queued job of a project after the web process has finished
 * that project's previous job. The database claim decides whether it may run;
 * a refused claim leaves the job queued for the scheduled worker.
 */
export async function drainNextQueuedProjectJob(
  projectId: string,
  runtime: QueuedProjectJobDrainRuntime = {},
) {
  // The scheduled worker stops its server after the HTTP response, so work
  // handed to its in-memory queue would be interrupted.
  if (envFlag("PROJECT_JOB_WORKER_PROCESS")) return null;
  const includeDoclingEnhancement = envFlag("DOCLING_ASYNC_AUTO_RUN", false);
  const next = await (runtime.findNext ?? findOldestQueuedProjectJob)(
    projectId,
    { includeDoclingEnhancement },
  );
  if (!next) return null;
  const input = parseProjectWorkflowInput(next.input);
  if (input.kind === "document_docling_enhancement" && !includeDoclingEnhancement) {
    return null;
  }
  return (await (runtime.autorun ?? claimAndScheduleProjectJobAutorun)(next.id, input)) ?? null;
}

function getStore() {
  if (!globalThis.__anbudProjectJobs) {
    globalThis.__anbudProjectJobs = new Map<string, ProjectJobRecord>();
  }

  const evictedTerminalJobIds = pruneTerminalProjectJobCache(
    globalThis.__anbudProjectJobs,
  );
  for (const jobId of evictedTerminalJobIds) {
    globalThis.__anbudProjectJobProgressWrites?.delete(jobId);
    globalThis.__anbudLocalProjectJobIds?.delete(jobId);
    globalThis.__anbudLocallyManagedPersistedProjectJobIds?.delete(jobId);
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

function getLocalJobIds() {
  if (!globalThis.__anbudLocalProjectJobIds) {
    globalThis.__anbudLocalProjectJobIds = new Set<string>();
  }

  return globalThis.__anbudLocalProjectJobIds;
}

function getLocallyManagedPersistedJobIds() {
  if (!globalThis.__anbudLocallyManagedPersistedProjectJobIds) {
    globalThis.__anbudLocallyManagedPersistedProjectJobIds = new Set<string>();
  }

  return globalThis.__anbudLocallyManagedPersistedProjectJobIds;
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
  let lastCompletedPhase = "oppstart";
  const timings: Array<{ phase: string; duration_ms: number }> = [];

  return {
    mark(phase: string) {
      const now = Date.now();
      const durationMs = now - phaseStartedAt;
      timings.push({ phase, duration_ms: durationMs });
      logJobPhase({ jobId, kind, phase, durationMs });
      phaseStartedAt = now;
      lastCompletedPhase = phase;
    },
    total() {
      return Date.now() - totalStartedAt;
    },
    timings() {
      return timings;
    },
    lastCompletedPhase() {
      return lastCompletedPhase;
    },
  };
}

function patchInMemoryJob(jobId: string, patch: Partial<ProjectJobRecord>) {
  const store = getStore();
  const current = store.get(jobId);
  const updatedAt = new Date().toISOString();

  if (current) {
    store.set(jobId, {
      ...current,
      ...patch,
      result: projectJobResultForRead(patch.result === undefined ? current.result : patch.result),
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
  options: {
    markStarted?: boolean;
    terminalMetadata?: Record<string, unknown>;
  } = {},
) {
  if (!context.persisted) {
    return true;
  }

  return updatePersistedProjectJob(jobId, patch, {
    leaseToken: context.leaseToken,
    markStarted: options.markStarted,
    terminalMetadata: options.terminalMetadata,
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
      ...safeErrorTelemetry(error),
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
      reconcilePersistedProjectJobCachePatch({
        jobs: getStore(),
        progressWrites: getProgressWriteStore(),
        localJobIds: getLocalJobIds(),
        locallyManagedPersistedJobIds: getLocallyManagedPersistedJobIds(),
        jobId,
        patch,
        accepted: persisted,
      });
    })
    .catch((error: unknown) => {
      logPersistedJobUpdateError(jobId, patch, error);
    });
}

async function finishJob(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  context: JobRunContext,
  workflow: ProjectWorkflowInput,
  failureMetadata: Record<string, unknown> = {},
) {
  let persisted: boolean;
  try {
    persisted = await persistJobUpdate(jobId, patch, context, {
      terminalMetadata: buildProjectJobTerminalMetadata(
        workflow,
        patch,
        failureMetadata,
      ),
    });
  } catch (error) {
    if (context.persisted) {
      evictCachedProjectJob(
        getStore(),
        getProgressWriteStore(),
        getLocalJobIds(),
        getLocallyManagedPersistedJobIds(),
        jobId,
      );
    }
    throw error;
  }
  reconcileTerminalProjectJobCache({
    jobs: getStore(),
    progressWrites: getProgressWriteStore(),
    localJobIds: getLocalJobIds(),
    locallyManagedPersistedJobIds: getLocallyManagedPersistedJobIds(),
    jobId,
    patch,
    persisted,
  });
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

  return persisted;
}

function startJobHeartbeat(jobId: string, context: JobRunContext) {
  const guard = createProjectJobLeaseGuard(jobId);
  if (!context.persisted) {
    return {
      ...guard,
      stop: () => undefined,
    };
  }

  let stopHeartbeat: () => void = () => undefined;
  stopHeartbeat = startProjectJobHeartbeat({
    renew: (signal) =>
      heartbeatProjectJob(jobId, context.leaseToken, { signal }),
    onLeaseLost: () => {
      stopHeartbeat();
      evictCachedProjectJob(
        getStore(),
        getProgressWriteStore(),
        getLocalJobIds(),
        getLocallyManagedPersistedJobIds(),
        jobId,
      );
      guard.abort();
      console.warn(
        JSON.stringify({
          event: "project_job_heartbeat_lease_lost",
          job_id: jobId,
        }),
      );
    },
    onError: (error: unknown) => {
      stopHeartbeat();
      evictCachedProjectJob(
        getStore(),
        getProgressWriteStore(),
        getLocalJobIds(),
        getLocallyManagedPersistedJobIds(),
        jobId,
      );
      guard.abort(error);
      logPersistedJobUpdateError(jobId, { status: "running" }, error);
    },
  });

  return {
    ...guard,
    stop: stopHeartbeat,
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
      : await insertProjectJob(record, input);
    getStore().set(persistedRecord.id, persistedRecord);
    getLocalJobIds().delete(persistedRecord.id);
    options.onDisposition?.({
      coalesced: persistedRecord.id !== record.id,
      jobId: persistedRecord.id,
      requestedJobId: record.id,
    });
    if (options.runNow) {
      const claimed = await claimQueuedProjectJob(persistedRecord.id);
      if (!claimed) {
        throw new Error(
          "Prosjektjobben kunne ikke reserveres av serverversjonen som godtok den.",
        );
      }
      drainAfterRun(
        input.projectId,
        await runProjectJob(
          persistedRecord.id,
          input,
          jobRunContextFromClaim(claimed),
        ),
      );
    } else if (shouldAutoRun) {
      await claimAndScheduleProjectJobAutorun(persistedRecord.id, input);
    }

    return persistedRecord;
  }

  getStore().set(record.id, record);
  getLocalJobIds().add(record.id);
  options.onDisposition?.({
    coalesced: false,
    jobId: record.id,
    requestedJobId: record.id,
  });
  if (options.runNow) {
    await runProjectJob(record.id, input, {
      persisted: false,
    });
  } else if (shouldAutoRun) {
    autoRunProjectJob(input, async () => {
      await runProjectJob(record.id, input, {
        persisted: false,
      });
    });
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
  activeLease?: ActiveProjectJobLease,
): Promise<ProjectJobRunOutcome> {
  const phaseTimer = createJobPhaseTimer(jobId, input.kind);
  if (context.persisted) {
    getLocallyManagedPersistedJobIds().add(jobId);
  }
  const lease = activeLease ?? startJobHeartbeat(jobId, context);
  let terminalPatch: Partial<ProjectJobRecord> | null = null;
  let failureTerminalMetadata: Record<string, unknown> = {};
  let acceptReportedTerminalMetadata = true;
  let terminalPersisted = false;
  let workflowAbandoned = false;

  try {
    lease.assertActive();
    updateJob(jobId, { status: "running" }, context, { markStarted: true });
    const result = await runProjectWorkflowWithDeadline({
      kind: input.kind,
      workflowSignal: lease.signal,
      run: (workflowSignal) =>
        runWithProjectWorkflowContext(
          {
            signal: workflowSignal,
            lease: context.persisted
              ? {
                  jobId,
                  leaseToken: context.leaseToken,
                  projectId: input.projectId,
                }
              : undefined,
            reportTerminalMetadata(metadata) {
              if (!acceptReportedTerminalMetadata) {
                return;
              }
              const sanitized = projectJobTerminalMetadataFromError({
                projectJobTerminalMetadata: metadata,
              });
              if (Object.keys(sanitized).length > 0) {
                failureTerminalMetadata = sanitized;
              }
            },
          },
          async () => {
            const assertWorkflowActive = () => workflowSignal.throwIfAborted();
            const committed = context.persisted ? await recoverCommittedProjectJobResult(input.projectId, jobId) : null;
            const completeCheckpoint = committed && !("completion_status" in committed && committed.completion_status === "evaluation_pending");
            const workflowResult = completeCheckpoint ? committed : await runProjectWorkflow(input, {
              setProgress(message) {
                assertWorkflowActive();
                updateJob(jobId, { message, status: "running" }, context);
              },
              onPhase(phase) {
                assertWorkflowActive();
                phaseTimer.mark(phase);
              },
              assertActive: assertWorkflowActive,
              timings: () => phaseTimer.timings(),
              totalDurationMs: () => phaseTimer.total(),
            });
            assertWorkflowActive();

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
              assertWorkflowActive();
              workflowResult.docling_enhancement_job_id = queuedEnhancement.id;
            }

            return workflowResult;
          },
        ),
    });
    lease.assertActive();

    logJobPhase({
      jobId,
      kind: input.kind,
      phase: "total",
      durationMs: phaseTimer.total(),
    });

    terminalPatch = {
      status: "completed",
      message: "completion_status" in result && result.completion_status === "evaluation_pending"
        ? "Løsningsutkastet er lagret. Revurdering gjenstår." : "Ferdig.",
      result,
      error: null,
    };
  } catch (error) {
    acceptReportedTerminalMetadata = false;
    if (lease.signal.aborted || isProjectJobLeaseLostError(error)) {
      evictCachedProjectJob(
        getStore(),
        getProgressWriteStore(),
        getLocalJobIds(),
        getLocallyManagedPersistedJobIds(),
        jobId,
      );
      console.warn(
        JSON.stringify({
          event: "project_job_execution_cancelled",
          job_id: jobId,
          reason: "lease_lost",
        }),
      );
      return { terminalPersisted: false, workflowAbandoned: true };
    }
    const committed = context.persisted ? await recoverCommittedProjectJobResult(input.projectId, jobId).catch(() => null) : null;
    if (committed) {
      terminalPatch = { status: "completed", message: "completion_status" in committed
        ? "Løsningsutkastet er lagret. Revurdering gjenstår." : "Resultatet er lagret.", error: null, result: committed };
    } else {
    const errorTerminalMetadata = projectJobTerminalMetadataFromError(error);
    if (Object.keys(errorTerminalMetadata).length > 0) {
      failureTerminalMetadata = errorTerminalMetadata;
    }
    if (isProjectWorkflowDeadlineExceededError(error)) {
      workflowAbandoned = true;
      console.warn(
        JSON.stringify({
          event: "project_job_execution_timeout",
          job_id: jobId,
          kind: input.kind,
          timeout_ms: error.timeoutMs,
          last_completed_phase: phaseTimer.lastCompletedPhase(),
          requirement_response_handoff:
            failureTerminalMetadata.requirement_response_handoff ?? null,
        }),
      );
      terminalPatch = {
        status: "failed",
        message: "Jobben nådde totalfristen.",
        error: `Jobben overskred totalfristen. Siste fullførte fase: ${phaseTimer.lastCompletedPhase()}.`,
        result: null,
      };
    } else {
      console.warn(
        JSON.stringify({
          event: "project_job_execution_failed",
          job_id: jobId,
          kind: input.kind,
          ...safeErrorTelemetry(error),
          last_completed_phase: phaseTimer.lastCompletedPhase(),
          requirement_response_handoff:
            failureTerminalMetadata.requirement_response_handoff ?? null,
        }),
      );
      terminalPatch = {
        status: "failed",
        message: "Jobben feilet.",
        error: productionSafeErrorMessage(
          error,
          "Jobben feilet. Kontakt support med feilreferansen.",
        ),
        result: null,
      };
    }
    }
  } finally {
    try {
      if (terminalPatch) {
        terminalPersisted = await finishJob(
          jobId,
          terminalPatch,
          context,
          input,
          failureTerminalMetadata,
        );
        lease.stop();
      }
    } finally {
      lease.stop();
      getLocallyManagedPersistedJobIds().delete(jobId);
    }
  }
  return { terminalPersisted, workflowAbandoned };
}

export async function getProjectJob(projectId: string, jobId: string) {
  const job = await readProjectJobAuthoritatively({
    jobs: getStore(),
    localJobIds: getLocalJobIds(),
    locallyManagedPersistedJobIds: getLocallyManagedPersistedJobIds(),
    projectId,
    jobId,
    findPersisted: () => findProjectJob(projectId, jobId),
  });
  return job ? { ...job, result: projectJobResultForRead(job.result) } : null;
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
  resumeArtifactId?: string;
}, options: QueueJobOptions = {}) {
  return enqueueProjectJob(
    {
      kind: "perfect_system_solution",
      projectId: input.projectId,
      model: input.model,
      resumeArtifactId: input.resumeArtifactId,
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

/** Claims and runs one queued job; null when another job holds the project. */
async function runQueuedProjectJobInput(
  jobId: string,
  input: ProjectWorkflowInput,
): Promise<ProjectJobRunOutcome | null> {
  const claimed = await claimQueuedProjectJob(jobId);
  if (!claimed) {
    return null;
  }

  return runProjectJob(jobId, input, jobRunContextFromClaim(claimed));
}

function jobRunContextFromClaim(claimed: ClaimedProjectJob): JobRunContext {
  return {
    persisted: true,
    leaseToken: claimed.leaseToken,
  };
}

/**
 * Runs one queued job in the calling request. `drainNext` hands the project's
 * next queued job to this web process afterwards; scripts leave it off because
 * work queued in their memory ends with the script.
 */
export async function runQueuedProjectJob(
  jobId: string,
  options: { drainNext?: boolean } = {},
) {
  const queuedInput = await getQueuedProjectJobInput(jobId);
  if (!queuedInput) {
    return;
  }

  const input = parseProjectWorkflowInput(queuedInput);
  const outcome = await runQueuedProjectJobInput(jobId, input);
  if (outcome && options.drainNext) drainAfterRun(input.projectId, outcome);
}

export async function runAvailableProjectJobs(options: {
  limit?: number;
  staleAfterMs?: number;
  deadlineAt: number;
  now?: () => number;
}) {
  await resetStaleRunningProjectJobs(options.staleAfterMs);
  return runProjectJobsWithinBudget({
    deadlineAt: options.deadlineAt,
    now: options.now ?? Date.now,
    maxJobs: options.limit ?? 1,
    listQueuedJobIds: listQueuedProjectJobIds,
    async readQueuedInput(jobId) {
      const queuedInput = await getQueuedProjectJobInput(jobId);
      return queuedInput ? parseProjectWorkflowInput(queuedInput) : null;
    },
    timeoutMsFor: (kind) => projectWorkflowTimeoutMs(kind),
    async claimAndRun(jobId, input) {
      const outcome = await runQueuedProjectJobInput(jobId, input);
      if (!outcome) return "claim_refused";
      return outcome.workflowAbandoned ? "workflow_abandoned" : "ran";
    },
    safeErrorMessage: (error) => productionSafeErrorMessage(
      error,
      "Jobben feilet. Kontakt support med feilreferansen.",
    ),
  });
}
