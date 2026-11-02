"use client";
import type { RequirementRegenerationSelection } from "@/lib/requirement-regeneration";

import { usePathname, useSearchParams } from "next/navigation";
import {
  FormEvent,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Brain,
  ClipboardCheck,
  FileCheck2,
  FileText,
  FolderOpen,
  Layers3,
  Scale,
  Sparkles,
} from "lucide-react";

import {
  deleteGeneratedArtifact,
  deleteProjectDocument,
  fetchCustomerAnalysis,
  fetchExecutiveSummary,
  fetchGeneratedArtifacts,
  fetchProjectArtifactAuthority,
  fetchProjectServices,
  fetchProjectState,
  fetchSolutionEvaluation,
  isProjectWorkflowBusyError,
  markClientPerformance,
  saveCustomerAnalysisSection,
  startProjectJob,
  updateGeneratedArtifact,
  retryDocumentEnhancement,
  uploadProjectDocument,
} from "@/lib/client/project-api";
import { DocumentProcessingFailure, trackDocumentProcessing } from "@/lib/client/document-job-tracker";
import { recordWorkflowRenderAfterPaint } from "@/lib/client/workflow-render-metric";
import { useProjectActivity } from "@/hooks/use-project-activity";
import { useProjectJobRunner } from "@/hooks/use-project-job-runner";
import { useProjectWorkspacePrefetch } from "@/hooks/use-project-workspace-prefetch";
import {
  isApprovedSolutionEvaluationDocument,
  isDocumentReadyForEvaluation,
  isSolutionEvaluationCandidate,
  requirementDocumentIdsForGeneration,
  suggestUploadDocumentRole,
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
  mergeProjectRefresh,
  isProjectSnapshotOlder,
  createLatestArtifactAuthorityRequestGate,
  hasAuthoritativeCurrentArtifact,
  loadedArtifactTypesMissingAuthorityVersion,
  mergeGeneratedArtifactsForType,
  prependGeneratedArtifactVersion,
  reconcileGeneratedArtifactAuthority,
  solutionProposalWorkflowStatus,
} from "@/components/projects/project-workflow-status";
import { deriveProjectStatus } from "@/components/projects/project-workspace-shared";
import { parseJobProgress } from "@/lib/project-job-progress";
import {
  GENERATABLE_ARTIFACT_TYPES,
  isGeneratableArtifactType,
} from "@/lib/types";
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

const ENHANCEMENT_WAIT_NOTICE = "Dokumentet er lest. Venter på den siste dokumentforbedringen før ny generering.";
const PROJECT_WORKSPACE_UI_SCALE = 0.9;
const DEFAULT_SIDEBAR_WIDTH = 260;
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

const ARTIFACT_TYPE_BY_TAB: Partial<
  Record<ProjectWorkspaceTab, GeneratedArtifactType>
> = {
  bilag1: "bilag1_rekonstruksjon",
  delivery: "gjennomforing_og_risiko",
  generator: "losningsutkast",
  requirements: "forbedret_kravsvar",
};

