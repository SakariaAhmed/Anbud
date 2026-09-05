"use client";

import { ArrowRight, Plus, Search, SlidersHorizontal, Trash2, UploadCloud } from "lucide-react";
import Link from "next/link";
import type { ChangeEvent, DragEvent, RefObject } from "react";

import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectSummary } from "@/lib/types";

export type ProjectStatusFilter = ProjectSummary["status"] | "Alle";
export type ProjectSort = "recent" | "name" | "documents" | "artifacts";

type PrefetchProjectHref = (href: string) => void;
type DeleteProjectHandler = (project: ProjectSummary) => void;

function projectActionHref(project: ProjectSummary) {
  return `/projects/${project.id}`;
}

export function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase("nb-NO");
}

function statusColor(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Dokument lastet opp":
      return "text-blue-800 bg-blue-50 border-blue-200";
    case "Kundeanalyse klar":
      return "text-amber-800 bg-amber-50 border-amber-200";
    default:
      return "text-slate-600 bg-slate-50 border-slate-200";
  }
}

function statusDot(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Dokument lastet opp":
      return "bg-blue-500";
    case "Kundeanalyse klar":
      return "bg-amber-500";
    default:
      return "bg-slate-400";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  }).format(new Date(value));
}

function nextProjectAction(project: ProjectSummary) {
  if (!project.customer_document_uploaded && project.document_count === 0) {
    return {
      label: "Last opp grunnlag",
      detail: "Kundedokument eller konkurransegrunnlag mangler.",
    };
  }
  if (!project.customer_analysis_generated) {
    return {
      label: "Generer kundeanalyse",
      detail: "Bruk dokumentgrunnlaget til å finne krav og risiko.",
    };
  }
  if (!project.solution_document_uploaded) {
    return {
      label: "Lag løsningsbeskrivelse",
      detail: "Prosjektet er klart for utkast og videre bearbeiding.",
    };
  }
  if (!project.solution_evaluation_generated) {
    return {
      label: "Vurder løsning",
      detail: "Sjekk treff mot kundebehov før leveranse.",
    };
  }
  return {
    label: "Klargjør leveranse",
    detail: "Samle vurdering, fremdriftsplan og lederoppsummering.",
  };
}

function prefetchLinkHandlers(href: string, prefetchProjectHref: PrefetchProjectHref) {
  return {
    onFocus: () => prefetchProjectHref(href),
    onPointerDown: () => prefetchProjectHref(href),
    onPointerEnter: () => prefetchProjectHref(href),
  };
}

export function DashboardIntro() {
  return (
    <section className="mb-5">
      <div className="min-w-0">
        <p className="text-[0.72rem] font-bold uppercase tracking-[0.16em] text-slate-500">
          Prosjektoversikt
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Mine prosjekter
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Fortsett i et prosjekt, eller opprett et nytt med kundens dokumenter.
        </p>
      </div>
    </section>
  );
}

