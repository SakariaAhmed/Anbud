"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  Download,
  FileCheck2,
  FileText,
  FolderOpen,
  LayoutGrid,
  Scale,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { markNextHomeNavigationWithoutAnimation } from "@/components/layout/app-header-logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/projects/primitives";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
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
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import type {
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  CustomerAnalysisSectionSnapshotMap,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentRole,
  ProjectServiceDescription,
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

const ProjectAnalysisTab = dynamic(
  () =>
    import("@/components/projects/project-analysis-tab").then(
      (module) => module.ProjectAnalysisTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster kundeanalyse ...
      </div>
    ),
  },
);

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Ukjent størrelse";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pageCountLabel(pageCount: number | null | undefined) {
  if (!pageCount) {
    return "Sider: ikke tilgjengelig";
  }

  return pageCount === 1 ? "Sider: 1" : `Sider: ${pageCount}`;
}

function downloadFileName(document: ProjectDocument) {
  return document.file_name || `${document.title}.${document.file_format}`;
}

function projectDocumentRoleLabel(document: ProjectDocument) {
  if (document.role === "primary_customer_document") return "Kundedokument";
  if (document.role === "primary_solution_document") return "Løsningsdokument";
  if (document.supporting_subtype === "kravdokument") return "Kravdokument";
  if (document.supporting_subtype === "rfp") return "RFP";
  if (document.supporting_subtype === "vedlegg") return "Vedlegg";
  return "Støttedokument";
}

function completionLabel(done: boolean) {
  return done ? "Klar" : "Gjenstår";
}

function workspaceActionForProject(project: ProjectDetail) {
  if (!project.customer_document_uploaded && project.documents.length === 0) {
    return "Last opp kundedokument eller konkurransegrunnlag.";
  }
  if (!project.customer_analysis_generated) {
    return "Generer kundeanalyse før du lager utkast.";
  }
  if (!project.generated_artifacts.length) {
    return "Lag første løsningsbeskrivelse eller Bilag 1-utkast.";
  }
  if (!project.solution_evaluation_generated) {
    return "Kjør vurdering før leveransearbeidet ferdigstilles.";
  }
  return "Prosjektet er klart for leveransepakke og lederoppsummering.";
}

function serviceModeLabel(service: ProjectServiceDescription) {
  return service.inclusion_mode === "fixed" ? "Fast" : "Valgt";
}

