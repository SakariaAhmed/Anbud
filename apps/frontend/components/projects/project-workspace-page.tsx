"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowRight,
  Brain,
  ClipboardCheck,
  FileCheck2,
  FileText,
  FolderOpen,
  Scale,
  Sparkles,
  Wrench,
} from "lucide-react";

import {
  getClientCache,
  PROJECT_SERVICES_CACHE_TTL_MS,
  projectServicesCacheKey,
  setClientCache,
} from "@/lib/client-cache";
import {
  deleteGeneratedArtifact,
  deleteProjectDocument,
  fetchCustomerAnalysis,
  fetchExecutiveSummary,
  fetchGeneratedArtifacts,
  fetchProjectArtifactAuthority,
  fetchProjectServices,
  fetchSolutionEvaluation,
  markClientPerformance,
  saveCustomerAnalysisSection,
  startProjectJob,
  updateGeneratedArtifact,
  uploadProjectDocument,
  watchProjectJob,
  type ProjectSnapshotPayload,
} from "@/lib/client/project-api";
import { useProjectJobRunner } from "@/hooks/use-project-job-runner";
import { useProjectWorkspacePrefetch } from "@/hooks/use-project-workspace-prefetch";
import { selectSolutionEvaluationDocumentCandidates } from "@/components/projects/project-evaluation-documents";
import {
  isDocumentReadyForEvaluation,
  isSolutionEvaluationCandidate,
  requirementDocumentIdsForGeneration,
} from "@/lib/document-processing";
import {
  ProjectWorkspaceShell,
  ProjectWorkspaceTabContent,
  type SecondaryNavGroup,
} from "@/components/projects/project-workspace-shell";
import {
  isProjectWorkspaceTab,
  type ProjectWorkspaceTab,
  type WorkflowStepItem,
} from "@/components/projects/project-workspace-types";
import {
  applyProjectSnapshot,
  createLatestArtifactAuthorityRequestGate,
  hasAuthoritativeCurrentArtifact,
  loadedArtifactTypesMissingAuthorityVersion,
  mergeGeneratedArtifactsForType,
  prependGeneratedArtifactVersion,
  reconcileGeneratedArtifactAuthority,
  solutionProposalWorkflowStatus,
} from "@/components/projects/project-workflow-status";
import { deriveProjectStatus } from "@/components/projects/project-workspace-shared";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  CustomerAnalysisSectionSnapshotMap,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentRole,
  ProjectServiceDescription,
  ProjectJobRecord,
  SolutionEvaluationResult,
} from "@/lib/types";

export type { ProjectWorkspaceTab } from "@/components/projects/project-workspace-types";

const PROJECT_WORKSPACE_UI_SCALE = 0.9;
const DEFAULT_SIDEBAR_WIDTH = Math.round(285 * PROJECT_WORKSPACE_UI_SCALE);
const MIN_SIDEBAR_WIDTH = Math.round(270 * PROJECT_WORKSPACE_UI_SCALE);
const MAX_SIDEBAR_WIDTH = Math.round(440 * PROJECT_WORKSPACE_UI_SCALE);

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
const SIDEBAR_WIDTH_STORAGE_KEY = "project-workspace-sidebar-width-v4";

function normalizeProjectState(
  project: ProjectDetail,
  options?: {
    preserveArtifactCount?: boolean;
  },
): ProjectDetail {
  return {
    ...project,
    status: deriveProjectStatus(project),
    document_count: project.documents.length,
    supporting_document_count: project.documents.length,
    artifact_count: options?.preserveArtifactCount
      ? project.artifact_count
      : project.generated_artifacts.length,
  };
}

