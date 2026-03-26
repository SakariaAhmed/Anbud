"use client";

import { FormEvent } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  NativeSelect,
  NativeSelectOption,
} from "@/components/projects/primitives";
import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { ARTIFACT_TYPES, formatDate } from "@/components/projects/project-workspace-shared";
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
    <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
      <Card className="border border-slate-200/80 bg-white shadow-none">
        <CardHeader className="border-b border-slate-200/80 pb-4">
          <CardTitle className="text-2xl font-semibold text-slate-950">Generator</CardTitle>
          <CardDescription className="text-base leading-7 text-slate-600">
            Generer tilbudsstrategi, løsningsutkast, verdiargumentasjon og andre tekster direkte fra prosjektkonteksten.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-5">
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="artifactType">Artefakttype</Label>
              <NativeSelect id="artifactType" value={artifactType} onChange={(event) => onArtifactTypeChange(event.target.value as GeneratedArtifactType)}>
                {ARTIFACT_TYPES.map((item) => (
                  <NativeSelectOption key={item.value} value={item.value}>
                    {item.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="artifactInstructions">Ekstra føringer</Label>
              <textarea
                id="artifactInstructions"
                value={artifactInstructions}
                onChange={(event) => onArtifactInstructionsChange(event.target.value)}
                placeholder="Hva vil du at generatoren skal fokusere på?"
                className="min-h-40 rounded-2xl border border-input bg-transparent px-3 py-3 text-base leading-7 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Generer utkast
            </Button>
          </form>
          {busy && busyMessage ? (
            <div className="mt-4 flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <LoaderCircle className="size-4 animate-spin text-sky-700" />
              <span>{busyMessage}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border border-slate-200/80 bg-white shadow-none">
        <CardHeader className="border-b border-slate-200/80 pb-4">
          <CardTitle className="text-2xl font-semibold text-slate-950">Lagrede artefakter</CardTitle>
          <CardDescription className="text-base leading-7 text-slate-600">
            Generatoren lagrer hvert utkast, slik at dere kan sammenligne versjoner og jobbe videre i teamet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {artifacts.map((artifact) => (
            <div key={artifact.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                  {ARTIFACT_TYPES.find((item) => item.value === artifact.artifact_type)?.label || artifact.artifact_type}
                </span>
                <p className="text-sm text-slate-500">{formatDate(artifact.created_at)}</p>
              </div>
              <h3 className="mt-3 text-xl font-semibold text-slate-950">{artifact.title}</h3>
              <div className="mt-4 overflow-x-auto rounded-2xl bg-white p-4">
                <MarkdownViewer content={artifact.content_markdown} className="text-sm text-slate-700" />
              </div>
            </div>
          ))}
          {artifacts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-8 text-slate-600">
              Ingen generatorutkast ennå.
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
