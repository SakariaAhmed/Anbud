import { ProjectDashboard } from "@/components/projects/project-dashboard";
import { listProjects } from "@/lib/server/repositories/projects";

export default async function HomePage() {
  const projects = await listProjects();
  return (
    <>
      <div aria-hidden="true" className="bidsite-boot-cover" />
      <ProjectDashboard projects={projects} />
    </>
  );
}
