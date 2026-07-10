import "server-only";

import { randomUUID } from "node:crypto";

import { createServiceClient } from "@/lib/server/supabase";
import type { ProjectJobRecord, ProjectJobResult } from "@/lib/types";

type StoredQueuedJobPayload = {
  __job_input: unknown;
};

type JobRow = {
  id: string;
  project_id: string;
  kind: ProjectJobRecord["kind"];
  status: ProjectJobRecord["status"];
  message: string;
  error: string | null;
  input_json?: unknown | null;
  result_json: ProjectJobResult | StoredQueuedJobPayload | null;
  created_at: string;
  updated_at: string;
  locked_at?: string | null;
  lease_token?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

export type ClaimedProjectJob = {
  leaseToken: string | null;
};

type PersistedJobUpdateOptions = {
  expectedStatus?: ProjectJobRecord["status"];
  leaseToken?: string | null;
  markStarted?: boolean;
};

function isStoredQueuedJobPayload(value: unknown): value is StoredQueuedJobPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__job_input" in value &&
      (value as StoredQueuedJobPayload).__job_input,
  );
}

function isMissingDurableJobColumn(error: { message?: string } | null | undefined) {
  return /input_json|locked_at|lease_token|started_at|completed_at|schema cache/i.test(
    error?.message ?? "",
  );
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
    result:
      row.status === "completed" && !isStoredQueuedJobPayload(row.result_json)
        ? (row.result_json as ProjectJobResult | null)
        : null,
  };
}

export async function insertProjectJob(
  record: ProjectJobRecord,
  queuedInput: unknown,
) {
  const supabase = createServiceClient();
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
  if (!inserted.error) {
    return;
  }

  if (!isMissingDurableJobColumn(inserted.error)) {
    throw new Error(inserted.error.message);
  }

  const legacyPayload = {
    id: record.id,
    project_id: record.project_id,
    kind: record.kind,
    status: record.status,
    message: record.message,
    error: record.error,
    result_json: { __job_input: queuedInput },
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
  const legacyInserted = await supabase.from("project_jobs").insert(legacyPayload);
  if (legacyInserted.error) {
    throw new Error(legacyInserted.error.message);
  }
}

export async function updatePersistedProjectJob(
  jobId: string,
  patch: Partial<ProjectJobRecord>,
  options: PersistedJobUpdateOptions = {},
) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
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

  let updateQuery = supabase
    .from("project_jobs")
    .update(payload)
    .eq("id", jobId);
  if (options.expectedStatus) {
    updateQuery = updateQuery.eq("status", options.expectedStatus);
  }
  if (options.leaseToken) {
    updateQuery = updateQuery.eq("lease_token", options.leaseToken);
  }

  const updated = await updateQuery.select("id").maybeSingle<{ id: string }>();
  if (!updated.error) {
    return Boolean(updated.data);
  }

  if (!isMissingDurableJobColumn(updated.error)) {
    throw new Error(updated.error.message);
  }

  delete payload.started_at;
  delete payload.completed_at;
  delete payload.locked_at;
  delete payload.lease_token;
  let legacyUpdateQuery = supabase
    .from("project_jobs")
    .update(payload)
    .eq("id", jobId);
  if (options.expectedStatus) {
    legacyUpdateQuery = legacyUpdateQuery.eq("status", options.expectedStatus);
  }

  const legacyUpdated = await legacyUpdateQuery
    .select("id")
    .maybeSingle<{ id: string }>();
  if (legacyUpdated.error) {
    throw new Error(legacyUpdated.error.message);
  }
  return Boolean(legacyUpdated.data);
}

export async function findProjectJob(projectId: string, jobId: string) {
  const supabase = createServiceClient();
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

export async function getQueuedProjectJobInput(jobId: string) {
  const supabase = createServiceClient();
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

  if (data.input_json) {
    return data.input_json;
  }

  if (isStoredQueuedJobPayload(data.result_json)) {
    return data.result_json.__job_input;
  }

  throw new Error("Prosjektjobben mangler kjøredata.");
}

export async function claimQueuedProjectJob(jobId: string) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const leaseToken = randomUUID();
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
  if (!claimed.error) {
    return claimed.data ? ({ leaseToken } satisfies ClaimedProjectJob) : null;
  }

  if (!isMissingDurableJobColumn(claimed.error)) {
    throw new Error(claimed.error.message);
  }

  const legacyClaimed = await supabase
    .from("project_jobs")
    .update({
      status: "running",
      message: "Starter jobben ...",
      updated_at: now,
    })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle<{ id: string }>();
  if (legacyClaimed.error) {
    throw new Error(legacyClaimed.error.message);
  }

  return legacyClaimed.data
    ? ({ leaseToken: null } satisfies ClaimedProjectJob)
    : null;
}

export async function listQueuedProjectJobIds(limit = 3) {
  const supabase = createServiceClient();
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

export async function resetStaleRunningProjectJobs(staleAfterMs = 15 * 60_000) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
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
    .or(`locked_at.is.null,locked_at.lt.${cutoff}`);

  if (!reset.error) {
    return;
  }

  if (isMissingDurableJobColumn(reset.error)) {
    const legacyReset = await supabase
      .from("project_jobs")
      .update({
        status: "queued",
        message: "Gjenopptar avbrutt jobb ...",
        updated_at: now,
      })
      .eq("status", "running")
      .lt("updated_at", cutoff);
    if (!legacyReset.error) {
      return;
    }
    throw new Error(legacyReset.error.message);
  }

  throw new Error(reset.error.message);
}
