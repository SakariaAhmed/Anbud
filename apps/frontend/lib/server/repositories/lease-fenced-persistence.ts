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

function authoritativeLeaseForProject(projectId: string) {
  const lease = getProjectWorkflowLease();
  if (!lease) {
    return null;
  }

  if (lease.projectId !== projectId) {
    throw new ProjectJobLeaseLostError(lease.jobId, {
      cause: new Error("Prosjektjobben forsøkte å skrive til et annet prosjekt."),
    });
  }

  return lease;
}

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
  if (
    operation === "solution_evaluation" ||
    operation === "customer_analysis" ||
    operation === "generated_artifact" ||
    operation === "executive_summary"
  ) {
    throw new Error(
      `${
        operation === "solution_evaluation"
          ? "Løsningsvurderinger"
          : operation === "customer_analysis"
            ? "Kundeanalyser"
            : operation === "generated_artifact"
              ? "Generatorartefakter"
              : "Lederoppsummeringer"
      } må bruke den atomiske, versjonsfencede lagringsoperasjonen.`,
    );
  }

  const lease = authoritativeLeaseForProject(projectId);
  if (!lease) {
    return { fenced: false, data: null };
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

/**
 * Generated artifacts are versioned project outputs. The dedicated RPC fences
 * both mutable source revisions and the exact ordered knowledge-artifact
 * manifest before allocating the next per-type version atomically.
 */
export async function runLeaseFencedGeneratedArtifactMutation<T>(
  projectId: string,
  payload: Record<string, unknown>,
  runtime: LeaseFencedPersistenceRuntime = {},
): Promise<LeaseFencedMutationResult<T>> {
  const lease = authoritativeLeaseForProject(projectId);
  if (!lease) {
    return { fenced: false, data: null };
  }

  const supabase = runtime.client ?? createServiceClient();
  const { data, error } = await supabase.rpc(
    "lease_fenced_save_generated_artifact",
    {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_project_id: projectId,
      p_payload: payload,
    },
  );

  if (error) {
    throw authoritativeLeaseError(lease.jobId, error);
  }

  return { fenced: true, data: data as T };
}

export async function runLeaseFencedCustomerAnalysisMutation<T>(
  projectId: string,
  payload: Record<string, unknown>,
  runtime: LeaseFencedPersistenceRuntime = {},
): Promise<LeaseFencedMutationResult<T>> {
  const lease = authoritativeLeaseForProject(projectId);
  if (!lease) {
    return { fenced: false, data: null };
  }

  const supabase = runtime.client ?? createServiceClient();
  const { data, error } = await supabase.rpc(
    "lease_fenced_save_customer_analysis",
    {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_project_id: projectId,
      p_payload: payload,
    },
  );

  if (error) {
    throw authoritativeLeaseError(lease.jobId, error);
  }

  return { fenced: true, data: data as T };
}

/**
 * Solution evaluations need stronger fencing than a per-job lease: two
 * different jobs can both own valid leases while completing out of order.
 * The dedicated RPC serializes on the project, rejects superseded jobs, and
 * commits the evaluation, summary invalidation, and project flag atomically.
 */
export async function runLeaseFencedSolutionEvaluationMutation<T>(
  projectId: string,
  payload: Record<string, unknown>,
  runtime: LeaseFencedPersistenceRuntime = {},
): Promise<LeaseFencedMutationResult<T>> {
  const lease = authoritativeLeaseForProject(projectId);
  if (!lease) {
    return { fenced: false, data: null };
  }

  const supabase = runtime.client ?? createServiceClient();
  const { data, error } = await supabase.rpc(
    "lease_fenced_save_solution_evaluation",
    {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_project_id: projectId,
      p_payload: payload,
    },
  );

  if (error) {
    throw authoritativeLeaseError(lease.jobId, error);
  }

  return { fenced: true, data: data as T };
}

export async function runLeaseFencedExecutiveSummaryMutation<T>(
  projectId: string,
  payload: Record<string, unknown>,
  runtime: LeaseFencedPersistenceRuntime = {},
): Promise<LeaseFencedMutationResult<T>> {
  const lease = authoritativeLeaseForProject(projectId);
  if (!lease) {
    return { fenced: false, data: null };
  }
  const supabase = runtime.client ?? createServiceClient();
  const { data, error } = await supabase.rpc(
    "lease_fenced_save_executive_summary",
    {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_project_id: projectId,
      p_payload: payload,
    },
  );
  if (error) {
    throw authoritativeLeaseError(lease.jobId, error);
  }
  return { fenced: true, data: data as T };
}
