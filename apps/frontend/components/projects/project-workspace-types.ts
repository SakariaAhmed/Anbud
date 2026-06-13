import type { LucideIcon } from "lucide-react";

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

export type WorkspaceNavItem = {
  value: ProjectWorkspaceTab;
  label: string;
  icon: LucideIcon;
};

export type WorkflowStepStatus =
  | "Ikke startet"
  | "Venter"
  | "Klar"
  | "Generert"
  | "Må sjekkes"
  | "Ferdig";

export type WorkflowStepItem = WorkspaceNavItem & {
  step: number;
  status: WorkflowStepStatus;
};

export function isProjectWorkspaceTab(
  value: string | null | undefined,
): value is ProjectWorkspaceTab {
  return PROJECT_WORKSPACE_TABS.includes(value as ProjectWorkspaceTab);
}
