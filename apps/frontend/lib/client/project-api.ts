import type {
  CustomerAnalysisResult,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  GeneratedArtifactAuthorityByType,
  GeneratedArtifactType,
  ProjectDocument,
  ProjectJobRecord,
  ProjectServiceDescription,
  ProjectSnapshotResult,
  ProjectDetail,
  SolutionEvaluationResult,
  CustomerAnalysisSection,
} from "@/lib/types";
import {
  clearClientCache,
  readClientCache,
  type ClientReadOptions,
  PROJECT_SERVICES_CACHE_TTL_MS,
  projectServicesCacheKey,
} from "@/lib/client-cache";

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
type ProjectReadOptions = ClientReadOptions;

function projectReadCacheKey(projectId: string, resource: string) {
  return `project-read:${projectId}:${resource}`;
}

// Mutations invalidate before sending and again when the response arrives, so a
// read started during the request cannot cache pre-mutation state.
function invalidateProjectReadCache(projectId: string) {
  clearClientCache(`project-read:${projectId}:`);
  clearClientCache(projectServicesCacheKey(projectId));
}

function errorMessageFromPayload(
  payload: unknown,
  fallbackMessage: string,
) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const fields = payload as {
    error?: unknown;
    detail?: unknown;
    message?: unknown;
  };
  const value = [fields.error, fields.detail, fields.message].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  if (!value) {
    return "";
  }

  return normalizeApiErrorMessage(value, fallbackMessage);
}

function normalizeApiErrorMessage(value: string, fallbackMessage: string) {
  const message = value.trim();
  if (/^unsupported\s+content\s+type$/i.test(message)) {
    return `${fallbackMessage} Serveren mottok en forespørsel med feil innholdstype. Last siden på nytt og prøv igjen.`;
  }

  return message;
}

function errorMessageFromText(text: string, fallbackMessage: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallbackMessage;
  }

  try {
    const payload = JSON.parse(trimmed) as unknown;
    const message = errorMessageFromPayload(payload, fallbackMessage);
    if (message) {
      return message;
    }
  } catch {
    // Not JSON; use the text below.
  }

  return normalizeApiErrorMessage(trimmed, fallbackMessage);
}

