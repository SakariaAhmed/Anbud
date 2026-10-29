import "server-only";

import type { ProjectJobKind } from "@/lib/types";

/** Room for the terminal write and result recovery after a workflow deadline. */
export const PROJECT_JOB_WORKER_JOB_MARGIN_MS = 60_000;
/** Upper bound on queued rows one worker invocation inspects. */
export const PROJECT_JOB_WORKER_MAX_SCAN = 20;
/** Upper bound on jobs one worker invocation may run. */
export const PROJECT_JOB_WORKER_MAX_JOBS = 10;

export type ProjectJobWorkerResult = {
  job_id: string;
  status: "processed" | "skipped" | "failed";
  reason?: "not_queued" | "claim_refused" | "insufficient_time";
  error?: string;
};

type ProjectJobWorkerBudgetRuntime<Input extends { kind: ProjectJobKind }> = {
  deadlineAt: number;
  now: () => number;
  maxJobs: number;
  listQueuedJobIds: (limit: number) => Promise<string[]>;
  readQueuedInput: (jobId: string) => Promise<Input | null>;
  timeoutMsFor: (kind: ProjectJobKind) => number;
  /** Claims in the database and runs the job; false when the claim is refused. */
  claimAndRun: (jobId: string, input: Input) => Promise<boolean>;
  safeErrorMessage: (error: unknown) => string;
  jobMarginMs?: number;
  maxScan?: number;
};

export function isProjectJobClaimsClosedError(error: unknown) {
  return error instanceof Error && error.message.startsWith("PROJECT_JOB_CLAIMS_CLOSED:");
}

/**
 * Run queued jobs one at a time while the replica still has room for the
 * candidate's full workflow deadline. The queue is re-read after every job,
 * because finishing one job can unblock another job in the same project.
 * Each queued row is considered at most once, which bounds the scan.
 */
export async function runProjectJobsWithinBudget<Input extends { kind: ProjectJobKind }>(
  runtime: ProjectJobWorkerBudgetRuntime<Input>,
) {
  const jobMarginMs = runtime.jobMarginMs ?? PROJECT_JOB_WORKER_JOB_MARGIN_MS;
  const maxScan = runtime.maxScan ?? PROJECT_JOB_WORKER_MAX_SCAN;
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
        if (remainingMs < runtime.timeoutMsFor(input.kind) + jobMarginMs) {
          // A shorter queued job may still fit, so keep scanning.
          results.push({ job_id: jobId, status: "skipped", reason: "insufficient_time" });
          continue;
        }
        if (!(await runtime.claimAndRun(jobId, input))) {
          results.push({ job_id: jobId, status: "skipped", reason: "claim_refused" });
          continue;
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
        // reporting the same refusal for the remaining queue.
        if (isProjectJobClaimsClosedError(error)) return results;
      }
    }

    if (!ranJob) break;
  }

  return results;
}
