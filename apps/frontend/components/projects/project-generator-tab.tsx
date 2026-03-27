"use client";

import { FormEvent } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import {
  ARTIFACT_TYPES,
  formatDate,
} from "@/components/projects/project-workspace-shared";
import type { GeneratedArtifact, GeneratedArtifactType } from "@/lib/types";

export function ProjectGeneratorTab({
  artifacts,
  artifactType,
  artifactInstructions,
  busy,
  busyMessage,
  onArtifactTypeChange,
  onArtifactInstructionsChange,
  onSubmit,
}: {
  artifacts: GeneratedArtifact[];
  artifactType: GeneratedArtifactType;
  artifactInstructions: string;
  busy: boolean;
  busyMessage: string;
  onArtifactTypeChange: (value: GeneratedArtifactType) => void;
  onArtifactInstructionsChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* Form */}
      <div className="overflow-hidden rounded-lg border shadow-sm">
        <div className="bg-muted px-4 py-3">
          <h2 className="text-sm font-bold text-foreground">Generator</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Generer tilbudsstrategi, løsningsutkast og andre tekster fra
            prosjektkonteksten.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="artifactType">Artefakttype</Label>
            <Select
              value={artifactType}
              onValueChange={(v) =>
                onArtifactTypeChange(v as GeneratedArtifactType)
              }
            >
              <SelectTrigger id="artifactType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARTIFACT_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="artifactInstructions">Ekstra føringer</Label>
            <Textarea
              id="artifactInstructions"
              value={artifactInstructions}
              onChange={(e) => onArtifactInstructionsChange(e.target.value)}
              placeholder="Hva vil du at generatoren skal fokusere på?"
              className="min-h-28 resize-y"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? (
              <Spinner className="size-4" />
            ) : (
              <Sparkles data-icon="inline-start" />
            )}
            Generer utkast
          </Button>
        </form>

        {busy && busyMessage ? (
          <div className="mt-3 flex items-center gap-2 px-4 pb-3 text-sm text-primary">
            <Spinner className="size-3.5" />
            <span>{busyMessage}</span>
          </div>
        ) : null}
      </div>

      {/* Artifacts list */}
      <div>
        <h3 className="mb-3 text-sm font-bold text-foreground">
          Lagrede artefakter
        </h3>
        {artifacts.length === 0 ? (
          <p className="rounded-lg border py-8 text-center text-sm text-muted-foreground shadow-sm">
            Ingen generatorutkast ennå.
          </p>
        ) : (
          <div className="space-y-2">
            {artifacts.map((artifact) => (
              <Collapsible key={artifact.id}>
                <CollapsibleTrigger
                  className="group flex w-full items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {ARTIFACT_TYPES.find(
                          (t) => t.value === artifact.artifact_type,
                        )?.label || artifact.artifact_type}
                      </span>
                      <span>·</span>
                      <span>{formatDate(artifact.created_at)}</span>
                    </div>
                    <h4 className="mt-0.5 text-sm font-medium text-foreground">
                      {artifact.title}
                    </h4>
                  </div>
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border-x border-b px-3 py-3">
                    <MarkdownViewer
                      content={artifact.content_markdown}
                      className="text-sm text-foreground"
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