function ProjectDocumentsTab({
  projectId,
  documents,
  services,
  uploadOpen,
  onToggleUploadOpen,
  docTitle,
  onDocTitleChange,
  uploadRole,
  onUploadRoleChange,
  selectedDocumentName,
  onFileChange,
  documentFileInputKey,
  onUploadDocument,
  uploadBusy,
  deletingDocumentId,
  onDeleteDocument,
}: {
  projectId: string;
  documents: ProjectDocument[];
  services: ProjectServiceDescription[];
  uploadOpen: boolean;
  onToggleUploadOpen: () => void;
  docTitle: string;
  onDocTitleChange: (value: string) => void;
  uploadRole: ProjectDocumentRole;
  onUploadRoleChange: (value: ProjectDocumentRole) => void;
  selectedDocumentName: string;
  onFileChange: (file: File | null) => void;
  documentFileInputKey: number;
  onUploadDocument: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  uploadBusy: boolean;
  deletingDocumentId: string | null;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
}) {
  const serviceDocuments = services.flatMap((service) =>
    service.documents.map((document) => ({ service, document })),
  );

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggleUploadOpen}
        className="flex w-full items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-5 text-left transition-colors hover:bg-slate-100/80"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <FolderOpen className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-xl font-bold text-slate-950">
              Dokumenter
            </span>
            <span className="mt-1 block text-sm text-slate-500">
              Prosjektdokumenter og tjenestebeskrivelser som brukes som grunnlag.
            </span>
          </span>
        </span>
        <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-bold text-blue-700">
          {documents.length} dokumenter
        </span>
      </button>

      {uploadOpen ? (
        <form
          onSubmit={onUploadDocument}
          className="grid gap-3 border-b border-slate-200 bg-white px-5 py-5 lg:grid-cols-[minmax(14rem,1fr)_minmax(12rem,16rem)_minmax(12rem,1fr)_auto]"
        >
          <Input
            value={docTitle}
            onChange={(event) => onDocTitleChange(event.target.value)}
            placeholder="Dokumenttittel"
            className="h-10 rounded-lg text-sm"
          />
          <select
            value={uploadRole}
            onChange={(event) =>
              onUploadRoleChange(event.target.value as ProjectDocumentRole)
            }
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-primary"
          >
            <option value="primary_customer_document">Kundedokument</option>
            <option value="primary_solution_document">Løsningsdokument</option>
            <option value="supporting_document">Støttedokument</option>
          </select>
          <label
            htmlFor="workspace-document-file"
            className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-sm font-semibold text-slate-600 hover:border-primary/60 hover:bg-primary/5"
          >
            <Upload className="size-4" />
            <span className="min-w-0 truncate">
              {selectedDocumentName || "Velg dokument"}
            </span>
          </label>
          <Input
            key={documentFileInputKey}
            id="workspace-document-file"
            type="file"
            accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
            className="sr-only"
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          />
          <Button
            type="submit"
            className="h-10"
            disabled={uploadBusy}
          >
            {uploadBusy ? (
              <Spinner className="size-3.5" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            Last opp
          </Button>
        </form>
      ) : null}

      <div className="grid min-w-0 gap-6 px-5 py-5 xl:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Prosjektdokumenter
          </p>
          {documents.length ? (
            <div className="grid gap-3">
              {documents.map((document) => (
                <div
                  key={document.id}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-base font-semibold leading-6 text-slate-950">
                        {document.title}
                      </p>
                      <p className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                        {projectDocumentRoleLabel(document)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <a
                        href={`/api/projects/${projectId}/documents/${document.id}`}
                        download={downloadFileName(document)}
                        className="inline-flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-950"
                        title={`Last ned ${downloadFileName(document)}`}
                      >
                        <Download className="size-3.5" />
                      </a>
                      <DeleteConfirmDialog
                        title="Slett dokument?"
                        description={`Dette sletter "${document.title}" fra prosjektet. Relaterte analyser kan også bli nullstilt. Handlingen kan ikke angres.`}
                        confirmLabel="Slett dokument"
                        onConfirm={() => onDeleteDocument(document)}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={deletingDocumentId === document.id}
                          className="text-slate-400 hover:text-destructive"
                        >
                          {deletingDocumentId === document.id ? (
                            <Spinner className="size-3" />
                          ) : (
                            <Trash2 className="size-3" />
                          )}
                        </Button>
                      </DeleteConfirmDialog>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm text-slate-500">
                    <span>{formatFileSize(document.file_size_bytes)}</span>
                    <span>·</span>
                    <span>{pageCountLabel(document.page_count)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7">
              <p className="text-sm font-semibold text-slate-950">
                Ingen prosjektdokumenter ennå
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Start med kundedokument, kravspesifikasjon eller RFP. Det gir
                kundeanalyse, kravbesvarelse og utkast et felles grunnlag.
              </p>
              {!uploadOpen ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={onToggleUploadOpen}
                >
                  <Upload data-icon="inline-start" />
                  Last opp dokument
                </Button>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Tjenestebeskrivelser
          </p>
          {serviceDocuments.length ? (
            <div className="grid gap-3">
              {serviceDocuments.map(({ service, document }) => (
                <div
                  key={`${service.id}-${document.id}`}
                  className="rounded-xl border border-teal-200 bg-teal-50/55 px-4 py-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <FileText className="mt-1 size-4 shrink-0 text-teal-700" />
                    <div className="min-w-0">
                      <p className="break-words text-base font-semibold leading-6 text-slate-950">
                        {document.title}
                      </p>
                      <p className="mt-1 break-words text-sm leading-5 text-slate-600">
                        {service.name}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full bg-white px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.1em] text-teal-800">
                      {serviceModeLabel(service)}
                    </span>
                    {service.recommended ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-bold text-amber-900">
                        Anbefalt
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm text-slate-500">
                    <span>{formatFileSize(document.file_size_bytes)}</span>
                    <span>·</span>
                    <span>{pageCountLabel(document.page_count)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-teal-200 bg-teal-50/40 px-4 py-7">
              <p className="text-sm font-semibold text-slate-950">
                Ingen tjenestedokumenter valgt
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Velg relevante tjenester i tjenestebeskrivelse-fanen for å
                bruke dem som kontekst i genereringene.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

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

const ProjectBilag1Tab = dynamic(
  () =>
    import("@/components/projects/project-bilag1-tab").then(
      (module) => module.ProjectBilag1Tab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster Bilag 1 ...
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
        Laster løsningsbeskrivelse ...
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

const PROJECT_WORKSPACE_TABS = [
  "documents",
  "analysis",
  "bilag1",
  "service-description",
  "requirements",
  "generator",
  "evaluation",
  "delivery",
  "executive-summary",
] as const;

export type ProjectWorkspaceTab = (typeof PROJECT_WORKSPACE_TABS)[number];

type WorkspaceNavItem = {
  value: ProjectWorkspaceTab;
  label: string;
  icon: LucideIcon;
};

function isProjectWorkspaceTab(value: string | null | undefined): value is ProjectWorkspaceTab {
  return PROJECT_WORKSPACE_TABS.includes(value as ProjectWorkspaceTab);
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

function prependGeneratedArtifact(
  artifacts: GeneratedArtifact[],
  artifact: GeneratedArtifact,
) {
  return [artifact, ...artifacts.filter((item) => item.id !== artifact.id)];
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
  const delays = [800, 1500, 2500];
  let attempt = 0;

  while (true) {
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 2500, signal);
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

function hasExplicitProgress(message: string) {
  return /\[\d{1,3}%\]/.test(message);
}

function progressMessageLabel(message: string) {
  return message.replace(/^\[\d{1,3}%\]\s*/, "");
}

function estimatedJobDurationMs(
  job: Pick<ProjectJobRecord, "kind">,
  modelId: string,
) {
  const model = modelId.toLowerCase();
  const modelMultiplier = model.includes("pro")
    ? 1.75
    : model.includes("5.5")
      ? 1.35
      : model.includes("nano")
        ? 0.55
        : model.includes("mini")
          ? 0.7
          : 1;
  const baseByKind: Record<ProjectJobRecord["kind"], number> = {
    customer_analysis: 75_000,
    solution_evaluation: 80_000,
    artifact_generation: 95_000,
    high_level_design: 65_000,
    perfect_system_solution: 135_000,
    executive_summary: 45_000,
  };

  return Math.round((baseByKind[job.kind] ?? 75_000) * modelMultiplier);
}

function estimatedProgressFromElapsed(elapsedMs: number, estimatedDurationMs: number) {
  const ratio = Math.min(1, Math.max(0, elapsedMs / estimatedDurationMs));
  // Ease out toward 86%; final save/completion remains controlled by job status.
  return Math.round(8 + (1 - Math.pow(1 - ratio, 1.7)) * 78);
}

const MODEL_STORAGE_KEY = "anbud-openai-model";
const PREFERRED_MODEL_ORDER = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.2",
  "gpt-5.2-pro",
];
const MODEL_HELP_TEXT: Record<string, string> = {
  "gpt-5.5": "Best balanse for komplekse tilbud: høy intelligens, god kvalitet, høyere kostnad.",
  "gpt-5.5-pro": "Tyngste valg for kritiske leveranser: maksimal resonnering og kvalitet, tregest og dyrest.",
  "gpt-5.4": "Sterkt standardvalg: høy kvalitet med bedre fart og kostnad enn pro-modellene.",
  "gpt-5.4-mini": "Raskere og rimeligere: godt for utkast, omskriving og enklere analyser.",
  "gpt-5.4-nano": "Raskest og billigst: best for korte oppgaver, lavere presisjon på kompleks strategi.",
  "gpt-5.2": "Stabilt kvalitetsvalg: god intelligens og forutsigbarhet, men eldre enn 5.4/5.5.",
  "gpt-5.2-pro": "Sterk eldre pro-modell: bra på krevende resonnement, ofte tregere og dyrere enn standard.",
};

type OpenAIModelSummary = {
  id: string;
  created: number | null;
  owned_by: string | null;
};

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

function pickDefaultModel(
  models: OpenAIModelSummary[],
  preferredModel?: string,
) {
  const modelIds = new Set(models.map((model) => model.id));
  if (preferredModel && modelIds.has(preferredModel)) {
    return preferredModel;
  }

  return (
    PREFERRED_MODEL_ORDER.find((modelId) => modelIds.has(modelId)) ??
    models.find((model) => /^gpt-/i.test(model.id))?.id ??
    models[0]?.id ??
    ""
  );
}

function modelHelpText(modelId: string) {
  return MODEL_HELP_TEXT[modelId] ?? "Velg modell ut fra behov for kvalitet, fart og kostnad.";
}

export function ProjectWorkspacePage({
  initialData,
  initialTab = "analysis",
}: {
  initialData: ProjectDetail;
  initialTab?: ProjectWorkspaceTab;
}) {
  const DEFAULT_SIDEBAR_WIDTH = 240;
  const MIN_SIDEBAR_WIDTH = 236;
  const MAX_SIDEBAR_WIDTH = 440;
  const router = useRouter();
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
  const [artifactInstructions, setArtifactInstructions] = useState("");
  const [selectedRequirementDocumentId, setSelectedRequirementDocumentId] =
    useState("");
  const [activeTab, setActiveTab] = useState<ProjectWorkspaceTab>(initialTab);
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
  const [availableModels, setAvailableModels] = useState<OpenAIModelSummary[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const progressIntervalRef = useRef<number | null>(null);
  const modelsRequestRef = useRef<Promise<void> | null>(null);
  const sidebarResizeRef = useRef(false);

  useEffect(() => {
    const tabFromUrl = searchParams.get("tab");
    setActiveTab(isProjectWorkspaceTab(tabFromUrl) ? tabFromUrl : "analysis");
  }, [searchParams]);

  const setWorkspaceTab = useCallback(
    (tab: ProjectWorkspaceTab) => {
      setActiveTab(tab);
      const nextParams = new URLSearchParams(searchParams.toString());
      if (tab === "analysis") {
        nextParams.delete("tab");
      } else {
        nextParams.set("tab", tab);
      }
      const query = nextParams.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const activeJobAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
    if (storedModel) {
      setSelectedModel(storedModel);
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    if (availableModels.length) return;
    if (modelsRequestRef.current) {
      await modelsRequestRef.current;
      return;
    }

    const request = (async () => {
      setModelsLoading(true);
      try {
        const response = await fetch("/api/openai-models", { cache: "no-store" });
        const payload = await readJsonPayload<{
          models?: OpenAIModelSummary[];
          default_model?: string;
        }>(response, "Kunne ikke hente modeller.");
        const models = payload.models ?? [];
        const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
        setAvailableModels(models);
        setSelectedModel((current) => {
          const currentIsValid =
            Boolean(current) && models.some((model) => model.id === current);
          const storedIsValid =
            Boolean(storedModel) &&
            models.some((model) => model.id === storedModel);
          const next =
            (currentIsValid ? current : "") ||
            (storedIsValid ? storedModel : "") ||
            pickDefaultModel(models, payload.default_model);
          if (next) {
            window.localStorage.setItem(MODEL_STORAGE_KEY, next);
          }
          return next;
        });
      } catch {
        setAvailableModels([]);
      } finally {
        setModelsLoading(false);
        modelsRequestRef.current = null;
      }
    })();
    modelsRequestRef.current = request;
    await request;
  }, [availableModels.length]);

  const aiModelHeaders = useCallback((): Record<string, string> => {
    return selectedModel ? { "X-OpenAI-Model": selectedModel } : {};
  }, [selectedModel]);

  const onModelChange = useCallback((value: string) => {
    setSelectedModel(value);
    if (value) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  }, []);

  const loadSidebarServiceDescriptions = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${project.id}/service-descriptions`,
        { cache: "no-store" },
      );
      const payload = await readJsonPayload<{
        services?: ProjectServiceDescription[];
        error?: string;
      }>(response, "Kunne ikke hente tjenestebeskrivelser.");
      if (!response.ok || !payload.services) {
        throw new Error(payload.error || "Kunne ikke hente tjenestebeskrivelser.");
      }
      setServiceDescriptions(payload.services);
    } catch {
      setServiceDescriptions([]);
    }
  }, [project.id]);

  useEffect(() => {
    void loadSidebarServiceDescriptions();
    const onServicesUpdated = () => void loadSidebarServiceDescriptions();
    window.addEventListener("project-services-updated", onServicesUpdated);
    return () => {
      window.removeEventListener("project-services-updated", onServicesUpdated);
    };
  }, [loadSidebarServiceDescriptions]);

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
    setBusyProgress(0);
  }

  function startProgressTicker(messages: string[]) {
    stopProgressTicker();
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
    const startedAt = Date.now();
    const estimatedDuration = estimatedJobDurationMs(job, selectedModel);
    setBusyProgress((current) => Math.max(current, progressForJobStatus(job)));
    progressIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const estimatedProgress = estimatedProgressFromElapsed(
        elapsed,
        estimatedDuration,
      );
      setBusyProgress((current) => Math.min(86, Math.max(current, estimatedProgress)));
    }, 1200);
  }

  useEffect(() => stopProgressTicker, []);

  useEffect(() => {
    return () => {
      activeJobAbortRef.current?.abort();
    };
  }, []);

  async function waitForProjectJob(
    jobId: string,
    failedFallbackMessage: string,
    initialJob?: ProjectJobRecord,
  ) {
    activeJobAbortRef.current?.abort();
    const controller = new AbortController();
    activeJobAbortRef.current = controller;
    if (initialJob) {
      startEstimatedProgress(initialJob);
    }

    try {
      const job = await pollProjectJob({
        projectId: project.id,
        jobId,
        onStatus(jobStatus) {
          setBusyMessage(progressMessageLabel(jobStatus.message));
          const nextProgress = progressForJobStatus(jobStatus);
          if (hasExplicitProgress(jobStatus.message)) {
            if (progressIntervalRef.current) {
              window.clearInterval(progressIntervalRef.current);
              progressIntervalRef.current = null;
            }
            setBusyProgress(nextProgress);
          } else {
            setBusyProgress((current) => Math.max(current, nextProgress));
          }
        },
        signal: controller.signal,
      });

      if (job.status === "failed") {
        throw new Error(job.error || failedFallbackMessage);
      }

      return job;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Jobben ble avbrutt.");
      }
      throw error;
    } finally {
      if (activeJobAbortRef.current === controller) {
        activeJobAbortRef.current = null;
      }
    }
  }

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
    fetch(`/api/projects/${project.id}/customer-analysis`)
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
    fetch(`/api/projects/${project.id}/solution-evaluation`)
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
    fetch(`/api/projects/${project.id}/executive-summary`)
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
      setBusyProgress(100);
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
      formData.append("role", uploadRole);
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
      setUploadRole("supporting_document");
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
    let uploadedDocument: ProjectDocument | null = null;
    let uploadedDocumentId = "";

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
      uploadedDocument = payload.document;
      uploadedDocumentId = payload.document.id;
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

    if (uploadedDocumentId) {
      setSelectedRequirementDocumentId(uploadedDocumentId);
    }

    return uploadedDocument as ProjectDocument | null;
  }

  async function onUpdateRequirementArtifact(
    artifact: GeneratedArtifact,
    value: { title: string; content_markdown: string },
  ) {
    setError("");
    setNotice("");
    setBusy(`update-artifact-${artifact.id}`);
    try {
      const response = await fetch(`/api/projects/${project.id}/generate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...aiModelHeaders() },
        body: JSON.stringify({
          artifact_id: artifact.id,
          title: value.title,
          content_markdown: value.content_markdown,
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
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              generated_artifacts: current.generated_artifacts.map((item) =>
                item.id === payload.artifact!.id ? payload.artifact! : item,
              ),
            },
            payload.project!,
          ),
        ),
      );
      setNotice("Kravbesvarelsen er oppdatert.");
    } catch (err) {
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
    try {
      const response = await fetch(`/api/projects/${project.id}/generate`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...aiModelHeaders() },
        body: JSON.stringify({ artifact_id: artifact.id }),
      });
      const payload = await readJsonPayload<{
        error?: string;
        project?: ProjectSnapshotPayload;
      }>(response, "Kunne ikke slette artefakten.");
      if (!response.ok || !payload.project) {
        throw new Error(payload.error || "Kunne ikke slette artefakten.");
      }
      setProject((current) =>
        normalizeProjectState(
          patchProjectWithSnapshot(
            {
              ...current,
              generated_artifacts: current.generated_artifacts.filter(
                (item) => item.id !== artifact.id,
              ),
            },
            payload.project!,
          ),
        ),
      );
      setNotice("Artefakten er slettet.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noe gikk galt.");
      throw err;
    } finally {
      setBusy(null);
    }
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
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({ kind: "customer_analysis" }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte kundeanalysen.");
        if (!response.ok || !payload.job) {
          throw new Error(payload.error || "Kunne ikke starte kundeanalysen.");
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Kundeanalysen feilet.",
          payload.job,
        );
        const result = completedJob.result as {
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
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "high_level_design",
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error ||
              "Kunne ikke starte jobben for overordnet løsningsdesign.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Jobben for overordnet løsningsdesign feilet.",
          payload.job,
        );
        const result = completedJob.result as {
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
          "Overordnet løsningsdesign og arkitekturdiagram er oppdatert uten å redigere hele kundeanalysen.",
        );
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
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
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
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "losningsutkast",
            instructions: artifactInstructions,
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte generatorjobben.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Generatorjobben feilet.",
          payload.job,
        );
        const result = completedJob.result as {
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
                generated_artifacts: prependGeneratedArtifact(
                  current.generated_artifacts,
                  result.artifact,
                ),
                artifact_count: current.artifact_count + 1,
              },
              result.project,
            ),
	          ),
	        );
	        setArtifactsLoaded(true);
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
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "gjennomforing_og_risiko",
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for fremdriftsplan.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Jobben for fremdriftsplanen feilet.",
          payload.job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
	        setProject((current) =>
	          normalizeProjectState(
            patchProjectWithSnapshot(
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
	          ),
	        );
	        setArtifactsLoaded(true);
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
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "bilag1_rekonstruksjon",
            instructions,
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for Bilag 1.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Jobben for Bilag 1 feilet.",
          payload.job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
	        setProject((current) =>
	          normalizeProjectState(
            patchProjectWithSnapshot(
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
	          ),
	        );
	        setArtifactsLoaded(true);
	      },
      ["Starter jobben for Bilag 1 ..."],
    );
  }

  async function onGenerateRequirementResponse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      "requirement-response",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "artifact_generation",
            artifact_type: "forbedret_kravsvar",
            source_document_ids: selectedRequirementDocumentId
              ? [selectedRequirementDocumentId]
              : [],
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte jobben for kravbesvarelse.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Jobben for kravbesvarelse feilet.",
          payload.job,
        );
        const result = completedJob.result as {
          artifact: GeneratedArtifact;
          project: ProjectSnapshotPayload;
        };
	        setProject((current) =>
	          normalizeProjectState(
            patchProjectWithSnapshot(
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
	          ),
	        );
	        setArtifactsLoaded(true);
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
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({
            kind: "solution_evaluation",
            allow_generated_solution: false,
            solution_document_id: solutionDocumentId,
          }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte jobben.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte løsningsvurderingen.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Løsningsvurderingen feilet.",
          payload.job,
        );
        const result = completedJob.result as {
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
      },
      ["Starter sammenligning av systemløsning og arkitektløsning ..."],
    );
  }

  async function onGenerateExecutiveSummary() {
    await runAction(
      "executive-summary",
      async () => {
        const response = await fetch(`/api/projects/${project.id}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...aiModelHeaders() },
          body: JSON.stringify({ kind: "executive_summary" }),
        });
        const payload = await readJsonPayload<{
          error?: string;
          job?: ProjectJobRecord;
        }>(response, "Kunne ikke starte lederoppsummeringen.");
        if (!response.ok || !payload.job) {
          throw new Error(
            payload.error || "Kunne ikke starte lederoppsummeringen.",
          );
        }
        setBusyMessage(payload.job.message);
        const completedJob = await waitForProjectJob(
          payload.job.id,
          "Lederoppsummeringen feilet.",
          payload.job,
        );
        const result = completedJob.result as {
          executive_summary: ExecutiveSummaryResult;
          project: ProjectSnapshotPayload;
        };
        setProject((current) =>
          normalizeProjectState(
            patchProjectWithSnapshot(
              {
                ...current,
                executive_summary: result.executive_summary,
              },
              result.project,
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
  const workspaceNavGroups: Array<{
    label: string;
    items: WorkspaceNavItem[];
  }> = [
    {
      label: "Grunnlag",
      items: [
        { value: "documents", label: "Dokumenter", icon: FolderOpen },
        { value: "service-description", label: "Tjenestebeskrivelse", icon: Wrench },
      ],
    },
    {
      label: "Analyse",
      items: [
        { value: "analysis", label: "Kundeanalyse", icon: Brain },
        { value: "requirements", label: "Kravbesvarelse", icon: FileCheck2 },
      ],
    },
    {
      label: "Produksjon",
      items: [
        { value: "bilag1", label: "Bilag 1", icon: FileText },
        {
          value: "generator",
          label: "Løsningsbeskrivelse",
          icon: Sparkles,
        },
        { value: "delivery", label: "Fremdriftsplan", icon: ArrowRight },
      ],
    },
    {
      label: "Kvalitet",
      items: [
        { value: "evaluation", label: "Vurdering", icon: Scale },
        { value: "executive-summary", label: "Leder oppsummering", icon: ClipboardCheck },
      ],
    },
  ];
  const workspaceNavItems = workspaceNavGroups.flatMap((group) => group.items);
  const projectMonogram = project.name.trim().charAt(0).toUpperCase() || "A";
  const projectStatus = deriveProjectStatus(project);
  const readinessItems = [
    {
      label: "Grunnlag",
      done: project.documents.length > 0,
      value: `${project.documents.length} dok.`,
    },
    {
      label: "Analyse",
      done: project.customer_analysis_generated,
      value: completionLabel(project.customer_analysis_generated),
    },
    {
      label: "Utkast",
      done: project.generated_artifacts.length > 0,
      value: `${project.generated_artifacts.length} stk.`,
    },
    {
      label: "Vurdering",
      done: project.solution_evaluation_generated,
      value: completionLabel(project.solution_evaluation_generated),
    },
  ];
  const showModelSelector =
    activeTab === "analysis" ||
    activeTab === "bilag1" ||
    activeTab === "requirements" ||
    activeTab === "generator" ||
    activeTab === "evaluation" ||
    activeTab === "delivery" ||
    activeTab === "executive-summary";

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
              "border-b border-sidebar-border/70 bg-sidebar/95 p-3 backdrop-blur transition-[padding] duration-150 ease-out",
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
              "min-h-0 flex-1 p-2 transition-[padding] duration-150 ease-out",
              !sidebarOpen && "px-1.5",
            )}
          >
            {workspaceNavGroups.map((group) => (
              <SidebarGroup
                key={group.label}
                className={cn("gap-2 px-3 py-2", !sidebarOpen && "px-0")}
              >
                {sidebarOpen ? (
                  <p className="px-3 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-sidebar-foreground/45">
                    {group.label}
                  </p>
                ) : null}
                <SidebarGroupContent>
                  <SidebarMenu
                    className={cn("gap-1", !sidebarOpen && "items-center")}
                  >
                    {group.items.map((item) => (
                      <SidebarMenuItem
                        key={item.value}
                        className={cn(!sidebarOpen && "flex justify-center")}
                      >
                        <SidebarMenuButton
                          isActive={activeTab === item.value}
                          size="lg"
                          tooltip={`${group.label}: ${item.label}`}
                          className={cn(
                            "h-10 rounded-lg px-3 text-[0.92rem] transition-colors duration-150 ease-out",
                            !sidebarOpen &&
                              "mx-auto size-10 justify-center rounded-md px-0",
                          )}
                          onClick={() => setWorkspaceTab(item.value)}
                        >
                          <item.icon className="size-4.5" />
                          {sidebarOpen ? <span>{item.label}</span> : null}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter
            className={cn(
              "border-t border-sidebar-border/70 bg-sidebar/95 p-3 backdrop-blur transition-[padding] duration-150 ease-out",
              !sidebarOpen && "px-1.5 py-2",
            )}
          >
            <SidebarMenu className={cn(!sidebarOpen && "items-center")}>
              <SidebarMenuItem
                className={cn(!sidebarOpen && "flex justify-center")}
              >
                <SidebarMenuButton
                  render={
                    <Link
                      href="/"
                      prefetch
                      onClick={markNextHomeNavigationWithoutAnimation}
                    />
                  }
                  size="lg"
                  tooltip="Alle prosjekter"
                  className={cn(
                    "h-11 rounded-lg px-3 text-[0.95rem] transition-colors duration-150 ease-out",
                    !sidebarOpen &&
                      "mx-auto size-10 justify-center rounded-md px-0",
                  )}
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
                {showModelSelector ? (
                  <div className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm sm:w-[21rem]">
                    <label
                      htmlFor="workspace-ai-model"
                      className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-500"
                    >
                      Modell
                    </label>
                    <select
                      id="workspace-ai-model"
                      value={selectedModel}
                      onChange={(event) => onModelChange(event.target.value)}
                      onFocus={() => void loadAvailableModels()}
                      onPointerDown={() => void loadAvailableModels()}
                      disabled={modelsLoading}
                      className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-sm font-semibold text-slate-950 outline-none transition-colors hover:bg-white focus-visible:border-primary disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      {selectedModel &&
                      !availableModels.some((model) => model.id === selectedModel) ? (
                        <option value={selectedModel}>{selectedModel}</option>
                      ) : null}
                      {modelsLoading ? (
                        <option value="">Henter modeller ...</option>
                      ) : null}
                      {!modelsLoading && !availableModels.length ? (
                        <option value="">Åpne for å hente modeller</option>
                      ) : null}
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                    {selectedModel ? (
                      <p className="mt-2 text-xs leading-relaxed text-slate-500">
                        {modelHelpText(selectedModel)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {readinessItems.map((item) => (
                  <div
                    key={item.label}
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm"
                  >
                    {item.done ? (
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <CircleDashed className="size-4 shrink-0 text-slate-400" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-[0.68rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                        {item.label}
                      </p>
                      <p className="truncate text-sm font-semibold text-slate-950">
                        {item.value}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${projectStatus === "Venter på dokument" ? "border-slate-200 bg-white text-slate-600" : "border-blue-200 bg-blue-50 text-blue-800"}`}>
                  {projectStatus}
                </span>
                <span>{workspaceActionForProject(project)}</span>
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
              <div className="mb-3">
                <GenerationProgress
                  message={busyMessage}
                  progress={busyProgress}
                />
              </div>
            ) : null}

            {activeTab === "documents" ? (
              <ProjectDocumentsTab
                projectId={project.id}
                documents={project.documents}
                services={serviceDescriptions}
                uploadOpen={uploadOpen}
                onToggleUploadOpen={() => setUploadOpen((open) => !open)}
                docTitle={docTitle}
                onDocTitleChange={setDocTitle}
                uploadRole={uploadRole}
                onUploadRoleChange={setUploadRole}
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
                  busyProgress={busyProgress}
                  onGenerate={onGenerateCustomerAnalysis}
                  onSaveAnalysis={onSaveAnalysis}
                  uploadOpen={uploadOpen}
                  onToggleUploadOpen={() => setUploadOpen((open) => !open)}
                  docTitle={docTitle}
                  onDocTitleChange={setDocTitle}
                  uploadRole={uploadRole}
                  onUploadRoleChange={setUploadRole}
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
                  busyProgress={busyProgress}
                  onGenerate={onGenerateSolutionEvaluation}
                />
              )
            ) : null}

            {activeTab === "bilag1" ? (
              <ProjectBilag1Tab
                documents={project.documents}
                artifacts={project.generated_artifacts.filter(
                  (artifact) =>
                    artifact.artifact_type === "bilag1_rekonstruksjon",
                )}
                busy={busy === "bilag1-artifact"}
                busyMessage={busy === "bilag1-artifact" ? busyMessage : ""}
                busyProgress={busyProgress}
                onDeleteArtifact={onDeleteArtifact}
                onSubmit={onGenerateBilag1Artifact}
              />
            ) : null}

            {activeTab === "delivery" ? (
              <ProjectDeliveryTab
                artifacts={project.generated_artifacts.filter(
                  (artifact) =>
                    artifact.artifact_type === "gjennomforing_og_risiko",
                )}
                busy={busy === "delivery-artifact"}
                busyMessage={busy === "delivery-artifact" ? busyMessage : ""}
                busyProgress={busyProgress}
                hasCustomerAnalysis={Boolean(customerAnalysis)}
                onDeleteArtifact={onDeleteArtifact}
                onSubmit={onGenerateDeliveryArtifact}
              />
            ) : null}

            {activeTab === "service-description" ? (
              <ProjectServiceDescriptionTab
                projectId={project.id}
              />
            ) : null}

            {activeTab === "requirements" ? (
              <ProjectRequirementResponseTab
                projectId={project.id}
                documents={project.documents}
                artifacts={project.generated_artifacts.filter(
                  (artifact) => artifact.artifact_type === "forbedret_kravsvar",
                )}
                uploadBusy={busy === "upload-requirement-document"}
                generateBusy={busy === "requirement-response"}
                busyMessage={
                  busy === "requirement-response" ? busyMessage : ""
                }
                busyProgress={busyProgress}
                deletingDocumentId={
                  busy?.startsWith("delete-")
                    ? busy.slice("delete-".length)
                    : null
                }
                onUpload={onUploadRequirementDocument}
                selectedDocumentId={selectedRequirementDocumentId}
                onSelectedDocumentChange={setSelectedRequirementDocumentId}
                onDeleteDocument={onDeleteDocument}
                onUpdateArtifact={onUpdateRequirementArtifact}
                onDeleteArtifact={onDeleteArtifact}
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
                  busyProgress={busyProgress}
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
                busyProgress={busyProgress}
                onArtifactInstructionsChange={setArtifactInstructions}
                onDeleteArtifact={onDeleteArtifact}
                onSubmit={onGenerateArtifact}
              />
            ) : null}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
