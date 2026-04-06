import Link from "next/link";
import { ArrowRight, FileText, Plus, Search, Sparkles } from "lucide-react";

import type { ProjectSummary } from "@/lib/types";

function statusColor(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Løsningsdokument lastet opp":
      return "text-blue-700";
    case "Kundeanalyse klar":
      return "text-amber-700";
    default:
      return "text-muted-foreground";
  }
}

function statusDot(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Løsningsdokument lastet opp":
      return "bg-blue-500";
    case "Kundeanalyse klar":
      return "bg-amber-500";
    default:
      return "bg-muted-foreground/50";
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ProjectDashboard({ projects }: { projects: ProjectSummary[] }) {
  const totals = {
    total: projects.length,
    analyses: projects.filter((p) => p.customer_analysis_generated).length,
    solutionDocs: projects.filter((p) => p.solution_document_uploaded).length,
    artifacts: projects.reduce((sum, p) => sum + p.artifact_count, 0),
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 lg:px-0">
      {/* Hero */}
      <section className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Tilbudsarbeidsflate
        </h1>
        <p className="mt-2 max-w-2xl text-base text-foreground/70">
          Last opp kundedokumenter, løsningsdokumenter og støttekontekst.
          Appen hjelper teamet å forstå kunden og bygge bedre
          løsningsutkast raskere.
        </p>
        <div className="mt-5 flex items-center gap-3">
          <Link
            href="/projects/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="size-4" />
            Ny analyse
          </Link>
          {projects[0] ? (
            <Link
              href={`/projects/${projects[0].id}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Åpne siste prosjekt
              <ArrowRight className="size-4" />
            </Link>
          ) : null}
        </div>
      </section>

      {/* Stats row */}
      <section className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border shadow-sm sm:grid-cols-4">
        {[
          { label: "Prosjekter", value: totals.total },
          { label: "Kundeanalyser", value: totals.analyses },
          { label: "Løsningsdokumenter", value: totals.solutionDocs },
          { label: "Løsningsutkast", value: totals.artifacts },
        ].map((item) => (
          <div
            key={item.label}
            className="bg-background px-5 py-4"
          >
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {item.value}
            </p>
            <p className="mt-0.5 text-sm font-medium text-muted-foreground">{item.label}</p>
          </div>
        ))}
      </section>

      {/* Projects list */}
      <section className="overflow-hidden rounded-lg border bg-border shadow-sm">
        <div className="flex items-center justify-between bg-muted px-5 py-3">
          <h2 className="text-sm font-bold text-foreground">Prosjekter</h2>
          <p className="text-sm text-muted-foreground">
            {projects.length} {projects.length === 1 ? "prosjekt" : "prosjekter"}
          </p>
        </div>

        {projects.length === 0 ? (
          <div className="bg-background py-14 text-center">
            <Search className="mx-auto size-7 text-muted-foreground/40" />
            <p className="mt-3 text-base font-semibold text-foreground">
              Ingen prosjekter ennå
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Opprett en analyse og last opp et primært kundedokument for å
              komme i gang.
            </p>
            <Link
              href="/projects/new"
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="size-4" />
              Opprett første prosjekt
            </Link>
          </div>
        ) : (
          <div>
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group flex flex-col gap-1.5 border-t border-border bg-background px-5 py-4 transition-colors hover:bg-muted/60 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <h3 className="truncate text-base font-semibold text-foreground group-hover:text-primary">
                      {project.name}
                    </h3>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                      <span
                        className={`inline-block size-2 rounded-full ${statusDot(project.status)}`}
                      />
                      <span className={statusColor(project.status)}>
                        {project.status}
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {project.customer_name || "Kunde ikke satt"}
                    {project.industry ? ` · ${project.industry}` : ""}
                  </p>
                  {project.description ? (
                    <p className="mt-0.5 line-clamp-1 text-sm text-foreground/60">
                      {project.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-4 text-sm text-muted-foreground sm:flex-col sm:items-end sm:gap-1">
                  <span>{formatDate(project.last_activity_at)}</span>
                  <span className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <FileText className="size-3.5" />
                      {project.document_count}
                    </span>
                    <span className="flex items-center gap-1">
                      <Sparkles className="size-3.5" />
                      {project.artifact_count}
                    </span>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Workflow guide */}
      <section className="mt-8 overflow-hidden rounded-lg border bg-muted shadow-sm">
        <div className="px-5 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-foreground/60">
            Arbeidsflyt
          </h2>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <div className="bg-background px-5 py-4">
            <p className="text-sm font-bold text-foreground">
              1. Last opp grunnlag
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Primært kundedokument, løsningsdokument og støttekontekst.
            </p>
          </div>
          <div className="bg-background px-5 py-4">
            <p className="text-sm font-bold text-foreground">
              2. Analyser kunden
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Generer kundeanalyse med implisitte krav, risiko, posisjonering
              og overordnet løsningsdesign.
            </p>
          </div>
          <div className="bg-background px-5 py-4">
            <p className="text-sm font-bold text-foreground">
              3. Generer utkast
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Generer et løsningsutkast som bygger på prosjektkonteksten og
              kundeanalysen.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
