"use client";

import { FormEvent } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  FileText,
  Sparkles,
  Trash2,
} from "lucide-react";

import { ArtifactActions } from "@/components/projects/artifact-actions";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  formatDate,
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { GeneratedArtifact, ProjectDocument } from "@/lib/types";

export function ProjectBilag1Tab({
  documents,
  artifacts,
  busy,
  busyMessage,
  busyProgress,
  onDeleteArtifact,
  onSubmit,
}: {
  documents: ProjectDocument[];
  artifacts: GeneratedArtifact[];
  busy: boolean;
  busyMessage: string;
  busyProgress: number;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const bilag1Artifacts = [...artifacts]
    .filter((artifact) => artifact.artifact_type === "bilag1_rekonstruksjon")
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    );
  const latestArtifact = bilag1Artifacts[0] ?? null;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border/70 bg-white px-5 py-5 shadow-sm md:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl">
            <p className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Rekonstruert Bilag 1
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
              Generer Bilag 1 fra prosjektets dokumenter
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Bruker opplastede kundedokumenter, Bilag 2, kravgrunnlag og
              kundeanalyse for å lage et ryddig utkast med behov,
              smertepunkter, krav, avklaringer og kildeindikasjoner.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2">
                <FileText className="size-4" />
                {documents.length} dokument{documents.length === 1 ? "" : "er"} i
                prosjektet
              </span>
              {latestArtifact ? (
                <span className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2">
                  <CalendarClock className="size-4" />
                  Sist generert {formatDate(latestArtifact.created_at)}
                </span>
              ) : null}
            </div>
          </div>

          <form onSubmit={onSubmit} className="w-full max-w-md space-y-3">
            <Textarea
              name="instructions"
              placeholder="Valgfritt: skriv hva som skal godkjennes, rettes eller regenereres i bestemte seksjoner."
              className="min-h-24 rounded-lg text-sm"
            />
            <Button
              type="submit"
              className="h-11 w-full rounded-lg"
              disabled={busy || documents.length === 0}
            >
              {busy ? (
                <Spinner className="size-4" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              Generer Bilag 1
            </Button>
          </form>
        </div>

        {busy && busyMessage ? (
          <div className="mt-5">
            <GenerationProgress message={busyMessage} progress={busyProgress} />
          </div>
        ) : null}

        {documents.length === 0 ? (
          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Last opp kundedokumenter på prosjektet før Bilag 1 kan genereres.
          </div>
        ) : null}
      </section>

      {latestArtifact ? (
        <section className="rounded-xl border border-border/70 bg-white shadow-sm">
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3 border-b border-border/70 px-5 py-4 text-left transition-colors hover:bg-muted/30 md:px-6">
              <div className="min-w-0">
                <p className="text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Generert Bilag 1
                </p>
                <h3 className="mt-2 text-xl font-semibold leading-8 text-foreground">
                  {latestArtifact.title || "Rekonstruert Bilag 1"}
                </h3>
              </div>
              <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="px-5 py-5 md:px-7 md:py-7">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <ArtifactActions artifact={latestArtifact} />
                <DeleteConfirmDialog
                  title="Slett Bilag 1-utkast?"
                  description={`Dette sletter "${latestArtifact.title || "Bilag 1-utkast"}" fra prosjektet. Handlingen kan ikke angres.`}
                  confirmLabel="Slett utkast"
                  onConfirm={() => onDeleteArtifact(latestArtifact)}
                >
                  <Button type="button" variant="destructive" className="h-9 rounded-lg">
                    <Trash2 data-icon="inline-start" />
                    Slett
                  </Button>
                </DeleteConfirmDialog>
              </div>
              <MarkdownViewer
                content={
                  latestArtifact.content_markdown ||
                  "Dette Bilag 1-utkastet mangler lagret innhold. Generer det på nytt for å få et komplett resultat."
                }
                className="artifact-markdown text-[1.02rem] text-foreground"
              />
            </div>
          </details>
        </section>
      ) : documents.length > 0 ? (
        <section className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            Ingen Bilag 1-utkast er generert ennå.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Trykk på knappen over for å lage første versjon.
          </p>
        </section>
      ) : null}

      <section className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950 shadow-sm md:px-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold">Kontroller før bruk</h3>
            <p className="mt-1 text-sm leading-6">
              Les spesielt åpne avklaringer og konfidens-tabellen. Tekst med lav
              konfidens bør bekreftes før den brukes i tilbud eller kontrakt.
            </p>
          </div>
        </div>
      </section>

      {bilag1Artifacts.length > 1 ? (
        <section className="rounded-xl border border-border/70 bg-card px-4 py-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Tidligere Bilag 1-utkast
          </p>
          <div className="space-y-2">
            {bilag1Artifacts.slice(1).map((artifact) => (
              <details key={artifact.id} className="group rounded-lg border bg-background">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/40">
                  <span className="min-w-0 truncate">
                    {artifact.title || "Rekonstruert Bilag 1"} ·{" "}
                    {formatDate(artifact.created_at)}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t px-4 py-4">
                  <div className="mb-4 flex justify-end">
                    <DeleteConfirmDialog
                      title="Slett Bilag 1-utkast?"
                      description={`Dette sletter "${artifact.title || "Bilag 1-utkast"}" fra prosjektet. Handlingen kan ikke angres.`}
                      confirmLabel="Slett utkast"
                      onConfirm={() => onDeleteArtifact(artifact)}
                    >
                      <Button type="button" variant="destructive" size="sm">
                        <Trash2 data-icon="inline-start" />
                        Slett
                      </Button>
                    </DeleteConfirmDialog>
                  </div>
                  <MarkdownViewer
                    content={artifact.content_markdown}
                    className="artifact-markdown text-[0.98rem] text-foreground"
                  />
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
