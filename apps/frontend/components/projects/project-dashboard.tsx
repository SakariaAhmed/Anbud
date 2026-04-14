import Link from "next/link";
import { ArrowRight, BarChart3, FileText, FolderOpen, Plus, Search, Sparkles } from "lucide-react";

import type { ProjectSummary } from "@/lib/types";

function statusColor(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
    case "Løsningsdokument lastet opp":
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
    case "Løsningsdokument lastet opp":
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
  }).format(new Date(value));
}

export function ProjectDashboard({ projects }: { projects: ProjectSummary[] }) {
  const totals = {
    total: projects.length,
    analyses: projects.filter((p) => p.customer_analysis_generated).length,
    solutionDocs: projects.filter((p) => p.solution_document_uploaded).length,
    artifacts: projects.reduce((sum, p) => sum + p.artifact_count, 0),
  };

  const stats = [
    { label: "Totalt prosjekter", value: totals.total, icon: FolderOpen, accent: "border-t-blue-900" },
    { label: "Kundeanalyser", value: totals.analyses, icon: BarChart3, accent: "border-t-emerald-600" },
    { label: "Løsningsdokumenter", value: totals.solutionDocs, icon: FileText, accent: "border-t-amber-500" },
    { label: "Løsningsutkast", value: totals.artifacts, icon: Sparkles, accent: "border-t-violet-600" },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-8">
      {/* Page Header */}
      <section className="mb-8">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              Oversikt
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
              Prosjektoversikt
            </h1>
            <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
              Administrer tilbudsprosjekter, kundeanalyser og løsningsutkast for teamet.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/projects/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-800"
            >
              <Plus className="size-3.5" />
              Nytt prosjekt
            </Link>
          </div>
        </div>
      </section>

      {/* Stat Cards */}
      <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((item) => (
          <div
            key={item.label}
            className={`rounded-md border border-border bg-card px-4 py-4 shadow-sm border-t-2 ${item.accent}`}
          >
            <div className="flex items-center justify-between">
              <item.icon className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-3 text-2xl font-bold tabular-nums text-foreground">
              {item.value}
            </p>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {item.label}
            </p>
          </div>
        ))}
      </section>

      {/* Project Table */}
      <section className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-5 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
            Prosjekter
          </h2>
          <span className="text-xs text-muted-foreground">
            {projects.length} {projects.length === 1 ? "prosjekt" : "totalt"}
          </span>
        </div>

        {projects.length === 0 ? (
          <div className="py-16 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">
              Ingen prosjekter ennå
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Opprett et prosjekt og last opp kundedokumenter for å komme i gang.
            </p>
            <Link
              href="/projects/new"
              className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-blue-800"
            >
              <Plus className="size-3.5" />
              Opprett prosjekt
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b-2 border-border bg-muted/30">
                  <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Prosjekt
                  </th>
                  <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Status
                  </th>
                  <th className="hidden px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:table-cell">
                    Dok.
                  </th>
                  <th className="hidden px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:table-cell">
                    Utkast
                  </th>
                  <th className="hidden px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground md:table-cell">
                    Sist endret
                  </th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.id}
                    className="group border-b border-border last:border-b-0 transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-3">
                      <Link href={`/projects/${project.id}`} className="block">
                        <p className="text-sm font-semibold text-foreground group-hover:text-primary">
                          {project.name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {project.customer_name || "Kunde ikke satt"}
                          {project.industry ? ` · ${project.industry}` : ""}
                        </p>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-medium ${statusColor(project.status)}`}>
                        <span className={`inline-block size-1.5 rounded-full ${statusDot(project.status)}`} />
                        {project.status}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {project.document_count}
                    </td>
                    <td className="hidden px-4 py-3 text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {project.artifact_count}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-xs text-muted-foreground md:table-cell">
                      {formatDate(project.last_activity_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${project.id}`}
                        className="text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        Åpne <ArrowRight className="ml-1 inline size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Workflow Steps */}
      <section className="mt-8 rounded-md border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Arbeidsflyt
        </h2>
        <div className="flex items-start gap-4">
          {[
            { step: "1", title: "Last opp grunnlag", desc: "Primært kundedokument, løsningsdokument og støttekontekst." },
            { step: "2", title: "Analyser kunden", desc: "Generer kundeanalyse med krav, risiko og posisjonering." },
            { step: "3", title: "Generer utkast", desc: "Generer løsningsutkast basert på prosjektkonteksten." },
          ].map((item, i) => (
            <div key={item.step} className="flex flex-1 items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {item.step}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.desc}</p>
              </div>
              {i < 2 ? <div className="mt-3.5 hidden h-px flex-1 bg-border lg:block" /> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
