"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import { ArrowDownToLine, FileText, Trash2, Upload, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/projects/primitives";
import { splitServiceDescriptionDocuments } from "@/lib/service-description";
import type { ProjectDocument } from "@/lib/types";

function fileTitle(file: File) {
  return file.name.replace(/\.[^.]+$/, "");
}

export function ProjectServiceDescriptionTab({
  projectId,
  documents,
  uploadBusy,
  deletingDocumentId,
  onUpload,
  onDeleteDocument,
}: {
  projectId: string;
  documents: ProjectDocument[];
  uploadBusy: boolean;
  deletingDocumentId: string | null;
  onUpload: (file: File) => Promise<void>;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
}) {
  const { serviceDescriptionDocuments } =
    splitServiceDescriptionDocuments(documents);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
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

  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-5">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-white">
              <Wrench className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                Firmaets verktøykasse
              </p>
              <h2 className="mt-1 text-xl font-bold text-slate-950">
                Tjenestebeskrivelse
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Last opp dokumentet som beskriver tjenestene firmaet tilbyr.
                Systemløsningen bruker relevant innhold herfra når den bygges.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 p-5">
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">
              Dokument
            </p>
            <label
              htmlFor="service-file"
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
                Dra og slipp tjenestebeskrivelsen her
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
              id="service-file"
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
            {uploadBusy ? <Spinner className="size-4" /> : <Upload data-icon="inline-start" />}
            Last opp tjenestebeskrivelse
          </Button>
        </form>
      </section>

      <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-950">
            Lagret tjenestebeskrivelse
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            KI-en bruker dette som tjenestekatalog når systemløsningen genereres.
          </p>
        </div>

        {serviceDescriptionDocuments.length ? (
          <div className="divide-y divide-slate-200">
            {serviceDescriptionDocuments.map((document) => (
              <div
                key={document.id}
                className="flex min-w-0 items-start justify-between gap-3 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-teal-700" />
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
          <div className="px-5 py-12 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <FileText className="size-5" />
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-950">
              Ingen tjenestebeskrivelse lastet opp
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Last opp dokumentet firmaet bruker for å beskrive relevante
              tjenester og leveranseområder.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
