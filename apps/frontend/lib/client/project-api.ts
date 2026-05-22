import type {
  CustomerAnalysisResult,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  ProjectDocument,
  ProjectJobRecord,
  ProjectServiceDescription,
  ProjectSnapshotResult,
  SolutionEvaluationResult,
  CustomerAnalysisSection,
} from "@/lib/types";
import {
  clearClientCache,
  getClientCache,
  setClientCache,
} from "@/lib/client-cache";

export type ProjectSnapshotPayload = ProjectSnapshotResult;

type ProjectWorkspaceTabName =
  | "documents"
  | "analysis"
  | "bilag1"
  | "service-description"
  | "requirements"
  | "generator"
  | "evaluation"
  | "delivery"
  | "executive-summary";

const PROJECT_READ_CACHE_TTL_MS = 30_000;
const pendingProjectReads = new Map<string, Promise<unknown>>();

export type OpenAIModelSummary = {
  id: string;
  created: number | null;
  owned_by: string | null;
};

function projectReadCacheKey(projectId: string, resource: string) {
  return `project-read:${projectId}:${resource}`;
}

function cachedProjectRead<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = PROJECT_READ_CACHE_TTL_MS,
) {
  const cached = getClientCache<{ value: T }>(key);
  if (cached) {
    return Promise.resolve(cached.value);
  }

  const pending = pendingProjectReads.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  const request = fetcher()
    .then((value) => {
      setClientCache(key, { value }, ttlMs);
      return value;
    })
    .finally(() => {
      pendingProjectReads.delete(key);
    });

  pendingProjectReads.set(key, request);
  return request;
}

export function invalidateProjectReadCache(projectId: string) {
  clearClientCache(`project-read:${projectId}:`);
  for (const key of pendingProjectReads.keys()) {
    if (key.startsWith(`project-read:${projectId}:`)) {
      pendingProjectReads.delete(key);
    }
  }
}

export function markClientPerformance(
  name: string,
  detail?: Record<string, unknown>,
) {
  if (typeof window === "undefined" || !("performance" in window)) {
    return;
  }

  const markName = `anbud:${name}`;
  performance.mark(markName, { detail });
  console.info(
    JSON.stringify({
      event: "client_performance_mark",
      name,
      detail,
      at: Math.round(performance.now()),
    }),
  );
}

export async function readJsonPayload<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T & { error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T & { error?: string };
  }

  const text = await response.text().catch(() => "");
  const looksLikeHtml = /^\s*</.test(text);
  return {
    error: looksLikeHtml
      ? `${fallbackMessage} Serveren returnerte en HTML-feilside i stedet for JSON. Sjekk serverloggen for detaljer.`
      : text.trim() || fallbackMessage,
  } as T & { error?: string };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timeout = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function pollProjectJob({
  projectId,
  jobId,
  onStatus,
  signal,
}: {
  projectId: string;
  jobId: string;
  onStatus: (job: ProjectJobRecord) => void;
  signal?: AbortSignal;
}) {
  const delays = [1500, 3000, 5000, 8000, 12000];
  let attempt = 0;

  while (true) {
    const baseDelay = delays[Math.min(attempt, delays.length - 1)] ?? 12000;
    const delay =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? Math.max(baseDelay, 20000)
        : baseDelay;

    await sleep(delay, signal);
    attempt += 1;

    const statusResponse = await fetch(
      `/api/projects/${projectId}/jobs/${jobId}`,
      { cache: "no-store", signal },
    );
    const statusPayload = await readJsonPayload<{
      error?: string;
      job?: ProjectJobRecord;
    }>(statusResponse, "Kunne ikke hente jobbstatus.");
    if (!statusResponse.ok || !statusPayload.job) {
      throw new Error(statusPayload.error || "Kunne ikke hente jobbstatus.");
    }

    onStatus(statusPayload.job);

    if (statusPayload.job.status === "failed") {
      throw new Error(statusPayload.job.error || "Jobben feilet.");
    }

    if (
      statusPayload.job.status === "completed" &&
      statusPayload.job.result
    ) {
      return statusPayload.job;
    }
  }
}

