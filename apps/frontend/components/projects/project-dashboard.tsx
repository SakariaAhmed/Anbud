"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useRef,
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";

import {
  DashboardHero,
  DashboardIntro,
  ProjectListSection,
  WorkflowSteps,
  normalizeSearch,
  type ProjectSort,
  type ProjectStatusFilter,
} from "@/components/projects/project-dashboard-sections";
import type { ProjectSummary } from "@/lib/types";

const HomepageRefreshAnimation = dynamic(
  () =>
    import("@/components/projects/homepage-refresh-animation").then(
      (module) => module.HomepageRefreshAnimation,
    ),
  { ssr: false, loading: () => null },
);

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

async function uploadProjectDocument({
  projectId,
  file,
}: {
  projectId: string;
  file: File;
}) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", fileTitle(file));

  const response = await fetch(`/api/projects/${projectId}/documents`, {
    method: "POST",
    body: formData,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Kunne ikke laste opp dokumentet.");
  }
}

export function ProjectDashboard({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prefetchedProjectHrefsRef = useRef<Set<string>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const latestProject = projects[0] ?? null;
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("Alle");
  const [sortBy, setSortBy] = useState<ProjectSort>("recent");
  const statusOptions = useMemo<ProjectStatusFilter[]>(
    () => [
      "Alle",
      ...Array.from(new Set(projects.map((project) => project.status))),
    ],
    [projects],
  );
  const filteredProjects = useMemo(() => {
    const query = normalizeSearch(searchQuery);
    const result = projects.filter((project) => {
      const matchesStatus =
        statusFilter === "Alle" || project.status === statusFilter;
      const searchable = [
        project.name,
        project.customer_name ?? "",
        project.industry ?? "",
        project.description ?? "",
        project.status,
      ]
        .join(" ")
        .toLocaleLowerCase("nb-NO");
      return matchesStatus && (!query || searchable.includes(query));
    });

    return result.sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name, "nb-NO");
      }
      if (sortBy === "documents") {
        return b.document_count - a.document_count;
      }
      if (sortBy === "artifacts") {
        return b.artifact_count - a.artifact_count;
      }
      return (
        new Date(b.last_activity_at).getTime() -
        new Date(a.last_activity_at).getTime()
      );
    });
  }, [projects, searchQuery, sortBy, statusFilter]);
  const prefetchProjectHref = useCallback(
    (href: string) => {
      if (prefetchedProjectHrefsRef.current.has(href)) {
        return;
      }
      prefetchedProjectHrefsRef.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  async function handleSpotlightUpload(file: File | null) {
    if (!file || uploading) return;

    setUploadError("");
    setUploading(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fileTitle(file),
          customer_name: "",
          industry: "",
          description: "",
        }),
      });
      const payload = (await response.json()) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !payload.id) {
        throw new Error(payload.error || "Kunne ikke opprette prosjekt.");
      }
      const projectId = payload.id;
      await uploadProjectDocument({ projectId, file });

      router.push(`/projects/${projectId}`);
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "Kunne ikke laste opp dokumentet.",
      );
      setUploading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    void handleSpotlightUpload(event.dataTransfer.files?.[0] ?? null);
  }

  function onDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0] ?? null;
    void handleSpotlightUpload(selectedFile);
    event.target.value = "";
  }

  async function handleDeleteProject(project: ProjectSummary) {
    if (deletingProjectId) return;
    setDeleteError("");
    setDeletingProjectId(project.id);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || "Kunne ikke slette prosjektet.");
      }
      router.refresh();
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Kunne ikke slette prosjektet.",
      );
    } finally {
      setDeletingProjectId("");
    }
  }

  return (
    <>
      <HomepageRefreshAnimation />
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <DashboardIntro />
        <DashboardHero
          dragActive={dragActive}
          fileInputRef={fileInputRef}
          latestProject={latestProject}
          onDragLeave={() => setDragActive(false)}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onFileChange={onFileChange}
          onUploadButtonClick={() => fileInputRef.current?.click()}
          prefetchProjectHref={prefetchProjectHref}
          uploadError={uploadError}
          uploading={uploading}
        />
        <ProjectListSection
          deleteError={deleteError}
          deletingProjectId={deletingProjectId}
          filteredProjects={filteredProjects}
          handleDeleteProject={(project) => void handleDeleteProject(project)}
          prefetchProjectHref={prefetchProjectHref}
          projects={projects}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          setSortBy={setSortBy}
          setStatusFilter={setStatusFilter}
          sortBy={sortBy}
          statusFilter={statusFilter}
          statusOptions={statusOptions}
        />
        <WorkflowSteps />
      </div>
    </>
  );
}
