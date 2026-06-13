"use client";

import type { FormEvent } from "react";
import { Download, FileText, FolderOpen, Trash2, Upload } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import { Input } from "@/components/projects/primitives";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  ProjectDocument,
  ProjectDocumentRole,
  ProjectServiceDescription,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type ProjectDocumentsTabProps = {
  projectId: string;
  documents: ProjectDocument[];
  services: ProjectServiceDescription[];
  uploadOpen: boolean;
  onToggleUploadOpen: () => void;
  docTitle: string;
  onDocTitleChange: (value: string) => void;
  uploadRole: ProjectDocumentRole;
  onUploadRoleChange: (value: ProjectDocumentRole) => void;
  selectedDocumentName: string;
  onFileChange: (file: File | null) => void;
  documentFileInputKey: number;
  onUploadDocument: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  uploadBusy: boolean;
  deletingDocumentId: string | null;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
};

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Ukjent størrelse";
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pageCountLabel(pageCount: number | null | undefined) {
  if (!pageCount) {
    return "Sider: ikke tilgjengelig";
  }

  return pageCount === 1 ? "Sider: 1" : `Sider: ${pageCount}`;
}

function downloadFileName(document: ProjectDocument) {
  return document.file_name || `${document.title}.${document.file_format}`;
}

function projectDocumentRoleLabel(document: ProjectDocument) {
  if (document.role === "primary_customer_document") return "Kundedokument";
  if (document.role === "primary_solution_document") return "Løsningsdokument";
  if (document.supporting_subtype === "kravdokument") return "Kravdokument";
  if (document.supporting_subtype === "rfp") return "RFP";
  if (document.supporting_subtype === "vedlegg") return "Vedlegg";
  return "Støttedokument";
}

function documentProcessingLabel(document: ProjectDocument) {
  switch (document.processing_status) {
    case "queued":
      return "Venter på RAG";
    case "processing":
      return "Indekserer";
    case "basic_ready":
      return "RAG klar";
    case "enhanced_ready":
      return "RAG forbedret";
    case "failed":
      return "Indeksering feilet";
  }
}

function documentProcessingClassName(document: ProjectDocument) {
  switch (document.processing_status) {
    case "queued":
      return "bg-slate-100 text-slate-700";
    case "processing":
      return "bg-blue-100 text-blue-700";
    case "basic_ready":
      return "bg-emerald-100 text-emerald-700";
    case "enhanced_ready":
      return "bg-teal-100 text-teal-700";
    case "failed":
      return "bg-red-100 text-red-700";
  }
}