function dedupeDocuments(documents: ProjectDocument[]) {
  const seen = new Set<string>();
  return documents.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

function documentFromJobResult(
  result: ProjectJobRecord["result"],
): ProjectDocument | null {
  if (!result || typeof result !== "object" || !("document" in result)) {
    return null;
  }

  const document = (result as { document?: unknown }).document;
  if (!document || typeof document !== "object" || !("id" in document)) {
    return null;
  }

  return document as ProjectDocument;
}

function prependGeneratedArtifact(
  artifacts: GeneratedArtifact[],
  artifact: GeneratedArtifact,
) {
  return prependGeneratedArtifactVersion(artifacts, artifact);
}

const CUSTOMER_ANALYSIS_SECTIONS: CustomerAnalysisSection[] = [
  "summary",
  "strategy",
  "clarifications",
  "design",
  "risks",
  "needs",
  "keywords",
  "value",
];

const WORKSPACE_ARTIFACT_TYPES: GeneratedArtifactType[] = [
  "bilag1_rekonstruksjon",
  "forbedret_kravsvar",
  "gjennomforing_og_risiko",
  "losningsutkast",
];

const ARTIFACT_TYPE_BY_TAB: Partial<
  Record<ProjectWorkspaceTab, GeneratedArtifactType>
> = {
  bilag1: "bilag1_rekonstruksjon",
  delivery: "gjennomforing_og_risiko",
  generator: "losningsutkast",
  requirements: "forbedret_kravsvar",
};

function mergeArtifactsForType(
  current: GeneratedArtifact[],
  incoming: GeneratedArtifact[],
  artifactType: GeneratedArtifactType,
) {
  return mergeGeneratedArtifactsForType(current, incoming, artifactType);
}

function loadedArtifactTypesFromArtifacts(artifacts: GeneratedArtifact[]) {
  return Array.from(
    new Set(
      artifacts
        .map((artifact) => artifact.artifact_type)
        .filter((type) => WORKSPACE_ARTIFACT_TYPES.includes(type)),
    ),
  );
}

function addLoadedArtifactType(
  current: GeneratedArtifactType[],
  artifactType: GeneratedArtifactType,
) {
  return current.includes(artifactType) ? current : [...current, artifactType];
}

function initialLoadedArtifactTypes(project: ProjectDetail) {
  if (project.artifact_count === 0) {
    return WORKSPACE_ARTIFACT_TYPES;
  }

  const loaded = new Set(loadedArtifactTypesFromArtifacts(project.generated_artifacts));
  if (project.artifact_counts_by_type) {
    for (const artifactType of WORKSPACE_ARTIFACT_TYPES) {
      if ((project.artifact_counts_by_type[artifactType] ?? 0) === 0) {
        loaded.add(artifactType);
      }
    }
  }

  return Array.from(loaded);
}

type ProgressDriverState = {
  startedAt: number;
  estimatedDurationMs: number;
  floor: number;
  ceiling: number;
};

function progressForJobStatus(job: Pick<ProjectJobRecord, "kind" | "status" | "message">) {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return 100;
  if (job.status === "queued") return 8;

  const message = job.message.toLowerCase();
  const explicitProgress = message.match(/\[(\d{1,3})%\]/);
  if (explicitProgress) {
    return Math.min(99, Math.max(3, Number(explicitProgress[1])));
  }

  if (message.includes("laster")) return 18;
  if (message.includes("køer")) return 8;
  if (message.includes("genererer") || message.includes("analyserer") || message.includes("sammenligner") || message.includes("skriver")) {
    return job.kind === "artifact_generation" ? 62 : 58;
  }
  if (message.includes("kjører ny vurdering")) return 78;
  if (message.includes("lagrer")) return 88;
  if (message.includes("ferdig")) return 100;

  return 28;
}

function progressCeilingForJobStatus(
  job: Pick<ProjectJobRecord, "status" | "message">,
) {
  if (job.status === "completed" || job.status === "failed") return 100;
  if (job.status === "queued") return 18;

  const message = job.message.toLowerCase();
  const explicitProgress = message.match(/\[(\d{1,3})%\]/);
  if (explicitProgress) {
    const progress = Math.min(99, Math.max(3, Number(explicitProgress[1])));
    return Math.min(99, progress + 8);
  }
  if (message.includes("lagrer") || message.includes("validerer")) return 97;
  if (
    message.includes("genererer") ||
    message.includes("analyserer") ||
    message.includes("sammenligner") ||
    message.includes("skriver")
  ) {
    return 93;
  }
  if (message.includes("henter") || message.includes("klargjør")) return 76;
  if (message.includes("bygger") || message.includes("kartlegger")) return 66;

  return 88;
}

function progressMessageLabel(message: string) {
  return message.replace(/^\[\d{1,3}%\]\s*/, "");
}

function estimatedJobDurationMs(job: Pick<ProjectJobRecord, "kind">) {
  const baseByKind: Record<ProjectJobRecord["kind"], number> = {
    document_ingestion: 45_000,
    document_docling_enhancement: 120_000,
    customer_analysis: 75_000,
    solution_evaluation: 80_000,
    artifact_generation: 95_000,
    high_level_design: 65_000,
    perfect_system_solution: 135_000,
    executive_summary: 45_000,
  };

  return baseByKind[job.kind] ?? 75_000;
}

function estimatedProgressFromElapsed(
  elapsedMs: number,
  estimatedDurationMs: number,
  floor = 8,
  ceiling = 93,
) {
  const ratio = Math.min(1, Math.max(0, elapsedMs / estimatedDurationMs));
  const eased = 1 - Math.pow(1 - ratio, 1.45);
  return Math.round(floor + eased * (ceiling - floor));
}

function nextDisplayedProgress(current: number, target: number) {
  if (target <= current) return current;
  const distance = target - current;
  const maxStep = distance > 20 ? 4 : distance > 8 ? 2.5 : 1.5;
  return Math.min(target, current + maxStep);
}

function parseCustomerAnalysisSectionBusy(
  busy: string | null,
): CustomerAnalysisSection | null {
  const prefix = "analysis-section-";
  if (!busy?.startsWith(prefix)) {
    return null;
  }

  const section = busy.slice(prefix.length);
  return CUSTOMER_ANALYSIS_SECTIONS.includes(section as CustomerAnalysisSection)
    ? (section as CustomerAnalysisSection)
    : null;
}

export function ProjectWorkspacePage({
  initialData,
  initialTab = "analysis",
}: {
  initialData: ProjectDetail;
  initialTab?: ProjectWorkspaceTab;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [project, setProject] = useState(initialData);
  const [serviceDescriptions, setServiceDescriptions] = useState<
    ProjectServiceDescription[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [busyProgress, setBusyProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadRole, setUploadRole] =
    useState<ProjectDocumentRole>("supporting_document");
  const [activeTab, setActiveTab] = useState<ProjectWorkspaceTab>(initialTab);
  const [isTabPending, startTabTransition] = useTransition();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [loadedArtifactTypes, setLoadedArtifactTypes] = useState<
    GeneratedArtifactType[]
  >(() => initialLoadedArtifactTypes(initialData));
  const [analysisLoaded, setAnalysisLoaded] = useState(
    Boolean(initialData.customer_analysis) ||
      !initialData.customer_analysis_generated,
  );
  const [evaluationLoaded, setEvaluationLoaded] = useState(
    Boolean(initialData.solution_evaluation) ||
      !initialData.solution_evaluation_generated,
  );
  const [executiveSummaryLoaded, setExecutiveSummaryLoaded] = useState(
    Boolean(initialData.executive_summary) ||
      !initialData.solution_evaluation_generated,
  );
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationLoadError, setEvaluationLoadError] = useState("");
  const [evaluationLoadRetryToken, setEvaluationLoadRetryToken] = useState(0);
  const [executiveSummaryLoading, setExecutiveSummaryLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [documentFileInputKey, setDocumentFileInputKey] = useState(0);
  const progressIntervalRef = useRef<number | null>(null);
  const progressDriverRef = useRef<ProgressDriverState | null>(null);
  const documentJobAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const artifactAuthorityRequestGateRef = useRef(
    createLatestArtifactAuthorityRequestGate(),
  );
  const sidebarResizeRef = useRef(false);
  const preloadWorkspaceTab = useProjectWorkspacePrefetch({
    projectId: project.id,
    customerAnalysisGenerated: project.customer_analysis_generated,
    solutionEvaluationGenerated: project.solution_evaluation_generated,
    artifactCount: project.artifact_count,
    analysisLoaded,
    evaluationLoaded,
    executiveSummaryLoaded,
    loadedArtifactTypes,
  });
  const architectureDocumentCandidates = useMemo(
    () => selectSolutionEvaluationDocumentCandidates(project.documents),
    [project.documents],
  );

  useEffect(() => {
    const tabFromUrl = searchParams.get("tab");
    setActiveTab(isProjectWorkspaceTab(tabFromUrl) ? tabFromUrl : "analysis");
  }, [searchParams]);

  const setWorkspaceTab = useCallback(
    (tab: ProjectWorkspaceTab) => {
      preloadWorkspaceTab(tab);
      if (tab === activeTab) {
        return;
      }
      markClientPerformance("workspace_tab_change", {
        project_id: project.id,
        from: activeTab,
        to: tab,
      });
      startTabTransition(() => {
        setActiveTab(tab);
      });
      const nextParams = new URLSearchParams(searchParams.toString());
      if (tab === "analysis") {
        nextParams.delete("tab");
      } else {
        nextParams.set("tab", tab);
      }
      const query = nextParams.toString();
      const nextHref = query ? `${pathname}?${query}` : pathname;
      window.history.pushState(null, "", nextHref);
    },
    [activeTab, pathname, preloadWorkspaceTab, project.id, searchParams],
  );
  const loadSidebarServiceDescriptions = useCallback(async (signal?: AbortSignal) => {
    const cacheKey = projectServicesCacheKey(project.id);
    const cached = getClientCache<ProjectServiceDescription[]>(cacheKey);
    if (cached) {
      if (signal?.aborted) return;
      setServiceDescriptions(cached);
      return;
    }

    try {
      const services = await fetchProjectServices(project.id, { signal });
      if (signal?.aborted) return;
      setServiceDescriptions(services);
      setClientCache(cacheKey, services, PROJECT_SERVICES_CACHE_TTL_MS);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return;
      setServiceDescriptions([]);
    }
  }, [project.id]);

  const refreshArtifactAuthority = useCallback(
    async (signal?: AbortSignal) => {
      const requestSequence = artifactAuthorityRequestGateRef.current.start();
      try {
        const authority = await fetchProjectArtifactAuthority(
          project.id,
          { signal },
        );
        if (
          signal?.aborted ||
          !artifactAuthorityRequestGateRef.current.isLatest(requestSequence)
        ) {
          return;
        }
        const missingLoadedTypes = loadedArtifactTypesMissingAuthorityVersion(
          project.generated_artifacts,
          authority.artifactAuthority,
          loadedArtifactTypes,
        );
        const refreshedByType = await Promise.all(
          missingLoadedTypes.map(async (artifactType) => {
            try {
              return {
                artifactType,
                artifacts: await fetchGeneratedArtifacts(project.id, {
                  signal,
                  artifactType,
                  forceRefresh: true,
                }),
              };
            } catch (error) {
              if (isAbortError(error) || signal?.aborted) {
                throw error;
              }
              return null;
            }
          }),
        );
        if (
          signal?.aborted ||
          !artifactAuthorityRequestGateRef.current.isLatest(requestSequence)
        ) {
          return;
        }
        setProject((current) => ({
          ...current,
          current_artifact_types: authority.currentArtifactTypes,
          artifact_authority: authority.artifactAuthority,
          generated_artifacts: reconcileGeneratedArtifactAuthority(
            refreshedByType.reduce(
              (artifacts, refreshed) =>
                refreshed
                  ? mergeArtifactsForType(
                      artifacts,
                      refreshed.artifacts,
                      refreshed.artifactType,
                    )
                  : artifacts,
              current.generated_artifacts,
            ),
            authority.artifactAuthority,
          ),
        }));
      } catch (err) {
        if (!isAbortError(err) && !signal?.aborted) {
          // Authority refresh is a consistency guard. Existing source mutation
          // responses still reconcile state if this best-effort refresh fails.
        }
      }
    },
    [loadedArtifactTypes, project.generated_artifacts, project.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void refreshArtifactAuthority(controller.signal);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("project-services-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.removeEventListener("project-services-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshArtifactAuthority]);

  useEffect(() => {
    if (activeTab !== "documents") {
      return;
    }

    const controller = new AbortController();
    void loadSidebarServiceDescriptions(controller.signal);
    const onServicesUpdated = () => void loadSidebarServiceDescriptions();
    window.addEventListener("project-services-updated", onServicesUpdated);
    return () => {
      controller.abort();
      window.removeEventListener("project-services-updated", onServicesUpdated);
    };
  }, [activeTab, loadSidebarServiceDescriptions]);

  const stopSidebarResize = useCallback(() => {
    if (!sidebarResizeRef.current) return;
    sidebarResizeRef.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  function stopProgressTicker() {
    if (progressIntervalRef.current) {
      window.clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    progressDriverRef.current = null;
    setBusyMessage("");
    setBusyProgress(0);
  }

  function startProgressTicker(messages: string[]) {
    stopProgressTicker();
    progressDriverRef.current = {
      startedAt: Date.now(),
      estimatedDurationMs: 45_000,
      floor: 6,
      ceiling: 82,
    };
    setBusyProgress(6);
    if (!messages.length) {
      setBusyMessage("Starter ...");
      return;
    }
    setBusyMessage(messages[0] ?? "");
  }

  function startEstimatedProgress(job: ProjectJobRecord) {
    if (progressIntervalRef.current) {
      window.clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    progressDriverRef.current = {
      startedAt: Date.now(),
      estimatedDurationMs: estimatedJobDurationMs(job),
      floor: progressForJobStatus(job),
      ceiling: progressCeilingForJobStatus(job),
    };
    setBusyProgress((current) =>
      nextDisplayedProgress(current, progressDriverRef.current?.floor ?? current),
    );
    progressIntervalRef.current = window.setInterval(() => {
      const driver = progressDriverRef.current;
      if (!driver) return;
      const elapsed = Date.now() - driver.startedAt;
      const targetProgress = estimatedProgressFromElapsed(
        elapsed,
        driver.estimatedDurationMs,
        driver.floor,
        driver.ceiling,
      );
      setBusyProgress((current) =>
        Math.min(
          driver.ceiling,
          nextDisplayedProgress(current, Math.max(driver.floor, targetProgress)),
        ),
      );
    }, 650);
  }

  useEffect(() => stopProgressTicker, []);

  useEffect(() => {
    const documentJobAbortControllers = documentJobAbortControllersRef.current;
    return () => {
      for (const controller of documentJobAbortControllers) {
        controller.abort();
      }
      documentJobAbortControllers.clear();
    };
  }, []);

  const { waitForProjectJob } = useProjectJobRunner({
    projectId: project.id,
    onStart: startEstimatedProgress,
    onStatus(jobStatus) {
      setBusyMessage(progressMessageLabel(jobStatus.message));
      const nextProgress = progressForJobStatus(jobStatus);
      const nextCeiling = progressCeilingForJobStatus(jobStatus);
      if (progressDriverRef.current) {
        progressDriverRef.current = {
          ...progressDriverRef.current,
          floor: Math.max(progressDriverRef.current.floor, nextProgress),
          ceiling: Math.max(progressDriverRef.current.ceiling, nextCeiling),
        };
      }
      setBusyProgress((current) =>
        jobStatus.status === "completed" || jobStatus.status === "failed"
          ? 100
          : nextDisplayedProgress(
              current,
              Math.min(
                progressCeilingForJobStatus(jobStatus),
                Math.max(current, nextProgress),
              ),
            ),
      );
    },
  });

  async function trackDocumentIngestionJob(
    job: ProjectJobRecord | null | undefined,
    documentId: string,
    options: { propagateFailure?: boolean } = {},
  ) {
    if (!job || job.kind !== "document_ingestion") {
      return null;
    }

    const controller = new AbortController();
    documentJobAbortControllersRef.current.add(controller);

    try {
      const completedJob = await watchProjectJob({
        projectId: project.id,
        jobId: job.id,
        signal: controller.signal,
        onStatus(jobStatus) {
          if (options.propagateFailure) {
            setBusyMessage(progressMessageLabel(jobStatus.message));
            setBusyProgress((current) =>
              jobStatus.status === "completed" || jobStatus.status === "failed"
                ? 100
                : nextDisplayedProgress(
                    current,
                    Math.max(current, progressForJobStatus(jobStatus)),
                  ),
            );
          }
          setProject((current) =>
            normalizeProjectState(
              {
                ...current,
                documents: current.documents.map((document) => {
                  if (document.id !== documentId) {
                    return document;
                  }

                  if (jobStatus.status === "failed") {
                    return {
                      ...document,
                      processing_status: "failed",
                      processing_message: "Dokumentindeksering feilet.",
                      processing_error: jobStatus.error,
                    };
                  }

                  if (jobStatus.status === "completed") {
                    return document;
                  }

                  return {
                    ...document,
                    processing_status:
                      jobStatus.status === "queued" ? "queued" : "processing",
                    processing_message: progressMessageLabel(jobStatus.message),
                    processing_error: null,
                  };
                }),
              },
              { preserveArtifactCount: true },
            ),
          );
        },
      });
      const completedDocument = documentFromJobResult(completedJob.result);
      if (!completedDocument) {
        return null;
      }

      const projectSnapshot =
        completedJob.result &&
        typeof completedJob.result === "object" &&
        "project" in completedJob.result
          ? (completedJob.result as { project?: ProjectSnapshotPayload }).project
          : null;

      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                completedDocument,
                ...current.documents.filter(
                  (document) => document.id !== completedDocument.id,
                ),
              ]),
            },
            projectSnapshot ?? current,
          ),
          { preserveArtifactCount: true },
        ),
      );
      return completedDocument;
    } catch (err) {
      if (controller.signal.aborted) {
        return null;
      }

      setProject((current) =>
        normalizeProjectState(
          {
            ...current,
            documents: current.documents.map((document) =>
              document.id === documentId
                ? {
                    ...document,
                    processing_status: "failed",
                    processing_message: "Dokumentindeksering feilet.",
                    processing_error:
                      err instanceof Error ? err.message : "Ukjent feil.",
                  }
                : document,
            ),
          },
          { preserveArtifactCount: true },
        ),
      );
      if (options.propagateFailure) {
        throw err;
      }
      return null;
    } finally {
      documentJobAbortControllersRef.current.delete(controller);
    }
  }

  useEffect(() => {
    try {
      const storedWidth = window.localStorage.getItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
      );
      const parsedWidth = Number(storedWidth);
      if (Number.isFinite(parsedWidth)) {
        setSidebarWidth(
          Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsedWidth)),
        );
      }
    } catch {
      // Ignore storage access issues and fall back to default width.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_WIDTH_STORAGE_KEY,
        String(sidebarWidth),
      );
    } catch {
      // Ignore storage access issues.
    }
    window.dispatchEvent(new Event("project-sidebar-layout-change"));
  }, [sidebarWidth]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!sidebarResizeRef.current || !sidebarOpen) return;
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, event.clientX),
      );
      setSidebarWidth(nextWidth);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopSidebarResize);
    window.addEventListener("pointercancel", stopSidebarResize);
    window.addEventListener("blur", stopSidebarResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopSidebarResize);
      window.removeEventListener("pointercancel", stopSidebarResize);
      window.removeEventListener("blur", stopSidebarResize);
      stopSidebarResize();
    };
  }, [sidebarOpen, stopSidebarResize]);

  useEffect(() => {
    if (!sidebarOpen) {
      stopSidebarResize();
    }
    window.dispatchEvent(new Event("project-sidebar-layout-change"));
  }, [sidebarOpen, stopSidebarResize]);

  useEffect(() => {
    if (
      activeTab !== "analysis" ||
      analysisLoaded ||
      !project.customer_analysis_generated
    ) {
      return;
    }

    const controller = new AbortController();
    setAnalysisLoading(true);
    fetchCustomerAnalysis(project.id, { signal: controller.signal })
      .then((analysis) => {
        if (!controller.signal.aborted) {
          setProject((current) => ({
            ...current,
            customer_analysis: analysis,
          }));
          setAnalysisLoaded(true);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente kundeanalysen.",
          );
          setAnalysisLoaded(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setAnalysisLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    analysisLoaded,
    project.customer_analysis_generated,
    project.id,
  ]);

  useEffect(() => {
    if (
      activeTab !== "evaluation" ||
      evaluationLoaded ||
      !project.solution_evaluation_generated
    ) {
      return;
    }

    const controller = new AbortController();
    setEvaluationLoading(true);
    setEvaluationLoadError("");
    fetchSolutionEvaluation(project.id, { signal: controller.signal })
      .then((evaluation) => {
        if (!controller.signal.aborted) {
          setProject((current) => ({
            ...current,
            solution_evaluation: evaluation,
          }));
          setEvaluationLoadError("");
          setEvaluationLoaded(true);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          const message =
            err instanceof Error
              ? err.message
              : "Kunne ikke hente løsningsvurderingen.";
          setError(message);
          setEvaluationLoadError(message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setEvaluationLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    evaluationLoaded,
    evaluationLoadRetryToken,
    project.id,
    project.solution_evaluation_generated,
  ]);

  useEffect(() => {
    if (
      activeTab !== "executive-summary" ||
      executiveSummaryLoaded ||
      !project.solution_evaluation_generated
    ) {
      return;
    }

    const controller = new AbortController();
    setExecutiveSummaryLoading(true);
    fetchExecutiveSummary(project.id, { signal: controller.signal })
      .then((executiveSummary) => {
        if (!controller.signal.aborted) {
          setProject((current) => ({
            ...current,
            executive_summary: executiveSummary,
          }));
          setExecutiveSummaryLoaded(true);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente lederoppsummeringen.",
          );
          setExecutiveSummaryLoaded(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setExecutiveSummaryLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    executiveSummaryLoaded,
    project.id,
    project.solution_evaluation_generated,
  ]);

  function retrySolutionEvaluationLoad() {
    setError("");
    setEvaluationLoadError("");
    setEvaluationLoadRetryToken((current) => current + 1);
  }

  async function runAction(
    label: string,
    action: () => Promise<void>,
    progressMessages?: string[],
  ) {
    setBusy(label);
    setError("");
    setNotice("");
    startProgressTicker(progressMessages ?? []);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt.");
    } finally {
      setBusyProgress(100);
      stopProgressTicker();
      setBusy(null);
    }
  }

  useEffect(() => {
    const artifactType = ARTIFACT_TYPE_BY_TAB[activeTab];
    if (
      !artifactType ||
      loadedArtifactTypes.includes(artifactType) ||
      project.artifact_count === 0
    ) {
      return;
    }
    const controller = new AbortController();
    fetchGeneratedArtifacts(project.id, {
      signal: controller.signal,
      artifactType,
    })
      .then((artifacts) => {
        if (!controller.signal.aborted) {
          setProject((current) =>
            normalizeProjectState(
              {
                ...current,
                generated_artifacts: mergeArtifactsForType(
                  current.generated_artifacts,
                  artifacts,
                  artifactType,
                ),
              },
              { preserveArtifactCount: true },
            ),
          );
          setLoadedArtifactTypes((current) =>
            addLoadedArtifactType(current, artifactType),
          );
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente generatorresultatene.",
          );
        }
      });
    return () => {
      controller.abort();
    };
  }, [activeTab, loadedArtifactTypes, project.artifact_count, project.id]);

  async function onUploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Velg en fil først.");
      return;
    }
    await runAction("upload", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", docTitle);
      formData.append("role", uploadRole);
      const payload = await uploadProjectDocument({
        projectId: project.id,
        formData,
        fallbackMessage: "Kunne ikke laste opp dokumentet.",
      });
      void trackDocumentIngestionJob(payload.job, payload.document.id);
      setDocTitle("");
      setFile(null);
      setUploadRole("supporting_document");
      setDocumentFileInputKey((current) => current + 1);
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document,
                ...current.documents,
              ]),
            },
            payload.project,
            { invalidateExecutiveSummary: true },
          ),
          {
            preserveArtifactCount: true,
          },
        ),
      );
    });
  }

  async function onUploadRequirementDocument(file: File) {
    let uploadedDocument: ProjectDocument | null = null;

    await runAction("upload-requirement-document", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "title",
        `Kravgrunnlag - ${file.name.replace(/\.[^.]+$/, "")}`,
      );
      formData.append("role", "supporting_document");
      formData.append("supporting_subtype", "kravdokument");
      const payload = await uploadProjectDocument({
        projectId: project.id,
        formData,
        fallbackMessage: "Kunne ikke laste opp kravdokumentet.",
      });
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document,
                ...current.documents,
              ]),
            },
            payload.project,
            { invalidateExecutiveSummary: true },
          ),
          {
            preserveArtifactCount: true,
          },
        ),
      );

      let completedDocument: ProjectDocument | null = payload.document;
      if (payload.job?.kind === "document_ingestion") {
        setBusyMessage(progressMessageLabel(payload.job.message));
        startEstimatedProgress(payload.job);
        completedDocument = await trackDocumentIngestionJob(
          payload.job,
          payload.document.id,
          { propagateFailure: true },
        );
      }
      if (!isDocumentReadyForEvaluation(completedDocument)) {
        throw new Error(
          completedDocument?.processing_status === "failed"
            ? completedDocument.processing_error ||
                "Kravdokumentet kunne ikke indekseres og kan ikke brukes til kravbesvarelse."
            : "Kravdokumentet indekseres fortsatt. Vent til dokumentet er klart før du genererer kravbesvarelsen.",
        );
      }
      uploadedDocument = completedDocument;
    });

    return uploadedDocument as ProjectDocument | null;
  }

  async function onUploadArchitectureDocument(file: File) {
    let uploadedDocument: ProjectDocument | null = null;

    await runAction("upload-architecture-document", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "title",
        `Bilag 2 - arkitektens svar - ${file.name.replace(/\.[^.]+$/, "")}`,
      );
      formData.append("role", "primary_solution_document");
      const payload = await uploadProjectDocument({
        projectId: project.id,
        formData,
        fallbackMessage: "Kunne ikke laste opp Bilag 2.",
      });
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document,
                ...current.documents,
              ]),
            },
            payload.project,
            { invalidateExecutiveSummary: true },
          ),
          {
            preserveArtifactCount: true,
          },
        ),
      );

      let completedDocument: ProjectDocument | null = payload.document;
      if (payload.job?.kind === "document_ingestion") {
        setBusyMessage(progressMessageLabel(payload.job.message));
        startEstimatedProgress(payload.job);
        completedDocument = await trackDocumentIngestionJob(
          payload.job,
          payload.document.id,
          { propagateFailure: true },
        );
      }
      if (!isDocumentReadyForEvaluation(completedDocument)) {
        throw new Error(
          "Bilag 2 er ikke ferdig indeksert ennå. Vent til dokumentet er RAG-klart før du starter vurderingen.",
        );
      }
      uploadedDocument = completedDocument;
    });

    return uploadedDocument as ProjectDocument | null;
  }

  async function onUpdateRequirementArtifact(
    artifact: GeneratedArtifact,
    value: {
      title: string;
      content_markdown: string;
      acknowledge_deterministic_repairs?: boolean;
    },
  ) {
    setError("");
    setNotice("");
    setBusy(`update-artifact-${artifact.id}`);
    const previousProject = project;
    const optimisticArtifact: GeneratedArtifact = {
      ...artifact,
      title: value.title,
      content_markdown: value.content_markdown,
    };
    setProject((current) =>
      normalizeProjectState(
        {
          ...current,
          generated_artifacts: current.generated_artifacts.map((item) =>
            item.id === artifact.id ? optimisticArtifact : item,
          ),
        },
        { preserveArtifactCount: true },
      ),
    );
    try {
      const payload = await updateGeneratedArtifact({
        projectId: project.id,
        artifactId: artifact.id,
        title: value.title,
        contentMarkdown: value.content_markdown,
        acknowledgeDeterministicRepairs:
          value.acknowledge_deterministic_repairs === true,
      });
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              generated_artifacts: prependGeneratedArtifact(
                current.generated_artifacts.map((item) =>
                  item.id === artifact.id
                    ? previousProject.generated_artifacts.find(
                        (previous) => previous.id === artifact.id,
                      ) ?? item
                    : item,
                ),
                payload.artifact,
              ),
            },
            payload.project,
          ),
          { preserveArtifactCount: true },
        ),
      );
      setNotice("Kravbesvarelsen er oppdatert.");
    } catch (err) {
      setProject(previousProject);
      setError(err instanceof Error ? err.message : "Noe gikk galt.");
      throw err;
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteArtifact(artifact: GeneratedArtifact) {
    setError("");
    setNotice("");
    setBusy(`delete-artifact-${artifact.id}`);
    const previousProject = project;
    setProject((current) =>
      normalizeProjectState(
        {
          ...current,
          generated_artifacts: current.generated_artifacts.filter(
            (item) => item.id !== artifact.id,
          ),
          artifact_count: Math.max(0, current.artifact_count - 1),
        },
        { preserveArtifactCount: true },
      ),
    );
    let deleteCommitted = false;
    try {
      const payload = await deleteGeneratedArtifact({
        projectId: project.id,
        artifactId: artifact.id,
      });
      deleteCommitted = true;
      let refreshedArtifacts: GeneratedArtifact[] | null = null;
      try {
        refreshedArtifacts = await fetchGeneratedArtifacts(project.id, {
          artifactType: artifact.artifact_type,
        });
      } catch {
        // applyProjectSnapshot deterministically promotes the highest loaded
        // remaining version with the authoritative source-current summary.
      }
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              generated_artifacts: refreshedArtifacts
                ? mergeArtifactsForType(
                    current.generated_artifacts,
                    refreshedArtifacts,
                    artifact.artifact_type,
                  )
                : current.generated_artifacts.filter(
                    (item) => item.id !== artifact.id,
                  ),
            },
            payload.project,
          ),
          { preserveArtifactCount: true },
        ),
      );
      setNotice("Artefakten er slettet.");
    } catch (err) {
      if (!deleteCommitted) {
        setProject(previousProject);
      }
      setError(err instanceof Error ? err.message : "Noe gikk galt.");
      throw err;
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteDocument(document: ProjectDocument) {
    const previousProject = project;
    await runAction(`delete-${document.id}`, async () => {
      setProject((current) =>
        normalizeProjectState(
          {
            ...current,
            documents: current.documents.filter(
              (item) => item.id !== document.id,
            ),
          },
          {
            preserveArtifactCount: true,
          },
        ),
      );
      let payload: Awaited<ReturnType<typeof deleteProjectDocument>>;
      try {
        payload = await deleteProjectDocument({
          projectId: project.id,
          documentId: document.id,
        });
      } catch (err) {
        setProject(previousProject);
        throw err;
      }
      setProject((current) => {
        const next = applyProjectSnapshot(
          {
            ...current,
            documents: current.documents.filter(
              (item) => item.id !== document.id,
            ),
            customer_analysis:
              !payload.project?.customer_analysis_generated
                ? null
                : current.customer_analysis,
            solution_evaluation:
              !payload.project?.solution_evaluation_generated
                ? null
                : current.solution_evaluation,
            executive_summary:
              !payload.project?.solution_evaluation_generated
                ? null
                : current.executive_summary,
          },
          payload.project,
        );
        return normalizeProjectState(next, {
          preserveArtifactCount: true,
        });
      });
      if (!payload.project.customer_analysis_generated) {
        setAnalysisLoaded(true);
      }
      if (!payload.project.solution_evaluation_generated) {
        setEvaluationLoadError("");
        setEvaluationLoaded(true);
        setExecutiveSummaryLoaded(true);
      }
    });
  }

  function startWorkspaceJob(body: unknown, fallbackMessage: string) {
    return startProjectJob({
      projectId: project.id,
      body,
      fallbackMessage,
    });
  }

  async function onGenerateCustomerAnalysis() {
    await runAction(
      "analysis",
      async () => {
        const job = await startWorkspaceJob(
          { kind: "customer_analysis" },
          "Kunne ikke starte kundeanalysen.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Kundeanalysen feilet.",
          job,
        );
        const result = completedJob.result as {
          analysis: CustomerAnalysisResult;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              { ...current, customer_analysis: result.analysis },
              result.project,
            ),
            {
              preserveArtifactCount: true,
            },
          ),
        );
        setAnalysisLoaded(true);
      },
      ["Starter kundeanalysen ..."],
    );
  }

  async function onSaveAnalysis(
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
  ) {
    await runAction("save-analysis", async () => {
      const payload = await saveCustomerAnalysisSection({
        projectId: project.id,
        section,
        snapshot,
      });
      setProject((current) =>
        normalizeProjectState(
          applyProjectSnapshot(
            { ...current, customer_analysis: payload.analysis },
            payload.project,
          ),
          {
            preserveArtifactCount: true,
          },
        ),
      );
      setAnalysisLoaded(true);
      setNotice("Analysen er oppdatert og lagret i prosjektet.");
    });
  }

  async function onGenerateArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "artifact",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "losningsutkast",
          },
          "Kunne ikke starte generatorjobben.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Generatorjobben feilet.",
          job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
          evaluation?: SolutionEvaluationResult;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                solution_evaluation:
                  result.evaluation ?? current.solution_evaluation,
                generated_artifacts: prependGeneratedArtifact(
                  current.generated_artifacts,
                  result.artifact,
                ),
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
            { preserveArtifactCount: true },
          ),
        );
        setLoadedArtifactTypes((current) =>
          addLoadedArtifactType(current, result.artifact.artifact_type),
        );
      },
      ["Starter generatorjobben ..."],
    );
  }

  async function onGenerateDeliveryArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "delivery-artifact",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "gjennomforing_og_risiko",
          },
          "Kunne ikke starte jobben for fremdriftsplan.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Jobben for fremdriftsplanen feilet.",
          job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                generated_artifacts: prependGeneratedArtifact(
                  current.generated_artifacts,
                  result.artifact,
                ),
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
            { preserveArtifactCount: true },
          ),
        );
        setLoadedArtifactTypes((current) =>
          addLoadedArtifactType(current, result.artifact.artifact_type),
        );
      },
      ["Starter jobben for fremdriftsplanen ..."],
    );
  }

  async function onGenerateBilag1Artifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const instructions = `${formData.get("instructions") || ""}`.trim();
    await runAction(
      "bilag1-artifact",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "bilag1_rekonstruksjon",
            instructions,
          },
          "Kunne ikke starte jobben for Bilag 1.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Jobben for Bilag 1 feilet.",
          job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                generated_artifacts: prependGeneratedArtifact(
                  current.generated_artifacts,
                  result.artifact,
                ),
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
            { preserveArtifactCount: true },
          ),
        );
        setLoadedArtifactTypes((current) =>
          addLoadedArtifactType(current, result.artifact.artifact_type),
        );
      },
      ["Starter jobben for Bilag 1 ..."],
    );
  }

  async function onGenerateRequirementResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sourceDocumentIds = requirementDocumentIdsForGeneration(
      project.documents,
    );
    if (!sourceDocumentIds.length) {
      setError(
        "Ingen klassifiserte kravdokumenter er klare. Vent til dokumentbehandlingen er ferdig før du genererer kravbesvarelsen.",
      );
      return;
    }
    await runAction(
      "requirement-response",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "forbedret_kravsvar",
            source_document_ids: sourceDocumentIds,
          },
          "Kunne ikke starte jobben for kravbesvarelse.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Jobben for kravbesvarelse feilet.",
          job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                generated_artifacts: prependGeneratedArtifact(
                  current.generated_artifacts,
                  result.artifact,
                ),
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
            { preserveArtifactCount: true },
          ),
        );
        setLoadedArtifactTypes((current) =>
          addLoadedArtifactType(current, result.artifact.artifact_type),
        );
      },
      ["Starter jobben for kravbesvarelse ..."],
    );
  }

  async function onGenerateSolutionEvaluation(
    solutionDocumentId?: string,
    importedDocument?: ProjectDocument,
  ) {
    const selectedDocument =
      importedDocument && importedDocument.id === solutionDocumentId
        ? importedDocument
        : solutionDocumentId
          ? project.documents.find(
              (document) => document.id === solutionDocumentId,
            )
          : architectureDocumentCandidates[0];
    if (!selectedDocument || !isSolutionEvaluationCandidate(selectedDocument)) {
      const message = !isDocumentReadyForEvaluation(selectedDocument)
        ? selectedDocument?.processing_status === "failed"
          ? selectedDocument.processing_error ||
            "Dokumentet kunne ikke indekseres og kan ikke vurderes."
          : "Dokumentet indekseres fortsatt. Vent til det er RAG-klart før du starter vurderingen."
        : "Dokumentet er ikke en godkjent primær arkitektløsning.";
      setError(message);
      return;
    }

    await runAction(
      "solution-evaluation",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "solution_evaluation",
            solution_document_id: selectedDocument.id,
          },
          "Kunne ikke starte løsningsvurderingen.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Løsningsvurderingen feilet.",
          job,
        );
        const result = completedJob.result as {
          evaluation: SolutionEvaluationResult;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                solution_evaluation: result.evaluation,
                executive_summary: null,
                has_executive_summary: false,
              },
              result.project,
            ),
            {
              preserveArtifactCount: true,
            },
          ),
        );
        setEvaluationLoadError("");
        setEvaluationLoaded(true);
        setExecutiveSummaryLoaded(true);
        setNotice("Sammenligningen er generert og lagret i prosjektet.");
      },
      ["Starter vurdering av Bilag 2 og arkitektens svar ..."],
    );
  }

  async function onGenerateExecutiveSummary() {
    await runAction(
      "executive-summary",
      async () => {
        const job = await startWorkspaceJob(
          { kind: "executive_summary" },
          "Kunne ikke starte lederoppsummeringen.",
        );
        setBusyMessage(job.message);
        const completedJob = await waitForProjectJob(
          job.id,
          "Lederoppsummeringen feilet.",
          job,
        );
        const result = completedJob.result as {
          executive_summary: ExecutiveSummaryResult;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            applyProjectSnapshot(
              {
                ...current,
                executive_summary: result.executive_summary,
              },
              result.project,
            ),
            {
              preserveArtifactCount: true,
            },
          ),
        );
        setExecutiveSummaryLoaded(true);
        setNotice("Lederoppsummeringen er generert og lagret separat.");
      },
      ["Genererer lederoppsummering ..."],
    );
  }

  const customerAnalysis =
    project.customer_analysis as CustomerAnalysisResult | null;
  const solutionEvaluation =
    project.solution_evaluation as SolutionEvaluationResult | null;
  const executiveSummary =
    project.executive_summary as ExecutiveSummaryResult | null;
  const requirementArtifacts = project.generated_artifacts.filter(
    (artifact) => artifact.artifact_type === "forbedret_kravsvar",
  );
  const solutionDraftArtifacts = project.generated_artifacts.filter(
    (artifact) => artifact.artifact_type === "losningsutkast",
  );
  const bilag1Artifacts = project.generated_artifacts.filter(
    (artifact) => artifact.artifact_type === "bilag1_rekonstruksjon",
  );
  const deliveryArtifacts = project.generated_artifacts.filter(
    (artifact) => artifact.artifact_type === "gjennomforing_og_risiko",
  );
  const hasArtifactType = (artifactType: GeneratedArtifactType) =>
    hasAuthoritativeCurrentArtifact(project, artifactType);
  const analysisSectionBusy = parseCustomerAnalysisSectionBusy(busy);
  const hasDocuments = project.documents.length > 0;
  const hasCustomerAnalysis =
    Boolean(customerAnalysis) || project.customer_analysis_generated;
  const hasRequirementResponse = hasArtifactType("forbedret_kravsvar");
  const hasSolutionDraft = hasArtifactType("losningsutkast");
  const hasEvaluationReadySolutionDocument =
    architectureDocumentCandidates.some(isDocumentReadyForEvaluation);
  const hasSolutionEvaluation =
    Boolean(solutionEvaluation) || project.solution_evaluation_generated;
  const hasDeliveryPlan = hasArtifactType("gjennomforing_og_risiko");
  const hasExecutiveSummary =
    Boolean(executiveSummary) || Boolean(project.has_executive_summary);
  const primaryWorkflowSteps: WorkflowStepItem[] = [
    {
      step: 1,
      value: "documents",
      label: "Dokumenter",
      icon: FolderOpen,
      status: hasDocuments ? "Ferdig" : "Ikke startet",
    },
    {
      step: 2,
      value: "analysis",
      label: "Kundeanalyse",
      icon: Brain,
      status: hasCustomerAnalysis ? "Generert" : hasDocuments ? "Klar" : "Venter",
    },
    {
      step: 3,
      value: "requirements",
      label: "Krav og svar",
      icon: FileCheck2,
      status: hasRequirementResponse
        ? "Generert"
        : hasCustomerAnalysis
          ? "Klar"
          : "Venter",
    },
    {
      step: 4,
      value: "generator",
      label: "Løsningsforslag",
      icon: Sparkles,
      status: solutionProposalWorkflowStatus({
        hasGeneratedSolutionDescription: hasSolutionDraft,
        hasReadyEvaluationBasis: hasEvaluationReadySolutionDocument,
        hasCustomerAnalysis,
      }),
    },
    {
      step: 5,
      value: "evaluation",
      label: "Vurdering",
      icon: Scale,
      status: hasSolutionEvaluation
        ? "Generert"
        : hasEvaluationReadySolutionDocument
          ? "Klar"
          : "Venter",
    },
    {
      step: 6,
      value: "delivery",
      label: "Fremdriftsplan",
      icon: ArrowRight,
      status: hasDeliveryPlan
        ? "Generert"
        : hasSolutionEvaluation
          ? "Klar"
          : "Venter",
    },
    {
      step: 7,
      value: "executive-summary",
      label: "Leder oppsummering",
      icon: ClipboardCheck,
      status: hasExecutiveSummary
        ? "Generert"
        : hasSolutionEvaluation
          ? "Klar"
          : "Venter",
    },
  ];
  const secondaryNavGroups: SecondaryNavGroup[] = [
    {
      label: "Verktøy",
      items: [
        { value: "service-description", label: "Velg tjenester", icon: Wrench },
        { value: "bilag1", label: "Bilag 1-utkast", icon: FileText },
      ],
    },
  ];
  const activeTabLabel =
    [
      ...primaryWorkflowSteps,
      ...secondaryNavGroups.flatMap((group) => group.items),
    ].find((item) => item.value === activeTab)?.label ?? "Prosjekt";

  function onSidebarResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!sidebarOpen) return;
    event.preventDefault();
    sidebarResizeRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function openChatPopout() {
    const width = 920;
    const height = 820;
    const left = Math.max(0, window.screenX + window.outerWidth - width - 32);
    const top = Math.max(0, window.screenY + 72);
    const url = `/projects/${project.id}/chat`;
    const features = [
      "popup=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
    ].join(",");
    const chatWindow = window.open(
      url,
      `bidsite-project-chat-${project.id}`,
      features,
    );

    chatWindow?.focus();
    return chatWindow;
  }

  return (
    <ProjectWorkspaceShell
      project={project}
      activeTab={activeTab}
      activeTabLabel={activeTabLabel}
      sidebarOpen={sidebarOpen}
      sidebarWidth={sidebarWidth}
      isTabPending={isTabPending}
      primaryWorkflowSteps={primaryWorkflowSteps}
      secondaryNavGroups={secondaryNavGroups}
      error={error}
      notice={notice}
      busy={busy}
      busyMessage={busyMessage}
      busyProgress={busyProgress}
      onSidebarOpenChange={setSidebarOpen}
      onSidebarResizeStart={onSidebarResizeStart}
      onPreloadWorkspaceTab={preloadWorkspaceTab}
      onSetWorkspaceTab={setWorkspaceTab}
      onOpenChatPopout={openChatPopout}
    >
      <ProjectWorkspaceTabContent
        activeTab={activeTab}
        project={project}
        serviceDescriptions={serviceDescriptions}
        architectureDocumentCandidates={architectureDocumentCandidates}
        customerAnalysis={customerAnalysis}
        solutionEvaluation={solutionEvaluation}
        executiveSummary={executiveSummary}
        analysisLoaded={analysisLoaded}
        analysisLoading={analysisLoading}
        evaluationLoaded={evaluationLoaded}
        evaluationLoading={evaluationLoading}
        evaluationLoadError={evaluationLoadError}
        executiveSummaryLoaded={executiveSummaryLoaded}
        executiveSummaryLoading={executiveSummaryLoading}
        busy={busy}
        busyMessage={busyMessage}
        busyProgress={busyProgress}
        analysisSectionBusy={analysisSectionBusy}
        uploadOpen={uploadOpen}
        docTitle={docTitle}
        uploadRole={uploadRole}
        selectedDocumentName={file?.name ?? ""}
        documentFileInputKey={documentFileInputKey}
        requirementArtifacts={requirementArtifacts}
        solutionDraftArtifacts={solutionDraftArtifacts}
        deliveryArtifacts={deliveryArtifacts}
        bilag1Artifacts={bilag1Artifacts}
        onToggleUploadOpen={() => setUploadOpen((open) => !open)}
        onDocTitleChange={setDocTitle}
        onUploadRoleChange={setUploadRole}
        onFileChange={setFile}
        onUploadDocument={onUploadDocument}
        onDeleteDocument={onDeleteDocument}
        onGenerateCustomerAnalysis={onGenerateCustomerAnalysis}
        onSaveAnalysis={onSaveAnalysis}
        onGenerateSolutionEvaluation={onGenerateSolutionEvaluation}
        onRetrySolutionEvaluationLoad={retrySolutionEvaluationLoad}
        onUploadArchitectureDocument={onUploadArchitectureDocument}
        onDeleteArtifact={onDeleteArtifact}
        onGenerateBilag1Artifact={onGenerateBilag1Artifact}
        onGenerateDeliveryArtifact={onGenerateDeliveryArtifact}
        onUploadRequirementDocument={onUploadRequirementDocument}
        onUpdateRequirementArtifact={onUpdateRequirementArtifact}
        onGenerateRequirementResponse={onGenerateRequirementResponse}
        onGenerateExecutiveSummary={onGenerateExecutiveSummary}
        onGenerateArtifact={onGenerateArtifact}
      />
    </ProjectWorkspaceShell>
  );
}
