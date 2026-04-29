"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  Brain,
  ClipboardCheck,
  FileCheck2,
  LayoutGrid,
  Scale,
  Sparkles,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  deriveProjectStatus,
  formatDate,
} from "@/components/projects/project-workspace-shared";
import { ProjectAnalysisTab } from "@/components/projects/project-analysis-tab";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  CustomerAnalysisSectionSnapshotMap,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  ProjectDetail,
  ProjectDocument,
  ProjectJobRecord,
  ProjectStatus,
  SolutionEvaluationResult,
} from "@/lib/types";

const ProjectEvaluationTab = dynamic(
  () =>
    import("@/components/projects/project-evaluation-tab").then(
      (module) => module.ProjectEvaluationTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster vurdering ...
      </div>
    ),
  },
);

const ProjectDeliveryTab = dynamic(
  () =>
    import("@/components/projects/project-delivery-tab").then(
      (module) => module.ProjectDeliveryTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster fremdriftsplan ...
      </div>
    ),
  },
);

const ProjectExecutiveSummaryTab = dynamic(
  () =>
    import("@/components/projects/project-executive-summary-tab").then(
      (module) => module.ProjectExecutiveSummaryTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster leder oppsummering ...
      </div>
    ),
  },
);

const ProjectServiceDescriptionTab = dynamic(
  () =>
    import("@/components/projects/project-service-description-tab").then(
      (module) => module.ProjectServiceDescriptionTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster tjenestebeskrivelse ...
      </div>
    ),
  },
);

const ProjectRequirementResponseTab = dynamic(
  () =>
    import("@/components/projects/project-requirement-response-tab").then(
      (module) => module.ProjectRequirementResponseTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster kravbesvarelse ...
      </div>
    ),
  },
);

const ProjectGeneratorTab = dynamic(
  () =>
    import("@/components/projects/project-generator-tab").then(
      (module) => module.ProjectGeneratorTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster løsningsutkast ...
      </div>
    ),
  },
);

interface ProjectSnapshotPayload {
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
  status: ProjectStatus;
  customer_document_uploaded: boolean;
  customer_analysis_generated: boolean;
  solution_document_uploaded: boolean;
  solution_evaluation_generated: boolean;
  last_activity_at: string;
}

function patchProjectWithSnapshot(
  project: ProjectDetail,
  snapshot: ProjectSnapshotPayload,
): ProjectDetail {
  return { ...project, ...snapshot };
}

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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readJsonPayload<T>(
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

function DeferredSectionLoader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground shadow-sm">
      <Spinner className="size-4 text-primary" />
      <span>{label}</span>
    </div>
  );
}

