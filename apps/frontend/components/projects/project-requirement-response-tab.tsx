"use client";

import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import {
  ArrowDownToLine,
  CheckSquare,
  ChevronDown,
  FileCheck2,
  FileText,
  Pencil,
  Save,
  Trash2,
  Upload,
  X,
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

type RequirementTableRow = {
  ref: string;
  requirement: string;
  answer: string;
  source: string;
};

type RequirementContentSegment =
  | { type: "markdown"; content: string }
  | { type: "table"; rows: RequirementTableRow[] };

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isRequirementTableHeader(line: string) {
  const cells = splitMarkdownTableRow(line).map((cell) => cell.toLowerCase());
  return (
    cells.some((cell) => cell.includes("kravref")) &&
    cells.some((cell) => cell === "krav") &&
    cells.some((cell) => cell === "svar") &&
    cells.some((cell) => cell.includes("kildegrunnlag"))
  );
}

function isMarkdownDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableIdFromRef(ref: string) {
  return ref.match(/Tabell ID\s+\d{1,3}-\d{1,3}[A-Z]?/i)?.[0] ?? "";
}

function serviceFromRef(ref: string, tableId: string) {
  return ref.replace(tableId, "").replace(/^\s*[-:,]\s*/, "").trim();
}

function parseRequirementContent(content: string): RequirementContentSegment[] {
  const lines = content.split("\n");
  const segments: RequirementContentSegment[] = [];
  let markdownBuffer: string[] = [];

  function flushMarkdown() {
    const markdown = markdownBuffer.join("\n").trim();
    if (markdown) {
      segments.push({ type: "markdown", content: markdown });
    }
    markdownBuffer = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isRequirementTableHeader(line) || !isMarkdownDivider(lines[index + 1] ?? "")) {
      markdownBuffer.push(line);
      continue;
    }

    const tableLines = [line, lines[index + 1] ?? ""];
    index += 2;
    while (index < lines.length && /^\s*\|/.test(lines[index] ?? "")) {
      tableLines.push(lines[index] ?? "");
      index += 1;
    }
    index -= 1;

    const rows = tableLines.slice(2).map(splitMarkdownTableRow);
    const tableRequirementRows = rows
      .filter((row) => tableIdFromRef(row[0] ?? ""))
      .map((row) => ({
        ref: row[0] ?? "",
        requirement: row[1] ?? "",
        answer: row[2] ?? "",
        source: row[3] ?? "",
      }));

    if (!tableRequirementRows.length) {
      markdownBuffer.push(tableLines.join("\n"));
      continue;
    }

    const regularRows = rows.filter((row) => !tableIdFromRef(row[0] ?? ""));
    if (regularRows.length) {
      markdownBuffer.push(
        [
          tableLines[0],
          tableLines[1],
          ...regularRows.map((row) => `| ${row.join(" | ")} |`),
        ].join("\n"),
      );
    }

    flushMarkdown();
    segments.push({ type: "table", rows: tableRequirementRows });
  }

  flushMarkdown();
  return segments;
}

