import type { ProjectJobRecord } from "@/lib/types";

type ProjectJobCache = Map<string, ProjectJobRecord>;
type ProgressWriteCache = Map<
  string,
  { message: string; writtenAt: number }
>;

export const TERMINAL_PROJECT_JOB_CACHE_TTL_MS = 10 * 60_000;
export const TERMINAL_PROJECT_JOB_CACHE_MAX_ENTRIES = 128;

function isTerminalProjectJob(job: ProjectJobRecord) {
  return job.status === "completed" || job.status === "failed";
}

function touchCachedProjectJob(jobs: ProjectJobCache, job: ProjectJobRecord) {
  jobs.delete(job.id);
  jobs.set(job.id, job);
}

function terminalRecordWithoutResult(job: ProjectJobRecord) {
  return isTerminalProjectJob(job) && job.result !== null
    ? { ...job, result: null }
    : job;
}

export function pruneTerminalProjectJobCache(
  jobs: ProjectJobCache,
  options: {
    now?: number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  const ttlMs = Math.max(0, options.ttlMs ?? TERMINAL_PROJECT_JOB_CACHE_TTL_MS);
  const maxEntries = Math.max(
    0,
    Math.floor(options.maxEntries ?? TERMINAL_PROJECT_JOB_CACHE_MAX_ENTRIES),
  );
  const evicted: string[] = [];
  const terminalIds: string[] = [];

  for (const [jobId, job] of jobs) {
    if (!isTerminalProjectJob(job)) {
      continue;
    }
    const terminalAt = Date.parse(job.updated_at || job.created_at);
    if (!Number.isFinite(terminalAt) || now - terminalAt >= ttlMs) {
      jobs.delete(jobId);
      evicted.push(jobId);
      continue;
    }
    terminalIds.push(jobId);
  }

  const overLimit = Math.max(0, terminalIds.length - maxEntries);
  for (const jobId of terminalIds.slice(0, overLimit)) {
    jobs.delete(jobId);
    evicted.push(jobId);
  }

  return evicted;
}

function cachedJobForProject(
  jobs: ProjectJobCache,
  projectId: string,
  jobId: string,
) {
  const cached = jobs.get(jobId) ?? null;
  if (cached?.project_id !== projectId) {
    return null;
  }
  if (isTerminalProjectJob(cached)) {
    touchCachedProjectJob(jobs, cached);
  }
  return cached;
}

export function evictCachedProjectJob(
  jobs: ProjectJobCache,
  progressWrites: ProgressWriteCache,
  localJobIds: Set<string>,
  locallyManagedPersistedJobIds: Set<string>,
  jobId: string,
) {
  jobs.delete(jobId);
  progressWrites.delete(jobId);
  localJobIds.delete(jobId);
  locallyManagedPersistedJobIds.delete(jobId);
}

export function reconcilePersistedProjectJobCachePatch(input: {
  jobs: ProjectJobCache;
  progressWrites: ProgressWriteCache;
  localJobIds: Set<string>;
  locallyManagedPersistedJobIds: Set<string>;
  jobId: string;
  patch: Partial<ProjectJobRecord>;
  accepted: boolean;
  updatedAt?: string;
}) {
  if (!input.accepted) {
    evictCachedProjectJob(
      input.jobs,
      input.progressWrites,
      input.localJobIds,
      input.locallyManagedPersistedJobIds,
      input.jobId,
    );
    return;
  }

  const current = input.jobs.get(input.jobId);
  if (!current) {
    return;
  }
  if (
    (current.status === "completed" || current.status === "failed") &&
    input.patch.status === "running"
  ) {
    return;
  }

  touchCachedProjectJob(input.jobs, {
    ...current,
    ...input.patch,
    updated_at: input.updatedAt ?? new Date().toISOString(),
  });
}

export function reconcileTerminalProjectJobCache(input: {
  jobs: ProjectJobCache;
  progressWrites: ProgressWriteCache;
  localJobIds: Set<string>;
  locallyManagedPersistedJobIds: Set<string>;
  jobId: string;
  patch: Partial<ProjectJobRecord>;
  persisted: boolean;
  updatedAt?: string;
}) {
  input.progressWrites.delete(input.jobId);
  if (!input.persisted) {
    evictCachedProjectJob(
      input.jobs,
      input.progressWrites,
      input.localJobIds,
      input.locallyManagedPersistedJobIds,
      input.jobId,
    );
    return;
  }

  const isLocalOnly = input.localJobIds.has(input.jobId);
  const isPersistedJob = input.locallyManagedPersistedJobIds.has(input.jobId);
  if (!isLocalOnly) {
    input.locallyManagedPersistedJobIds.delete(input.jobId);
  }

  const current = input.jobs.get(input.jobId);
  if (!current) {
    return;
  }

  const updated = {
    ...current,
    ...input.patch,
    updated_at: input.updatedAt ?? new Date().toISOString(),
  };
  touchCachedProjectJob(
    input.jobs,
    isPersistedJob ? terminalRecordWithoutResult(updated) : updated,
  );
}

export async function readProjectJobAuthoritatively(input: {
  jobs: ProjectJobCache;
  localJobIds: Set<string>;
  locallyManagedPersistedJobIds: Set<string>;
  projectId: string;
  jobId: string;
  findPersisted: () => Promise<ProjectJobRecord | null>;
}) {
  const cached = cachedJobForProject(
    input.jobs,
    input.projectId,
    input.jobId,
  );
  if (
    cached &&
    (input.localJobIds.has(input.jobId) ||
      input.locallyManagedPersistedJobIds.has(input.jobId))
  ) {
    return cached;
  }

  try {
    const persisted = await input.findPersisted();
    if (!persisted) {
      if (cached) {
        input.jobs.delete(input.jobId);
      }
      input.localJobIds.delete(input.jobId);
      input.locallyManagedPersistedJobIds.delete(input.jobId);
      return null;
    }

    touchCachedProjectJob(
      input.jobs,
      terminalRecordWithoutResult(persisted),
    );
    input.localJobIds.delete(input.jobId);
    return persisted;
  } catch {
    return cached;
  }
}
