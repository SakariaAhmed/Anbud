"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import {
  ArrowDownToLine,
  CheckSquare,
  ChevronDown,
  FileCheck2,
  FileText,
  Trash2,
  Upload,
} from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { formatDate } from "@/components/projects/project-workspace-shared";
import { Input } from "@/components/projects/primitives";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { GeneratedArtifact, ProjectDocument } from "@/lib/types";

function fileTitle(file: File) {
  return `Kravdokument - ${file.name.replace(/\.[^.]+$/, "")}`;
}

function isRequirementDocument(document: ProjectDocument) {
  const text = `${document.title} ${document.file_name}`.toLowerCase();
  return (
    text.includes("krav") ||
    text.includes("requirement") ||
    text.includes("requirements")
  );
}

export function ProjectRequirementResponseTab({
  projectId,
  documents,
  artifacts,
  instructions,
  uploadBusy,
  generateBusy,
  busyMessage,
  deletingDocumentId,
  onUpload,
  onDeleteDocument,
  onInstructionsChange,
  onSubmit,
}: {
  projectId: string;
  documents: ProjectDocument[];
  artifacts: GeneratedArtifact[];
  instructions: string;
  uploadBusy: boolean;
  generateBusy: boolean;
  busyMessage: string;
  deletingDocumentId: string | null;
  onUpload: (file: File) => Promise<void>;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onInstructionsChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requirementDocuments = documents.filter(isRequirementDocument);
  const requirementResponses = artifacts.filter(
    (artifact) => artifact.artifact_type === "forbedret_kravsvar",
  );
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  async function onUploadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    await onUpload(file);
    setFile(null);
    setFileInputKey((current) => current + 1);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    setFile(event.dataTransfer.files?.[0] ?? null);
  }

  const savedRequirementResponses = (
    <section className="min-w-0">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">
        Lagrede kravbesvarelser
      </h3>
      {requirementResponses.length === 0 ? (
        <p className="rounded-xl border py-10 text-center text-sm text-muted-foreground shadow-sm">
          Ingen kravbesvarelse ennå.
        </p>
      ) : (
        <div className="space-y-3">
          {requirementResponses.map((artifact) => (
            <details
              key={artifact.id}
              className="group min-w-0 rounded-2xl border bg-card"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/30">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <span>Kravbesvarelse</span>
                    <span>·</span>
                    <span>{formatDate(artifact.created_at)}</span>
                  </div>
                  <h4 className="mt-2 text-xl font-semibold leading-8 text-foreground">
                    {artifact.title || "Kravbesvarelse uten tittel"}
                  </h4>
                </div>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="rounded-b-2xl border-t bg-card px-7 py-7">
                <MarkdownViewer
                  content={
                    artifact.content_markdown ||
                    "Denne kravbesvarelsen mangler lagret innhold. Generer den på nytt for å få et komplett resultat."
                  }
                  className="artifact-markdown text-[1.02rem] text-foreground"
                />
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-w-0 space-y-6">
      {savedRequirementResponses}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-5">
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
                <FileCheck2 className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                  Krav og svar
                </p>
                <h2 className="mt-1 text-xl font-bold text-slate-950">
                  Kravbesvarelse
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Last opp kravdokumentet som skal fylles ut. AI-en bruker
                  kundeanalyse, Bilag 1, løsningsutkast og tjenestebeskrivelse
                  som grunnlag for svarene.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={onUploadSubmit} className="space-y-4 p-5">
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">
                Kravdokument
              </p>
              <label
                htmlFor="requirement-file"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center transition-colors ${
                  dragActive
                    ? "border-slate-950 bg-slate-100"
                    : "border-slate-300 bg-slate-50 hover:border-primary/60 hover:bg-primary/5"
                }`}
              >
                <span className="mb-3 flex size-11 items-center justify-center rounded-lg bg-white text-primary shadow-sm">
                  <Upload className="size-5" />
                </span>
                <span className="text-sm font-semibold text-slate-950">
                  Dra og slipp kravdokumentet her
                </span>
                <span className="mt-1 text-xs leading-5 text-slate-500">
                  eller klikk for å velge PDF, DOCX, TXT eller MD.
                </span>
                {file ? (
                  <span className="mt-3 flex max-w-full flex-col items-center gap-1 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
                    <span className="max-w-full truncate">{file.name}</span>
                    <span className="font-medium text-primary/70">
                      Tittel: {fileTitle(file)}
                    </span>
                  </span>
                ) : null}
              </label>
              <Input
                key={fileInputKey}
                id="requirement-file"
                type="file"
                accept=".pdf,.docx,.txt,.md"
                className="sr-only"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>

            <Button
              type="submit"
              className="h-11 w-full rounded-lg"
              disabled={uploadBusy || !file}
            >
              {uploadBusy ? (
                <Spinner className="size-4" />
              ) : (
                <Upload data-icon="inline-start" />
              )}
              Last opp kravdokument
            </Button>
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
            <h3 className="text-sm font-bold text-slate-950">
              Generer svar
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Ekstra føringer kan brukes til format, tone eller hvilke krav som
              skal prioriteres.
            </p>
          </div>
          <form onSubmit={onSubmit} className="space-y-4 p-5">
            <div className="space-y-2">
              <Label
                htmlFor="requirementInstructions"
                className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"
              >
                Ekstra føringer
              </Label>
              <Textarea
                id="requirementInstructions"
                value={instructions}
                onChange={(event) => onInstructionsChange(event.target.value)}
                placeholder="For eksempel: behold tabellformatet fra dokumentet, eller svar bare på obligatoriske krav."
                className="min-h-32 resize-y rounded-xl"
              />
            </div>
            <Button
              type="submit"
              className="h-11 w-full rounded-xl"
              disabled={generateBusy}
            >
              {generateBusy ? (
                <Spinner className="size-4" />
              ) : (
                <CheckSquare data-icon="inline-start" />
              )}
              Generer kravbesvarelse
            </Button>
            {generateBusy && busyMessage ? (
              <div className="flex min-w-0 items-center gap-2 text-sm text-primary">
                <Spinner className="size-3.5" />
                <span className="min-w-0">{busyMessage}</span>
              </div>
            ) : null}
          </form>
        </section>

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
            <h3 className="text-sm font-bold text-slate-950">
              Lagrede kravdokumenter
            </h3>
          </div>
          {requirementDocuments.length ? (
            <div className="divide-y divide-slate-200">
              {requirementDocuments.map((document) => (
                <div
                  key={document.id}
                  className="flex min-w-0 items-start justify-between gap-3 px-5 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-sky-700" />
                      <p className="truncate text-sm font-semibold text-slate-950">
                        {document.title}
                      </p>
                    </div>
                    <p className="mt-1 pl-6 text-xs text-slate-500">
                      {document.file_format.toUpperCase()} ·{" "}
                      {Math.max(1, Math.round(document.file_size_bytes / 1024))} KB
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <a
                      href={`/api/projects/${projectId}/documents/${document.id}`}
                      className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950"
                    >
                      <ArrowDownToLine className="size-3.5" />
                    </a>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void onDeleteDocument(document)}
                      disabled={deletingDocumentId === document.id}
                    >
                      {deletingDocumentId === document.id ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                <FileText className="size-5" />
              </div>
              <p className="mt-3 text-sm font-semibold text-slate-950">
                Ingen kravdokumenter funnet
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Last opp et dokument med krav eller kravspesifikasjon.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
