import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { ProjectChatPopoutPage } from "@/components/projects/project-chat-popout-page";
import { AUTH_OWNER_HEADER } from "@/lib/password-auth";
import {
  getProjectShell,
  listProjects,
} from "@/lib/server/repositories/projects";

function parseSessionId(value: string | string[] | undefined) {
  const sessionId = Array.isArray(value) ? value[0] : value;
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : null;
}

export default async function ProjectChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string | string[] }>;
}) {
  try {
    const [{ id }, query] = await Promise.all([params, searchParams]);
    const ownerId = (await headers()).get(AUTH_OWNER_HEADER);
    const [project, projects] = await Promise.all([
      getProjectShell(id),
      ownerId ? listProjects(ownerId) : Promise.resolve([]),
    ]);

    return (
      <ProjectChatPopoutPage
        projectId={project.id}
        projectName={project.name}
        customerName={project.customer_name}
        projects={projects}
        initialSessionId={parseSessionId(query.session_id)}
      />
    );
  } catch {
    notFound();
  }
}
