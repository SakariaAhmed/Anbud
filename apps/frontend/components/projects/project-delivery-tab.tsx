"use client";

import { FormEvent } from "react";
import {
  CalendarClock,
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
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-950">
              {latestArtifact?.title || "Fremdriftsplan"}
            </h2>
            {latestArtifact ? (
              <div className="mt-2 flex w-fit items-center gap-2 text-xs text-slate-600">
                <CalendarClock className="size-4" />
                {formatDate(latestArtifact.created_at)}
              </div>
            ) : null}
          </div>
          <form onSubmit={onSubmit}>
            <Button
              type="submit"

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


    </div>
  );
}

function PhaseList({ phases, muted = false }: { phases: ProgressPhase[]; muted?: boolean }) {
  if (!phases.length) {
    return <p className="py-4 text-sm text-muted-foreground">Ingen faser er lagret i denne planen.</p>;
  }

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      {phases.map((phase, index) => (
        <article key={`${phase.title}-${index}`} className={`min-w-0 border-t border-slate-200 pt-4 ${muted ? "border-dashed" : ""}`}>
          <h4 className="text-base font-semibold text-slate-950">{phase.title}</h4>
          <MarkdownViewer content={phase.body} className="analysis-prose mt-3 text-sm leading-7 text-slate-700" />
        </article>
      ))}
    </div>
  );
}
