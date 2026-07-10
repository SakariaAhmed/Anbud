"use client";

import dynamic from "next/dynamic";
import type {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, MessageSquareText } from "lucide-react";

import {
  formatDate,
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import type {
  ProjectWorkspaceTab,
  WorkflowStepItem,
  WorkflowStepStatus,
  WorkspaceNavItem,
} from "@/components/projects/project-workspace-types";
import { Spinner } from "@/components/ui/spinner";
import {
  Sidebar,
  SidebarContent,
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
  SolutionEvaluationResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";

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

const ProjectDocumentsTab = dynamic(
  () =>
    import("@/components/projects/project-documents-tab").then(
      (module) => module.ProjectDocumentsTab,
    ),
  {
    loading: () => (
      <div className="rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground">
        Laster dokumenter ...
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

const WORKFLOW_SIDEBAR_STATUS_STYLES: Record<WorkflowStepStatus, string> = {
  "Ikke startet": "border-slate-200 bg-slate-50 text-slate-600",
  Venter: "border-amber-200 bg-amber-50 text-amber-800",
  Klar: "border-sky-200 bg-sky-50 text-sky-700",
  Generert: "border-emerald-200 bg-emerald-50 text-emerald-800",
  "Må sjekkes": "border-orange-200 bg-orange-50 text-orange-800",
  Ferdig: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

export type SecondaryNavGroup = {
  label: string;
  items: WorkspaceNavItem[];
};

type ProjectWorkspaceShellProps = {
  project: ProjectDetail;
  activeTab: ProjectWorkspaceTab;
  activeTabLabel: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  isTabPending: boolean;
  primaryWorkflowSteps: WorkflowStepItem[];
  secondaryNavGroups: SecondaryNavGroup[];
  error: string;
  notice: string;
  busy: string | null;
  busyMessage: string;
  busyProgress: number;
  onSidebarOpenChange: (open: boolean) => void;
  onSidebarResizeStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPreloadWorkspaceTab: (tab: ProjectWorkspaceTab) => void;
  onSetWorkspaceTab: (tab: ProjectWorkspaceTab) => void;
  onOpenChatPopout: () => Window | null;
  children: ReactNode;
};

type ProjectWorkspaceSidebarProps = Pick<
  ProjectWorkspaceShellProps,
  | "project"
  | "activeTab"
  | "sidebarOpen"
  | "primaryWorkflowSteps"
  | "secondaryNavGroups"
  | "onSidebarResizeStart"
  | "onPreloadWorkspaceTab"
  | "onSetWorkspaceTab"
  | "onOpenChatPopout"
>;

type WorkspaceHeaderProps = {
  project: ProjectDetail;
  activeTabLabel: string;
};

type WorkspaceStatusMessagesProps = {
  error: string;
  notice: string;
  busy: string | null;
  busyMessage: string;
  busyProgress: number;
};

export type ProjectWorkspaceTabContentProps = {
  activeTab: ProjectWorkspaceTab;
  project: ProjectDetail;
  serviceDescriptions: ProjectServiceDescription[];
  architectureDocumentCandidates: ProjectDocument[];
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  executiveSummary: ExecutiveSummaryResult | null;
  analysisLoaded: boolean;
  analysisLoading: boolean;
  evaluationLoaded: boolean;
  evaluationLoading: boolean;
  executiveSummaryLoaded: boolean;
  executiveSummaryLoading: boolean;
  busy: string | null;
  busyMessage: string;
  busyProgress: number;
  analysisSectionBusy: CustomerAnalysisSection | null;
  uploadOpen: boolean;
  docTitle: string;
  uploadRole: ProjectDocumentRole;
  selectedDocumentName: string;
  documentFileInputKey: number;
  selectedRequirementDocumentId: string;
  requirementArtifacts: GeneratedArtifact[];
  solutionDraftArtifacts: GeneratedArtifact[];
  deliveryArtifacts: GeneratedArtifact[];
  bilag1Artifacts: GeneratedArtifact[];
  onToggleUploadOpen: () => void;
  onDocTitleChange: (value: string) => void;
  onUploadRoleChange: (value: ProjectDocumentRole) => void;
  onFileChange: (file: File | null) => void;
  onUploadDocument: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onGenerateCustomerAnalysis: () => Promise<void>;
  onSaveAnalysis: (
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
  ) => Promise<void>;
  onGenerateSolutionEvaluation: (
    solutionDocumentId?: string,
  ) => Promise<void>;
  onUploadArchitectureDocument: (file: File) => Promise<ProjectDocument | null>;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onGenerateBilag1Artifact: (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  onGenerateDeliveryArtifact: (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  onUploadRequirementDocument: (file: File) => Promise<ProjectDocument | null>;
  onSelectedRequirementDocumentChange: (documentId: string) => void;
  onUpdateRequirementArtifact: (
    artifact: GeneratedArtifact,
    value: { title: string; content_markdown: string },
  ) => Promise<void>;
  onGenerateRequirementResponse: (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  onGenerateExecutiveSummary: () => Promise<void>;
  onGenerateArtifact: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

export function ProjectWorkspaceShell({
  project,
  activeTab,
  activeTabLabel,
  sidebarOpen,
  sidebarWidth,
  isTabPending,
  primaryWorkflowSteps,
  secondaryNavGroups,
  error,
  notice,
  busy,
  busyMessage,
  busyProgress,
  onSidebarOpenChange,
  onSidebarResizeStart,
  onPreloadWorkspaceTab,
  onSetWorkspaceTab,
  onOpenChatPopout,
  children,
}: ProjectWorkspaceShellProps) {
  return (
    <div className="min-h-[calc(100dvh-var(--app-header-height))] w-full overflow-x-hidden">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={onSidebarOpenChange}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--sidebar-width-icon": "3.5rem",
            "--sidebar-offset-top": "var(--app-header-height)",
            "--sidebar-offset-bottom": "0px",
            "--sidebar": "rgb(255, 255, 255)",
            "--sidebar-foreground": "rgb(71, 85, 105)",
            "--sidebar-primary": "rgb(37, 99, 235)",
            "--sidebar-primary-foreground": "rgb(255, 255, 255)",
            "--sidebar-accent": "rgb(248, 250, 252)",
            "--sidebar-accent-foreground": "rgb(15, 23, 42)",
            "--sidebar-border": "rgb(226, 232, 240)",
            "--sidebar-ring": "rgb(37, 99, 235)",
          } as CSSProperties
        }
        className="min-h-[calc(100dvh-var(--app-header-height))] bg-slate-50/35 max-md:flex-col"
      >
        <ProjectWorkspaceSidebar
          project={project}
          activeTab={activeTab}
          sidebarOpen={sidebarOpen}
          primaryWorkflowSteps={primaryWorkflowSteps}
          secondaryNavGroups={secondaryNavGroups}
          onSidebarResizeStart={onSidebarResizeStart}
          onPreloadWorkspaceTab={onPreloadWorkspaceTab}
          onSetWorkspaceTab={onSetWorkspaceTab}
          onOpenChatPopout={onOpenChatPopout}
        />

        <SidebarInset className="min-w-0 overflow-x-hidden bg-transparent">
          <div
            className={cn(
              "relative w-full max-w-full overflow-x-hidden px-5 py-6 md:px-9 md:py-9",
              !sidebarOpen && "mx-auto",
            )}
          >
            <WorkspaceHeader project={project} activeTabLabel={activeTabLabel} />
            <WorkspaceStatusMessages
              error={error}
              notice={notice}
              busy={busy}
              busyMessage={busyMessage}
              busyProgress={busyProgress}
            />

            <div
              className={cn(
                "transition-[opacity,transform] duration-150 ease-out",
                isTabPending
                  ? "translate-y-1 opacity-80"
                  : "translate-y-0 opacity-100",
              )}
              aria-busy={isTabPending ? "true" : undefined}
            >
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function ProjectWorkspaceSidebar({
  project,
  activeTab,
  sidebarOpen,
  primaryWorkflowSteps,
  secondaryNavGroups,
  onSidebarResizeStart,
  onPreloadWorkspaceTab,
  onSetWorkspaceTab,
  onOpenChatPopout,
}: ProjectWorkspaceSidebarProps) {
  return (
    <Sidebar
      collapsible="icon"
      className="bg-white md:border-r md:border-slate-200"
    >
      <SidebarHeader
        className={cn(
          "flex min-h-20 flex-row items-center border-b border-slate-200 bg-white px-5 py-4 transition-[padding] duration-150 ease-out",
          sidebarOpen ? "justify-between gap-3" : "justify-center px-2",
        )}
      >
        {sidebarOpen ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[1.02rem] font-semibold leading-6 text-slate-950">
              {project.name}
            </p>
            {project.customer_name ? (
              <p className="mt-1 truncate text-[0.88rem] font-medium leading-5 text-slate-500">
                {project.customer_name}
              </p>
            ) : null}
          </div>
        ) : null}
        <SidebarTrigger
          aria-label={sidebarOpen ? "Kollaps sidemeny" : "Utvid sidemeny"}
          title={sidebarOpen ? "Kollaps sidemeny" : "Utvid sidemeny"}
          className="size-12 shrink-0 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-950"
        >
          {sidebarOpen ? (
            <ChevronLeft className="size-4.5" />
          ) : (
            <ChevronRight className="size-4.5" />
          )}
        </SidebarTrigger>
      </SidebarHeader>

      <SidebarContent
        className={cn(
          "min-h-0 flex-1 bg-white px-4 py-3 transition-[padding] duration-150 ease-out",
          !sidebarOpen && "px-1.5",
        )}
      >
        <SidebarGroup className={cn("gap-2 px-1 py-2.5", !sidebarOpen && "px-0")}>
          <SidebarGroupContent>
            <SidebarMenu className={cn("gap-2", !sidebarOpen && "items-center")}>
              {primaryWorkflowSteps.map((item) => (
                <SidebarMenuItem
                  key={item.value}
                  className={cn(!sidebarOpen && "flex justify-center")}
                >
                  <SidebarMenuButton
                    isActive={activeTab === item.value}
                    size="lg"
                    tooltip={`${item.step}. ${item.label}: ${item.status}`}
                    className={cn(
                      "relative h-auto min-h-[4.65rem] gap-3 overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-3 text-[0.94rem] font-medium text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-all duration-150 ease-out hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 data-active:border-slate-200 data-active:bg-blue-50/60 data-active:text-blue-950 data-active:shadow-[0_8px_22px_rgba(37,99,235,0.08)] data-active:before:absolute data-active:before:inset-y-0 data-active:before:left-0 data-active:before:w-0.5 data-active:before:bg-blue-600",
                      !sidebarOpen &&
                        "mx-auto size-10 min-h-10 justify-center rounded-md px-0 py-0",
                    )}
                    onPointerDown={() => onPreloadWorkspaceTab(item.value)}
                    onFocus={() => onPreloadWorkspaceTab(item.value)}
                    onClick={() => onSetWorkspaceTab(item.value)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-[0.86rem] font-semibold text-blue-600 shadow-sm group-data-active/menu-button:border-blue-200 group-data-active/menu-button:bg-white group-data-active/menu-button:text-blue-700">
                      {item.step}
                    </span>
                    {sidebarOpen ? (
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                          <span className="min-w-0 text-left leading-5">
                            {item.label}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-2 py-0.5 text-[0.68rem] font-bold leading-4",
                              WORKFLOW_SIDEBAR_STATUS_STYLES[item.status],
                            )}
                          >
                            {item.status}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-slate-400 transition-colors group-data-active/menu-button:text-slate-600" />
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {secondaryNavGroups.map((group) => (
          <SidebarGroup
            key={group.label}
            className={cn("gap-2 px-1 py-2.5", !sidebarOpen && "px-0")}
          >
            {sidebarOpen ? (
              <p className="px-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-slate-600">
                {group.label}
              </p>
            ) : null}
            <SidebarGroupContent>
              <SidebarMenu className={cn("gap-1.5", !sidebarOpen && "items-center")}>
                <SidebarMenuItem
                  className={cn(!sidebarOpen && "flex justify-center")}
                >
                  <SidebarMenuButton
                    render={
                      <a
                        href={`/projects/${project.id}/chat`}
                        target={`bidsite-project-chat-${project.id}`}
                        rel="noopener noreferrer"
                        onClick={onOpenChatPopout}
                      />
                    }
                    size="lg"
                    tooltip="Åpne AI Chat i pop-out vindu"
                    className={cn(
                      "h-11 gap-3 rounded-lg border border-transparent px-2 text-[0.94rem] font-medium text-slate-600 transition-colors duration-150 ease-out hover:bg-slate-50 hover:text-slate-950",
                      !sidebarOpen &&
                        "mx-auto size-10 justify-center rounded-md px-0",
                    )}
                  >
                    <MessageSquareText className="size-4.5 text-slate-500" />
                    {sidebarOpen ? <span>AI Chat</span> : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
                        "h-11 gap-3 rounded-lg border border-transparent px-2 text-[0.94rem] font-medium text-slate-600 transition-colors duration-150 ease-out hover:bg-slate-50 hover:text-slate-950 data-active:bg-blue-50 data-active:text-blue-950",
                        !sidebarOpen &&
                          "mx-auto size-10 justify-center rounded-md px-0",
                      )}
                      onPointerDown={() => onPreloadWorkspaceTab(item.value)}
                      onFocus={() => onPreloadWorkspaceTab(item.value)}
                      onClick={() => onSetWorkspaceTab(item.value)}
                    >
                      <item.icon className="size-4.5 text-slate-500" />
                      {sidebarOpen ? <span>{item.label}</span> : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Resize sidebar"
          onPointerDown={onSidebarResizeStart}
          className="absolute top-0 right-[-6px] bottom-0 hidden w-3 cursor-col-resize touch-none bg-transparent md:block"
        >
          <span className="absolute top-0 right-[5px] bottom-0 w-px bg-border/70 transition-colors hover:bg-primary/50" />
        </button>
      ) : null}
    </Sidebar>
  );
}

function WorkspaceHeader({ project, activeTabLabel }: WorkspaceHeaderProps) {
  return (
    <section className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <SidebarTrigger className="mt-0.5 size-12 shrink-0 md:hidden" />
          <div className="min-w-0">
            <p className="text-[0.72rem] font-semibold uppercase tracking-[0.26em] text-slate-500">
              {activeTabLabel}
            </p>
            <h2 className="mt-2 text-[2rem] font-semibold leading-tight tracking-[-0.015em] text-slate-950">
              {project.name}
            </h2>
            <p className="mt-2 text-left text-[1rem] text-slate-500">
              Oppdatert {formatDate(project.last_activity_at)}
            </p>
            {project.customer_name || project.industry ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[1rem] text-slate-500">
                {project.customer_name ? (
                  <span className="font-medium">{project.customer_name}</span>
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
  );
}

function WorkspaceStatusMessages({
  error,
  notice,
  busy,
  busyMessage,
  busyProgress,
}: WorkspaceStatusMessagesProps) {
  return (
    <>
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
          <GenerationProgress message={busyMessage} progress={busyProgress} />
        </div>
      ) : null}
    </>
  );
}

function DeferredSectionLoader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-5 py-6 text-sm text-muted-foreground shadow-sm">
      <Spinner className="size-4 text-primary" />
      <span>{label}</span>
    </div>
  );
}

export function ProjectWorkspaceTabContent({
  activeTab,
  project,
  serviceDescriptions,
  architectureDocumentCandidates,
  customerAnalysis,
  solutionEvaluation,
  executiveSummary,
  analysisLoaded,
  analysisLoading,
  evaluationLoaded,
  evaluationLoading,
  executiveSummaryLoaded,
  executiveSummaryLoading,
  busy,
  busyMessage,
  busyProgress,
  analysisSectionBusy,
  uploadOpen,
  docTitle,
  uploadRole,
  selectedDocumentName,
  documentFileInputKey,
  selectedRequirementDocumentId,
  requirementArtifacts,
  solutionDraftArtifacts,
  deliveryArtifacts,
  bilag1Artifacts,
  onToggleUploadOpen,
  onDocTitleChange,
  onUploadRoleChange,
  onFileChange,
  onUploadDocument,
  onDeleteDocument,
  onGenerateCustomerAnalysis,
  onSaveAnalysis,
  onGenerateSolutionEvaluation,
  onUploadArchitectureDocument,
  onDeleteArtifact,
  onGenerateBilag1Artifact,
  onGenerateDeliveryArtifact,
  onUploadRequirementDocument,
  onSelectedRequirementDocumentChange,
  onUpdateRequirementArtifact,
  onGenerateRequirementResponse,
  onGenerateExecutiveSummary,
  onGenerateArtifact,
}: ProjectWorkspaceTabContentProps) {
  return (
    <>
      {activeTab === "documents" ? (
        <ProjectDocumentsTab
          projectId={project.id}
          documents={project.documents}
          services={serviceDescriptions}
          uploadOpen={uploadOpen}
          onToggleUploadOpen={onToggleUploadOpen}
          docTitle={docTitle}
          onDocTitleChange={onDocTitleChange}
          uploadRole={uploadRole}
          onUploadRoleChange={onUploadRoleChange}
          selectedDocumentName={selectedDocumentName}
          onFileChange={onFileChange}
          documentFileInputKey={documentFileInputKey}
          onUploadDocument={onUploadDocument}
          uploadBusy={busy === "upload"}
          deletingDocumentId={
            busy?.startsWith("delete-") ? busy.slice("delete-".length) : null
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
            sectionBusy={analysisSectionBusy}
            busyMessage={analysisSectionBusy ? busyMessage : ""}
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
            documents={architectureDocumentCandidates}
            solutionEvaluation={solutionEvaluation}
            hasSolutionDocument={architectureDocumentCandidates.length > 0}
            busy={busy === "solution-evaluation"}
            busyMessage={busy === "solution-evaluation" ? busyMessage : ""}
            busyProgress={busyProgress}
            onGenerate={onGenerateSolutionEvaluation}
            importBusy={busy === "upload-architecture-document"}
            onImportArchitectureDocument={onUploadArchitectureDocument}
          />
        )
      ) : null}

      {activeTab === "bilag1" ? (
        <ProjectBilag1Tab
          documents={project.documents}
          artifacts={bilag1Artifacts}
          busy={busy === "bilag1-artifact"}
          busyMessage={busy === "bilag1-artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateBilag1Artifact}
        />
      ) : null}

      {activeTab === "delivery" ? (
        <ProjectDeliveryTab
          artifacts={deliveryArtifacts}
          busy={busy === "delivery-artifact"}
          busyMessage={busy === "delivery-artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          hasCustomerAnalysis={Boolean(customerAnalysis)}
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateDeliveryArtifact}
        />
      ) : null}

      {activeTab === "service-description" ? (
        <ProjectServiceDescriptionTab projectId={project.id} />
      ) : null}

      {activeTab === "requirements" ? (
        <ProjectRequirementResponseTab
          projectId={project.id}
          documents={project.documents}
          artifacts={requirementArtifacts}
          uploadBusy={busy === "upload-requirement-document"}
          generateBusy={busy === "requirement-response"}
          busyMessage={busy === "requirement-response" ? busyMessage : ""}
          busyProgress={busyProgress}
          deletingDocumentId={
            busy?.startsWith("delete-") ? busy.slice("delete-".length) : null
          }
          onUpload={onUploadRequirementDocument}
          selectedDocumentId={selectedRequirementDocumentId}
          onSelectedDocumentChange={onSelectedRequirementDocumentChange}
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
            busyMessage={busy === "executive-summary" ? busyMessage : ""}
            busyProgress={busyProgress}
            onGenerate={onGenerateExecutiveSummary}
          />
        )
      ) : null}

      {activeTab === "generator" ? (
        <ProjectGeneratorTab
          artifacts={solutionDraftArtifacts}
          busy={busy === "artifact"}
          busyMessage={busy === "artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateArtifact}
        />
      ) : null}
    </>
  );
}
