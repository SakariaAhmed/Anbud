import { ArrowRight, FileStack, MessagesSquare, Plus } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Link,
} from "@/components/projects/primitives";
import type { ProjectSummary } from "@/lib/types";

function statusTone(status: ProjectSummary["status"]) {
  switch (status) {
    case "Klar for sparring":
      return "default";
    case "Løsningsdokument lastet opp":
      return "secondary";
    case "Kundeanalyse klar":
      return "outline";
    default:
      return "outline";
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
    analyses: projects.filter((project) => project.customer_analysis_generated).length,
    evaluations: projects.filter((project) => project.solution_evaluation_generated).length,
    chatReady: projects.filter((project) => project.has_chat).length,
  };

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.14),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(34,197,94,0.10),_transparent_24%),linear-gradient(180deg,_#f8fbff_0%,_#f4f7fb_100%)]">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-4 py-8 md:px-6 md:py-10">
        <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <Card className="border border-slate-200/80 bg-white/90 shadow-none backdrop-blur">
            <CardHeader className="gap-4 border-b border-slate-200/80 pb-6">
              <Badge variant="outline" className="w-fit border-sky-200 bg-sky-50 text-sky-700">
                Anbud
              </Badge>
              <div className="space-y-4">
                <CardTitle className="max-w-4xl text-4xl font-semibold tracking-tight text-slate-950 md:text-6xl">
                  Kundeanalyse, løsningsvurdering og sparring for tilbudsteam.
                </CardTitle>
                <CardDescription className="max-w-3xl text-base leading-8 text-slate-600 md:text-lg">
                  Last opp kundedokumenter, løsningsutkast og støttekontekst. Appen hjelper teamet å forstå kunden,
                  vurdere konkurransekraft og bygge bedre svar raskere.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 pt-6">
              <Button size="lg" render={<Link href="/projects/new" />}>
                <Plus />
                Ny analyse
              </Button>
              <Button variant="outline" size="lg" render={<Link href={projects[0] ? `/projects/${projects[0].id}` : "/projects/new"} />}>
                Åpne siste prosjekt
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {[
              { label: "Prosjekter", value: totals.total, note: "Aktive analyser i arbeidsflaten" },
              { label: "Kundeanalyser", value: totals.analyses, note: "Prosjekter med strukturert analyse" },
              { label: "Løsningsvurderinger", value: totals.evaluations, note: "Prosjekter med evaluert svarutkast" },
              { label: "Chat brukt", value: totals.chatReady, note: "Prosjekter med sparringshistorikk" },
            ].map((item) => (
              <Card key={item.label} className="border border-slate-200/80 bg-white/88 shadow-none backdrop-blur">
                <CardContent className="flex items-center justify-between py-6">
                  <div>
                    <p className="text-sm uppercase tracking-[0.18em] text-slate-500">{item.label}</p>
                    <p className="mt-3 text-4xl font-semibold text-slate-950">{item.value}</p>
                  </div>
                  <p className="max-w-[180px] text-right text-sm leading-6 text-slate-500">{item.note}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="border border-slate-200/80 bg-white/90 shadow-none">
            <CardHeader className="border-b border-slate-200/80 pb-4">
              <CardTitle className="text-2xl font-semibold text-slate-950">Prosjekter</CardTitle>
              <CardDescription className="text-base text-slate-600">
                Hvert prosjekt samler kundedokument, støttedokumenter, kundeanalyse, løsningsvurdering, generator og
                chat i én arbeidsflate.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-5">
              {projects.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-8 text-slate-600">
                  Ingen prosjekter ennå. Opprett en analyse og last opp et primært kundedokument for å komme i gang.
                </div>
              ) : (
                projects.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`} className="block">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5 transition hover:border-slate-300 hover:bg-white">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-xl font-semibold text-slate-950">{project.name}</h3>
                            <Badge variant={statusTone(project.status)}>{project.status}</Badge>
                          </div>
                          <p className="text-sm text-slate-500">
                            {project.customer_name || "Kunde ikke satt"}{project.industry ? ` · ${project.industry}` : ""}
                          </p>
                          {project.description ? (
                            <p className="max-w-3xl text-base leading-7 text-slate-700">{project.description}</p>
                          ) : null}
                        </div>
                        <div className="text-right text-sm text-slate-500">Oppdatert {formatDate(project.last_activity_at)}</div>
                      </div>
                      <div className="mt-5 flex flex-wrap gap-2">
                        <Badge variant="outline">{project.document_count} dokumenter</Badge>
                        <Badge variant="outline">{project.supporting_document_count} støttedokumenter</Badge>
                        <Badge variant="outline">{project.artifact_count} generatorutkast</Badge>
                        <Badge variant="outline">{project.has_chat ? "Chat aktiv" : "Ingen chat ennå"}</Badge>
                      </div>
                    </div>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border border-slate-200/80 bg-[#0c172b] text-white shadow-none">
            <CardHeader className="border-b border-white/10 pb-4">
              <CardTitle className="text-2xl font-semibold">Arbeidsflyt</CardTitle>
              <CardDescription className="text-sm leading-7 text-slate-300">
                Én arbeidsflate for å gå fra kundedokument til tilbudsstrategi.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-5">
              {[
                { icon: FileStack, title: "1. Last opp grunnlag", text: "Primært kundedokument, løsningsdokument og støttekontekst." },
                { icon: ArrowRight, title: "2. Analyser og vurder", text: "Generer kundeanalyse og evaluer hvor godt løsningen faktisk svarer." },
                { icon: MessagesSquare, title: "3. Sparr og generer", text: "Bruk chat og generator til å styrke strategi, verdi og svar." },
              ].map((item) => (
                <div key={item.title} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <item.icon className="size-4 text-sky-300" />
                    <p className="text-sm font-medium tracking-[0.14em] text-sky-100 uppercase">{item.title}</p>
                  </div>
                  <p className="text-sm leading-7 text-slate-300">{item.text}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