export async function watchProjectJob({
  projectId,
  jobId,
  onStatus,
  signal,
}: {
  projectId: string;
  jobId: string;
  onStatus: (job: ProjectJobRecord) => void;
  signal?: AbortSignal;
}) {
  if (typeof window === "undefined" || !("EventSource" in window)) {
    return pollProjectJob({ projectId, jobId, onStatus, signal });
  }

  return new Promise<ProjectJobRecord>((resolve, reject) => {
    let settled = false;
    let sawEvent = false;
    let fallbackStarted = false;
    const source = new EventSource(
      `/api/projects/${projectId}/jobs/${jobId}/events`,
    );

    const cleanup = () => {
      settled = true;
      source.close();
      signal?.removeEventListener("abort", onAbort);
    };

    const fallbackToPolling = () => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      source.close();
      signal?.removeEventListener("abort", onAbort);
      void pollProjectJob({ projectId, jobId, onStatus, signal })
        .then(resolve)
        .catch(reject);
    };

    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    source.addEventListener("job", (event) => {
      sawEvent = true;
      const payload = JSON.parse((event as MessageEvent).data) as {
        job?: ProjectJobRecord;
      };
      if (!payload.job || settled) {
        return;
      }

      onStatus(payload.job);

      if (payload.job.status === "failed") {
        cleanup();
        reject(new Error(payload.job.error || "Jobben feilet."));
        return;
      }

      if (payload.job.status === "completed" && payload.job.result) {
        cleanup();
        markClientPerformance("project_job_completed", {
          project_id: projectId,
          job_id: jobId,
          kind: payload.job.kind,
        });
        resolve(payload.job);
      }
    });

    source.addEventListener("error", () => {
      if (!sawEvent || source.readyState === EventSource.CLOSED) {
        fallbackToPolling();
      }
    });
  });
}

export async function fetchOpenAIModels() {
  const response = await fetch("/api/openai-models");
  return readJsonPayload<{
    models?: OpenAIModelSummary[];
    default_model?: string;
  }>(response, "Kunne ikke hente modeller.");
}

export async function fetchProjectServices(projectId: string) {
  const response = await fetch(`/api/projects/${projectId}/service-descriptions`);
  const payload = await readJsonPayload<{
    services?: ProjectServiceDescription[];
    error?: string;
  }>(response, "Kunne ikke hente tjenestebeskrivelser.");
  if (!response.ok || !payload.services) {
    throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
  }
  return payload.services;
}

export async function fetchCustomerAnalysis(projectId: string) {
  return cachedProjectRead(
    projectReadCacheKey(projectId, "customer-analysis"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/customer-analysis`);
      const payload = await readJsonPayload<{
        error?: string;
        analysis?: CustomerAnalysisResult | null;
      }>(response, "Kunne ikke hente kundeanalysen.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke hente kundeanalysen.");
      }
      return payload.analysis ?? null;
    },
  );
}

export async function fetchSolutionEvaluation(projectId: string) {
  return cachedProjectRead(
    projectReadCacheKey(projectId, "solution-evaluation"),
    async () => {
      const response = await fetch(
        `/api/projects/${projectId}/solution-evaluation`,
      );
      const payload = await readJsonPayload<{
        error?: string;
        evaluation?: SolutionEvaluationResult | null;
      }>(response, "Kunne ikke hente løsningsvurderingen.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke hente løsningsvurderingen.");
      }
      return payload.evaluation ?? null;
    },
  );
}

export async function fetchExecutiveSummary(projectId: string) {
  return cachedProjectRead(
    projectReadCacheKey(projectId, "executive-summary"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/executive-summary`);
      const payload = await readJsonPayload<{
        error?: string;
        executive_summary?: ExecutiveSummaryResult | null;
      }>(response, "Kunne ikke hente lederoppsummeringen.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke hente lederoppsummeringen.");
      }
      return payload.executive_summary ?? null;
    },
  );
}