export async function readJsonPayload<T>(
  response: Response,
  fallbackMessage: string,
): Promise<Partial<T> & { error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // The fields are only checked by callers; a failed request may carry none.
    const payload = (await response.json().catch(() => ({ error: fallbackMessage }))) as Partial<T> & {
      error?: string;
    };
    const message = errorMessageFromPayload(payload, fallbackMessage);
    return message ? { ...payload, error: message } : payload;
  }

  const text = await response.text().catch(() => "");
  const looksLikeHtml = /^\s*</.test(text);
  const noFields: Partial<T> = {};
  return {
    ...noFields,
    error: looksLikeHtml
      ? `${fallbackMessage} Serveren returnerte en HTML-feilside i stedet for JSON. Sjekk serverloggen for detaljer.`
      : errorMessageFromText(text, fallbackMessage),
  };
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

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollProjectJob({
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
  let transportFailures = 0;
  let terminalCacheInvalidated = false;

  while (true) {
    const baseDelay = delays[Math.min(attempt, delays.length - 1)] ?? 12000;
    const delay =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? Math.max(baseDelay, 20000)
        : baseDelay;

    await sleep(delay, signal);
    attempt += 1;

    let statusPayload: { error?: string; job?: ProjectJobRecord };
    try {
      const statusResponse = await fetch(`/api/projects/${projectId}/jobs/${jobId}`, { cache: "no-store", signal });
      statusPayload = await readJsonPayload<{ error?: string; job?: ProjectJobRecord }>(statusResponse, "Kunne ikke hente jobbstatus.");
      if (!statusResponse.ok || !statusPayload.job) {
        if ([401, 403, 404].includes(statusResponse.status)) {
          throw Object.assign(new Error(statusPayload.error || "Jobben er ikke tilgjengelig."), { permanent: true });
        }
        throw new Error("Kontakt med jobbstatus er midlertidig utilgjengelig.");
      }
      transportFailures = 0;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if ((error as { permanent?: boolean })?.permanent || ++transportFailures >= 5) {
        throw new Error("Mistet kontakt med jobbstatus. Jobben kan fortsatt pågå. Last inn prosjektet på nytt for å sjekke resultatet.");
      }
      continue;
    }
    if (!statusPayload.job) continue;

    if (
      !terminalCacheInvalidated &&
      (statusPayload.job.status === "completed" ||
        statusPayload.job.status === "failed")
    ) {
      terminalCacheInvalidated = true;
      invalidateProjectReadCache(projectId);
    }

    onStatus(statusPayload.job);

    if (statusPayload.job.status === "failed") {
      throw new Error(
        statusPayload.job.error
          ? errorMessageFromText(statusPayload.job.error, "Jobben feilet.")
          : "Jobben feilet.",
      );
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
  signal?.throwIfAborted();
  if (typeof window === "undefined" || !("EventSource" in window)) {
    return pollProjectJob({ projectId, jobId, onStatus, signal });
  }

  return new Promise<ProjectJobRecord>((resolve, reject) => {
    let settled = false;
    let fallbackStarted = false;
    let terminalCacheInvalidated = false;
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
      settled = true;
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
      if (settled) return;
      let payload: { job?: ProjectJobRecord } | null;
      try { payload = JSON.parse((event as MessageEvent).data); }
      catch { fallbackToPolling(); return; }
      if (!payload?.job) {
        fallbackToPolling();
        return;
      }

      if (
        !terminalCacheInvalidated &&
        (payload.job.status === "completed" || payload.job.status === "failed")
      ) {
        terminalCacheInvalidated = true;
        invalidateProjectReadCache(projectId);
      }

      try {
        onStatus(payload.job);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      if (payload.job.status === "failed") {
        cleanup();
        reject(
          new Error(
            payload.job.error
              ? errorMessageFromText(payload.job.error, "Jobben feilet.")
              : "Jobben feilet.",
          ),
        );
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
      fallbackToPolling();
    });
  });
}

export async function createProject(input: {
  name: string;
  customer_name: string;
  industry: string;
  description: string;
  selected_service_ids?: string[];
}) {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readJsonPayload<{ id: string }>(
    response,
    "Kunne ikke opprette prosjekt.",
  );
  if (!response.ok || !payload.id) {
    throw new Error(payload.error || "Kunne ikke opprette prosjekt.");
  }
  return payload.id;
}

export async function fetchProjectState(projectId: string, signal?: AbortSignal): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store", signal });
  const payload = await readJsonPayload<ProjectDetail>(response, "Kunne ikke oppdatere prosjektstatus.");
  if (!response.ok || !payload.id) throw new Error(payload.error ?? "Kunne ikke oppdatere prosjektstatus.");
  // A successful response from this route is a complete project.
  return payload as ProjectDetail;
}

export async function fetchProjectServices(
  projectId: string,
  options: ProjectReadOptions = {},
) {
  return readClientCache(
    projectServicesCacheKey(projectId),
    async () => {
      const response = await fetch(
        `/api/projects/${projectId}/service-descriptions`,
        { cache: "no-store", signal: options.signal },
      );
      const payload = await readJsonPayload<{
        services?: ProjectServiceDescription[];
        error?: string;
      }>(response, "Kunne ikke hente tjenestebeskrivelser.");
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
      }
      return payload.services;
    },
    PROJECT_SERVICES_CACHE_TTL_MS,
    options,
  );
}

export async function fetchCustomerAnalysis(
  projectId: string,
  options: ProjectReadOptions = {},
) {
  return readClientCache(
    projectReadCacheKey(projectId, "customer-analysis"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/customer-analysis`, {
        cache: "no-store",
        signal: options.signal,
      });
      const payload = await readJsonPayload<{
        error?: string;
        analysis?: CustomerAnalysisResult | null;
      }>(response, "Kunne ikke hente kundeanalysen.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke hente kundeanalysen.");
      }
      return payload.analysis ?? null;
    },
    PROJECT_READ_CACHE_TTL_MS,
    options,
  );
}

export async function fetchSolutionEvaluation(
  projectId: string,
  options: ProjectReadOptions = {},
) {
  return readClientCache(
    projectReadCacheKey(projectId, "solution-evaluation"),
    async () => {
      const response = await fetch(
        `/api/projects/${projectId}/solution-evaluation`,
        { cache: "no-store", signal: options.signal },
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
    PROJECT_READ_CACHE_TTL_MS,
    options,
  );
}

export async function fetchExecutiveSummary(
  projectId: string,
  options: ProjectReadOptions = {},
) {
  return readClientCache(
    projectReadCacheKey(projectId, "executive-summary"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/executive-summary`, {
        cache: "no-store",
        signal: options.signal,
      });
      const payload = await readJsonPayload<{
        error?: string;
        executive_summary?: ExecutiveSummaryResult | null;
      }>(response, "Kunne ikke hente lederoppsummeringen.");
      if (!response.ok) {
        throw new Error(payload.error || "Kunne ikke hente lederoppsummeringen.");
      }
      return payload.executive_summary ?? null;
    },
    PROJECT_READ_CACHE_TTL_MS,
    options,
  );
}

