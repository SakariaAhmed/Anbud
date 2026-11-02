import "server-only";
import { createServiceClient } from "@/lib/server/data-api";
import { getProjectWorkflowLease, type ProjectWorkflowLease } from "@/lib/server/project-workflow-cancellation";
import { parseAutomaticAnalysisRequest } from "@/lib/automatic-analysis";
import { authoritativeLeaseError } from "@/lib/server/repositories/lease-fenced-persistence";
import type { AutomaticAnalysisRequest } from "@/lib/types";
import { safeErrorTelemetry } from "@/lib/server/safe-errors";

export async function getAutomaticAnalysisRequest(projectId: string): Promise<AutomaticAnalysisRequest | null> {
  const { data, error } = await createServiceClient().from("project_analysis_requests")
    .select("request_id,status,job_id,source_revision,reason_code,updated_at").eq("project_id", projectId).maybeSingle<unknown>();
  if (error) throw new Error(error.message);
  return parseAutomaticAnalysisRequest(data);
}

/** The SQL owner checks readiness under the project lock, either within the
 * finishing workflow's lease or after the project becomes idle. */
export async function scheduleReadyCustomerAnalysis(projectId: string, lease: ProjectWorkflowLease | null = getProjectWorkflowLease() ?? null) {
  const request = await getAutomaticAnalysisRequest(projectId);
  if (request?.status !== "pending") return;
  const { error } = await createServiceClient().rpc("schedule_ready_customer_analysis", { p_project_id: projectId, p_parent_job_id: lease?.jobId ?? null, p_parent_lease_token: lease?.leaseToken ?? null });
  if (error) {
    const failure = lease ? authoritativeLeaseError(lease.jobId, error) : new Error(error.message);
    // Preserve a newer upload intent. A failed scheduling attempt does not
    // become an unbounded retry on every subsequent job completion.
    if (!error.message.includes("PROJECT_JOB_LEASE_LOST")) {
      const { error: markError } = await createServiceClient().from("project_analysis_requests")
        .update({ status: "failed", reason_code: "scheduling_failed", updated_at: new Date().toISOString() })
        .eq("project_id", projectId).eq("request_id", request.request_id).eq("status", "pending");
      if (markError) console.error(JSON.stringify({ event: "automatic_analysis_failure_state_not_saved", project_id: projectId, ...safeErrorTelemetry(markError) }));
    }
    throw failure;
  }
}

export async function dispatchReadyCustomerAnalyses() {
  const { error } = await createServiceClient().rpc("dispatch_ready_customer_analyses", { p_limit: 20 });
  if (error) throw new Error(error.message);
}
