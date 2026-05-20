"use client";

import { FormEvent } from "react";
import {
  CalendarClock,
  ChevronDown,
  Flag,
  Milestone,
  Sparkles,
  Trash2,
} from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { ArtifactActions } from "@/components/projects/artifact-actions";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  formatDate,
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { GeneratedArtifact } from "@/lib/types";

interface ProgressPhase {
  title: string;
  body: string;
}

const MAX_PROGRESS_PHASES = 4;

const PHASE_CARD_STYLES = [
  {
    railClassName: "from-blue-600 via-blue-500 to-cyan-500",
    iconClassName: "bg-blue-600 text-white",
    shellClassName: "border-blue-200 bg-blue-50/70 text-blue-950",
    phaseIconClassName: "text-blue-700",
  },
  {
    railClassName: "from-emerald-600 via-emerald-500 to-teal-500",
    iconClassName: "bg-emerald-600 text-white",
    shellClassName: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
    phaseIconClassName: "text-emerald-700",
  },
  {
    railClassName: "from-amber-500 via-orange-400 to-rose-400",
    iconClassName: "bg-amber-500 text-white",
    shellClassName: "border-amber-200 bg-amber-50/72 text-amber-950",
    phaseIconClassName: "text-amber-700",
  },
  {
    railClassName: "from-slate-800 via-slate-700 to-indigo-500",
    iconClassName: "bg-slate-950 text-white",
    shellClassName: "border-slate-200 bg-slate-50/85 text-slate-950",
    phaseIconClassName: "text-slate-700",
  },
] as const;

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
  busyProgress,
  hasCustomerAnalysis,
  onDeleteArtifact,
  onSubmit,
}: {
  artifacts: GeneratedArtifact[];
  busy: boolean;
  busyMessage: string;
  busyProgress: number;
  hasCustomerAnalysis: boolean;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
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
          <div className="mx-5 mt-5 md:mx-6">
            <GenerationProgress message={busyMessage} progress={busyProgress} />
          </div>
        ) : null}

        {!hasCustomerAnalysis ? (
          <div className="mx-5 mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900 md:mx-6">
            Fremdriftsplanen lages etter at kundeanalysen er klar.
          </div>
        ) : null}

        <div className="px-5 py-5 md:px-6">
          {latestArtifact ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <ArtifactActions artifact={latestArtifact} />
              <DeleteConfirmDialog
                title="Slett fremdriftsplan?"
                description={`Dette sletter "${latestArtifact.title || "fremdriftsplan uten tittel"}" fra prosjektet. Handlingen kan ikke angres.`}
                confirmLabel="Slett plan"
                onConfirm={() => onDeleteArtifact(latestArtifact)}
              >
                <Button type="button" variant="destructive" className="h-9 rounded-lg">
                  <Trash2 data-icon="inline-start" />
                  Slett
                </Button>
              </DeleteConfirmDialog>
            </div>
          ) : null}
          {latestArtifact && latestPhases.length ? (
            <PhaseList phases={latestPhases} muted={false} />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600">
              Ingen prosjektspesifikk fremdriftsplan er generert ennå. Bruk
              knappen over for å lage en plan basert på kundedokumenter,
              analyse, risiko, avhengigheter og relevante tjenestebeskrivelser.
            </div>
          )}
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
                  <div className="mb-3 flex justify-end">
                    <DeleteConfirmDialog
                      title="Slett fremdriftsplan?"
                      description={`Dette sletter "${artifact.title || "fremdriftsplan uten tittel"}" fra prosjektet. Handlingen kan ikke angres.`}
                      confirmLabel="Slett plan"
                      onConfirm={() => onDeleteArtifact(artifact)}
                    >
                      <Button type="button" variant="destructive" size="sm">
                        <Trash2 data-icon="inline-start" />
                        Slett
                      </Button>
                    </DeleteConfirmDialog>
                  </div>
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
  const visiblePhases = phases.slice(0, MAX_PROGRESS_PHASES);

  if (!visiblePhases.length) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-5 py-8 text-center text-sm text-muted-foreground">
        Ingen faser er lagret i denne planen.
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      {visiblePhases.map((phase, index) => {
        const style = PHASE_CARD_STYLES[index % PHASE_CARD_STYLES.length];
        const isFinalVisiblePhase = index === visiblePhases.length - 1;

        return (
        <article
          key={`${phase.title}-${index}`}
          className={`relative flex h-full min-w-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white/88 shadow-[0_16px_40px_rgba(15,23,42,0.06)] ${
            muted ? "border-dashed" : ""
          }`}
        >
          <div
            className={`absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b ${style.railClassName}`}
          />
          <div className="flex min-w-0 flex-1 px-5 py-5 md:px-6">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-4">
              <div
                className={`flex size-12 shrink-0 items-center justify-center rounded-lg shadow-sm ${style.iconClassName}`}
              >
                <span className="text-base font-black">{index + 1}</span>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-start gap-2">
                  {isFinalVisiblePhase ? (
                    <Flag
                      className={`mt-1 size-4 shrink-0 ${style.phaseIconClassName}`}
                    />
                  ) : (
                    <Milestone
                      className={`mt-1 size-4 shrink-0 ${style.phaseIconClassName}`}
                    />
                  )}
                  <h4 className="min-w-0 text-lg font-semibold leading-7 tracking-[-0.025em] text-slate-950">
                    {phase.title}
                  </h4>
                </div>
                <div className={`mt-4 flex-1 rounded-lg border px-4 py-4 ${style.shellClassName}`}>
                  <MarkdownViewer
                    content={phase.body}
                    className="analysis-prose max-w-none text-[0.96rem] font-medium leading-7"
                  />
                </div>
              </div>
            </div>
          </div>
        </article>
        );
      })}
    </div>
  );
}