export async function fetchGeneratedArtifacts(projectId: string) {
  return cachedProjectRead(
    projectReadCacheKey(projectId, "generated-artifacts"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/generate`, {
        cache: "no-store",
      });
      const payload = await readJsonPayload<{
        error?: string;
        artifacts?: GeneratedArtifact[];
      }>(response, "Kunne ikke hente generatorresultatene.");
      if (!response.ok || !payload.artifacts) {
        throw new Error(payload.error || "Kunne ikke hente generatorresultatene.");
      }
      return payload.artifacts;
    },
  );
}

export function prefetchProjectTabData(
  projectId: string,
  tab: ProjectWorkspaceTabName,
  hints?: {
    customerAnalysisGenerated?: boolean;
    solutionEvaluationGenerated?: boolean;
    artifactCount?: number;
  },
) {
  const requests: Array<Promise<unknown>> = [];

  if (tab === "analysis" && hints?.customerAnalysisGenerated !== false) {
    requests.push(fetchCustomerAnalysis(projectId));
  }

  if (tab === "evaluation" && hints?.solutionEvaluationGenerated !== false) {
    requests.push(fetchSolutionEvaluation(projectId));
  }

  if (
    tab === "executive-summary" &&
    hints?.solutionEvaluationGenerated !== false
  ) {
    requests.push(fetchExecutiveSummary(projectId));
  }

  if (
    (tab === "generator" ||
      tab === "delivery" ||
      tab === "requirements" ||
      tab === "bilag1") &&
    hints?.artifactCount !== 0
  ) {
    requests.push(fetchGeneratedArtifacts(projectId));
  }

  if (!requests.length) {
    return Promise.resolve();
  }

  return Promise.all(requests.map((request) => request.catch(() => null))).then(
    () => undefined,
  );
}

export async function uploadProjectDocument(input: {
  projectId: string;
  formData: FormData;
  fallbackMessage: string;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(`/api/projects/${input.projectId}/documents`, {
    method: "POST",
    body: input.formData,
  });
  const payload = await readJsonPayload<{
    error?: string;
    document?: ProjectDocument;
    project?: ProjectSnapshotPayload;
  }>(response, input.fallbackMessage);
  if (!response.ok || !payload.document || !payload.project) {
    throw new Error(payload.error || input.fallbackMessage);
  }
  return {
    document: payload.document,
    project: payload.project,
  };
}

export async function startProjectJob(input: {
  projectId: string;
  body: unknown;
  headers?: Record<string, string>;
  fallbackMessage: string;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(`/api/projects/${input.projectId}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...input.headers },
    body: JSON.stringify(input.body),
  });
  const payload = await readJsonPayload<{
    error?: string;
    job?: ProjectJobRecord;
  }>(response, input.fallbackMessage);
  if (!response.ok || !payload.job) {
    throw new Error(payload.error || input.fallbackMessage);
  }
  return payload.job;
}

export async function saveCustomerAnalysisSection(input: {
  projectId: string;
  section: CustomerAnalysisSection;
  snapshot: unknown;
  headers?: Record<string, string>;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(
    `/api/projects/${input.projectId}/customer-analysis`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...input.headers },
      body: JSON.stringify({
        section: input.section,
        section_snapshot: input.snapshot,
      }),
    },
  );
  const payload = await readJsonPayload<{
    error?: string;
    analysis?: CustomerAnalysisResult;
    project?: ProjectSnapshotPayload;
  }>(response, "Kunne ikke lagre analysen.");
  if (!response.ok || !payload.analysis || !payload.project) {
    throw new Error(payload.error || "Kunne ikke lagre analysen.");
  }
  return {
    analysis: payload.analysis,
    project: payload.project,
  };
}

export async function updateGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
  title: string;
  contentMarkdown: string;
  headers?: Record<string, string>;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(`/api/projects/${input.projectId}/generate`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...input.headers },
    body: JSON.stringify({
      artifact_id: input.artifactId,
      title: input.title,
      content_markdown: input.contentMarkdown,
    }),
  });
  const payload = await readJsonPayload<{
    error?: string;
    artifact?: GeneratedArtifact;
    project?: ProjectSnapshotPayload;
  }>(response, "Kunne ikke lagre kravbesvarelsen.");
  if (!response.ok || !payload.artifact || !payload.project) {
    throw new Error(payload.error || "Kunne ikke lagre kravbesvarelsen.");
  }
  return {
    artifact: payload.artifact,
    project: payload.project,
  };
}

export async function deleteGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
  headers?: Record<string, string>;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(`/api/projects/${input.projectId}/generate`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...input.headers },
    body: JSON.stringify({ artifact_id: input.artifactId }),
  });
  const payload = await readJsonPayload<{
    error?: string;
    project?: ProjectSnapshotPayload;
  }>(response, "Kunne ikke slette artefakten.");
  if (!response.ok || !payload.project) {
    throw new Error(payload.error || "Kunne ikke slette artefakten.");
  }
  return {
    project: payload.project,
  };
}

export async function deleteProjectDocument(input: {
  projectId: string;
  documentId: string;
}) {
  invalidateProjectReadCache(input.projectId);
  const response = await fetch(
    `/api/projects/${input.projectId}/documents/${input.documentId}`,
    { method: "DELETE" },
  );
  const payload = await readJsonPayload<{
    error?: string;
    project?: ProjectSnapshotPayload;
  }>(response, "Kunne ikke slette dokumentet.");
  if (!response.ok || !payload.project) {
    throw new Error(payload.error || "Kunne ikke slette dokumentet.");
  }
  return {
    project: payload.project,
  };
}
