import "server-only";

import { errorRequestId } from "@/lib/server/safe-errors";
import type { ProjectJobKind } from "@/lib/types";

/** Room for the terminal write and result recovery after a workflow deadline. */
export const PROJECT_JOB_WORKER_JOB_MARGIN_MS = 60_000;
/** Upper bound on queued rows one worker invocation inspects. */
export const PROJECT_JOB_WORKER_MAX_SCAN = 20;
/** Upper bound on jobs one worker invocation may run. */
export const PROJECT_JOB_WORKER_MAX_JOBS = 10;
/** Matches projectJobWorkerReplicaTimeout when the replica does not report it. */
export const DEFAULT_PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS = 2100;
/** Kept free at the end of the replica for the response and server shutdown. */
export const PROJECT_JOB_WORKER_SHUTDOWN_ALLOWANCE_MS = 60_000;
/** Assumed server startup when a caller does not send its own deadline. */
const DEFAULT_STARTUP_ALLOWANCE_MS = 120_000;

export function projectJobWorkerReplicaTimeoutMs(
  environment: Record<string, string | undefined> = process.env,
) {
  const configured = Number(environment.PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS);
  return (Number.isSafeInteger(configured) && configured >= 60
    ? configured
    : DEFAULT_PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS) * 1000;
}

/**
 * Turns a worker request into a job limit and planning deadline. The scheduled
 * worker sends a deadline measured from its process start; without one the
 * slowest server startup is assumed. No plan reaches past this replica.
 */
export function projectJobWorkerPlan(
  body: Record<string, unknown>,
  input: { requestStartedAt: number; environment?: Record<string, string | undefined> },
) {
  const latest = input.requestStartedAt +
    projectJobWorkerReplicaTimeoutMs(input.environment) -
    PROJECT_JOB_WORKER_SHUTDOWN_ALLOWANCE_MS;
  const requestedDeadline = body.deadline_at;
  const deadlineAt = typeof requestedDeadline === "number" && Number.isFinite(requestedDeadline)
    ? Math.min(requestedDeadline, latest)
    : latest - DEFAULT_STARTUP_ALLOWANCE_MS;
  const requestedLimit = body.limit;
  const limit = typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), PROJECT_JOB_WORKER_MAX_JOBS)
    : 1;
  return { limit, deadlineAt };
}

export type ProjectJobWorkerResult = {
  job_id: string;
  status: "processed" | "skipped" | "failed";
  reason?: "not_queued" | "claim_refused" | "insufficient_time" | "workflow_abandoned";
  error?: string;
};

type ProjectJobWorkerBudgetRuntime<Input extends { kind: ProjectJobKind }> = {
  deadlineAt: number;
  now: () => number;
  maxJobs: number;
  listQueuedJobIds: (limit: number) => Promise<string[]>;
  readQueuedInput: (jobId: string) => Promise<Input | null>;
  timeoutMsFor: (kind: ProjectJobKind) => number;
  /**
   * Claims in the database and runs the job. "workflow_abandoned" means the
   * deadline or a lost lease released the runner while the work may still be
   * running in this process.
   */
  claimAndRun: (
    jobId: string,
    input: Input,
  ) => Promise<"claim_refused" | "ran" | "workflow_abandoned">;
  safeErrorMessage: (error: unknown) => string;
  warn?: (entry: Record<string, unknown>) => void;
  jobMarginMs?: number;
  maxScan?: number;
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

/** A run that failed after it started, carrying what it left behind. */
export class ProjectJobRunError extends Error {
  readonly outcome: ProjectJobRunOutcome;
  /** The backend's request id, kept visible to safeErrorTelemetry. */
  declare readonly request_id?: string;

  constructor(cause: unknown, outcome: ProjectJobRunOutcome) {
    super(cause instanceof Error ? cause.message : "Prosjektjobben feilet.", { cause });
    this.name = "ProjectJobRunError";
    this.outcome = outcome;
    const requestId = errorRequestId(cause);
    if (requestId) this.request_id = requestId;
  }
}

export function isProjectJobClaimsClosedError(error: unknown) {
  return error instanceof Error && error.message.startsWith("PROJECT_JOB_CLAIMS_CLOSED:");
}

/**
 * Run queued jobs one at a time while the replica still has room for the
 * candidate's full workflow deadline. The first job only needs its deadline to
 * fit; later jobs also need the job margin. The queue is re-read after every
 * job, because finishing one job can unblock another job in the same project.
 * Each queued row is considered at most once, which bounds the scan. The loop
 * stops once a workflow was abandoned, since that work still occupies the
 * process.
 */
export async function runProjectJobsWithinBudget<Input extends { kind: ProjectJobKind }>(
  runtime: ProjectJobWorkerBudgetRuntime<Input>,
) {
  const jobMarginMs = runtime.jobMarginMs ?? PROJECT_JOB_WORKER_JOB_MARGIN_MS;
  const maxScan = runtime.maxScan ?? PROJECT_JOB_WORKER_MAX_SCAN;
  const warn = runtime.warn ?? ((entry) => console.warn(JSON.stringify(entry)));
  const considered = new Set<string>();
  const results: ProjectJobWorkerResult[] = [];
  let processed = 0;

  while (processed < runtime.maxJobs && considered.size < maxScan) {
    const candidates = (await runtime.listQueuedJobIds(maxScan))
      .filter((jobId) => !considered.has(jobId));
    let ranJob = false;

    for (const jobId of candidates) {
      if (considered.size >= maxScan) break;
      considered.add(jobId);
      try {
        const input = await runtime.readQueuedInput(jobId);
        if (!input) {
          results.push({ job_id: jobId, status: "skipped", reason: "not_queued" });
          continue;
        }
        const remainingMs = runtime.deadlineAt - runtime.now();
        const timeoutMs = runtime.timeoutMsFor(input.kind);
        if (remainingMs < timeoutMs + (processed === 0 ? 0 : jobMarginMs)) {
          if (processed === 0) {
            // The first job may use the whole remaining replica time; if even
            // that is too short, its deadline needs a longer replica timeout.
            warn({
              event: "project_job_worker_first_job_exceeds_budget",
              job_id: jobId,
              kind: input.kind,
              timeout_ms: timeoutMs,
              remaining_ms: remainingMs,
            });
          }
          // A shorter queued job may still fit, so keep scanning.
          results.push({ job_id: jobId, status: "skipped", reason: "insufficient_time" });
          continue;
        }
        const outcome = await runtime.claimAndRun(jobId, input);
        if (outcome === "claim_refused") {
          results.push({ job_id: jobId, status: "skipped", reason: "claim_refused" });
          continue;
        }
        if (outcome === "workflow_abandoned") {
          results.push({ job_id: jobId, status: "processed", reason: "workflow_abandoned" });
          return results;
        }
        results.push({ job_id: jobId, status: "processed" });
        processed += 1;
        ranJob = true;
        break;
      } catch (error) {
        results.push({
          job_id: jobId,
          status: "failed",
          error: runtime.safeErrorMessage(error),
        });
        // Release cutover closes claims for every job; stop instead of
        // reporting the same refusal for the remaining queue. Abandoned work
        // still occupies the process even when its terminal write failed.
        if (isProjectJobClaimsClosedError(error)) return results;
        if (error instanceof ProjectJobRunError && error.outcome.workflowAbandoned) return results;
      }
    }

    if (!ranJob) break;
  }

  return results;
}
