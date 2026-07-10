import "server-only";

import { ProjectJobLeaseLostError } from "@/lib/server/project-job-heartbeat";
import { getProjectWorkflowLease } from "@/lib/server/project-workflow-cancellation";
import { createServiceClient } from "@/lib/server/supabase";

const LEASE_LOST_MARKER = "PROJECT_JOB_LEASE_LOST";

type LeaseFencedPersistenceRuntime = {
  client?: ReturnType<typeof createServiceClient>;
};

export type LeaseFencedMutationResult<T> =
  | { fenced: false; data: null }
  | { fenced: true; data: T };

function persistenceErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return error instanceof Error ? error.message : String(error ?? "");
}

export function authoritativeLeaseError(jobId: string, error: unknown) {
  if (persistenceErrorMessage(error).includes(LEASE_LOST_MARKER)) {
    return new ProjectJobLeaseLostError(jobId, { cause: error });
  }
  return new Error(persistenceErrorMessage(error));
}

function isAuthoritativeLeaseLoss(error: unknown) {
  return (
    error instanceof ProjectJobLeaseLostError ||
    persistenceErrorMessage(error).includes(LEASE_LOST_MARKER)
  );
}

export function rethrowAuthoritativeLeaseLoss(error: unknown): void {
  if (isAuthoritativeLeaseLoss(error)) {
    throw error;
  }
}

export async function runLeaseFencedProjectMutation<T>(
  projectId: string,
  operation: string,
  payload: Record<string, unknown>,
  runtime: LeaseFencedPersistenceRuntime = {},
): Promise<LeaseFencedMutationResult<T>> {
  const lease = getProjectWorkflowLease();
  if (!lease) {
    return { fenced: false, data: null };
  }

  if (lease.projectId !== projectId) {
    throw new ProjectJobLeaseLostError(lease.jobId, {
      cause: new Error("Prosjektjobben forsøkte å skrive til et annet prosjekt."),
    });
  }

  const supabase = runtime.client ?? createServiceClient();
  const { data, error } = await supabase.rpc("lease_fenced_project_write", {
    p_job_id: lease.jobId,
    p_lease_token: lease.leaseToken,
    p_project_id: projectId,
    p_operation: operation,
    p_payload: payload,
  });

  if (error) {
    throw authoritativeLeaseError(lease.jobId, error);
  }

  return { fenced: true, data: data as T };
}
