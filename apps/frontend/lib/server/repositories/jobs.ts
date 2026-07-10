import "server-only";

import { randomUUID as generateRandomUUID } from "node:crypto";

import { createServiceClient } from "@/lib/server/supabase";
import { authoritativeLeaseError } from "@/lib/server/repositories/lease-fenced-persistence";
import type { ProjectWorkflowLease } from "@/lib/server/project-workflow-cancellation";
import type { ProjectJobRecord, ProjectJobResult } from "@/lib/types";

type JobRow = {
  id: string;
  project_id: string;
  kind: ProjectJobRecord["kind"];
  status: ProjectJobRecord["status"];
  message: string;
  error: string | null;
  input_json: unknown | null;
  result_json: ProjectJobResult | null;
  created_at: string;
  updated_at: string;
  locked_at: string | null;
  lease_token: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type ClaimedProjectJob = {
  leaseToken: string;
};

type PersistedJobUpdateOptions = {
  leaseToken: string;
  markStarted?: boolean;
};

type ProjectJobRepositoryRuntime = {
  client?: ReturnType<typeof createServiceClient>;
  now?: () => Date;
  randomUUID?: () => string;
};

function serviceClient(runtime: ProjectJobRepositoryRuntime) {
  return runtime.client ?? createServiceClient();
}

function nowIso(runtime: ProjectJobRepositoryRuntime) {
  return (runtime.now?.() ?? new Date()).toISOString();
}

function assertLeaseToken(leaseToken: string) {
  if (!leaseToken.trim()) {
    throw new Error("Prosjektjobben mangler en gyldig lease-token.");
  }
}

function mapJobRow(row: JobRow): ProjectJobRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    created_at: row.created_at,
    updated_at: row.updated_at,
    error: row.error,
    result: row.status === "completed" ? row.result_json : null,
  };
}

export async function insertProjectJob(
  record: ProjectJobRecord,
  queuedInput: unknown,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const durablePayload = {
    id: record.id,
    project_id: record.project_id,
    kind: record.kind,
    status: record.status,
    message: record.message,
    error: record.error,
    input_json: queuedInput,
    result_json: null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };

  const inserted = await supabase.from("project_jobs").insert(durablePayload);
  if (inserted.error) {
    throw new Error(inserted.error.message);
  }
}

export async function insertFollowUpProjectJob(
  record: ProjectJobRecord,
  queuedInput: unknown,
  parentLease: ProjectWorkflowLease,
  idempotencyKey: string,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  assertLeaseToken(parentLease.leaseToken);
  if (!idempotencyKey.trim()) {
    throw new Error("Oppfølgingsjobben mangler idempotency key.");
  }

  const supabase = serviceClient(runtime);
  const { data, error } = await supabase.rpc("lease_fenced_enqueue_project_job", {
    p_parent_job_id: parentLease.jobId,
    p_parent_lease_token: parentLease.leaseToken,
    p_project_id: parentLease.projectId,
    p_idempotency_key: idempotencyKey,
    p_job: {
      id: record.id,
      kind: record.kind,
      message: record.message,
      input_json: queuedInput,
      created_at: record.created_at,
      updated_at: record.updated_at,
    },
  });

  if (error) {
    throw authoritativeLeaseError(parentLease.jobId, error);
  }
  if (!data) {
    throw new Error("Kunne ikke lagre idempotent oppfølgingsjobb.");
  }

  return mapJobRow(data as JobRow);
}

export async function updatePersistedProjectJob(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  options: PersistedJobUpdateOptions,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  assertLeaseToken(options.leaseToken);
  const supabase = serviceClient(runtime);
  const now = nowIso(runtime);
  const payload: Record<string, unknown> = {
    updated_at: now,
  };
  if (patch.status !== undefined) {
    payload.status = patch.status;
    if (patch.status === "running") {
      payload.locked_at = now;
      if (options.markStarted) {
        payload.started_at = now;
      }
    }
    if (patch.status === "completed" || patch.status === "failed") {
      payload.completed_at = now;
      payload.locked_at = null;
      payload.lease_token = null;
    }
  }
  if (patch.message !== undefined) payload.message = patch.message;
  if (patch.error !== undefined) payload.error = patch.error;
  if (patch.result !== undefined) payload.result_json = patch.result;

  const updateQuery = supabase
    .from("project_jobs")
    .update(payload)
    .eq("id", jobId)
    .eq("status", "running")
    .eq("lease_token", options.leaseToken);

  const updated = await updateQuery.select("id").maybeSingle<{ id: string }>();
  if (updated.error) {
    throw new Error(updated.error.message);
  }
  return Boolean(updated.data);
}

export async function heartbeatProjectJob(
  jobId: string,
  leaseToken: string,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  return updatePersistedProjectJob(
    jobId,
    { status: "running" },
    { leaseToken },
    runtime,
  );
}

export async function findProjectJob(
  projectId: string,
  jobId: string,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const { data, error } = await supabase
    .from("project_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("project_id", projectId)
    .maybeSingle<JobRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? mapJobRow(data) : null;
}

export async function getQueuedProjectJobInput(
  jobId: string,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const { data, error } = await supabase
    .from("project_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle<JobRow>();

  if (error || !data) {
    throw new Error(error?.message || "Fant ikke køet prosjektjobb.");
  }

  if (data.status !== "queued") {
    return null;
  }

  if (data.input_json !== null && data.input_json !== undefined) {
    return data.input_json;
  }

  throw new Error("Prosjektjobben mangler kjøredata.");
}

export async function claimQueuedProjectJob(
  jobId: string,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const now = nowIso(runtime);
  const leaseToken = runtime.randomUUID?.() ?? generateRandomUUID();
  assertLeaseToken(leaseToken);
  const payload = {
    status: "running",
    message: "Starter jobben ...",
    locked_at: now,
    lease_token: leaseToken,
    started_at: now,
    updated_at: now,
  };
  const claimed = await supabase
    .from("project_jobs")
    .update(payload)
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle<{ id: string }>();
  if (claimed.error) {
    throw new Error(claimed.error.message);
  }
  return claimed.data ? ({ leaseToken } satisfies ClaimedProjectJob) : null;
}

export async function listQueuedProjectJobIds(
  limit = 3,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const { data, error } = await supabase
    .from("project_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => row.id as string);
}

export async function resetStaleRunningProjectJobs(
  staleAfterMs = 15 * 60_000,
  runtime: ProjectJobRepositoryRuntime = {},
) {
  const supabase = serviceClient(runtime);
  const nowDate = runtime.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - staleAfterMs).toISOString();
  const reset = await supabase
    .from("project_jobs")
    .update({
      status: "queued",
      message: "Gjenopptar avbrutt jobb ...",
      locked_at: null,
      lease_token: null,
      updated_at: now,
    })
    .eq("status", "running")
    .or(`locked_at.is.null,locked_at.lt.${cutoff}`)
    .select("id");

  if (reset.error) {
    throw new Error(reset.error.message);
  }
  return reset.data?.length ?? 0;
}