function loadedArtifactTypesFromArtifacts(artifacts: GeneratedArtifact[]) {
  return Array.from(
    new Set(
      artifacts
        .map((artifact) => artifact.artifact_type)
        .filter(isGeneratableArtifactType),
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
    return [...GENERATABLE_ARTIFACT_TYPES];
  }

  const loaded = new Set(loadedArtifactTypesFromArtifacts(project.generated_artifacts));
  if (project.artifact_counts_by_type) {
    for (const artifactType of GENERATABLE_ARTIFACT_TYPES) {
      if ((project.artifact_counts_by_type[artifactType] ?? 0) === 0) {
        loaded.add(artifactType);
      }
    }
  }

  return Array.from(loaded);
}

function savedArtifactResult(job: ProjectJobRecord) {
  const result = job.result;
  if (result && "artifact" in result && result.artifact) {
    return { artifact: result.artifact, project: result.project };
  }
  throw new Error("Jobben returnerte ikke et lagret dokument.");
}

function progressForJobStatus(job: Pick<ProjectJobRecord, "status" | "message">) {
  if (job.status === "completed") return 100;
  if (job.status !== "running") return -1;
  const count = /(?:Besvart|Analysert|Behandlet)\s+(\d+)\s+av\s+(\d+)\s+krav/iu.exec(job.message);
  const done = Number(count?.[1]);
  const total = Number(count?.[2]);
  return total > 0 && done >= 0 && done <= total ? Math.round(100 * done / total) : -1;
}

function progressMessageLabel(message: string) {
  return parseJobProgress(message).label;
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
  canShare = false,
  canDownloadDocuments = false,
  readOnly = false,
}: {
  initialData: ProjectDetail;
  initialTab?: ProjectWorkspaceTab;
  canShare?: boolean;
  canDownloadDocuments?: boolean;
  readOnly?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [project, setProject] = useState(initialData);
  const [serviceDescriptions, setServiceDescriptions] = useState<
    ProjectServiceDescription[]
  >([]);
  const [serviceDescriptionsLoaded, setServiceDescriptionsLoaded] =
    useState(false);
  const busyActionRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [busyProgress, setBusyProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadRole, setUploadRole] =
    useState<ProjectDocumentRole>("supporting_document");
  // A role the user picked is kept; otherwise each chosen file suggests one.
  const uploadRoleChosenRef = useRef(false);
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
  const [analysisLoadError, setAnalysisLoadError] = useState("");
  const [analysisLoadRetryToken, setAnalysisLoadRetryToken] = useState(0);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationLoadError, setEvaluationLoadError] = useState("");
  const [evaluationLoadRetryToken, setEvaluationLoadRetryToken] = useState(0);
  const [executiveSummaryLoading, setExecutiveSummaryLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [documentFileInputKey, setDocumentFileInputKey] = useState(0);
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
    () => project.documents.filter(isApprovedSolutionEvaluationDocument),
    [project.documents],
  );

  useEffect(() => {
    const tabFromUrl = searchParams.get("tab");
    setActiveTab(isProjectWorkspaceTab(tabFromUrl) ? tabFromUrl : "analysis");
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/projects/${project.id}/page-view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: activeTab }),
      signal: controller.signal,
    }).catch(() => undefined);
    return () => controller.abort();
  }, [activeTab, project.id]);

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
    try {
      const services = await fetchProjectServices(project.id, { signal });
      if (signal?.aborted) return;
      setServiceDescriptions(services);
      setServiceDescriptionsLoaded(true);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return;
      setServiceDescriptions([]);
    }
  }, [project.id]);
  const updateServiceDescriptions = useCallback(
    (services: ProjectServiceDescription[]) => {
      setServiceDescriptions(services);
      setServiceDescriptionsLoaded(true);
    },
    [],
  );

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
                  ? mergeGeneratedArtifactsForType(
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
    window.addEventListener("project-workflow-updated", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.removeEventListener("project-services-updated", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("project-workflow-updated", refresh);
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
    setBusyMessage("");
    setBusyProgress(-1);
  }

  function startProgressTicker(messages: string[]) {
    setBusyProgress(-1);
    setBusyMessage(messages[0] || "Starter ...");
  }

  function startPersistedProgress(job: ProjectJobRecord) {
    setBusyProgress(progressForJobStatus(job));
    setBusyMessage(progressMessageLabel(job.message));
  }

  useEffect(() => {
    const documentJobAbortControllers = documentJobAbortControllersRef.current;
    return () => {
      for (const controller of documentJobAbortControllers) {
        controller.abort();
      }
      documentJobAbortControllers.clear();
    };
  }, []);

  const {
    jobs: projectJobs,
    automaticAnalysis,
    blockingReason: workflowBlockedReason,
    recordJob,
    refreshJobs,
  } = useProjectActivity({
    projectId: project.id,
    documents: project.documents,
    async refreshProject() {
      // A transport failure never changes authoritative document status; the
      // activity loop keeps the last state and retries on its next run.
      const fresh = await fetchProjectState(project.id);
      // A background refresh must not force a lazy tab that is still
      // hydrating back to its loading fallback.
      startTransition(() => setProject((current) => mergeProjectRefresh(current, fresh)));
    },
  });

  const { waitForProjectJob } = useProjectJobRunner({
    projectId: project.id,
    onStart: startPersistedProgress,
    onStatus(jobStatus) {
      recordJob(jobStatus);
      setBusyMessage(progressMessageLabel(jobStatus.message));
      setBusyProgress(progressForJobStatus(jobStatus));
    },
  });


  async function trackDocumentIngestionJob(
    job: ProjectJobRecord | null | undefined,
    documentId: string,
    options: { propagateFailure?: boolean; submittedAt?: number } = {},
  ) {
    if (!job || (job.kind !== "document_ingestion" && job.kind !== "document_docling_enhancement")) {
      return null;
    }

    const controller = new AbortController();
    documentJobAbortControllersRef.current.add(controller);

    try {
      const tracked = await trackDocumentProcessing({
        projectId: project.id,
        job,
        signal: controller.signal,
        onStatus(jobStatus) {
          if (options.propagateFailure) {
            setBusyMessage(progressMessageLabel(jobStatus.message));
            setBusyProgress(progressForJobStatus(jobStatus));
          }
          setProject((current) => normalizeProjectState({
            ...current,
            documents: current.documents.map((document) => {
              if (document.id !== documentId || jobStatus.status === "completed") return document;
              // Enhancement cannot turn the persisted basic result into a
              // failed ingestion. The tracker refreshes its authoritative state.
              if (jobStatus.kind === "document_docling_enhancement") {
                return jobStatus.status === "failed" ? document : { ...document, processing_message: progressMessageLabel(jobStatus.message), processing_error: null };
              }
              if (jobStatus.status === "failed") return {
                ...document,
                processing_status: "failed",
                processing_message: "Dokumentbehandlingen feilet.",
                processing_error: "Dokumentbehandlingen feilet. Prøv å behandle dokumentet på nytt.",
              };
              return {
                ...document,
                processing_status: jobStatus.status === "queued" ? "queued" : "processing",
                processing_message: progressMessageLabel(jobStatus.message),
                processing_error: null,
              };
            }),
          }, { preserveArtifactCount: true }));
        },
        onEnhancement() {
          setNotice(ENHANCEMENT_WAIT_NOTICE);
        },
        onEnhancementFailed() {
          setNotice("Dokumentforbedringen feilet. Grunnversjonen er lagret og kan brukes. Du kan prøve forbedringen på nytt under Dokumenter.");
        },
        onDocumentReady(ready) {
          if (options.submittedAt === undefined || !(ready.processing_status === "basic_ready" || ready.processing_status === "enhanced_ready")) return;
          recordWorkflowRenderAfterPaint(project.id, { phase: "upload_to_ready", traceId: ready.id, documentId: ready.id, sourceRevision: ready.chunk_source_revision }, options.submittedAt, controller.signal);
        },
        onIngestionFailed() {
          if (options.submittedAt === undefined) return;
          recordWorkflowRenderAfterPaint(project.id, { phase: "upload_to_ready", traceId: documentId, documentId, status: "failed" }, options.submittedAt, controller.signal);
        },
        onProject(freshProject) {
          setProject((current) => mergeProjectRefresh(current, freshProject));
        },
      });
      setNotice((current) => current === ENHANCEMENT_WAIT_NOTICE ? "" : current);
      return tracked;
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (error instanceof DocumentProcessingFailure && error.kind === "server") {
        setNotice("");
        setError(error.message);
      } else setNotice("Mistet kontakt med dokumentbehandlingen. Status oppdateres når forbindelsen er tilbake.");
      if (options.propagateFailure) throw error;
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
    setAnalysisLoadError("");
    const requestSnapshot = project.snapshot_revision;
    fetchCustomerAnalysis(project.id, { signal: controller.signal, forceRefresh: true })
      .then((analysis) => {
        if (!controller.signal.aborted) {
          setProject((current) => current.snapshot_revision !== requestSnapshot ? current : ({
            ...current,
            customer_analysis: analysis,
          }));
          setAnalysisLoaded(true);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && !isAbortError(err)) {
          setAnalysisLoadError(
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
    project.snapshot_revision,
    analysisLoadRetryToken,
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
    if (busyActionRef.current) {
      setError("En handling pågår allerede. Vent til den er ferdig.");
      return false;
    }
    busyActionRef.current = label;
    setBusy(label);
    setError("");
    setNotice("");
    startProgressTicker(progressMessages ?? []);
    try {
      await action();
      return true;
    } catch (err) {
      // A busy project is a reason to wait, not a failure (see startWorkspaceJob).
      if (isProjectWorkflowBusyError(err)) {
        setNotice(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Noe gikk galt.");
      }
      return false;
    } finally {
      setBusyProgress(100);
      stopProgressTicker();
      busyActionRef.current = null;
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
                generated_artifacts: mergeGeneratedArtifactsForType(
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
    const automaticAnalysisChoice = new FormData(event.currentTarget).get("request_auto_analysis");
    if (!file) {
      setError("Velg en fil først.");
      return;
    }
    const submittedAt = performance.now();
    await runAction("upload", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", docTitle);
      formData.append("role", uploadRole);
      if (uploadRole !== "primary_solution_document") formData.append("request_auto_analysis", String(automaticAnalysisChoice === "on"));
      // Only the user's own choice may replace a current primary document.
      const roleSource = uploadRoleChosenRef.current ? "explicit" : "suggested";
      formData.append("role_source", roleSource);
      const payload = await uploadProjectDocument({
        projectId: project.id,
        formData,
        fallbackMessage: "Kunne ikke laste opp dokumentet.",
      });
      // The server keeps a suggested primary role only while it is vacant.
      if (
        roleSource === "suggested" &&
        uploadRole !== "supporting_document" &&
        payload.document.role === "supporting_document"
      ) {
        setNotice(
          `Prosjektet har allerede et ${uploadRole === "primary_customer_document" ? "kundedokument" : "løsningsdokument"}, så dokumentet ble lagret som støttedokument. Velg rollen selv hvis det skal erstatte det.`,
        );
      }
      void trackDocumentIngestionJob(payload.job, payload.document.id, { submittedAt });
      setDocTitle("");
      setFile(null);
      setUploadRole("supporting_document");
      uploadRoleChosenRef.current = false;
      setDocumentFileInputKey((current) => current + 1);
      setProject((current) =>
        isProjectSnapshotOlder(current, payload.project) ? current : normalizeProjectState(
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

  // Same input as the server's suggestion: the title and the file name.
  function suggestUploadRole(title: string, selected: File | null) {
    if (selected && !uploadRoleChosenRef.current) {
      setUploadRole(suggestUploadDocumentRole(`${title} ${selected.name}`, project.documents));
    }
  }

  function onSelectUploadFile(selected: File | null) {
    setFile(selected);
    suggestUploadRole(docTitle, selected);
  }

  function onUploadTitleChange(title: string) {
    setDocTitle(title);
    suggestUploadRole(title, file);
  }

  function onChooseUploadRole(role: ProjectDocumentRole) {
    uploadRoleChosenRef.current = true;
    setUploadRole(role);
  }

  async function onUploadRequirementDocument(file: File) {
    let uploadedDocument: ProjectDocument | null = null;
    const submittedAt = performance.now();

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
        isProjectSnapshotOlder(current, payload.project) ? current : normalizeProjectState(
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
        startPersistedProgress(payload.job);
        completedDocument = await trackDocumentIngestionJob(
          payload.job,
          payload.document.id,
          { propagateFailure: true, submittedAt },
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
    const submittedAt = performance.now();

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
        isProjectSnapshotOlder(current, payload.project) ? current : normalizeProjectState(
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
        startPersistedProgress(payload.job);
        completedDocument = await trackDocumentIngestionJob(
          payload.job,
          payload.document.id,
          { propagateFailure: true, submittedAt },
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
        isProjectSnapshotOlder(current, payload.project) ? current : normalizeProjectState(
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
        isProjectSnapshotOlder(current, payload.project) ? current : normalizeProjectState(
          applyProjectSnapshot(
            {
              ...current,
              generated_artifacts: refreshedArtifacts
                ? mergeGeneratedArtifactsForType(
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

  async function onRetryDocumentEnhancement(document: ProjectDocument) {
    await runAction(`enhance-${document.id}`, async () => {
      const job = await retryDocumentEnhancement({ projectId: project.id, documentId: document.id, sourceRevision: document.chunk_source_revision });
      recordJob(job);
      // The server cleared the failure when it accepted the retry.
      setProject((current) => normalizeProjectState({
        ...current,
        documents: current.documents.map((item) => item.id === document.id
          ? { ...item, processing_message: "Dokumentforbedringen er satt i kø. Grunnversjonen kan brukes imens.", processing_error: null }
          : item),
      }, { preserveArtifactCount: true }));
      setNotice("Dokumentforbedringen er startet på nytt. Grunnversjonen kan brukes imens.");
      void trackDocumentIngestionJob(job, document.id).then((updated) => {
        if (updated?.processing_status === "enhanced_ready") setNotice("Dokumentforbedringen er ferdig.");
        else if (updated && !updated.processing_error) setNotice("");
      });
    });
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
        if (isProjectSnapshotOlder(current, payload.project)) return current;
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

  async function startWorkspaceJob(body: unknown, fallbackMessage: string) {
    try {
      const job = await startProjectJob({
        projectId: project.id,
        body,
        fallbackMessage,
      });
      recordJob(job);
      return job;
    } catch (error) {
      // Another user's job may hold the project; show it instead of guessing.
      if (isProjectWorkflowBusyError(error)) void refreshJobs();
      throw error;
    }
  }

  async function refreshProjectAfterMutation() {
    try {
      const fresh = await fetchProjectState(project.id);
      setProject((current) =>
        mergeProjectRefresh(current, fresh),
      );
    } catch {
      // The mutation already committed; background refresh will retry the read.
    }
    window.dispatchEvent(new Event("project-workflow-updated"));
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
        await waitForProjectJob(
          job.id,
          "Kundeanalysen feilet.",
          job,
        );
        await refreshProjectAfterMutation();
        setAnalysisLoaded(true);
      },
      ["Starter kundeanalysen ..."],
    );
  }

  async function onSaveAnalysis(
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
    revision?: string,
  ) {
    return runAction("save-analysis", async () => {
      await saveCustomerAnalysisSection({
        projectId: project.id,
        section,
        snapshot,
        revision,
      });
      await refreshProjectAfterMutation();
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
        const result = savedArtifactResult(completedJob);
        setProject((current) =>
          isProjectSnapshotOlder(current, result.project) ? current : normalizeProjectState(
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
        const result = savedArtifactResult(completedJob);
        setProject((current) =>
          isProjectSnapshotOlder(current, result.project) ? current : normalizeProjectState(
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
        const result = savedArtifactResult(completedJob);
        setProject((current) =>
          isProjectSnapshotOlder(current, result.project) ? current : normalizeProjectState(
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
    await generateRequirementResponse();
  }

  async function onRegenerateRequirements(selection: RequirementRegenerationSelection) {
    if (!await generateRequirementResponse(selection)) throw new Error("Utvalgte krav ble ikke lagret. Kontroller jobbstatus og prøv igjen.");
  }

  async function generateRequirementResponse(selection?: RequirementRegenerationSelection) {
    const sourceDocumentIds = requirementDocumentIdsForGeneration(
      project.documents,
    );
    if (!sourceDocumentIds.length) {
      setError(
        "Ingen klassifiserte kravdokumenter er klare. Vent til dokumentbehandlingen er ferdig før du genererer kravbesvarelsen.",
      );
      return false;
    }
    return runAction(
      "requirement-response",
      async () => {
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "forbedret_kravsvar",
            regenerate_requirements: selection,
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
        const result = savedArtifactResult(completedJob);
        setProject((current) =>
          isProjectSnapshotOlder(current, result.project) ? current : normalizeProjectState(
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
        await waitForProjectJob(
          job.id,
          "Løsningsvurderingen feilet.",
          job,
        );
        await refreshProjectAfterMutation();
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
        await waitForProjectJob(
          job.id,
          "Lederoppsummeringen feilet.",
          job,
        );
        await refreshProjectAfterMutation();
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
  const hasSelectedServices = serviceDescriptions.some(
    (service) => service.selected,
  );
  const hasCustomerAnalysis =
    Boolean(customerAnalysis) || project.customer_analysis_generated;
  const hasRequirementResponse = hasArtifactType("forbedret_kravsvar");
  const hasSolutionDraft = hasArtifactType("losningsutkast");
  const hasEvaluationReadySolutionDocument =
    architectureDocumentCandidates.some(isDocumentReadyForEvaluation);
  const hasSolutionEvaluation =
    Boolean(solutionEvaluation) || project.solution_evaluation_generated;
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
      value: "service-description",
      label: "Tjenester",
      icon: Layers3,
      status: hasSelectedServices
        ? "Ferdig"
        : serviceDescriptionsLoaded
          ? "Må sjekkes"
          : "Klar",
    },
    {
      step: 3,
      value: "analysis",
      label: "Kundeanalyse",
      icon: Brain,
      status: hasCustomerAnalysis ? "Generert" : hasDocuments ? "Klar" : "Venter",
    },
    {
      step: 4,
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
      step: 5,
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
      step: 6,
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
      step: 7,
      value: "executive-summary",
      label: "Lederoppsummering",
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
      canShare={canShare}
      readOnly={readOnly}
    >
      <ProjectWorkspaceTabContent
        canDownloadDocuments={canDownloadDocuments}
        readOnly={readOnly}
        activeTab={activeTab}
        project={project}
        serviceDescriptions={serviceDescriptions}
        architectureDocumentCandidates={architectureDocumentCandidates}
        customerAnalysis={customerAnalysis}
        solutionEvaluation={solutionEvaluation}
        executiveSummary={executiveSummary}
        analysisLoaded={analysisLoaded}
        analysisLoading={analysisLoading}
        analysisLoadError={analysisLoadError}
        onRetryAnalysisLoad={() => { setAnalysisLoaded(false); setAnalysisLoadRetryToken(value => value + 1); }}
        evaluationLoaded={evaluationLoaded}
        evaluationLoading={evaluationLoading}
        evaluationLoadError={evaluationLoadError}
        executiveSummaryLoaded={executiveSummaryLoaded}
        executiveSummaryLoading={executiveSummaryLoading}
        busy={busy}
        busyMessage={busyMessage}
        busyProgress={busyProgress}
        projectJobs={projectJobs}
        automaticAnalysis={automaticAnalysis}
        workflowBlockedReason={readOnly ? null : workflowBlockedReason}
        onProjectJobRecorded={recordJob}
        onRefreshProjectJobs={refreshJobs}
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
        onServiceDescriptionsChange={updateServiceDescriptions}
        onDocTitleChange={onUploadTitleChange}
        onUploadRoleChange={onChooseUploadRole}
        onFileChange={onSelectUploadFile}
        onUploadDocument={onUploadDocument}
        onDeleteDocument={onDeleteDocument}
        onRetryDocumentEnhancement={onRetryDocumentEnhancement}
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
          onRegenerateRequirements={onRegenerateRequirements}
        onGenerateExecutiveSummary={onGenerateExecutiveSummary}
        onGenerateArtifact={onGenerateArtifact}
      />
    </ProjectWorkspaceShell>
  );
}
