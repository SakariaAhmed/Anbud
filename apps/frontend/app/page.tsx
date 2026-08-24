import { ProjectDashboard } from "@/components/projects/project-dashboard";
import { requireRequestPrincipal } from "@/lib/server/authorization";
import { listProjects } from "@/lib/server/repositories/projects";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const principal = await requireRequestPrincipal();
  const projects = await listProjects(principal.id, {
    admin: principal.isAdmin,
  });
  return (
    <>
      <div aria-hidden="true" className="bidsite-boot-cover" />
      <ProjectDashboard projects={projects} />
    </>
  );
}