export async function fetchGeneratedArtifacts(
  projectId: string,
  options: ProjectReadOptions & { artifactType?: GeneratedArtifactType } = {},
) {
  const resource = options.artifactType
    ? `generated-artifacts:${options.artifactType}`
    : "generated-artifacts";
  return readClientCache(
    projectReadCacheKey(projectId, resource),
    async () => {
      const query = options.artifactType
        ? `?artifact_type=${encodeURIComponent(options.artifactType)}`
        : "";
      const response = await fetch(`/api/projects/${projectId}/generate${query}`, {
        cache: "no-store",
        signal: options.signal,
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
    PROJECT_READ_CACHE_TTL_MS,
    options,
  );
}

export async function fetchProjectArtifactAuthority(
  projectId: string,
  options: ProjectReadOptions = {},
) {
  const response = await fetch(`/api/projects/${projectId}/artifact-authority`, {
    cache: "no-store",
    signal: options.signal,
  });
  const payload = await readJsonPayload<{
    error?: string;
    artifact_authority?: GeneratedArtifactAuthorityByType;
    current_artifact_types?: GeneratedArtifactType[];
  }>(response, "Kunne ikke hente artefaktstatus.");
  if (
    !response.ok ||
    !payload.artifact_authority ||
    !payload.current_artifact_types
  ) {
    throw new Error(payload.error || "Kunne ikke hente artefaktstatus.");
  }
  return {
    artifactAuthority: payload.artifact_authority,
    currentArtifactTypes: payload.current_artifact_types,
  };
}

export function prefetchProjectTabData(
  projectId: string,
  tab: ProjectWorkspaceTabName,
  hints?: {
    customerAnalysisGenerated?: boolean;
    solutionEvaluationGenerated?: boolean;
    artifactCount?: number;
    artifactType?: GeneratedArtifactType;
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
    requests.push(
      fetchGeneratedArtifacts(projectId, { artifactType: hints?.artifactType }),
    );
  }

  if (tab === "service-description") {
    requests.push(fetchProjectServices(projectId));
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
  }).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    document?: ProjectDocument;
    project?: ProjectSnapshotResult;
    job?: ProjectJobRecord;
  }>(response, input.fallbackMessage);
  if (!response.ok || !payload.document || !payload.project) {
    throw new Error(payload.error || input.fallbackMessage);
  }
  return {
    document: payload.document,
    project: payload.project,
    job: payload.job ?? null,
  };
}

// Short enough that a poll always reads fresh state, long enough to share one
// request between callers that refresh at the same moment.
const PROJECT_JOBS_CACHE_TTL_MS = 2_000;

/** Drops a cached or in-flight job list, e.g. after applying a newer status. */
export function invalidateProjectJobsCache(projectId: string) {
  clearClientCache(projectReadCacheKey(projectId, "jobs"));
}

export async function fetchProjectJobs(projectId: string) {
  return readClientCache(
    projectReadCacheKey(projectId, "jobs"),
    async () => {
      const response = await fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store" });
      const payload = await readJsonPayload<{ jobs?: ProjectJobRecord[] }>(
        response,
        "Kunne ikke hente jobbstatus.",
      );
      if (!response.ok || !Array.isArray(payload.jobs)) {
        throw new Error(payload.error || "Kunne ikke hente jobbstatus.");
      }
      return payload.jobs;
    },
    PROJECT_JOBS_CACHE_TTL_MS,
  );
}

/** A refused API request; `code` is the server's workflow error code, if any. */
export class ProjectApiError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
    this.code = code;
  }
}

export function isProjectWorkflowBusyError(error: unknown): error is ProjectApiError {
  return error instanceof ProjectApiError && error.code === "PROJECT_WORKFLOW_BUSY";
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
  }).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    code?: unknown;
    job?: ProjectJobRecord;
  }>(response, input.fallbackMessage);
  if (!response.ok || !payload.job) {
    throw new ProjectApiError(
      payload.error || input.fallbackMessage,
      response.status,
      typeof payload.code === "string" ? payload.code : null,
    );
  }
  return payload.job;
}

export async function saveCustomerAnalysisSection(input: {
  projectId: string;
  section: CustomerAnalysisSection;
  snapshot: unknown;
  revision?: string;
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
        expected_analysis_revision: input.revision,
      }),
    },
  ).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    analysis?: CustomerAnalysisResult;
    project?: ProjectSnapshotResult;
  }>(response, "Kunne ikke lagre analysen.");
  if (!response.ok || !payload.analysis) {
    throw new Error(payload.error || "Kunne ikke lagre analysen.");
  }
  return {
    analysis: payload.analysis,
    project: payload.project ?? null,
  };
}

export async function updateGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
  title: string;
  contentMarkdown: string;
  acknowledgeDeterministicRepairs?: boolean;
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
      acknowledge_deterministic_repairs:
        input.acknowledgeDeterministicRepairs === true,
    }),
  }).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    artifact?: GeneratedArtifact;
    project?: ProjectSnapshotResult;
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
  }).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    project?: ProjectSnapshotResult;
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
  ).finally(() => invalidateProjectReadCache(input.projectId));
  const payload = await readJsonPayload<{
    error?: string;
    project?: ProjectSnapshotResult;
  }>(response, "Kunne ikke slette dokumentet.");
  if (!response.ok || !payload.project) {
    throw new Error(payload.error || "Kunne ikke slette dokumentet.");
  }
  return {
    project: payload.project,
  };
}
