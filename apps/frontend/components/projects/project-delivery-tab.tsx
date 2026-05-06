"use client";

import { FormEvent } from "react";
import { CalendarClock, ChevronDown, Flag, Milestone, Sparkles } from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { formatDate } from "@/components/projects/project-workspace-shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { GeneratedArtifact } from "@/lib/types";

interface ProgressPhase {
  title: string;
  body: string;
}

const DEFAULT_PHASES: ProgressPhase[] = [
  {
    title: "Fase 1: Avklar neste beslutning",
    body: "Gjør kundeanalysen beslutningsklar før teamet går videre.\n\n- bekreft kundens viktigste driver og hvor risiko må reduseres først\n- avklar hvilke åpne spørsmål som må lukkes internt eller med kunden\n- bestem hva som må være klart før løsningsbeskrivelsen oppdateres",
  },
  {
    title: "Fase 2: Konkretiser løsningsretning",
    body: "Oversett innsikten til en tydelig retning for løsning og tilbudstekst.\n\n- formuler anbefalt målarkitektur og viktigste plattformgrep\n- koble løsningsvalg til kundens mål, risiko og evalueringskriterier\n- pek ut hvilke deler som trenger mer bevis eller presisjon",
  },
  {
    title: "Fase 3: Planlegg første leveransebølge",
    body: "Gjør planen operativ ved å definere hva som bør skje først.\n\n- velg første leveransebølge basert på risiko, avhengigheter og kundeverdi\n- beskriv hva teamet må etablere før første leveranse kan starte\n- tydeliggjør ansvar, kundebidrag og akseptansekriterier",
  },
  {
    title: "Fase 4: Klargjør tilbuds- og leveransegrunnlag",
    body: "Gjør materialet klart for videre tilbudsarbeid og praktisk oppfølging.\n\n- oppdater løsningsbeskrivelsen med faseplanen og kundespesifikke bevis\n- kontroller at fremdriftsplanen henger sammen med risiko, verdi og evaluering\n- avklar hvilke beslutninger som skal følges opp før endelig tilbud eller oppstart",
  },
];

function extractProgressPhases(markdown: string): ProgressPhase[] {
  const sections = markdown.split(/\n(?=##\s+)/g);

  return sections
    .map((section) => {
      const match = section.match(/^##\s+(.+?)\s*\n([\s\S]*)$/);
      if (!match || !/^Fase\s+\d+/i.test(match[1].trim())) {
        return null;
      }

      return {
        title: match[1].trim(),
        body: match[2].trim(),
      };
    })
    .filter((phase): phase is ProgressPhase => Boolean(phase));
}

export function ProjectDeliveryTab({
  artifacts,
  busy,
  busyMessage,
  hasCustomerAnalysis,
  onSubmit,
}: {
  artifacts: GeneratedArtifact[];
  busy: boolean;
  busyMessage: string;
  hasCustomerAnalysis: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const progressArtifacts = [...artifacts]
    .filter((artifact) => artifact.artifact_type === "gjennomforing_og_risiko")
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    );
  const latestArtifact = progressArtifacts[0] ?? null;
  const latestPhases = latestArtifact
    ? extractProgressPhases(latestArtifact.content_markdown)
    : [];
  const visiblePhases = latestPhases.length ? latestPhases : DEFAULT_PHASES;

  return (
    <div className="min-w-0 space-y-5">
      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.98),rgba(255,255,255,0.94))] px-5 py-5 md:px-6">
          <div className="min-w-0">
            <p className="text-[0.72rem] font-bold uppercase tracking-[0.18em] text-slate-500">
              Etter kundeanalyse
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">
              {latestArtifact?.title || "Fremdriftsplan"}
            </h2>
            {latestArtifact ? (
              <div className="mt-2 flex w-fit items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-600">
                <CalendarClock className="size-4" />
                {formatDate(latestArtifact.created_at)}
              </div>
            ) : null}
          </div>
          <form onSubmit={onSubmit}>
            <Button
              type="submit"
              className="h-10 rounded-lg"
              disabled={busy || !hasCustomerAnalysis}
            >
              {busy ? (
                <Spinner className="size-4" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              Lag fremdriftsplan
            </Button>
          </form>
        </div>

        {busy && busyMessage ? (
          <div className="mx-5 mt-5 flex min-w-0 items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary md:mx-6">
            <Spinner className="size-3.5" />
            <span className="min-w-0">{busyMessage}</span>
          </div>
        ) : null}

        {!hasCustomerAnalysis ? (
          <div className="mx-5 mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 md:mx-6">
            Fremdriftsplanen lages etter at kundeanalysen er klar.
          </div>
        ) : null}

        <div className="px-5 py-5 md:px-6">
          <PhaseList phases={visiblePhases} muted={!latestArtifact} />
        </div>
      </div>

      {progressArtifacts.length > 1 ? (
        <div className="rounded-xl border border-border/70 bg-card px-4 py-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Tidligere faseplaner
          </p>
          <div className="space-y-2">
            {progressArtifacts.slice(1).map((artifact) => (
              <details
                key={artifact.id}
                className="group rounded-lg border border-border/70 bg-background"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-semibold text-foreground hover:text-primary">
                  <span className="min-w-0 truncate">
                    {artifact.title || "Fremdriftsplan uten tittel"}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-border/70 px-3 py-3">
                  <PhaseList
                    phases={extractProgressPhases(artifact.content_markdown)}
                  />
                </div>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PhaseList({
  phases,
  muted = false,
}: {
  phases: ProgressPhase[];
  muted?: boolean;
}) {
  if (!phases.length) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-5 py-8 text-center text-sm text-muted-foreground">
        Ingen faser er lagret i denne planen.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {phases.map((phase, index) => (
        <article
          key={`${phase.title}-${index}`}
          className={`grid min-w-0 gap-4 rounded-xl border border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(248,250,252,0.92))] px-4 py-4 shadow-[0_12px_28px_rgba(15,23,42,0.05)] md:grid-cols-[3.5rem_minmax(0,1fr)] md:px-5 ${
            muted ? "border-dashed" : ""
          }`}
        >
          <div className="flex items-center gap-3 md:block">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-sm font-black text-white shadow-sm">
              {index + 1}
            </div>
            <div className="h-px flex-1 bg-slate-200 md:mx-auto md:mt-3 md:h-full md:w-px" />
          </div>
          <div className="min-w-0">
            <div className="mb-3 flex min-w-0 items-center gap-2">
              {index === phases.length - 1 ? (
                <Flag className="size-4 shrink-0 text-emerald-600" />
              ) : (
                <Milestone className="size-4 shrink-0 text-blue-600" />
              )}
              <h4 className="min-w-0 text-lg font-bold tracking-tight text-slate-950">
                {phase.title}
              </h4>
            </div>
            <MarkdownViewer
              content={phase.body}
              className="analysis-prose max-w-none text-[0.98rem] leading-7 text-slate-700"
            />
          </div>
        </article>
      ))}
    </div>
  );
}
