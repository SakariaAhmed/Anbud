"use client";

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
  ArrowDownToLine,
  Brain,
  ChevronDown,
  FileText,
  LayoutGrid,
  ListChecks,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
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
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
} from "@/components/projects/primitives";
import {
  SUPPORTING_SUBTYPES,
  deriveProjectStatus,
  formatDate,
  roleLabel,
  supportingSubtypeLabel,
} from "@/components/projects/project-workspace-shared";
import { ProjectAnalysisTab } from "@/components/projects/project-analysis-tab";
import { ProjectDeliveryTab } from "@/components/projects/project-delivery-tab";
import { ProjectGeneratorTab } from "@/components/projects/project-generator-tab";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  GeneratedArtifact,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentRole,
  ProjectJobRecord,
  ProjectStatus,
  SupportingDocumentSubtype,
} from "@/lib/types";

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
    supporting_document_count: project.documents.filter(
      (d) => d.role === "supporting_document",
    ).length,
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
  const [docRole, setDocRole] = useState<ProjectDocumentRole>(
    "primary_customer_document",
  );
  const [supportingSubtype, setSupportingSubtype] =
    useState<SupportingDocumentSubtype>("rfp");
  const [file, setFile] = useState<File | null>(null);
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [deliveryArtifactInstructions, setDeliveryArtifactInstructions] =
    useState("");
  const [activeTab, setActiveTab] = useState("documents");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [artifactsLoaded, setArtifactsLoaded] = useState(
    initialData.generated_artifacts.length > 0 ||
      initialData.artifact_count === 0,
  );
  const [uploadOpen, setUploadOpen] = useState(false);
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
      (activeTab !== "generator" && activeTab !== "delivery") ||
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
      formData.append("role", docRole);
      if (docRole === "supporting_document") {
        formData.append("supporting_subtype", supportingSubtype);
      }
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
        throw new Error(payload.error || "Kunne ikke laste opp dokumentet.");
      }
      setDocTitle("");
      setFile(null);
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
              document.role === "primary_customer_document" &&
              !payload.project?.customer_analysis_generated
                ? null
                : current.customer_analysis,
            solution_evaluation:
              document.role === "primary_solution_document" &&
              !payload.project?.solution_evaluation_generated
                ? null
                : current.solution_evaluation,
          },
          payload.project!,
        );
        return normalizeProjectState(next, {
          preserveArtifactCount: !artifactsLoaded,
        });
      });
    });
  }

  async function onGenerateCustomerAnalysis() {
    await runAction("analysis", async () => {
      const response = await fetch(
        `/api/projects/${project.id}/customer-analysis`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        error?: string;
        analysis?: CustomerAnalysisResult;
        project?: ProjectSnapshotPayload;
      };
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
    });
  }

  async function onRegenerateCustomerAnalysisSection(
    section: CustomerAnalysisSection,
  ) {
    await runAction(
      `analysis-section-${section}`,
      async () => {
        const response = await fetch(
          `/api/projects/${project.id}/customer-analysis`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ section }),
          },
        );
        const payload = (await response.json()) as {
          error?: string;
          analysis?: CustomerAnalysisResult;
          project?: ProjectSnapshotPayload;
        };
        if (!response.ok || !payload.analysis || !payload.project) {
          throw new Error(payload.error || "Kunne ikke regenerere seksjonen.");
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
        setNotice("Seksjonen er regenerert og lagret i kundeanalysen.");
      },
      ["Regenererer valgt seksjon ..."],
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
          setNotice(
            "Overordnet løsningsdesign og arkitekturdiagram er oppdatert uten å regenerere hele kundeanalysen.",
          );
          break;
        }
      },
      ["Starter generering av overordnet løsningsdesign ..."],
    );
  }

  async function onSaveAnalysis(value: string) {
    await runAction("save-analysis", async () => {
      const response = await fetch(
        `/api/projects/${project.id}/customer-analysis`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ analysis_text: value }),
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
            instructions: deliveryArtifactInstructions,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          job?: ProjectJobRecord;
        };
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for gjennomføring.",
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
                "Jobben for gjennomføringsplanen feilet.",
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
      ["Starter jobben for gjennomføringsplanen ..."],
    );
  }

  const customerAnalysis =
    project.customer_analysis as CustomerAnalysisResult | null;
  const workspaceNavItems = [
    { value: "documents", label: "Dokumenter", icon: FileText },
    { value: "analysis", label: "Kundeanalyse", icon: Brain },
    { value: "delivery", label: "Gjennomføring", icon: ListChecks },
    { value: "generator", label: "Løsningsutkast", icon: Sparkles },
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
    <div className="min-h-[calc(100dvh-var(--app-header-height))] w-full">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--sidebar-width-icon": "3.5rem",
            "--sidebar-offset-top": "0px",
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

        <SidebarInset className="min-w-0 bg-transparent">
          <div className="px-5 py-5 md:px-8 md:py-7">
            <section className="mb-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <SidebarTrigger className="mt-0.5 shrink-0 md:hidden" />
                  <div>
                    <p className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {workspaceNavItems.find(
                        (item) => item.value === activeTab,
                      )?.label ?? "Prosjekt"}
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                      {project.name}
                    </h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-muted-foreground">
                      {project.customer_name ? (
                        <span className="font-medium">
                          {project.customer_name}
                        </span>
                      ) : null}
                      {project.industry ? (
                        <>
                          <span className="text-border">·</span>
                          <span>{project.industry}</span>
                        </>
                      ) : null}
                      <span className="text-border">·</span>
                      <span>
                        Oppdatert {formatDate(project.last_activity_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              {project.description ? (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground/70">
                  {project.description}
                </p>
              ) : null}
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
                <span>{busyMessage}</span>
              </div>
            ) : null}

            {activeTab === "documents" ? (
              <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                {/* Upload form */}
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
                  <div>
                    <button
                      type="button"
                      onClick={() => setUploadOpen((open) => !open)}
                      className="flex w-full items-center justify-between bg-muted px-4 py-3 text-sm font-semibold text-foreground hover:text-primary"
                    >
                      <span className="flex items-center gap-2">
                        <Upload className="size-4" />
                        Last opp dokument
                      </span>
                      <ChevronDown
                        className={`size-4 text-muted-foreground transition-transform ${uploadOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                    {uploadOpen ? (
                      <form
                        onSubmit={onUploadDocument}
                        className="space-y-3 p-4"
                      >
                        <div className="space-y-1.5">
                          <Label htmlFor="docTitle" className="font-medium">
                            Tittel
                          </Label>
                          <Input
                            id="docTitle"
                            value={docTitle}
                            onChange={(e) => setDocTitle(e.target.value)}
                            placeholder="Visningsnavn i prosjektet"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="docRole" className="font-medium">
                            Dokumentrolle
                          </Label>
                          <NativeSelect
                            id="docRole"
                            value={docRole}
                            onChange={(event) =>
                              setDocRole(
                                event.target.value as ProjectDocumentRole,
                              )
                            }
                          >
                            <NativeSelectOption value="primary_customer_document">
                              Primært kundedokument
                            </NativeSelectOption>
                            <NativeSelectOption value="primary_solution_document">
                              Primært løsningsdokument
                            </NativeSelectOption>
                            <NativeSelectOption value="supporting_document">
                              Støttedokument
                            </NativeSelectOption>
                          </NativeSelect>
                        </div>
                        {docRole === "supporting_document" ? (
                          <div className="space-y-1.5">
                            <Label
                              htmlFor="supportingSubtype"
                              className="font-medium"
                            >
                              Undertype
                            </Label>
                            <NativeSelect
                              id="supportingSubtype"
                              value={supportingSubtype}
                              onChange={(event) =>
                                setSupportingSubtype(
                                  event.target
                                    .value as SupportingDocumentSubtype,
                                )
                              }
                            >
                              {SUPPORTING_SUBTYPES.map((item) => (
                                <NativeSelectOption
                                  key={item.value}
                                  value={item.value}
                                >
                                  {item.label}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                        ) : null}
                        <div className="space-y-1.5">
                          <Label htmlFor="file" className="font-medium">
                            Fil
                          </Label>
                          <Input
                            id="file"
                            type="file"
                            accept=".pdf,.docx,.txt,.md"
                            onChange={(e) =>
                              setFile(e.target.files?.[0] ?? null)
                            }
                          />
                        </div>
                        <Button
                          type="submit"
                          className="w-full"
                          disabled={busy === "upload"}
                        >
                          {busy === "upload" ? (
                            <Spinner className="size-4" />
                          ) : (
                            <Upload data-icon="inline-start" />
                          )}
                          Last opp
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </div>

                {/* Document list */}
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
                  <div className="bg-muted px-4 py-3">
                    <h3 className="text-sm font-bold text-foreground">
                      Dokumenter i prosjektet
                    </h3>
                  </div>
                  {project.documents.length === 0 ? (
                    <p className="bg-background py-8 text-center text-sm text-muted-foreground">
                      Ingen dokumenter lastet opp ennå.
                    </p>
                  ) : (
                    <div>
                      {project.documents.map((document) => (
                        <div
                          key={document.id}
                          className="flex items-start justify-between gap-3 border-t bg-background px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <FileText className="size-4 shrink-0 text-primary" />
                              <span className="truncate text-sm font-semibold text-foreground">
                                {document.title}
                              </span>
                            </div>
                            <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
                              {roleLabel(document.role)}
                              {document.role === "supporting_document"
                                ? ` · ${supportingSubtypeLabel(document.supporting_subtype)}`
                                : ""}
                              {" · "}
                              {document.file_format.toUpperCase()}{" "}
                              {Math.round(document.file_size_bytes / 1024)} KB
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <a
                              href={`/api/projects/${project.id}/documents/${document.id}`}
                              className={cn(
                                buttonVariants({
                                  variant: "ghost",
                                  size: "icon-xs",
                                }),
                              )}
                            >
                              <ArrowDownToLine className="size-3.5" />
                            </a>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => onDeleteDocument(document)}
                              disabled={busy === `delete-${document.id}`}
                              className="text-destructive hover:text-destructive"
                            >
                              {busy === `delete-${document.id}` ? (
                                <Spinner className="size-3.5" />
                              ) : (
                                <Trash2 className="size-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {activeTab === "analysis" ? (
              <ProjectAnalysisTab
                customerAnalysis={customerAnalysis}
                busy={busy === "analysis"}
                saveBusy={busy === "save-analysis"}
                sectionBusy={parseCustomerAnalysisSectionBusy(busy)}
                busyMessage={
                  parseCustomerAnalysisSectionBusy(busy) ? busyMessage : ""
                }
                onGenerate={onGenerateCustomerAnalysis}
                onRegenerateSection={onRegenerateCustomerAnalysisSection}
                onSaveAnalysis={onSaveAnalysis}
              />
            ) : null}

            {activeTab === "delivery" ? (
              <ProjectDeliveryTab
                artifacts={project.generated_artifacts.filter(
                  (artifact) =>
                    artifact.artifact_type === "gjennomforing_og_risiko",
                )}
                artifactInstructions={deliveryArtifactInstructions}
                busy={busy === "delivery-artifact"}
                busyMessage={busy === "delivery-artifact" ? busyMessage : ""}
                onArtifactInstructionsChange={setDeliveryArtifactInstructions}
                onSubmit={onGenerateDeliveryArtifact}
              />
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
