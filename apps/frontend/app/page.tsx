import { ProjectDashboard } from "@/components/projects/project-dashboard";
import { listProjects } from "@/lib/server/projects-db";

export default async function HomePage() {
  const projects = await listProjects();
  return <ProjectDashboard projects={projects} />;
}