function RequirementResponseContent({
  content,
}: {
  content: string;
}) {
  const segments = parseRequirementContent(content);

  return (
    <div className="space-y-6">
      {segments.map((segment, index) => {
        if (segment.type === "markdown") {
          return (
            <MarkdownViewer
              key={`markdown-${index}`}
              content={segment.content}
              className="artifact-markdown requirement-markdown text-[1.02rem] text-foreground"
            />
          );
        }

        const groups = new Map<string, RequirementTableRow[]>();
        for (const row of segment.rows) {
          const tableId = tableIdFromRef(row.ref) || "Tabellkrav";
          groups.set(tableId, [...(groups.get(tableId) ?? []), row]);
        }

        return (
          <div key={`table-${index}`} className="space-y-5">
            {Array.from(groups.entries()).map(([tableId, rows]) => (
              <section
                key={tableId}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h5 className="text-sm font-bold text-slate-950">{tableId}</h5>
                  <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600">
                    {rows.length} krav
                  </span>
                </div>
                <div className="space-y-3">
                  {rows.map((row, rowIndex) => {
                    const service = serviceFromRef(row.ref, tableId);
                    return (
                      <article
                        key={`${row.ref}-${rowIndex}`}
                        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          {service ? (
                            <span className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">
                              {service}
                            </span>
                          ) : null}
                          <span className="text-xs font-medium text-slate-500">
                            {row.source}
                          </span>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
                          <div>
                            <p className="mb-1 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                              Krav
                            </p>
                            <p className="text-sm leading-7 text-slate-900">
                              {row.requirement}
                            </p>
                          </div>
                          <div>
                            <p className="mb-1 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                              Atea svar
                            </p>
                            <p className="text-sm leading-7 text-slate-900">
                              {row.answer}
                            </p>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function ProjectRequirementResponseTab({
  projectId,
  documents,
  artifacts,
  uploadBusy,
  generateBusy,
  busyMessage,
  deletingDocumentId,
  onUpload,
  selectedDocumentId,
  onSelectedDocumentChange,
  onDeleteDocument,
  onUpdateArtifact,
  onSubmit,
}: {
  projectId: string;
  documents: ProjectDocument[];
  artifacts: GeneratedArtifact[];
  uploadBusy: boolean;
  generateBusy: boolean;
  busyMessage: string;
  deletingDocumentId: string | null;
  onUpload: (file: File) => Promise<ProjectDocument | null>;
  selectedDocumentId: string;
  onSelectedDocumentChange: (documentId: string) => void;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onUpdateArtifact: (
    artifact: GeneratedArtifact,
    value: { title: string; content_markdown: string },
  ) => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requirementDocuments = useMemo(
    () => documents.filter(isRequirementDocument),
    [documents],
  );
  const selectableDocuments = useMemo(() => documents, [documents]);
  const requirementResponses = artifacts.filter(
    (artifact) => artifact.artifact_type === "forbedret_kravsvar",
  );
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(
    null,
  );
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [savingArtifactId, setSavingArtifactId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectableDocuments.length) {
      if (selectedDocumentId) {
        onSelectedDocumentChange("");
      }
      return;
    }

    if (!selectableDocuments.some((document) => document.id === selectedDocumentId)) {
      onSelectedDocumentChange(
        requirementDocuments[0]?.id ?? selectableDocuments[0]?.id ?? "",
      );
    }
  }, [
    onSelectedDocumentChange,
    requirementDocuments,
    selectableDocuments,
    selectedDocumentId,
  ]);

  async function uploadSelectedFile(nextFile: File | null) {
    if (!nextFile || uploadBusy) return;

    setFile(nextFile);
    const uploadedDocument = await onUpload(nextFile);
    if (uploadedDocument) {
      onSelectedDocumentChange(uploadedDocument.id);
    }
    setFile(null);
    setFileInputKey((current) => current + 1);
  }

  function startEdit(artifact: GeneratedArtifact) {
    setEditingArtifactId(artifact.id);
    setEditTitle(artifact.title || "Kravbesvarelse");
    setEditContent(artifact.content_markdown || "");
  }

  async function saveEdit(artifact: GeneratedArtifact) {
    setSavingArtifactId(artifact.id);
    try {
      await onUpdateArtifact(artifact, {
        title: editTitle,
        content_markdown: editContent,
      });
      setEditingArtifactId(null);
    } catch {
      // Parent action sets the visible error message.
    } finally {
      setSavingArtifactId(null);
    }
  }

  async function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    await uploadSelectedFile(event.dataTransfer.files?.[0] ?? null);
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
          {requirementResponses.map((artifact, index) => (
            <details
              key={artifact.id}
              open={index === 0}
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
              <div className="space-y-4 rounded-b-2xl border-t bg-card px-7 py-7">
                {editingArtifactId === artifact.id ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor={`requirement-title-${artifact.id}`}
                        className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        Tittel
                      </Label>
                      <Input
                        id={`requirement-title-${artifact.id}`}
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label
                        htmlFor={`requirement-content-${artifact.id}`}
                        className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        Kravbesvarelse
                      </Label>
                      <Textarea
                        id={`requirement-content-${artifact.id}`}
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                        className="min-h-[28rem] resize-y rounded-xl font-mono text-sm leading-6"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-lg"
                        onClick={() => setEditingArtifactId(null)}
                        disabled={savingArtifactId === artifact.id}
                      >
                        <X data-icon="inline-start" />
                        Avbryt
                      </Button>
                      <Button
                        type="button"
                        className="h-9 rounded-lg"
                        onClick={() => void saveEdit(artifact)}
                        disabled={savingArtifactId === artifact.id}
                      >
                        {savingArtifactId === artifact.id ? (
                          <Spinner className="size-4" />
                        ) : (
                          <Save data-icon="inline-start" />
                        )}
                        Lagre endringer
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-lg"
                        onClick={() => startEdit(artifact)}
                      >
                        <Pencil data-icon="inline-start" />
                        Rediger
                      </Button>
                    </div>
                    <RequirementResponseContent
                      content={
                        artifact.content_markdown ||
                        "Denne kravbesvarelsen mangler lagret innhold. Generer den på nytt for å få et komplett resultat."
                      }
                    />
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-w-0 space-y-6">
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-950">Generer svar</h3>
        </div>
        <form onSubmit={onSubmit} className="p-5">
          <div className="mb-4 space-y-2">
            <Label
              htmlFor="requirement-document-select"
              className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500"
            >
              Bruk dokument
            </Label>
            <select
              id="requirement-document-select"
              value={selectedDocumentId}
              onChange={(event) => onSelectedDocumentChange(event.target.value)}
              disabled={generateBusy || uploadBusy || selectableDocuments.length === 0}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-950 outline-none transition-colors focus:border-slate-950 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
            >
              {selectableDocuments.length ? (
                selectableDocuments.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.title}
                  </option>
                ))
              ) : (
                <option value="">Ingen dokumenter lastet opp</option>
              )}
            </select>
            <p className="text-xs leading-5 text-slate-500">
              Valgt dokument brukes som kravgrunnlag. Nye opplastinger velges automatisk.
            </p>
          </div>
          <Button
            type="submit"
            className="h-11 w-full rounded-xl"
            disabled={generateBusy || !selectedDocumentId}
          >
            {generateBusy ? (
              <Spinner className="size-4" />
            ) : (
              <CheckSquare data-icon="inline-start" />
            )}
            Generer kravbesvarelse
          </Button>
          {generateBusy && busyMessage ? (
            <div className="mt-3 flex min-w-0 items-center gap-2 text-sm text-primary">
              <Spinner className="size-3.5" />
              <span className="min-w-0">{busyMessage}</span>
            </div>
          ) : null}
        </form>
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm xl:col-start-1">
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
                  kundeanalyse, Bilag 1, løsningsbeskrivelse og tjenestebeskrivelse
                  som grunnlag for svarene.
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-4 p-5">
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
                  eller klikk for å velge PDF, DOCX, Excel, TXT eller MD.
                </span>
                {file ? (
                  <span className="mt-3 flex max-w-full flex-col items-center gap-1 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
                    <span className="max-w-full truncate">{file.name}</span>
                    <span className="font-medium text-primary/70">
                      {uploadBusy
                        ? "Laster opp ..."
                        : `Tittel: ${fileTitle(file)}`}
                    </span>
                  </span>
                ) : null}
              </label>
              <Input
                key={fileInputKey}
                id="requirement-file"
                type="file"
                accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
                className="sr-only"
                onChange={(event) =>
                  void uploadSelectedFile(event.target.files?.[0] ?? null)
                }
              />
            </div>

            {uploadBusy ? (
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
                <Spinner className="size-4" />
                <span className="min-w-0">Laster opp kravdokument ...</span>
              </div>
            ) : null}
          </div>
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

      {savedRequirementResponses}
    </div>
  );
}
