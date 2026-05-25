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
  useTransition,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  Brain,
  ChevronDown,
  ClipboardCheck,
  Download,
  FileCheck2,
  FileText,
  FolderOpen,
  LayoutGrid,
  MessageSquareText,
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
  fetchOpenAIModels,
  fetchProjectServices,
  fetchSolutionEvaluation,
  markClientPerformance,
  saveCustomerAnalysisSection,
  startProjectJob,
  updateGeneratedArtifact,
  uploadProjectDocument,
  type OpenAIModelSummary,
  type ProjectSnapshotPayload,
} from "@/lib/client/project-api";
import { Spinner } from "@/components/ui/spinner";
import { useProjectJobRunner } from "@/hooks/use-project-job-runner";
import { useProjectWorkspacePrefetch } from "@/hooks/use-project-workspace-prefetch";
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
    ssr: false,
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
                  {service.recommended ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-bold text-amber-900">
                        Anbefalt
                      </span>
                    </div>
                  ) : null}
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
  "clarifications",
  "design",
  "risks",
  "needs",
  "keywords",
  "value",
];

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

const MODEL_STORAGE_KEY = "anbud-openai-model";
const CHAT_ARTIFACT_SEED_STORAGE_KEY_PREFIX = "anbud-chat-artifact-seed";
const DEFAULT_WORKSPACE_MODEL = "gpt-5.4";
const FAST_WORKSPACE_MODEL = "gpt-5.4-mini";
const PREFERRED_MODEL_ORDER = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
  "gpt-5-mini",
];
const MODEL_HELP_TEXT: Record<string, string> = {
  "gpt-5-mini": "Rask standard for produksjon: lavere ventetid og kostnad for generering.",
  "gpt-5.5": "Best balanse for komplekse tilbud: høy intelligens, god kvalitet, høyere kostnad.",
  "gpt-5.5-pro": "Tyngste valg for kritiske leveranser: maksimal resonnering og kvalitet, tregest og dyrest.",
  "gpt-5.4": "Sterkt standardvalg: høy kvalitet med bedre fart og kostnad enn pro-modellene.",
  "gpt-5.4-mini": "Raskere og rimeligere: godt for utkast, omskriving og enklere analyser.",
  "gpt-5.4-nano": "Raskest og billigst: best for korte oppgaver, lavere presisjon på kompleks strategi.",
  "gpt-5.2": "Stabilt kvalitetsvalg: god intelligens og forutsigbarhet, men eldre enn 5.4/5.5.",
  "gpt-5.2-pro": "Sterk eldre pro-modell: bra på krevende resonnement, ofte tregere og dyrere enn standard.",
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

function isSlowOrExpensiveModel(modelId: string) {
  return /\bpro\b|5\.5/i.test(modelId);
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
  const [isTabPending, startTabTransition] = useTransition();
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
  const [selectedModel, setSelectedModel] = useState(DEFAULT_WORKSPACE_MODEL);
  const [modelsLoading, setModelsLoading] = useState(false);
  const progressIntervalRef = useRef<number | null>(null);
  const progressDriverRef = useRef<ProgressDriverState | null>(null);
  const modelsRequestRef = useRef<Promise<void> | null>(null);
  const sidebarResizeRef = useRef(false);
  const preloadWorkspaceTab = useProjectWorkspacePrefetch({
    projectId: project.id,
    customerAnalysisGenerated: project.customer_analysis_generated,
    solutionEvaluationGenerated: project.solution_evaluation_generated,
    artifactCount: project.artifact_count,
    analysisLoaded,
    evaluationLoaded,
    executiveSummaryLoaded,
    artifactsLoaded,
  });

  useEffect(() => {
    const tabFromUrl = searchParams.get("tab");
    setActiveTab(isProjectWorkspaceTab(tabFromUrl) ? tabFromUrl : "analysis");
  }, [searchParams]);

  useEffect(() => {
    const key = `${CHAT_ARTIFACT_SEED_STORAGE_KEY_PREFIX}:${project.id}`;
    const seed = window.localStorage.getItem(key);
    if (!seed?.trim()) {
      return;
    }

    setArtifactInstructions((current) =>
      current.trim() ? current : seed.trim(),
    );
    window.localStorage.removeItem(key);
    setNotice("Sparringen er lagt inn som føring for neste generering.");
  }, [project.id]);

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
      router.prefetch(nextHref);
      router.push(nextHref, { scroll: false });
    },
    [activeTab, pathname, preloadWorkspaceTab, project.id, router, searchParams],
  );
  useEffect(() => {
    const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
    if (!storedModel || isSlowOrExpensiveModel(storedModel)) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, DEFAULT_WORKSPACE_MODEL);
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
        const payload = await fetchOpenAIModels();
        const models = payload.models ?? [];
        const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
        setAvailableModels(models);
        setSelectedModel((current) => {
          const currentIsValid =
            Boolean(current) && models.some((model) => model.id === current);
          const storedIsValid =
            Boolean(storedModel) &&
            !isSlowOrExpensiveModel(storedModel) &&
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

  useEffect(() => {
    void loadAvailableModels();
  }, [loadAvailableModels]);

  const aiModelHeaders = useCallback(
    (mode: "quality" | "fast" = "quality"): Record<string, string> => {
      const model = mode === "fast" ? FAST_WORKSPACE_MODEL : selectedModel;
      return model ? { "X-OpenAI-Model": model } : {};
    },
    [selectedModel],
  );

  const onModelChange = useCallback((value: string) => {
    const normalizedValue = isSlowOrExpensiveModel(value)
      ? pickDefaultModel(availableModels, "")
      : value;
    setSelectedModel(normalizedValue);
    if (normalizedValue) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, normalizedValue);
    } else {
      window.localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  }, [availableModels]);

  const loadSidebarServiceDescriptions = useCallback(async () => {
    const cacheKey = projectServicesCacheKey(project.id);
    const cached = getClientCache<ProjectServiceDescription[]>(cacheKey);
    if (cached) {
      setServiceDescriptions(cached);
      return;
    }

    try {
      const services = await fetchProjectServices(project.id);
      setServiceDescriptions(services);
      setClientCache(cacheKey, services, PROJECT_SERVICES_CACHE_TTL_MS);
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
      estimatedDurationMs: estimatedJobDurationMs(job, selectedModel),
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
                hasExplicitProgress(jobStatus.message)
                  ? Math.max(current, nextProgress)
                  : Math.max(current, nextProgress),
              ),
            ),
      );
    },
  });

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
    fetchCustomerAnalysis(project.id)
      .then((analysis) => {
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            customer_analysis: analysis,
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
    fetchSolutionEvaluation(project.id)
      .then((evaluation) => {
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            solution_evaluation: evaluation,
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
    fetchExecutiveSummary(project.id)
      .then((executiveSummary) => {
        if (!cancelled) {
          setProject((current) => ({
            ...current,
            executive_summary: executiveSummary,
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
	        activeTab !== "requirements" &&
	        activeTab !== "bilag1") ||
	      artifactsLoaded ||
	      project.artifact_count === 0
	    )
      return;
    let cancelled = false;
    fetchGeneratedArtifacts(project.id)
      .then((artifacts) => {
        if (!cancelled) {
          setProject((current) =>
            normalizeProjectState({
              ...current,
              generated_artifacts: artifacts,
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
      const payload = await uploadProjectDocument({
        projectId: project.id,
        formData,
        fallbackMessage: "Kunne ikke laste opp dokumentet.",
      });
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

  async function onUploadRequirementDocument(file: File) {
    let uploadedDocument: ProjectDocument | null = null;
    let uploadedDocumentId = "";

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
    const previousProject = project;
    const optimisticArtifact: GeneratedArtifact = {
      ...artifact,
      title: value.title,
      content_markdown: value.content_markdown,
    };
    setProject((current) =>
      normalizeProjectState({
        ...current,
        generated_artifacts: current.generated_artifacts.map((item) =>
          item.id === artifact.id ? optimisticArtifact : item,
        ),
      }),
    );
    try {
      const payload = await updateGeneratedArtifact({
        projectId: project.id,
        artifactId: artifact.id,
        title: value.title,
        contentMarkdown: value.content_markdown,
        headers: aiModelHeaders(),
      });
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
      normalizeProjectState({
        ...current,
        generated_artifacts: current.generated_artifacts.filter(
          (item) => item.id !== artifact.id,
        ),
      }),
    );
    try {
      const payload = await deleteGeneratedArtifact({
        projectId: project.id,
        artifactId: artifact.id,
        headers: aiModelHeaders(),
      });
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
      setProject(previousProject);
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
            preserveArtifactCount: !artifactsLoaded,
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

  function startWorkspaceJob(body: unknown, fallbackMessage: string) {
    const kind =
      body && typeof body === "object" && "kind" in body
        ? (body as { kind?: string }).kind
        : "";
    const modelMode = kind === "executive_summary" ? "fast" : "quality";
    return startProjectJob({
      projectId: project.id,
      body,
      headers: aiModelHeaders(modelMode),
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

  async function onSaveAnalysis(
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
  ) {
    await runAction("save-analysis", async () => {
      const payload = await saveCustomerAnalysisSection({
        projectId: project.id,
        section,
        snapshot,
        headers: aiModelHeaders(),
      });
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
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "losningsutkast",
            instructions: artifactInstructions,
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
        const job = await startWorkspaceJob(
          {
            kind: "artifact_generation",
            artifact_type: "forbedret_kravsvar",
            source_document_ids: selectedRequirementDocumentId
              ? [selectedRequirementDocumentId]
              : [],
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
        const job = await startWorkspaceJob(
          {
            kind: "solution_evaluation",
            allow_generated_solution: false,
            solution_document_id: solutionDocumentId,
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
                          onFocus={() => preloadWorkspaceTab(item.value)}
                          onPointerEnter={() => preloadWorkspaceTab(item.value)}
                          onPointerDown={() => preloadWorkspaceTab(item.value)}
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
                    <a
                      href={`/projects/${project.id}/chat`}
                      target={`bidsite-project-chat-${project.id}`}
                      rel="noopener noreferrer"
                      onClick={openChatPopout}
                    />
                  }
                  size="lg"
                  tooltip="Åpne sparring i pop-out vindu"
                  className={cn(
                    "h-11 rounded-lg px-3 text-[0.95rem] transition-colors duration-150 ease-out",
                    !sidebarOpen &&
                      "mx-auto size-10 justify-center rounded-md px-0",
                  )}
                >
                  <MessageSquareText className="size-4.5" />
                  {sidebarOpen ? <span>Sparring</span> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
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
                  <div className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-2.5 shadow-sm shadow-slate-200/70 sm:w-[16rem]">
                    <label
                      htmlFor="workspace-ai-model"
                      className="text-[0.58rem] font-bold uppercase tracking-[0.14em] text-slate-500"
                    >
                      Modell
                    </label>
                    <div
                      className="relative mt-1.5"
                      aria-busy={modelsLoading ? "true" : undefined}
                    >
                      <select
                        id="workspace-ai-model"
                        value={selectedModel}
                        onChange={(event) => onModelChange(event.target.value)}
                        onFocus={() => void loadAvailableModels()}
                        onPointerDown={() => void loadAvailableModels()}
                        className="h-8 w-full appearance-none rounded-md border border-slate-200 bg-slate-50 px-2.5 pr-8 text-[0.82rem] font-bold text-slate-950 outline-none transition-colors hover:bg-white focus-visible:border-primary focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-primary/15"
                      >
                        {selectedModel &&
                        !availableModels.some((model) => model.id === selectedModel) ? (
                          <option value={selectedModel}>{selectedModel}</option>
                        ) : null}
                        {availableModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.id}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-slate-950"
                      />
                    </div>
                    {selectedModel ? (
                      <p className="mt-2 text-[0.68rem] leading-4 text-slate-500">
                        {modelHelpText(selectedModel)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
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

            <div
              className={cn(
                "transition-[opacity,transform] duration-150 ease-out",
                isTabPending
                  ? "translate-y-1 opacity-80"
                  : "translate-y-0 opacity-100",
              )}
              aria-busy={isTabPending ? "true" : undefined}
            >
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
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
