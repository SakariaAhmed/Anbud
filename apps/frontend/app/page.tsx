import { headers } from "next/headers";
import { ProjectDashboard } from "@/components/projects/project-dashboard";
import { AUTH_OWNER_HEADER } from "@/lib/password-auth";
import { listProjects } from "@/lib/server/repositories/projects";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ownerId = (await headers()).get(AUTH_OWNER_HEADER);
  const projects = ownerId ? await listProjects(ownerId) : [];
  return (
    <>
      <div aria-hidden="true" className="bidsite-boot-cover" />
      <ProjectDashboard projects={projects} />
    </>
  );
}
