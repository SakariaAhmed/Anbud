import { notFound } from "next/navigation";

import { ProjectWorkspacePage } from "@/components/projects/project-workspace-page";
import { getProjectDetail } from "@/lib/server/projects-db";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await getProjectDetail(id);
    return <ProjectWorkspacePage initialData={project} />;
  } catch {
    notFound();
  }
}
