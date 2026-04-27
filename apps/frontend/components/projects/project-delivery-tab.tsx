"use client";

import { FormEvent } from "react";
import { ChevronDown, ListChecks, Sparkles } from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  AnalysisTabEmptyState,
  formatDate,
} from "@/components/projects/project-workspace-shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { GeneratedArtifact } from "@/lib/types";

export function ProjectDeliveryTab({
  artifacts,
  artifactInstructions,
  busy,
  busyMessage,
  onArtifactInstructionsChange,
  onSubmit,
}: {
  artifacts: GeneratedArtifact[];
  artifactInstructions: string;
  busy: boolean;
  busyMessage: string;
  onArtifactInstructionsChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const deliveryArtifacts = [...artifacts]
    .filter((artifact) => artifact.artifact_type === "gjennomforing_og_risiko")
    .sort(
      (left, right) =>
        new Date(right.created_at).getTime() -
        new Date(left.created_at).getTime(),
    );

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(18rem,22.5rem)_minmax(0,1fr)]">
      <div className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="border-b bg-muted/50 px-6 py-5">
          <p className="text-[0.72rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Gjennomføring
          </p>
          <h2 className="mt-2 text-xl font-bold text-foreground">
            Bygg neste versjon av planen
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Generatoren lager en konkret og faseinndelt gjennomføringsplan for
            skyarkitekt- og leveranseteamet, basert på kundedokumenter,
            kundeanalyse, støttedokumenter og tidligere utkast.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5 p-6">
          <div className="space-y-2">
            <Label
              htmlFor="deliveryArtifactInstructions"
              className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"
            >
              Ekstra føringer
            </Label>
            <Textarea
              id="deliveryArtifactInstructions"
              value={artifactInstructions}
              onChange={(e) => onArtifactInstructionsChange(e.target.value)}
              placeholder="Hva skal gjennomføringsplanen vektlegge for teamet akkurat nå?"
              className="min-h-36 resize-y rounded-xl"
            />
          </div>
          <Button
            type="submit"
            className="h-11 w-full rounded-xl"
            disabled={busy}
          >
            {busy ? (
              <Spinner className="size-4" />
            ) : (
              <Sparkles data-icon="inline-start" />
            )}
            Generer gjennomføringsplan
          </Button>
        </form>

        {busy && busyMessage ? (
          <div className="mt-1 flex min-w-0 items-center gap-2 px-5 pb-4 text-sm text-primary">
            <Spinner className="size-3.5" />
            <span className="min-w-0">{busyMessage}</span>
          </div>
        ) : null}
      </div>

      <div className="min-w-0">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">
          Lagrede gjennomføringsplaner
        </h3>
        {deliveryArtifacts.length === 0 ? (
          <AnalysisTabEmptyState>
            Ingen gjennomføringsplan ennå. Generer en egen plan her.
          </AnalysisTabEmptyState>
        ) : (
          <div className="space-y-3">
            {deliveryArtifacts.map((artifact) => (
              <details
                key={artifact.id}
                className="group min-w-0 rounded-2xl border bg-card"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      <span>Gjennomføring</span>
                      <span>·</span>
                      <span>{formatDate(artifact.created_at)}</span>
                    </div>
                    <div className="mt-2 flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                        <ListChecks className="size-4.5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-xl font-semibold leading-8 text-foreground">
                          {artifact.title || "Gjennomføringsplan uten tittel"}
                        </h4>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          Konkret faseplan, beslutningspunkter og risikostyring
                          for gjennomføringsteamet.
                        </p>
                      </div>
                    </div>
                  </div>
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="rounded-b-2xl border-t bg-card px-7 py-7">
                  <MarkdownViewer
                    content={
                      artifact.content_markdown ||
                      "Denne gjennomføringsplanen mangler lagret innhold. Generer den på nytt for å få et komplett resultat."
                    }
                    className="artifact-markdown text-[1.02rem] text-foreground"
                  />
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