const CUSTOMER_ANALYSIS_SECTIONS: CustomerAnalysisSection[] = [
  "summary",
  "strategy",
  "design",
  "risks",
  "needs",
  "keywords",
  "value",
];

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
}: {
  initialData: ProjectDetail;
}) {
  const DEFAULT_SIDEBAR_WIDTH = 240;
  const MIN_SIDEBAR_WIDTH = 236;
  const MAX_SIDEBAR_WIDTH = 360;
  const router = useRouter();
  const [project, setProject] = useState(initialData);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [requirementInstructions, setRequirementInstructions] = useState("");
  const [activeTab, setActiveTab] = useState("analysis");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [artifactsLoaded, setArtifactsLoaded] = useState(
    initialData.generated_artifacts.length > 0 ||
      initialData.artifact_count === 0,
  );
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
  const [executiveSummaryLoading, setExecutiveSummaryLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [documentFileInputKey, setDocumentFileInputKey] = useState(0);
  const progressIntervalRef = useRef<number | null>(null);
  const sidebarResizeRef = useRef(false);

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
    setBusyMessage("");
  }

  function startProgressTicker(messages: string[]) {
    stopProgressTicker();
    if (!messages.length) return;
    setBusyMessage(messages[0] ?? "");
    if (messages.length < 2) return;
    let index = 0;
    progressIntervalRef.current = window.setInterval(() => {
      index = Math.min(index + 1, messages.length - 1);
      setBusyMessage(messages[index] ?? "");
    }, 3200);
  }

  useEffect(() => stopProgressTicker, []);

  useEffect(() => {
    try {
      const storedWidth = window.localStorage.getItem(
        "project-workspace-sidebar-width",
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
        "project-workspace-sidebar-width",
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

    let cancelled = false;
    setAnalysisLoading(true);
    fetch(`/api/projects/${project.id}/customer-analysis`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await readJsonPayload<{
          error?: string;
          analysis?: CustomerAnalysisResult | null;
        }>(response, "Kunne ikke hente kundeanalysen.");
        if (!response.ok) {
          throw new Error(payload.error || "Kunne ikke hente kundeanalysen.");
        }
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            customer_analysis: payload.analysis ?? null,
          }));
          setAnalysisLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente kundeanalysen.",
          );
          setAnalysisLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAnalysisLoading(false);
        }
      });

    return () => {
      cancelled = true;
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

    let cancelled = false;
    setEvaluationLoading(true);
    fetch(`/api/projects/${project.id}/solution-evaluation`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          error?: string;
          evaluation?: SolutionEvaluationResult | null;
        };
        if (!response.ok) {
          throw new Error(
            payload.error || "Kunne ikke hente løsningsvurderingen.",
          );
        }
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            solution_evaluation: payload.evaluation ?? null,
          }));
          setEvaluationLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente løsningsvurderingen.",
          );
          setEvaluationLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEvaluationLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    evaluationLoaded,
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

    let cancelled = false;
    setExecutiveSummaryLoading(true);
    fetch(`/api/projects/${project.id}/executive-summary`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          error?: string;
          executive_summary?: ExecutiveSummaryResult | null;
        };
        if (!response.ok) {
          throw new Error(
            payload.error || "Kunne ikke hente lederoppsummeringen.",
          );
        }
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            executive_summary: payload.executive_summary ?? null,
          }));
          setExecutiveSummaryLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente lederoppsummeringen.",
          );
          setExecutiveSummaryLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExecutiveSummaryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    executiveSummaryLoaded,
    project.id,
    project.solution_evaluation_generated,
  ]);

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
      stopProgressTicker();
      setBusy(null);
    }
  }

  useEffect(() => {
    if (
      (activeTab !== "generator" &&
        activeTab !== "delivery" &&
        activeTab !== "requirements") ||
      artifactsLoaded ||
      project.artifact_count === 0
    )
      return;
    let cancelled = false;
    fetch(`/api/projects/${project.id}/generate`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          error?: string;
          artifacts?: GeneratedArtifact[];
        };
        if (!response.ok || !payload.artifacts) {
          throw new Error(
            payload.error || "Kunne ikke hente generatorresultatene.",
          );
        }
        if (!cancelled) {
          setProject((current) =>
            normalizeProjectState({
              ...current,
              generated_artifacts: payload.artifacts ?? [],
            }),
          );
          setArtifactsLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Kunne ikke hente generatorresultatene.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, artifactsLoaded, project.artifact_count, project.id]);

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
      const response = await fetch(`/api/projects/${project.id}/documents`, {
        method: "POST",
        body: formData,
      });
      const payload = await readJsonPayload<{
        error?: string;
        document?: ProjectDocument;
        project?: ProjectSnapshotPayload;
      }>(response, "Kunne ikke laste opp dokumentet.");
      if (!response.ok || !payload.document || !payload.project) {
        throw new Error(payload.error || "Kunne ikke laste opp dokumentet.");
      }
      setDocTitle("");
      setFile(null);
      setDocumentFileInputKey((current) => current + 1);
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document!,
                ...current.documents,
              ]),
            },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
      setArtifactsLoaded(true);
    });
  }

  async function onUploadServiceDescriptionDocument(file: File) {
    await runAction("upload-service-description", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", file.name.replace(/\.[^.]+$/, ""));
      const response = await fetch(`/api/projects/${project.id}/documents`, {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        error?: string;
        document?: ProjectDocument;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.document || !payload.project) {
        throw new Error(
          payload.error || "Kunne ikke laste opp tjenestebeskrivelsen.",
        );
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document!,
                ...current.documents,
              ]),
            },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
      setArtifactsLoaded(true);
    });
  }

  async function onUploadRequirementDocument(file: File) {
    await runAction("upload-requirement-document", async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "title",
        `Kravdokument - ${file.name.replace(/\.[^.]+$/, "")}`,
      );
      const response = await fetch(`/api/projects/${project.id}/documents`, {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        error?: string;
        document?: ProjectDocument;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.document || !payload.project) {
        throw new Error(payload.error || "Kunne ikke laste opp kravdokumentet.");
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              documents: dedupeDocuments([
                payload.document!,
                ...current.documents,
              ]),
            },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
          },
        ),
      );
      setArtifactsLoaded(true);
    });
  }

  async function onDeleteDocument(document: ProjectDocument) {
    await runAction(`delete-${document.id}`, async () => {
      const response = await fetch(
        `/api/projects/${project.id}/documents/${document.id}`,
        { method: "DELETE" },
      );
      const payload = (await response.json()) as {
        error?: string;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || "Kunne ikke slette dokumentet.");
      }
      setProject((current) => {
        const next = patchProjectWithSnapshot(
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
          payload.project!,
        );
        return normalizeProjectState(next, {
          preserveArtifactCount: !artifactsLoaded,
        });
      });
      if (!payload.project.customer_analysis_generated) {
        setAnalysisLoaded(true);
      }
      if (!payload.project.solution_evaluation_generated) {
        setEvaluationLoaded(true);
        setExecutiveSummaryLoaded(true);
      }
    });
  }

  async function onGenerateCustomerAnalysis() {
    await runAction(
      "analysis",
      async () => {
        const response = await fetch(
          `/api/projects/${project.id}/customer-analysis`,
          { method: "POST" },
        );
        const payload = await readJsonPayload<{
          error?: string;
          analysis?: CustomerAnalysisResult;
          project?: ProjectSnapshotPayload;
        }>(response, "Kunne ikke generere kundeanalyse.");
        if (!response.ok || !payload.analysis || !payload.project) {
          throw new Error(payload.error || "Kunne ikke generere kundeanalyse.");
        }
        setProject((current) =>
          normalizeProjectState(
            patchProjectWithSnapshot(
              { ...current, customer_analysis: payload.analysis! },
              payload.project!,
            ),
            {
              preserveArtifactCount: !artifactsLoaded,
            },
          ),
        );
        setAnalysisLoaded(true);
      },
      ["Starter kundeanalysen ..."],
    );
  }

  async function onGenerateHighLevelDesign() {
    await runAction(
      "high-level-design",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "high_level_design",
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error ||
              "Kunne ikke starte jobben for overordnet løsningsdesign.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error ||
                "Jobben for overordnet løsningsdesign feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          ) {
            continue;
          }

          const result = statusPayload.job.result as {
            analysis: CustomerAnalysisResult;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                { ...current, customer_analysis: result.analysis },
                result.project,
              ),
              {
                preserveArtifactCount: !artifactsLoaded,
              },
            ),
          );
          setAnalysisLoaded(true);
          setNotice(
            "Overordnet løsningsdesign og arkitekturdiagram er oppdatert uten å regenerere hele kundeanalysen.",
          );
          break;
        }
      },
      ["Starter generering av overordnet løsningsdesign ..."],
    );
  }

  async function onSaveAnalysis(
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
  ) {
    await runAction("save-analysis", async () => {
      const response = await fetch(
        `/api/projects/${project.id}/customer-analysis`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            section,
            section_snapshot: snapshot,
          }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        analysis?: CustomerAnalysisResult;
        project?: ProjectSnapshotPayload;
      };
      if (!response.ok || !payload.analysis || !payload.project) {
        throw new Error(payload.error || "Kunne ikke lagre analysen.");
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            { ...current, customer_analysis: payload.analysis! },
            payload.project!,
          ),
          {
            preserveArtifactCount: !artifactsLoaded,
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
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "losningsutkast",
            instructions: artifactInstructions,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte generatorjobben.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error || "Generatorjobben feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          )
            continue;

          const result = statusPayload.job.result as {
            artifact: GeneratedArtifact;
            project: ProjectSnapshotPayload;
            evaluation?: SolutionEvaluationResult;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  solution_evaluation:
                    result.evaluation ?? current.solution_evaluation,
                  generated_artifacts: [
                    result.artifact,
                    ...current.generated_artifacts,
                  ],
                  artifact_count: current.artifact_count + 1,
                },
                result.project,
              ),
            ),
          );
          break;
        }
      },
      ["Starter generatorjobben ..."],
    );
  }

  async function onGenerateDeliveryArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "delivery-artifact",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "gjennomforing_og_risiko",
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for fremdriftsplan.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error ||
                "Jobben for fremdriftsplanen feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          )
            continue;

          const result = statusPayload.job.result as {
            artifact: GeneratedArtifact;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  generated_artifacts: [
                    result.artifact,
                    ...current.generated_artifacts,
                  ],
                  artifact_count: current.artifact_count + 1,
                },
                result.project,
              ),
            ),
          );
          break;
        }
      },
      ["Starter jobben for fremdriftsplanen ..."],
    );
  }

  async function onGenerateRequirementResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "requirement-response",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "forbedret_kravsvar",
            instructions: requirementInstructions,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for kravbesvarelse.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error || "Jobben for kravbesvarelse feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          )
            continue;

          const result = statusPayload.job.result as {
            artifact: GeneratedArtifact;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  generated_artifacts: [
                    result.artifact,
                    ...current.generated_artifacts,
                  ],
                  artifact_count: current.artifact_count + 1,
                },
                result.project,
              ),
            ),
          );
          break;
        }
      },
      ["Starter jobben for kravbesvarelse ..."],
    );
  }

  async function onGenerateSolutionEvaluation(solutionDocumentId?: string) {
    await runAction(
      "solution-evaluation",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "solution_evaluation",
            allow_generated_solution: false,
            solution_document_id: solutionDocumentId,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte løsningsvurderingen.",
          );
        }
        setBusyMessage(payload.job.message);
        while (true) {
          await sleep(1500);
          const statusResponse = await fetch(
            `/api/projects/${project.id}/jobs/${payload.job.id}`,
            { cache: "no-store" },
          );
          const statusPayload = (await statusResponse.json()) as {
            error?: string;
            job?: ProjectJobRecord;
          };
          if (!statusResponse.ok || !statusPayload.job) {
            throw new Error(
              statusPayload.error || "Kunne ikke hente jobbstatus.",
            );
          }
          setBusyMessage(statusPayload.job.message);
          if (statusPayload.job.status === "failed") {
            throw new Error(
              statusPayload.job.error || "Løsningsvurderingen feilet.",
            );
          }
          if (
            statusPayload.job.status !== "completed" ||
            !statusPayload.job.result
          ) {
            continue;
          }

          const result = statusPayload.job.result as {
            evaluation: SolutionEvaluationResult;
            project: ProjectSnapshotPayload;
          };
          setProject((current) =>
            normalizeProjectState(
              patchProjectWithSnapshot(
                {
                  ...current,
                  solution_evaluation: result.evaluation,
                  executive_summary: null,
                },
                result.project,
              ),
              {
                preserveArtifactCount: !artifactsLoaded,
              },
            ),
          );
          setEvaluationLoaded(true);
          setExecutiveSummaryLoaded(true);
          setNotice("Sammenligningen er generert og lagret i prosjektet.");
          break;
        }
      },
      ["Starter sammenligning av systemløsning og arkitektløsning ..."],
    );
  }

  async function onGenerateExecutiveSummary() {
    await runAction(
      "executive-summary",
      async () => {
        const response = await fetch(
          `/api/projects/${project.id}/executive-summary`,
          { method: "POST" },
        );
        const payload = (await response.json()) as {
          error?: string;
          executive_summary?: ExecutiveSummaryResult;
          project?: ProjectSnapshotPayload;
        };
        if (!response.ok || !payload.executive_summary || !payload.project) {
          throw new Error(
            payload.error || "Kunne ikke generere lederoppsummering.",
          );
        }
        setProject((current) =>
          normalizeProjectState(
            patchProjectWithSnapshot(
              {
                ...current,
                executive_summary: payload.executive_summary!,
              },
              payload.project!,
            ),
            {
              preserveArtifactCount: !artifactsLoaded,
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
  const workspaceNavItems = [
    { value: "analysis", label: "Kundeanalyse", icon: Brain },
    { value: "evaluation", label: "Vurdering", icon: Scale },
    { value: "service-description", label: "Tjenestebeskrivelse", icon: Wrench },
    { value: "requirements", label: "Kravbesvarelse", icon: FileCheck2 },
    { value: "generator", label: "Løsningsutkast", icon: Sparkles },
    { value: "executive-summary", label: "Leder oppsummering", icon: ClipboardCheck },
    { value: "delivery", label: "Fremdriftsplan", icon: ArrowRight },
  ] as const;
  const projectMonogram = project.name.trim().charAt(0).toUpperCase() || "A";

  function onSidebarResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!sidebarOpen) return;
    event.preventDefault();
    sidebarResizeRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  return (
    <div className="min-h-[calc(100dvh-var(--app-header-height))] w-full overflow-x-hidden">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--sidebar-width-icon": "3.5rem",
            "--sidebar-offset-top": "var(--app-header-height)",
            "--sidebar-offset-bottom": "0px",
          } as CSSProperties
        }
        className="min-h-[calc(100dvh-var(--app-header-height))] bg-white/70 max-md:flex-col"
      >
        <Sidebar
          collapsible="icon"
          className="bg-sidebar/70 md:border-r md:border-sidebar-border/70"
        >
          <SidebarHeader
            className={cn(
              "border-b border-sidebar-border/70 bg-sidebar/95 p-3 backdrop-blur transition-[padding] duration-300 ease-out",
              !sidebarOpen && "px-2 py-2",
            )}
          >
            {sidebarOpen ? (
              <div className="relative px-1 py-1">
                <SidebarTrigger className="absolute top-0 right-0 size-8 shrink-0 text-muted-foreground hover:bg-sidebar-accent/80 hover:text-foreground" />

                <div className="flex min-w-0 items-center gap-3 pr-10">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary/12 text-base font-semibold text-sidebar-primary">
                    {projectMonogram}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Arbeidsflate
                    </p>
                    <p className="mt-1 truncate text-[1.02rem] font-semibold text-foreground">
                      {project.name}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-1">
                <SidebarTrigger className="size-8 shrink-0 rounded-md text-muted-foreground hover:bg-sidebar-accent/80 hover:text-foreground" />
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary/12 text-xs font-semibold text-sidebar-primary">
                  {projectMonogram}
                </div>
              </div>
            )}
          </SidebarHeader>

          <SidebarContent
            className={cn(
              "min-h-0 flex-1 p-2 transition-[padding] duration-300 ease-out",
              !sidebarOpen && "px-1.5",
            )}
          >
            <SidebarGroup
              className={cn("gap-4 p-3", !sidebarOpen && "gap-3 px-0 py-2")}
            >
              <SidebarGroupContent>
                <SidebarMenu
                  className={cn("gap-1", !sidebarOpen && "items-center")}
                >
                  {workspaceNavItems.map((item) => (
                    <SidebarMenuItem
                      key={item.value}
                      className={cn(!sidebarOpen && "flex justify-center")}
                    >
                      <SidebarMenuButton
                        isActive={activeTab === item.value}
                        size="lg"
                        tooltip={item.label}
                        className={cn(
                          "h-11 rounded-lg px-3 text-[0.95rem] transition-all duration-300 ease-out",
                          !sidebarOpen &&
                            "mx-auto size-10 justify-center rounded-md px-0",
                        )}
                        onClick={() => setActiveTab(item.value)}
                      >
                        <item.icon className="size-4.5" />
                        {sidebarOpen ? <span>{item.label}</span> : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter
            className={cn(
              "border-t border-sidebar-border/70 bg-sidebar/95 p-3 backdrop-blur transition-[padding] duration-300 ease-out",
              !sidebarOpen && "px-1.5 py-2",
            )}
          >
            <SidebarMenu className={cn(!sidebarOpen && "items-center")}>
              <SidebarMenuItem
                className={cn(!sidebarOpen && "flex justify-center")}
              >
                <SidebarMenuButton
                  size="lg"
                  tooltip="Alle prosjekter"
                  className={cn(
                    "h-11 rounded-lg px-3 text-[0.95rem] transition-all duration-300 ease-out",
                    !sidebarOpen &&
                      "mx-auto size-10 justify-center rounded-md px-0",
                  )}
                  onClick={() => router.push("/")}
                >
                  <LayoutGrid className="size-4.5" />
                  {sidebarOpen ? <span>Alle prosjekter</span> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          {sidebarOpen ? (
            <button
              type="button"
              aria-label="Resize sidebar"
              onPointerDown={onSidebarResizeStart}
              className="absolute top-0 right-[-3px] bottom-0 hidden w-2 cursor-col-resize touch-none bg-transparent md:block"
            >
              <span className="absolute top-0 right-[2px] bottom-0 w-px bg-border/70 transition-colors hover:bg-primary/50" />
            </button>
          ) : null}
        </Sidebar>

        <SidebarInset className="min-w-0 overflow-x-hidden bg-transparent">
          <div
            className={cn(
              "relative w-full max-w-full overflow-x-hidden px-5 py-5 md:px-8 md:py-7",
              !sidebarOpen && "mx-auto",
            )}
          >
            <section className="mb-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <SidebarTrigger className="mt-0.5 shrink-0 md:hidden" />
                  <div className="min-w-0">
                    <p className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {workspaceNavItems.find(
                        (item) => item.value === activeTab,
                      )?.label ?? "Prosjekt"}
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                      {project.name}
                    </h2>
                    <p className="mt-1.5 text-left text-sm text-muted-foreground">
                      Oppdatert {formatDate(project.last_activity_at)}
                    </p>
                    {project.customer_name || project.industry ? (
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-muted-foreground">
                        {project.customer_name ? (
                          <span className="font-medium">
                            {project.customer_name}
                          </span>
                        ) : null}
                        {project.customer_name && project.industry ? (
                          <span className="text-border">·</span>
                        ) : null}
                        {project.industry ? <span>{project.industry}</span> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            {error ? (
              <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            {!error && notice ? (
              <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
                {notice}
              </div>
            ) : null}
            {busyMessage && busy === "artifact" ? (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
                <Spinner className="size-3.5" />
                <span className="min-w-0">{busyMessage}</span>
              </div>
            ) : null}

            {activeTab === "analysis" ? (
              !analysisLoaded || analysisLoading ? (
                <DeferredSectionLoader label="Laster kundeanalyse ..." />
              ) : (
                <ProjectAnalysisTab
                  projectId={project.id}
                  documents={project.documents}
                  customerAnalysis={customerAnalysis}
                  busy={busy === "analysis"}
                  saveBusy={busy === "save-analysis"}
                  sectionBusy={parseCustomerAnalysisSectionBusy(busy)}
                  busyMessage={
                    parseCustomerAnalysisSectionBusy(busy) ? busyMessage : ""
                  }
                  onGenerate={onGenerateCustomerAnalysis}
                  onSaveAnalysis={onSaveAnalysis}
                  uploadOpen={uploadOpen}
                  onToggleUploadOpen={() => setUploadOpen((open) => !open)}
                  docTitle={docTitle}
                  onDocTitleChange={setDocTitle}
                  selectedDocumentName={file?.name ?? ""}
                  onFileChange={setFile}
                  documentFileInputKey={documentFileInputKey}
                  onUploadDocument={onUploadDocument}
                  uploadBusy={busy === "upload"}
                  deletingDocumentId={
                    busy?.startsWith("delete-")
                      ? busy.slice("delete-".length)
                      : null
                  }
                  onDeleteDocument={onDeleteDocument}
                />
              )
            ) : null}

            {activeTab === "evaluation" ? (
              !evaluationLoaded || evaluationLoading ? (
                <DeferredSectionLoader label="Laster vurdering ..." />
              ) : (
                <ProjectEvaluationTab
                  documents={project.documents}
                  solutionEvaluation={solutionEvaluation}
                  hasSolutionDocument={project.documents.length > 0}
                  busy={busy === "solution-evaluation"}
                  busyMessage={busy === "solution-evaluation" ? busyMessage : ""}
                  onGenerate={onGenerateSolutionEvaluation}
                />
              )
            ) : null}

            {activeTab === "delivery" ? (
              <ProjectDeliveryTab
                artifacts={project.generated_artifacts.filter(
                  (artifact) =>
                    artifact.artifact_type === "gjennomforing_og_risiko",
                )}
                busy={busy === "delivery-artifact"}
                busyMessage={busy === "delivery-artifact" ? busyMessage : ""}
                hasCustomerAnalysis={Boolean(customerAnalysis)}
                onSubmit={onGenerateDeliveryArtifact}
              />
            ) : null}

            {activeTab === "service-description" ? (
              <ProjectServiceDescriptionTab
                projectId={project.id}
                documents={project.documents}
                uploadBusy={busy === "upload-service-description"}
                deletingDocumentId={
                  busy?.startsWith("delete-")
                    ? busy.slice("delete-".length)
                    : null
                }
                onUpload={onUploadServiceDescriptionDocument}
                onDeleteDocument={onDeleteDocument}
              />
            ) : null}

            {activeTab === "requirements" ? (
              <ProjectRequirementResponseTab
                projectId={project.id}
                documents={project.documents}
                artifacts={project.generated_artifacts.filter(
                  (artifact) => artifact.artifact_type === "forbedret_kravsvar",
                )}
                instructions={requirementInstructions}
                uploadBusy={busy === "upload-requirement-document"}
                generateBusy={busy === "requirement-response"}
                busyMessage={
                  busy === "requirement-response" ? busyMessage : ""
                }
                deletingDocumentId={
                  busy?.startsWith("delete-")
                    ? busy.slice("delete-".length)
                    : null
                }
                onUpload={onUploadRequirementDocument}
                onDeleteDocument={onDeleteDocument}
                onInstructionsChange={setRequirementInstructions}
                onSubmit={onGenerateRequirementResponse}
              />
            ) : null}

            {activeTab === "executive-summary" ? (
              !executiveSummaryLoaded || executiveSummaryLoading ? (
                <DeferredSectionLoader label="Laster lederoppsummering ..." />
              ) : (
                <ProjectExecutiveSummaryTab
                  executiveSummary={executiveSummary}
                  hasSolutionEvaluation={Boolean(solutionEvaluation)}
                  busy={busy === "executive-summary"}
                  busyMessage={
                    busy === "executive-summary" ? busyMessage : ""
                  }
                  onGenerate={onGenerateExecutiveSummary}
                />
              )
            ) : null}

            {activeTab === "generator" ? (
              <ProjectGeneratorTab
                artifacts={project.generated_artifacts.filter(
                  (artifact) => artifact.artifact_type === "losningsutkast",
                )}
                artifactInstructions={artifactInstructions}
                busy={busy === "artifact"}
                busyMessage={busy === "artifact" ? busyMessage : ""}
                onArtifactInstructionsChange={setArtifactInstructions}
                onSubmit={onGenerateArtifact}
              />
            ) : null}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
