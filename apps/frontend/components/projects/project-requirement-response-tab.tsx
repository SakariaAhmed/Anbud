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

function downloadFileName(artifact: GeneratedArtifact) {
  const source = artifact.title || "kravbesvarelse";
  const safeTitle = source
    .toLowerCase()
    .replace(/[^a-z0-9æøå]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${safeTitle || "kravbesvarelse"}.pdf`;
}

function normalizePdfText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ");
}

function asciiBytes(value: string) {
  return Array.from(value, (char) => char.charCodeAt(0));
}

function pdfLiteralBytes(value: string) {
  const normalized = normalizePdfText(value);
  const bytes = [40];
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const byte = code <= 255 ? code : 63;
    if (byte === 40 || byte === 41 || byte === 92) {
      bytes.push(92);
    }
    bytes.push(byte);
  }
  bytes.push(41);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function stripMarkdown(value: string) {
  return normalizePdfText(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "- ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/g, "")
    .split("|")
    .map((cell) => stripMarkdown(cell));
}

function parseRequirementMarkdown(markdown: string) {
  const status: string[] = [];
  let headers: string[] = [];
  const rows: string[][] = [];
  let section = "";

  for (const rawLine of normalizePdfText(markdown).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#{1,6}\s+/u.test(line)) {
      const heading = stripMarkdown(line).toLowerCase();
      if (heading.includes("status")) {
        section = "status";
      } else if (heading.includes("kravbesvarelse")) {
        section = "requirements";
      } else {
        section = "";
      }
      continue;
    }

    if (section === "status") {
      status.push(stripMarkdown(line));
      continue;
    }

    if (section === "requirements" && line.startsWith("|")) {
      if (/^\|?[-:\s|]+\|?$/u.test(line)) continue;
      const cells = splitMarkdownTableRow(line);
      if (!headers.length) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }
  }

  return { status, headers, rows };
}

function wrapPdfText(value: string, width: number, fontSize: number) {
  const maxChars = Math.max(8, Math.floor(width / (fontSize * 0.48)));
  const words = stripMarkdown(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pushPdfText(
  target: number[],
  text: string,
  x: number,
  y: number,
  options?: {
    font?: "regular" | "bold";
    size?: number;
    color?: [number, number, number];
  },
) {
  const font = options?.font === "bold" ? "F2" : "F1";
  const size = options?.size ?? 10;
  const color = options?.color ?? [15, 23, 42];
  target.push(
    ...asciiBytes(
      `BT\n${(color[0] / 255).toFixed(3)} ${(color[1] / 255).toFixed(3)} ${(
        color[2] / 255
      ).toFixed(3)} rg\n/${font} ${size} Tf\n1 0 0 1 ${x.toFixed(2)} ${y.toFixed(
        2,
      )} Tm `,
    ),
  );
  target.push(...pdfLiteralBytes(text));
  target.push(...asciiBytes(" Tj\nET\n"));
}

function pushPdfRect(
  target: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    fill?: [number, number, number];
    stroke?: [number, number, number];
    lineWidth?: number;
  },
) {
  target.push(...asciiBytes("q\n"));
  if (options.fill) {
    target.push(
      ...asciiBytes(
        `${(options.fill[0] / 255).toFixed(3)} ${(
          options.fill[1] / 255
        ).toFixed(3)} ${(options.fill[2] / 255).toFixed(3)} rg\n`,
      ),
    );
  }
  if (options.stroke) {
    target.push(
      ...asciiBytes(
        `${(options.stroke[0] / 255).toFixed(3)} ${(
          options.stroke[1] / 255
        ).toFixed(3)} ${(options.stroke[2] / 255).toFixed(3)} RG\n${
          options.lineWidth ?? 0.7
        } w\n`,
      ),
    );
  }
  target.push(
    ...asciiBytes(
      `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(
        2,
      )} re ${options.fill && options.stroke ? "B" : options.fill ? "f" : "S"}\nQ\n`,
    ),
  );
}

function buildRequirementPdf(artifact: GeneratedArtifact) {
  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 24;
  const marginTop = 24;
  const marginBottom = 24;
  const tableWidth = pageWidth - marginX * 2;
  const columns = [44, 170, 430, tableWidth - 44 - 170 - 430];
  const content = parseRequirementMarkdown(artifact.content_markdown || "");
  const pages: Uint8Array[] = [];

  let page: number[] = [];
  let y = pageHeight - marginTop;

  function startPage() {
    page = [];
    pushPdfRect(page, 0, 0, pageWidth, pageHeight, { fill: [255, 255, 255] });
    y = pageHeight - marginTop;
  }

  function finishPage() {
    pages.push(Uint8Array.from(page));
  }

  function newPage() {
    if (page.length) finishPage();
    startPage();
  }

  function renderTableHeader() {
    const headerHeight = 26;
    y -= headerHeight;
    pushPdfRect(page, marginX, y, tableWidth, headerHeight, {
      fill: [241, 245, 249],
      stroke: [226, 232, 240],
    });
    let x = marginX;
    const labels = content.headers.length
      ? content.headers
      : ["Kravref.", "Krav", "Foreslått svar", "Kildegrunnlag"];
    labels.slice(0, 4).forEach((label, index) => {
      pushPdfText(page, label, x + 7, y + 9, {
        font: "bold",
        size: 8.5,
        color: [15, 23, 42],
      });
      x += columns[index];
    });
  }

  startPage();
  pushPdfText(
    page,
    `KRAVBESVARELSE · ${formatDate(artifact.created_at)}`,
    marginX,
    y,
    { font: "bold", size: 8, color: [100, 116, 139] },
  );
  y -= 24;
  pushPdfText(page, artifact.title || "Kravbesvarelse", marginX, y, {
    font: "bold",
    size: 16,
    color: [15, 23, 42],
  });
  y -= 42;

  pushPdfText(page, "Status", marginX, y, {
    font: "bold",
    size: 22,
    color: [15, 23, 42],
  });
  y -= 22;
  const statusLines = wrapPdfText(content.status.join(" "), tableWidth, 11);
  statusLines.forEach((line) => {
    pushPdfText(page, line, marginX, y, {
      size: 11,
      color: [30, 41, 59],
    });
    y -= 16;
  });
  y -= 20;

  pushPdfText(page, "Kravbesvarelse", marginX, y, {
    font: "bold",
    size: 22,
    color: [15, 23, 42],
  });
  y -= 18;
  renderTableHeader();

  content.rows.forEach((row) => {
    const cellLines = columns.map((width, index) =>
      wrapPdfText(row[index] ?? "", width - 14, 8.5),
    );
    const rowHeight = Math.max(
      32,
      Math.max(...cellLines.map((lines) => lines.length)) * 12 + 16,
    );
    if (y - rowHeight < marginBottom) {
      newPage();
      renderTableHeader();
    }
    y -= rowHeight;
    pushPdfRect(page, marginX, y, tableWidth, rowHeight, {
      fill: [255, 255, 255],
      stroke: [226, 232, 240],
    });

    let x = marginX;
    cellLines.forEach((lines, columnIndex) => {
      let textY = y + rowHeight - 17;
      lines.forEach((line) => {
        pushPdfText(page, line, x + 7, textY, {
          size: 8.5,
          color: [30, 41, 59],
        });
        textY -= 12;
      });
      x += columns[columnIndex];
    });
  });

  finishPage();

  const objects: Uint8Array[] = [];
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 2);
  const contentObjectNumbers = pages.map((_, index) => 4 + index * 2);
  const regularFontObjectNumber = 3 + pages.length * 2;
  const boldFontObjectNumber = regularFontObjectNumber + 1;

  objects.push(
    Uint8Array.from(
      asciiBytes("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    ),
  );
  objects.push(
    Uint8Array.from(
      asciiBytes(
        `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers
          .map((number) => `${number} 0 R`)
          .join(" ")}] /Count ${pages.length} >>\nendobj\n`,
      ),
    ),
  );

  pages.forEach((pageContent, pageIndex) => {
    objects.push(
      Uint8Array.from(
        asciiBytes(
          `${pageObjectNumbers[pageIndex]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${regularFontObjectNumber} 0 R /F2 ${boldFontObjectNumber} 0 R >> >> /Contents ${contentObjectNumbers[pageIndex]} 0 R >>\nendobj\n`,
        ),
      ),
    );
    objects.push(
      concatBytes([
        Uint8Array.from(
          asciiBytes(
            `${contentObjectNumbers[pageIndex]} 0 obj\n<< /Length ${pageContent.length} >>\nstream\n`,
          ),
        ),
        pageContent,
        Uint8Array.from(asciiBytes("endstream\nendobj\n")),
      ]),
    );
  });

  objects.push(
    Uint8Array.from(
      asciiBytes(
        `${regularFontObjectNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
      ),
    ),
  );
  objects.push(
    Uint8Array.from(
      asciiBytes(
        `${boldFontObjectNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
      ),
    ),
  );

  const header = Uint8Array.from(asciiBytes("%PDF-1.4\n"));
  const chunks = [header];
  const offsets = [0];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets
      .slice(1)
      .map((item) => `${String(item).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Uint8Array.from(asciiBytes(xref)));

  return new Blob([concatBytes(chunks)], { type: "application/pdf" });
}

function downloadRequirementPdf(artifact: GeneratedArtifact) {
  const url = URL.createObjectURL(buildRequirementPdf(artifact));
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadFileName(artifact);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)]">
      <div className="space-y-6">
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
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        downloadRequirementPdf(artifact);
                      }}
                      className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950"
                      aria-label="Last ned kravbesvarelse"
                    >
                      <ArrowDownToLine className="size-3.5" />
                    </button>
                    <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                  </div>
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
    </div>
  );
}
