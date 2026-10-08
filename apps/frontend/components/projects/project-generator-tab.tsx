"use client";

import { FormEvent } from "react";
import { ChevronDown, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { ArtifactActions } from "@/components/projects/artifact-actions";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  formatDate,
  GenerationProgress,
} from "@/components/projects/project-workspace-shared";
import type { GeneratedArtifact } from "@/lib/types";

export function ProjectGeneratorTab({
  artifacts,
  busy,
  busyMessage,
  busyProgress,
  onDeleteArtifact,
  onSubmit,
}: {
  artifacts: GeneratedArtifact[];
  busy: boolean;
  busyMessage: string;
  busyProgress: number;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const losningsutkast = artifacts.filter(
    (artifact) => artifact.artifact_type === "losningsutkast",
  );

  return (
    <div className="min-w-0 space-y-5">
      <section className="min-w-0">
        <div className="space-y-3">
          <form onSubmit={onSubmit} className="flex flex-wrap items-center justify-end gap-3">
            <Button
              type="submit"

              disabled={busy}
            >
              {busy ? (
                <Spinner className="size-4" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              Generer ny løsningsbeskrivelse
            </Button>
            {busy && busyMessage ? (
              <div className="w-full">
                <GenerationProgress message={busyMessage} progress={busyProgress} />
              </div>
            ) : null}
          </form>
        </div>
      </section>

      <section className="min-w-0">
        <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
          Lagrede løsningsbeskrivelser
        </h3>
        {losningsutkast.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Ingen løsningsbeskrivelser ennå.
          </p>
        ) : (
          <div className="space-y-3">
            {losningsutkast.map((artifact) => (
              <details key={artifact.id} className="group min-w-0 border-y border-slate-200 bg-white">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-semibold tracking-normal text-muted-foreground">
                      <span>Løsningsbeskrivelse</span>
                      <span>·</span>
                      <span>{formatDate(artifact.created_at)}</span>
                    </div>
                    <h4 className="mt-2 text-base font-semibold leading-6 text-foreground">
                      {artifact.title || "Generatorutkast uten tittel"}
                    </h4>
                  </div>
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t bg-card px-4 py-4">
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                      <ArtifactActions artifact={artifact} />
                      <DeleteConfirmDialog
                        title="Slett løsningsbeskrivelse?"
                        description={`Dette sletter "${artifact.title || "utkast uten tittel"}" fra prosjektet. Handlingen kan ikke angres.`}
                        confirmLabel="Slett utkast"
                        onConfirm={() => onDeleteArtifact(artifact)}
                      >
                          <Button type="button" variant="destructive" className="h-9 rounded-md">
                          <Trash2 data-icon="inline-start" />
                          Slett
                        </Button>
                      </DeleteConfirmDialog>
                    </div>
                    <MarkdownViewer
                      content={
                        artifact.content_markdown ||
                        "Dette generatorutkastet mangler lagret innhold. Generer det på nytt for å få et komplett resultat."
                      }
                      className="artifact-markdown text-sm text-foreground"
                    />
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