export function ProjectDocumentsTab({
  projectId,
  documents,
  services,
  uploadOpen,
  onToggleUploadOpen,
  docTitle,
  onDocTitleChange,
  uploadRole,
  onUploadRoleChange,
  selectedDocumentName,
  onFileChange,
  documentFileInputKey,
  onUploadDocument,
  uploadBusy,
  deletingDocumentId,
  onDeleteDocument,
}: ProjectDocumentsTabProps) {
  const serviceDocuments = services.flatMap((service) =>
    service.documents.map((document) => ({ service, document })),
  );

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggleUploadOpen}
        className="flex w-full items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-5 text-left transition-colors hover:bg-slate-100/80"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <FolderOpen className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-xl font-bold text-slate-950">
              Dokumenter
            </span>
            <span className="mt-1 block text-sm text-slate-500">
              Prosjektdokumenter og tjenestebeskrivelser som brukes som grunnlag.
            </span>
          </span>
        </span>
        <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-bold text-blue-700">
          {documents.length} dokumenter
        </span>
      </button>

      {uploadOpen ? (
        <form
          onSubmit={onUploadDocument}
          className="grid gap-3 border-b border-slate-200 bg-white px-5 py-5 lg:grid-cols-[minmax(14rem,1fr)_minmax(12rem,16rem)_minmax(12rem,1fr)_auto]"
        >
          <Input
            value={docTitle}
            onChange={(event) => onDocTitleChange(event.target.value)}
            placeholder="Dokumenttittel"
            className="h-10 rounded-lg text-sm"
          />
          <select
            value={uploadRole}
            onChange={(event) =>
              onUploadRoleChange(event.target.value as ProjectDocumentRole)
            }
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-primary"
          >
            <option value="primary_customer_document">Kundedokument</option>
            <option value="primary_solution_document">Løsningsdokument</option>
            <option value="supporting_document">Støttedokument</option>
          </select>
          <label
            htmlFor="workspace-document-file"
            className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-center text-sm font-semibold text-slate-600 hover:border-primary/60 hover:bg-primary/5"
          >
            <Upload className="size-4" />
            <span className="min-w-0 truncate">
              {selectedDocumentName || "Velg dokument"}
            </span>
          </label>
          <Input
            key={documentFileInputKey}
            id="workspace-document-file"
            type="file"
            accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
            className="sr-only"
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          />
          <Button type="submit" className="h-10" disabled={uploadBusy}>
            {uploadBusy ? (
              <Spinner className="size-3.5" />
            ) : (
              <Upload data-icon="inline-start" />
            )}
            Last opp
          </Button>
        </form>
      ) : null}

      <div className="grid min-w-0 gap-6 px-5 py-5 xl:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Prosjektdokumenter
          </p>
          {documents.length ? (
            <div className="grid gap-3">
              {documents.map((document) => (
                <div
                  key={document.id}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-base font-semibold leading-6 text-slate-950">
                        {document.title}
                      </p>
                      <p className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                        {projectDocumentRoleLabel(document)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[0.68rem] font-bold",
                            documentProcessingClassName(document),
                          )}
                        >
                          {documentProcessingLabel(document)}
                        </span>
                        {document.processing_status === "processing" ? (
                          <Spinner className="size-3 text-blue-600" />
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <a
                        href={`/api/projects/${projectId}/documents/${document.id}`}
                        download={downloadFileName(document)}
                        className="inline-flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-950"
                        title={`Last ned ${downloadFileName(document)}`}
                      >
                        <Download className="size-3.5" />
                      </a>
                      <DeleteConfirmDialog
                        title="Slett dokument?"
                        description={`Dette sletter "${document.title}" fra prosjektet. Relaterte analyser kan også bli nullstilt. Handlingen kan ikke angres.`}
                        confirmLabel="Slett dokument"
                        onConfirm={() => onDeleteDocument(document)}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={deletingDocumentId === document.id}
                          className="text-slate-400 hover:text-destructive"
                        >
                          {deletingDocumentId === document.id ? (
                            <Spinner className="size-3" />
                          ) : (
                            <Trash2 className="size-3" />
                          )}
                        </Button>
                      </DeleteConfirmDialog>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm text-slate-500">
                    <span>{formatFileSize(document.file_size_bytes)}</span>
                    <span>·</span>
                    <span>{pageCountLabel(document.page_count)}</span>
                  </div>
                  {document.processing_message || document.processing_error ? (
                    <p className="mt-2 break-words text-xs leading-5 text-slate-500">
                      {document.processing_error ??
                        document.processing_message}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7">
              <p className="text-sm font-semibold text-slate-950">
                Ingen prosjektdokumenter ennå
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Start med kundedokument, kravspesifikasjon eller RFP. Det gir
                kundeanalyse, kravbesvarelse og utkast et felles grunnlag.
              </p>
              {!uploadOpen ? (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4"
                  onClick={onToggleUploadOpen}
                >
                  <Upload data-icon="inline-start" />
                  Last opp dokument
                </Button>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
            Tjenestebeskrivelser
          </p>
          {serviceDocuments.length ? (
            <div className="grid gap-3">
              {serviceDocuments.map(({ service, document }) => (
                <div
                  key={`${service.id}-${document.id}`}
                  className="rounded-xl border border-teal-200 bg-teal-50/55 px-4 py-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <FileText className="mt-1 size-4 shrink-0 text-teal-700" />
                    <div className="min-w-0">
                      <p className="break-words text-base font-semibold leading-6 text-slate-950">
                        {document.title}
                      </p>
                      <p className="mt-1 break-words text-sm leading-5 text-slate-600">
                        {service.name}
                      </p>
                    </div>
                  </div>
                  {service.recommended ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-bold text-amber-900">
                        Anbefalt
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm text-slate-500">
                    <span>{formatFileSize(document.file_size_bytes)}</span>
                    <span>·</span>
                    <span>{pageCountLabel(document.page_count)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-teal-200 bg-teal-50/40 px-4 py-7">
              <p className="text-sm font-semibold text-slate-950">
                Ingen tjenestedokumenter valgt
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Velg relevante tjenester i tjenestebeskrivelse-fanen for å
                bruke dem som kontekst i genereringene.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
