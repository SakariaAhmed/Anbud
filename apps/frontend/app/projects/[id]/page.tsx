import { notFound } from "next/navigation";

import {
  ProjectWorkspacePage,
  type ProjectWorkspaceTab,
} from "@/components/projects/project-workspace-page";
import { getProjectShell } from "@/lib/server/projects-db";

const validTabs = new Set<string>([
  "analysis",
  "bilag1",
  "service-description",
  "requirements",
  "generator",
  "evaluation",
  "delivery",
  "executive-summary",
]);

function parseInitialTab(value: string | string[] | undefined): ProjectWorkspaceTab {
  const tab = Array.isArray(value) ? value[0] : value;
  return validTabs.has(tab ?? "") ? (tab as ProjectWorkspaceTab) : "analysis";
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  try {
    const [{ id }, query] = await Promise.all([params, searchParams]);
    const project = await getProjectShell(id);
    return (
      <ProjectWorkspacePage
        initialData={project}
        initialTab={parseInitialTab(query.tab)}
      />
    );
  } catch {
    notFound();
  }
}