export function DashboardHero({
  dragActive,
  fileInputRef,
  latestProject,
  onDragLeave,
  onDragOver,
  onDrop,
  onFileChange,
  onUploadButtonClick,
  prefetchProjectHref,
  uploadError,
  uploading,
}: {
  dragActive: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  latestProject: ProjectSummary | null;
  onDragLeave: () => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onUploadButtonClick: () => void;
  prefetchProjectHref: PrefetchProjectHref;
  uploadError: string;
  uploading: boolean;
}) {
  const latestProjectHref = latestProject ? `/projects/${latestProject.id}` : "";

  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white px-5 py-5 sm:px-6">
      <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">
            Start et nytt tilbud
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Last opp konkurransegrunnlaget for å opprette et prosjekt og klargjøre dokumentene for analyse.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href="/projects/new"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <Plus className="size-4" />
              Nytt prosjekt
            </Link>
            {latestProject ? (
              <Link
                href={latestProjectHref}
                prefetch={false}
                {...prefetchLinkHandlers(latestProjectHref, prefetchProjectHref)}
                className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
              >
                Siste prosjekt
                <ArrowRight className="size-4" />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
            className="sr-only"
            onChange={onFileChange}
          />
          <button
            type="button"
            onClick={onUploadButtonClick}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            disabled={uploading}
            className={`relative z-10 flex min-h-36 w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-5 text-center transition-colors disabled:cursor-wait ${
              dragActive
                ? "border-blue-600 bg-blue-50"
                : "border-slate-300 bg-slate-50 hover:border-blue-500 hover:bg-blue-50"
            }`}
          >
            <UploadCloud className="size-7 text-blue-700" />
            <span className="mt-3 text-sm font-semibold text-slate-900">
              {uploading ? "Laster opp ..." : "Slipp dokument her"}
            </span>
            <span className="mt-1 text-xs leading-5 text-slate-600">
              Oppretter prosjekt og lagrer filen i dokumenter.
            </span>
          </button>
          {uploadError ? (
            <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {uploadError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ProjectFilters({
  filteredCount,
  projectCount,
  searchQuery,
  setSearchQuery,
  setSortBy,
  setStatusFilter,
  sortBy,
  statusFilter,
  statusOptions,
}: {
  filteredCount: number;
  projectCount: number;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  setSortBy: (value: ProjectSort) => void;
  setStatusFilter: (value: ProjectStatusFilter) => void;
  sortBy: ProjectSort;
  statusFilter: ProjectStatusFilter;
  statusOptions: ProjectStatusFilter[];
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50/80 px-4 py-4 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.16em] text-slate-900">
            Prosjekter
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Sorter etter aktivitet, filtrer på status, og åpne anbefalt neste steg.
          </p>
        </div>
        <span className="text-sm font-medium tabular-nums text-slate-500">
          {filteredCount} av {projectCount}
        </span>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(14rem,1fr)_13rem_13rem]">
        <label className="relative">
          <span className="sr-only">Søk i prosjekter</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Søk etter prosjekt, kunde, bransje eller status"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm font-medium text-slate-950 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400"
          />
        </label>
        <label className="relative">
          <span className="sr-only">Filtrer status</span>
          <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as ProjectStatusFilter)
            }
            className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-10 pr-3 text-sm font-semibold text-slate-800 outline-none focus:border-slate-400"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status === "Alle" ? "Alle statuser" : status}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Sorter prosjekter</span>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as ProjectSort)}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-slate-400"
          >
            <option value="recent">Sist endret</option>
            <option value="name">Navn A-Å</option>
            <option value="documents">Flest dokumenter</option>
            <option value="artifacts">Flest utkast</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function ProjectListSection({
  deleteError,
  deletingProjectId,
  filteredProjects,
  handleDeleteProject,
  prefetchProjectHref,
  projects,
  searchQuery,
  setSearchQuery,
  setSortBy,
  setStatusFilter,
  sortBy,
  statusFilter,
  statusOptions,
}: {
  deleteError: string;
  deletingProjectId: string;
  filteredProjects: ProjectSummary[];
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
  projects: ProjectSummary[];
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  setSortBy: (value: ProjectSort) => void;
  setStatusFilter: (value: ProjectStatusFilter) => void;
  sortBy: ProjectSort;
  statusFilter: ProjectStatusFilter;
  statusOptions: ProjectStatusFilter[];
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
      <ProjectFilters
        filteredCount={filteredProjects.length}
        projectCount={projects.length}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        setSortBy={setSortBy}
        setStatusFilter={setStatusFilter}
        sortBy={sortBy}
        statusFilter={statusFilter}
        statusOptions={statusOptions}
      />
      {deleteError ? (
        <div className="border-b border-red-100 bg-red-50 px-7 py-3 text-sm font-medium text-red-700">
          {deleteError}
        </div>
      ) : null}
      <ProjectListBody
        deletingProjectId={deletingProjectId}
        filteredProjects={filteredProjects}
        handleDeleteProject={handleDeleteProject}
        prefetchProjectHref={prefetchProjectHref}
        projects={projects}
      />
    </section>
  );
}

function ProjectListBody({
  deletingProjectId,
  filteredProjects,
  handleDeleteProject,
  prefetchProjectHref,
  projects,
}: {
  deletingProjectId: string;
  filteredProjects: ProjectSummary[];
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
  projects: ProjectSummary[];
}) {
  if (projects.length === 0) {
    return <EmptyProjectState />;
  }

  if (filteredProjects.length === 0) {
    return <NoFilteredProjectsState />;
  }

  return (
    <>
      <ProjectTable
        deletingProjectId={deletingProjectId}
        filteredProjects={filteredProjects}
        handleDeleteProject={handleDeleteProject}
        prefetchProjectHref={prefetchProjectHref}
      />
      <ProjectMobileCards
        deletingProjectId={deletingProjectId}
        filteredProjects={filteredProjects}
        handleDeleteProject={handleDeleteProject}
        prefetchProjectHref={prefetchProjectHref}
      />
    </>
  );
}

function EmptyProjectState() {
  return (
    <div className="py-16 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
        <Search className="size-5 text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-semibold text-foreground">
        Ingen prosjekter ennå
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Opprett et prosjekt og last opp dokumenter for å komme i gang.
      </p>
      <Link
        href="/projects/new"
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover"
      >
        <Plus className="size-3.5" />
        Opprett prosjekt
      </Link>
    </div>
  );
}

function NoFilteredProjectsState() {
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-slate-100">
        <Search className="size-5 text-slate-500" />
      </div>
      <p className="mt-4 text-sm font-semibold text-slate-950">
        Ingen prosjekter matcher filtrene
      </p>
      <p className="mt-1 text-sm text-slate-500">
        Juster søk, statusfilter eller sortering for å se flere prosjekter.
      </p>
    </div>
  );
}

function ProjectTable({
  deletingProjectId,
  filteredProjects,
  handleDeleteProject,
  prefetchProjectHref,
}: {
  deletingProjectId: string;
  filteredProjects: ProjectSummary[];
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200 bg-white">
            {["Prosjekt", "Status", "Dok.", "Utkast", "Sist endret"].map((label) => (
              <th
                key={label}
                className="px-5 py-4 text-xs font-bold uppercase tracking-[0.16em] text-slate-400 first:px-7"
              >
                {label}
              </th>
            ))}
            <th className="px-7 py-4" />
          </tr>
        </thead>
        <tbody>
          {filteredProjects.map((project) => (
            <ProjectTableRow
              key={project.id}
              deletingProjectId={deletingProjectId}
              handleDeleteProject={handleDeleteProject}
              prefetchProjectHref={prefetchProjectHref}
              project={project}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectTableRow({
  deletingProjectId,
  handleDeleteProject,
  prefetchProjectHref,
  project,
}: {
  deletingProjectId: string;
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
  project: ProjectSummary;
}) {
  const action = nextProjectAction(project);
  const href = projectActionHref(project);

  return (
    <tr
      onFocusCapture={() => prefetchProjectHref(href)}
      onPointerEnter={() => prefetchProjectHref(href)}
      className="group border-b border-slate-200/80 transition-colors last:border-b-0 hover:bg-blue-50/35"
    >
      <td className="px-7 py-5">
        <Link
          href={href}
          prefetch={false}
          {...prefetchLinkHandlers(href, prefetchProjectHref)}
          className="block"
        >
          <p className="text-lg font-bold tracking-[-0.02em] text-slate-950 transition-colors group-hover:text-blue-800">
            {project.name}
          </p>
          <p className="mt-1 text-base leading-6 text-slate-500">
            {project.customer_name || "Kunde ikke satt"}
            {project.industry ? ` · ${project.industry}` : ""}
          </p>
          <p className="mt-2 text-sm font-semibold text-slate-700">
            {action.label}
            <span className="font-normal text-slate-400"> · </span>
            <span className="ml-2 font-normal text-slate-500">
              {action.detail}
            </span>
          </p>
        </Link>
      </td>
      <td className="px-5 py-5">
        <ProjectStatusBadge status={project.status} />
      </td>
      <td className="hidden px-5 py-5 text-lg font-semibold tabular-nums text-slate-600 sm:table-cell">
        {project.document_count}
      </td>
      <td className="hidden px-5 py-5 text-lg font-semibold tabular-nums text-slate-600 sm:table-cell">
        {project.artifact_count}
      </td>
      <td className="hidden px-5 py-5 text-base text-slate-500 md:table-cell">
        {formatDate(project.last_activity_at)}
      </td>
      <td className="px-7 py-5 text-right">
        <ProjectRowActions
          deletingProjectId={deletingProjectId}
          handleDeleteProject={handleDeleteProject}
          href={href}
          prefetchProjectHref={prefetchProjectHref}
          project={project}
        />
      </td>
    </tr>
  );
}

function ProjectStatusBadge({ status }: { status: ProjectSummary["status"] }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-semibold shadow-sm ${statusColor(status)}`}>
      <span className={`inline-block size-2 rounded-full ${statusDot(status)}`} />
      {status}
    </span>
  );
}

function ProjectRowActions({
  deletingProjectId,
  handleDeleteProject,
  href,
  prefetchProjectHref,
  project,
}: {
  deletingProjectId: string;
  handleDeleteProject: DeleteProjectHandler;
  href: string;
  prefetchProjectHref: PrefetchProjectHref;
  project: ProjectSummary;
}) {
  return (
    <div className="flex justify-end gap-2">
      <DeleteProjectButton
        deletingProjectId={deletingProjectId}
        handleDeleteProject={handleDeleteProject}
        project={project}
      />
      <Link
        href={href}
        prefetch={false}
        {...prefetchLinkHandlers(href, prefetchProjectHref)}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
      >
        Åpne <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}

function DeleteProjectButton({
  deletingProjectId,
  handleDeleteProject,
  project,
}: {
  deletingProjectId: string;
  handleDeleteProject: DeleteProjectHandler;
  project: ProjectSummary;
}) {
  return (
    <DeleteConfirmDialog
      title="Slett prosjekt?"
      description={`Dette sletter "${project.name}" med dokumenter, analyser, chat og genererte utkast. Handlingen kan ikke angres.`}
      confirmLabel="Slett prosjekt"
      onConfirm={() => handleDeleteProject(project)}
    >
      <button
        type="button"
        disabled={Boolean(deletingProjectId)}
        aria-label={`Slett ${project.name}`}
        className="inline-flex size-9 items-center justify-center rounded-md border border-transparent bg-transparent text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
      >
        {deletingProjectId === project.id ? (
          <Spinner className="size-4" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </button>
    </DeleteConfirmDialog>
  );
}

function ProjectMobileCards({
  deletingProjectId,
  filteredProjects,
  handleDeleteProject,
  prefetchProjectHref,
}: {
  deletingProjectId: string;
  filteredProjects: ProjectSummary[];
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
}) {
  return (
    <div className="grid gap-3 p-4 md:hidden">
      {filteredProjects.map((project) => (
        <ProjectMobileCard
          key={project.id}
          deletingProjectId={deletingProjectId}
          handleDeleteProject={handleDeleteProject}
          prefetchProjectHref={prefetchProjectHref}
          project={project}
        />
      ))}
    </div>
  );
}

function ProjectMobileCard({
  deletingProjectId,
  handleDeleteProject,
  prefetchProjectHref,
  project,
}: {
  deletingProjectId: string;
  handleDeleteProject: DeleteProjectHandler;
  prefetchProjectHref: PrefetchProjectHref;
  project: ProjectSummary;
}) {
  const action = nextProjectAction(project);
  const href = projectActionHref(project);

  return (
    <article
      onFocusCapture={() => prefetchProjectHref(href)}
      onPointerEnter={() => prefetchProjectHref(href)}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={href}
            prefetch={false}
            {...prefetchLinkHandlers(href, prefetchProjectHref)}
            className="block text-base font-bold text-slate-950"
          >
            {project.name}
          </Link>
          <p className="mt-1 text-sm text-slate-500">
            {project.customer_name || "Kunde ikke satt"}
            {project.industry ? ` · ${project.industry}` : ""}
          </p>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>
      <ProjectMobileStats project={project} />
      <p className="mt-4 text-sm font-semibold text-slate-950">{action.label}</p>
      <p className="mt-1 text-sm leading-5 text-slate-500">{action.detail}</p>
      <div className="mt-4 flex justify-between gap-2">
        <DeleteProjectButton
          deletingProjectId={deletingProjectId}
          handleDeleteProject={handleDeleteProject}
          project={project}
        />
        <Link
          href={href}
          prefetch={false}
          {...prefetchLinkHandlers(href, prefetchProjectHref)}
          className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
        >
          Åpne
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </article>
  );
}

function ProjectMobileStats({ project }: { project: ProjectSummary }) {
  const stats = [
    { label: "Dok.", value: project.document_count },
    { label: "Utkast", value: project.artifact_count },
    { label: "Endret", value: formatDate(project.last_activity_at) },
  ];

  return (
    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-md bg-slate-50 px-2 py-2">
          <p className="truncate text-sm font-semibold tabular-nums text-slate-950">
            {stat.value}
          </p>
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-slate-500">
            {stat.label}
          </p>
        </div>
      ))}
    </div>
  );
}
