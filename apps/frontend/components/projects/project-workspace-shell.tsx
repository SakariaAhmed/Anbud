"use client";

import "./project-workspace.css";

import { ProjectAnalysisResult } from "@/components/projects/project-analysis-result";
import { ProjectWorkflowJobs } from "@/components/projects/project-workflow-jobs";
import dynamic from "next/dynamic";
import type {
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  MessageSquareText,
} from "lucide-react";

import { GenerationProgress } from "@/components/projects/project-workspace-shared";
import { ProjectShareDialog } from "@/components/projects/project-share-dialog";
import { isDocumentReadyForEvaluation } from "@/lib/document-processing";
import type {
  ProjectWorkspaceTab,
  WorkflowStepItem,
  WorkspaceNavItem,
} from "@/components/projects/project-workspace-types";
import { Button } from "@/components/ui/button";
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
  useSidebar,
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
  canShare: boolean;
  readOnly: boolean;
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
  canShare: boolean;
  readOnly: boolean;
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
  analysisLoadError: string;
  onRetryAnalysisLoad: () => void;
  evaluationLoaded: boolean;
  evaluationLoading: boolean;
  evaluationLoadError: string;
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
  requirementArtifacts: GeneratedArtifact[];
  solutionDraftArtifacts: GeneratedArtifact[];
  deliveryArtifacts: GeneratedArtifact[];
  bilag1Artifacts: GeneratedArtifact[];
  onToggleUploadOpen: () => void;
  onServiceDescriptionsChange: (
    services: ProjectServiceDescription[],
  ) => void;
  onDocTitleChange: (value: string) => void;
  onUploadRoleChange: (value: ProjectDocumentRole) => void;
  onFileChange: (file: File | null) => void;
  onUploadDocument: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onGenerateCustomerAnalysis: () => Promise<void>;
  onSaveAnalysis: (
    section: CustomerAnalysisSection,
    snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection],
    revision?: string,
  ) => Promise<boolean>;
  onGenerateSolutionEvaluation: (
    solutionDocumentId?: string,
    importedDocument?: ProjectDocument,
  ) => Promise<void>;
  onRetrySolutionEvaluationLoad: () => void;
  onUploadArchitectureDocument: (file: File) => Promise<ProjectDocument | null>;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onGenerateBilag1Artifact: (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  onGenerateDeliveryArtifact: (
    event: FormEvent<HTMLFormElement>,
  ) => Promise<void>;
  onUploadRequirementDocument: (file: File) => Promise<ProjectDocument | null>;
  onUpdateRequirementArtifact: (
    artifact: GeneratedArtifact,
    value: {
      title: string;
      content_markdown: string;
      acknowledge_deterministic_repairs?: boolean;
    },
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
  canShare,
  readOnly,
  children,
}: ProjectWorkspaceShellProps) {
  return (
    <div className="project-workspace min-h-[calc(100dvh-var(--app-header-height))] w-full overflow-x-hidden">
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={onSidebarOpenChange}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--sidebar-width-icon": "3.5rem",
            "--sidebar-offset-top": "var(--app-header-height)",
            "--sidebar-offset-bottom": "0px",
          } as CSSProperties
        }
        className="min-h-[calc(100dvh-var(--app-header-height))] bg-transparent max-md:flex-col"
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
              "workspace-content relative mx-auto w-full max-w-[1440px] px-5 py-6 md:px-10 md:py-8",
              !sidebarOpen && "mx-auto",
            )}
          >
            <WorkspaceHeader
              project={project}
              activeTabLabel={activeTabLabel}
              canShare={canShare}
              readOnly={readOnly}
            />
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
  const { isMobile, setOpenMobile } = useSidebar();
  const showLabels = isMobile || sidebarOpen;
  function navigate(tab: ProjectWorkspaceTab) {
    onSetWorkspaceTab(tab);
    if (isMobile) setOpenMobile(false);
  }
  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar md:border-r md:border-sidebar-border"
    >
      <SidebarHeader
        className={cn(
          "flex min-h-20 flex-row items-center border-b border-sidebar-border bg-sidebar px-5 py-4 transition-[padding] duration-150 ease-out",
          showLabels ? "justify-between gap-3" : "justify-center px-2",
        )}
      >
        {showLabels ? (
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold leading-6 text-sidebar-foreground">
              {project.name}
            </p>
          </div>
        ) : null}
        <SidebarTrigger
          aria-label={isMobile ? "Lukk sidemeny" : showLabels ? "Kollaps sidemeny" : "Utvid sidemeny"}
          title={isMobile ? "Lukk sidemeny" : showLabels ? "Kollaps sidemeny" : "Utvid sidemeny"}
          className="size-12 shrink-0 rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {showLabels ? (
            <ChevronLeft className="size-4.5" />
          ) : (
            <ChevronRight className="size-4.5" />
          )}
        </SidebarTrigger>
      </SidebarHeader>

      <SidebarContent
        className={cn(
          "min-h-0 flex-1 bg-sidebar px-3 py-4 transition-[padding] duration-150 ease-out",
          !showLabels && "px-1.5",
        )}
      >
        <SidebarGroup className={cn("gap-2 px-1 py-2.5", !showLabels && "px-0")}>
          <SidebarGroupContent>
            <SidebarMenu className={cn("gap-2", !showLabels && "items-center")}>
              {primaryWorkflowSteps.map((item) => (
                <SidebarMenuItem
                  key={item.value}
                  className={cn(!showLabels && "flex justify-center")}
                >
                  <SidebarMenuButton
                    isActive={activeTab === item.value}
                    aria-label={item.label}
                    size="lg"
                    tooltip={item.label}
                    className={cn(
                      "workspace-nav-button relative h-auto min-h-11 gap-3 rounded-md border border-transparent px-3 py-2 text-sm font-medium",
                      !showLabels &&
                        "mx-auto size-10 min-h-10 justify-center rounded-md px-0 py-0",
                    )}
                    onPointerDown={() => onPreloadWorkspaceTab(item.value)}
                    onFocus={() => onPreloadWorkspaceTab(item.value)}
                    onClick={() => navigate(item.value)}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden="true" />
                    {showLabels ? (
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                          <span className="min-w-0 break-words text-left leading-5 hyphens-auto">
                            {item.label}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-current transition-colors" />
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
            className={cn("gap-2 px-1 py-2.5", !showLabels && "px-0")}
          >
            {showLabels ? (
              <p className="px-2 text-xs font-bold tracking-normal text-slate-400">
                {group.label}
              </p>
            ) : null}
            <SidebarGroupContent>
              <SidebarMenu className={cn("gap-1.5", !showLabels && "items-center")}>
                <SidebarMenuItem
                  className={cn(!showLabels && "flex justify-center")}
                >
                  <SidebarMenuButton
                    render={
                      <a
                        href={`/projects/${project.id}/chat`}
                        target={`bidsite-project-chat-${project.id}`}
                        rel="noopener noreferrer"
                        onClick={(event) => {
                          // The anchor remains the fallback when the popup is blocked.
                          if (onOpenChatPopout()) event.preventDefault();
                          if (isMobile) setOpenMobile(false);
                        }}
                      />
                    }
                    size="lg"
                    tooltip="Åpne AI Chat i pop-out vindu"
                    className={cn(
                      "workspace-nav-button h-11 gap-3 rounded-md border border-transparent px-3 text-sm font-medium",
                      !showLabels &&
                        "mx-auto size-10 justify-center rounded-md px-0",
                    )}
                  >
                    <MessageSquareText className="size-4.5 text-current" />
                    {showLabels ? <span>AI Chat</span> : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {group.items.map((item) => (
                  <SidebarMenuItem
                    key={item.value}
                    className={cn(!showLabels && "flex justify-center")}
                  >
                    <SidebarMenuButton
                      isActive={activeTab === item.value}
                    aria-label={item.label}
                      size="lg"
                      tooltip={`${group.label}: ${item.label}`}
                      className={cn(
                        "workspace-nav-button h-11 gap-3 rounded-md border border-transparent px-3 text-sm font-medium",
                        !showLabels &&
                          "mx-auto size-10 justify-center rounded-md px-0",
                      )}
                      onPointerDown={() => onPreloadWorkspaceTab(item.value)}
                      onFocus={() => onPreloadWorkspaceTab(item.value)}
                      onClick={() => navigate(item.value)}
                    >
                      <item.icon className="size-4.5 text-current" />
                      {showLabels ? <span>{item.label}</span> : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {showLabels ? (
        <button
          type="button"
          aria-label="Endre bredden på sidemenyen"
          onPointerDown={onSidebarResizeStart}
          className="absolute top-0 right-[-6px] bottom-0 hidden w-3 cursor-col-resize touch-none bg-transparent md:block"
        >
          <span className="absolute top-0 right-[5px] bottom-0 w-px bg-border/70 transition-colors hover:bg-primary/50" />
        </button>
      ) : null}
    </Sidebar>
  );
}

function WorkspaceHeader({
  project,
  activeTabLabel,
  canShare,
  readOnly,
}: WorkspaceHeaderProps) {
  return (
    <section className="workspace-heading mb-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <SidebarTrigger aria-label="Åpne sidemeny" className="mt-0.5 size-12 shrink-0 md:hidden" />
          <div className="min-w-0">
            <p className="workspace-eyebrow text-xs font-semibold">
              {activeTabLabel}
            </p>
            <h2 className="mt-2 font-display text-[1.45rem] font-semibold leading-tight tracking-[-0.035em] text-slate-950 sm:text-[1.75rem]">
              {project.name}
            </h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {readOnly ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <LockKeyhole className="size-3.5" />
              Lesetilgang
            </span>
          ) : null}
          {canShare ? (
            <ProjectShareDialog projectId={project.id} projectName={project.name} />
          ) : null}
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
  analysisLoadError,
  onRetryAnalysisLoad,
  evaluationLoaded,
  evaluationLoading,
  evaluationLoadError,
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
  requirementArtifacts,
  solutionDraftArtifacts,
  deliveryArtifacts,
  bilag1Artifacts,
  onToggleUploadOpen,
  onServiceDescriptionsChange,
  onDocTitleChange,
  onUploadRoleChange,
  onFileChange,
  onUploadDocument,
  onDeleteDocument,
  onGenerateCustomerAnalysis,
  onSaveAnalysis,
  onGenerateSolutionEvaluation,
  onRetrySolutionEvaluationLoad,
  onUploadArchitectureDocument,
  onDeleteArtifact,
  onGenerateBilag1Artifact,
  onGenerateDeliveryArtifact,
  onUploadRequirementDocument,
  onUpdateRequirementArtifact,
  onGenerateRequirementResponse,
  onGenerateExecutiveSummary,
  onGenerateArtifact,
}: ProjectWorkspaceTabContentProps) {
  return (
    <>
      <ProjectWorkflowJobs key={`jobs-${project.id}`} projectId={project.id} />
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
          uploadBusy={Boolean(busy)}
          deletingDocumentId={
            busy?.startsWith("delete-") ? busy.slice("delete-".length) : null
          }
          onDeleteDocument={onDeleteDocument}
        />
      ) : null}

      {activeTab === "analysis" ? (
        <ProjectAnalysisResult key={`analysis-${project.id}`} projectId={project.id} currentAnalysis={customerAnalysis} hasCurrentAnalysis={project.customer_analysis_generated} snapshotRevision={project.snapshot_revision}>
          {(fallback) => !customerAnalysis && !fallback && (!analysisLoaded || analysisLoading) ? (
            <DeferredSectionLoader label="Laster kundeanalyse ..." />
          ) : analysisLoadError && !customerAnalysis && !fallback ? (
            <div role="alert" className="rounded-lg border p-4">
              <p className="text-sm text-red-700">{analysisLoadError}</p>
              <Button variant="outline" className="mt-3" onClick={onRetryAnalysisLoad}>Prøv igjen</Button>
            </div>
          ) : (
            <ProjectAnalysisTab
              projectId={project.id}
              documents={project.documents}
              customerAnalysis={customerAnalysis ?? fallback}
              sourceChanged={Boolean(fallback)}
              busy={Boolean(busy)}
              saveBusy={busy === "save-analysis"}
              sectionBusy={analysisSectionBusy}
              busyMessage={analysisSectionBusy ? busyMessage : ""}
              busyProgress={busyProgress}
              onGenerate={onGenerateCustomerAnalysis}
              onSaveAnalysis={fallback ? undefined : onSaveAnalysis}
            />
          )}
        </ProjectAnalysisResult>
      ) : null}

      {activeTab === "evaluation" ? (
        evaluationLoading || (!evaluationLoaded && !evaluationLoadError) ? (
          <DeferredSectionLoader label="Laster vurdering ..." />
        ) : evaluationLoadError ? (
          <div className="rounded-xl border border-rose-200 bg-white px-5 py-6 shadow-sm">
            <p className="text-sm font-semibold text-rose-900">
              Kunne ikke hente den lagrede vurderingen.
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {evaluationLoadError}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={onRetrySolutionEvaluationLoad}
            >
              Prøv å laste vurderingen på nytt
            </Button>
          </div>
        ) : (
          <ProjectEvaluationTab
            documents={architectureDocumentCandidates}
            solutionEvaluation={solutionEvaluation}
            hasSolutionDocument={architectureDocumentCandidates.some(
              isDocumentReadyForEvaluation,
            )}
            busy={Boolean(busy)}
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
          busy={Boolean(busy)}
          busyMessage={busy === "bilag1-artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateBilag1Artifact}
        />
      ) : null}

      {activeTab === "delivery" ? (
        <ProjectDeliveryTab
          artifacts={deliveryArtifacts}
          busy={Boolean(busy)}
          busyMessage={busy === "delivery-artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          hasCustomerAnalysis={
            Boolean(customerAnalysis) || project.customer_analysis_generated
          }
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateDeliveryArtifact}
        />
      ) : null}

      {activeTab === "service-description" ? (
        <ProjectServiceDescriptionTab
          projectId={project.id}
          onServicesChange={onServiceDescriptionsChange}
        />
      ) : null}

      {activeTab === "requirements" ? (
        <ProjectRequirementResponseTab
          projectId={project.id}
          documents={project.documents}
          artifacts={requirementArtifacts}
          uploadBusy={Boolean(busy)}
          uploadInProgress={busy === "upload-requirement-document"}
          generateBusy={Boolean(busy)}
          busyMessage={busy === "requirement-response" ? busyMessage : ""}
          busyProgress={busyProgress}
          deletingDocumentId={
            busy?.startsWith("delete-") ? busy.slice("delete-".length) : null
          }
          onUpload={onUploadRequirementDocument}
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
            hasSolutionEvaluation={
              Boolean(solutionEvaluation) || project.solution_evaluation_generated
            }
            busy={Boolean(busy)}
            busyMessage={busy === "executive-summary" ? busyMessage : ""}
            busyProgress={busyProgress}
            onGenerate={onGenerateExecutiveSummary}
          />
        )
      ) : null}

      {activeTab === "generator" ? (
        <ProjectGeneratorTab
          artifacts={solutionDraftArtifacts}
          busy={Boolean(busy)}
          busyMessage={busy === "artifact" ? busyMessage : ""}
          busyProgress={busyProgress}
          onDeleteArtifact={onDeleteArtifact}
          onSubmit={onGenerateArtifact}
        />
      ) : null}
    </>
  );
}
