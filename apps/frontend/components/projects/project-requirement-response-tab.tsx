"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  FileDown,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  DocumentSourceMeta,
  DocumentUploadDropzoneContent,
  formatDate,
  GenerationProgress,
  documentDropzoneClass,
} from "@/components/projects/project-workspace-shared";
import { Input } from "@/components/projects/primitives";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { sanitizeDownloadFileBase } from "@/lib/client/download";
import { downloadElementAsPdf } from "@/lib/client/pdf-download";
import { compareRequirementOrder, sortByRequirementOrder } from "@/lib/requirement-order";
import type { GeneratedArtifact, ProjectDocument } from "@/lib/types";

function fileTitle(file: File) {
  return `Kravgrunnlag - ${file.name.replace(/\.[^.]+$/, "")}`;
}

function isRequirementDocument(document: ProjectDocument) {
  if (document.supporting_subtype === "kravdokument") {
    return true;
  }

  const text = `${document.title} ${document.file_name}`.toLowerCase();
  return (
    text.includes("kravdokument") ||
    text.includes("requirement") ||
    text.includes("requirements")
  );
}

type RequirementTableRow = {
  ref: string;
  group: string;
  requirement: string;
  answer: string;
  evidence: string;
  source: string;
  orderIndex: number;
};

type RequirementContentSegment =
  | { type: "markdown"; content: string }
  | { type: "table"; rows: RequirementTableRow[] };

type RequirementResponseMetadata = {
  ledgerConfidence?: {
    level?: string;
    score?: number;
    requirement_count?: number;
  };
  fallbackAfterHandoff: number;
  unresolvedFallbackAnswers: Array<{
    nr: number;
    ref: string;
    reason?: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ledgerConfidenceLevelLabel(level: string) {
  switch (level.toLowerCase()) {
    case "high":
      return "høy";
    case "medium":
      return "middels";
    case "low":
      return "lav";
    default:
      return level;
  }
}

function artifactRequirementResponseMetadata(
  artifact: GeneratedArtifact,
): RequirementResponseMetadata {
  const snapshot = isRecord(artifact.input_snapshot) ? artifact.input_snapshot : {};
  const generationMetadata = isRecord(snapshot.generation_metadata)
    ? snapshot.generation_metadata
    : {};
  const requirementResponse = isRecord(generationMetadata.requirement_response)
    ? generationMetadata.requirement_response
    : {};
  const fallbackAfterHandoff =
    typeof requirementResponse.deterministic_fallback_answers_after_handoff ===
      "number" &&
    Number.isFinite(
      requirementResponse.deterministic_fallback_answers_after_handoff,
    )
      ? Math.max(
          0,
          Math.round(
            requirementResponse.deterministic_fallback_answers_after_handoff,
          ),
        )
      : 0;
  const unresolvedFallbackAnswers = Array.isArray(
    requirementResponse.unresolved_fallback_answers,
  )
    ? requirementResponse.unresolved_fallback_answers
        .map((value) => (isRecord(value) ? value : null))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          nr:
            typeof value.nr === "number" && Number.isFinite(value.nr)
              ? Math.round(value.nr)
              : 0,
          ref: typeof value.ref === "string" ? value.ref : "",
          reason: typeof value.reason === "string" ? value.reason : undefined,
        }))
        .filter((value) => value.nr > 0 && value.ref)
    : [];
  const ledgerConfidence = isRecord(requirementResponse.ledger_confidence)
    ? {
        level:
          typeof requirementResponse.ledger_confidence.level === "string"
            ? requirementResponse.ledger_confidence.level
            : undefined,
        score:
          typeof requirementResponse.ledger_confidence.score === "number" &&
          Number.isFinite(requirementResponse.ledger_confidence.score)
            ? requirementResponse.ledger_confidence.score
            : undefined,
        requirement_count:
          typeof requirementResponse.ledger_confidence.requirement_count ===
            "number" &&
          Number.isFinite(
            requirementResponse.ledger_confidence.requirement_count,
          )
            ? requirementResponse.ledger_confidence.requirement_count
            : undefined,
      }
    : undefined;

  return {
    ledgerConfidence,
    fallbackAfterHandoff: Math.max(
      fallbackAfterHandoff,
      unresolvedFallbackAnswers.length,
    ),
    unresolvedFallbackAnswers,
  };
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isRequirementTableHeader(line: string) {
  const columns = requirementTableColumns(line);
  return Boolean(columns);
}

function normalizedHeaderCell(value: string) {
  return value
    .toLowerCase()
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementTableColumns(line: string) {
  const cells = splitMarkdownTableRow(line).map(normalizedHeaderCell);
  const refIndex = cells.findIndex((cell) => cell.includes("kravref"));
  const requirementIndex = cells.findIndex((cell) => cell === "krav");
  const answerIndex = cells.findIndex((cell) => cell === "svar");
  const evidenceIndex = cells.findIndex((cell) =>
    /^(?:svargrunnlag|answer evidence|evidence|bevis)$/.test(cell),
  );
  const sourceIndex = cells.findIndex((cell) =>
    /^(?:kildegrunnlag|kilde|source|source reference)$/.test(cell),
  );

  return (
    refIndex >= 0 &&
    requirementIndex >= 0 &&
    answerIndex >= 0 &&
    sourceIndex >= 0
      ? { refIndex, requirementIndex, answerIndex, evidenceIndex, sourceIndex }
      : null
  );
}

function isMarkdownDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableIdFromRef(ref: string) {
  return ref.match(/Tabell ID\s+\d{1,3}-\d{1,3}[A-Z]?/i)?.[0] ?? "";
}

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripRepeatedGroup(value: string, group: string) {
  const text = value.replace(/\s+/g, " ").trim();
  const groupText = group.replace(/\s+/g, " ").trim();
  if (!text || !groupText) {
    return text;
  }

  if (normalizeLabel(text) === normalizeLabel(groupText)) {
    return "";
  }

  if (normalizeLabel(text).startsWith(`${normalizeLabel(groupText)} `)) {
    return text
      .slice(groupText.length)
      .replace(/^\s*[-:,]\s*/, "")
      .trim();
  }

  return text;
}

function cleanSourceReference(value: string, group: string) {
  return value
    .split(",")
    .map((part) => stripRepeatedGroup(part.trim(), group))
    .filter(Boolean)
    .filter((part) => normalizeLabel(part) !== normalizeLabel(group))
    .join(", ");
}

function sourceWithRequirementReference(
  source: string,
  ref: string,
  section: string,
) {
  const cleanedSource = source.replace(/\s+/g, " ").trim();
  const cleanedRef = ref.replace(/\s+/g, " ").trim();
  if (!cleanedRef) {
    return cleanedSource;
  }

  const localRef = stripRepeatedGroup(cleanedRef, section);
  const displayRef = displayRequirementReference(cleanedRef, section);
  const sourceWithoutLocalRef =
    displayRef &&
    localRef &&
    normalizeLabel(displayRef) !== normalizeLabel(localRef)
      ? cleanedSource
          .split(",")
          .map((part) => part.trim())
          .filter((part) => normalizeLabel(part) !== normalizeLabel(localRef))
          .join(", ")
      : cleanedSource;
  const normalizedSource = normalizeLabel(sourceWithoutLocalRef);
  if (displayRef && normalizedSource.includes(normalizeLabel(displayRef))) {
    return sourceWithoutLocalRef;
  }

  return [sourceWithoutLocalRef, `Kravref. ${displayRef}`]
    .filter(Boolean)
    .join(", ");
}

function compactRequirementId(value: string) {
  return value
    .replace(/^Tabell\s+ID\s*/i, "")
    .replace(/^Krav\s*(?:nr\.?|nummer)?\s*/i, "Krav ")
    .replace(/^Req\s*[- ]?\s*/i, "REQ-")
    .replace(/^ID\s*/i, "ID ")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementSectionPrefix(section: string) {
  const sectionLabel = section.replace(/\s+/g, " ").trim();
  const explicit = sectionLabel.match(/^(\d{1,3}(?:\.\d{1,3})*)\s+/)?.[1];
  if (explicit) {
    return explicit;
  }

  const normalized = normalizeLabel(sectionLabel.replace(/:$/, ""));
  if (normalized === "functional requirements") {
    return "3.1";
  }
  if (normalized === "commercial requirements") {
    return "3.2";
  }

  return "";
}

function splitRequirementReference(value: string, section: string) {
  const sectionLabel = section.replace(/\s+/g, " ").trim();
  const fullReference = value.replace(/\s+/g, " ").trim();
  const localReference = stripRepeatedGroup(fullReference, sectionLabel);
  const match = localReference.match(
    /^(Tabell\s+ID\s+\d{1,4}\s*[-.]\s*\d{1,4}[A-Z]?|Krav\s*(?:nr\.?|nummer)?\s*\d{1,4}(?:\s*[.-]\s*\d{1,4}){0,5}[A-Z]?|ID\s*\d{1,4}(?:\s*[.-]\s*\d{1,4}){1,5}[A-Z]?|REQ\s*[- ]?\s*\d{1,5}[A-Z]?|\d{1,4}(?:\s*[.-]\s*\d{1,4}){0,5}[A-Z]?)(?:\s*[-–]\s*(.+))?$/i,
  );

  if (!match) {
    return {
      sourceId: compactRequirementId(localReference || fullReference),
      requirementType: sectionLabel || "Krav",
      title: "",
      fullReference,
    };
  }

  const rawSourceId = compactRequirementId(match[1] ?? localReference);
  const prefix = requirementSectionPrefix(sectionLabel);
  const sourceId =
    prefix && /^\d{1,4}[A-Z]?$/i.test(rawSourceId)
      ? `${prefix}.${rawSourceId}`
      : rawSourceId;

  return {
    sourceId,
    requirementType: sectionLabel || "Krav",
    title: match[2]?.replace(/\s+/g, " ").trim() ?? "",
    fullReference,
  };
}

function displayRequirementReference(reference: string, section: string) {
  const { sourceId, title } = splitRequirementReference(reference, section);
  return [sourceId, title ? `- ${title}` : ""].filter(Boolean).join(" ");
}

function RequirementIdCell({
  section,
  reference,
}: {
  section: string;
  reference: string;
}) {
  const { sourceId, requirementType, fullReference } =
    splitRequirementReference(reference, section);
  const label = [requirementType, fullReference].filter(Boolean).join(": ");

  return (
    <div
      aria-label={label}
      title={label}
      className="min-w-0 space-y-1"
    >
      <span className="block whitespace-nowrap text-sm font-bold leading-5 tabular-nums text-slate-950">
        {sourceId || "-"}
      </span>
      {requirementType ? (
        <span className="block max-w-[12rem] truncate whitespace-nowrap text-xs font-medium leading-5 text-slate-500">
          {requirementType}
        </span>
      ) : null}
    </div>
  );
}

function takeTrailingTableHeading(lines: string[]) {
  let index = lines.length - 1;
  while (index >= 0 && !(lines[index] ?? "").trim()) {
    index -= 1;
  }

  const line = (lines[index] ?? "").trim();
  const match = line.match(/^#{2,6}\s+(.+)$/);
  if (!match) {
    return "";
  }

  lines.splice(index, 1);
  while (lines.length && !(lines[lines.length - 1] ?? "").trim()) {
    lines.pop();
  }
  return match[1]?.trim() ?? "";
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

    const columns = requirementTableColumns(tableLines[0] ?? "");
    if (!columns) {
      markdownBuffer.push(tableLines.join("\n"));
      continue;
    }

    const groupTitle = takeTrailingTableHeading(markdownBuffer);
    const rows = tableLines.slice(2).map(splitMarkdownTableRow);
    const tableRequirementRows = rows
      .filter((row) => Boolean((row[columns.requirementIndex] ?? "").trim()))
      .map((row, rowIndex) => ({
        ref: stripRepeatedGroup(row[columns.refIndex] ?? "", groupTitle),
        group:
          groupTitle ||
          tableIdFromRef(row[columns.refIndex] ?? "") ||
          "Kravliste",
        requirement: row[columns.requirementIndex] ?? "",
        answer: row[columns.answerIndex] ?? "",
        evidence:
          columns.evidenceIndex >= 0
            ? row[columns.evidenceIndex] ?? ""
            : "",
        source: cleanSourceReference(row[columns.sourceIndex] ?? "", groupTitle),
        orderIndex: rowIndex,
      }));

    if (!tableRequirementRows.length) {
      markdownBuffer.push(tableLines.join("\n"));
      continue;
    }

    const regularRows = rows.filter(
      (row) => !Boolean((row[columns.requirementIndex] ?? "").trim()),
    );
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
  const segments = useMemo(() => parseRequirementContent(content), [content]);

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
          const tableId = row.group || tableIdFromRef(row.ref) || "Kravliste";
          groups.set(tableId, [...(groups.get(tableId) ?? []), row]);
        }
        const orderedGroups = Array.from(groups.entries())
          .map(([tableId, rows]) => ({
            tableId,
            rows: sortByRequirementOrder(rows, (row, rowIndex) => ({
              reference: row.ref,
              sourceReference: row.source,
              group: tableId,
              fallbackIndex: row.orderIndex ?? rowIndex,
            })),
          }))
          .sort((left, right) =>
            compareRequirementOrder(
              {
                reference: left.rows[0]?.ref,
                sourceReference: left.rows[0]?.source,
                group: left.tableId,
                fallbackIndex: left.rows[0]?.orderIndex ?? 0,
              },
              {
                reference: right.rows[0]?.ref,
                sourceReference: right.rows[0]?.source,
                group: right.tableId,
                fallbackIndex: right.rows[0]?.orderIndex ?? 0,
              },
            ),
          );

        return (
          <div key={`table-${index}`} className="space-y-5">
            {orderedGroups.map(({ tableId, rows }) => (
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
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="overflow-x-auto">
                    <table className="min-w-[1040px] w-full border-collapse text-left">
                      <thead className="bg-slate-50 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-slate-500">
                        <tr>
                          <th className="w-40 border-b border-slate-200 px-4 py-3">
                            ID
                          </th>
                          <th className="w-[30%] border-b border-slate-200 px-4 py-3">
                            Krav
                          </th>
                          <th className="w-[34%] border-b border-slate-200 px-4 py-3">
                            Atea svar
                          </th>
                          <th className="w-[15rem] border-b border-slate-200 px-4 py-3">
                            Svargrunnlag
                          </th>
                          <th className="w-[15rem] border-b border-slate-200 px-4 py-3">
                            Kildegrunnlag
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm text-slate-900">
                        {rows.map((row, rowIndex) => {
                          const source = sourceWithRequirementReference(
                            row.source,
                            row.ref,
                            tableId,
                          );
                          return (
                            <tr
                              key={`${row.ref}-${rowIndex}`}
                              className="align-top transition-colors hover:bg-slate-50/80"
                            >
                              <td className="px-4 py-4">
                                {row.ref ? (
                                  <RequirementIdCell
                                    section={tableId}
                                    reference={row.ref}
                                  />
                                ) : (
                                  <span className="text-slate-400">-</span>
                                )}
                              </td>
                              <td className="px-4 py-4">
                                <p className="max-w-[38rem] whitespace-pre-wrap text-sm leading-6 text-slate-900">
                                  {row.requirement}
                                </p>
                              </td>
                              <td className="px-4 py-4">
                                <p className="max-w-[46rem] whitespace-pre-wrap text-sm leading-6 text-slate-900">
                                  {row.answer}
                                </p>
                              </td>
                              <td className="px-4 py-4">
                                {row.evidence ? (
                                  <p className="max-w-[17rem] whitespace-pre-wrap text-[0.78rem] leading-5 text-slate-700">
                                    {row.evidence}
                                  </p>
                                ) : (
                                  <span className="text-slate-400">-</span>
                                )}
                              </td>
                              <td className="px-4 py-4">
                                {source ? (
                                  <p className="max-w-[17rem] break-words text-[0.78rem] font-medium leading-5 text-slate-600">
                                    {source}
                                  </p>
                                ) : (
                                  <span className="text-slate-400">-</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
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
  documents,
  artifacts,
  uploadBusy,
  generateBusy,
  busyMessage,
  busyProgress,
  onUpload,
  selectedDocumentId,
  onSelectedDocumentChange,
  onUpdateArtifact,
  onDeleteArtifact,
  onSubmit,
}: {
  projectId: string;
  documents: ProjectDocument[];
  artifacts: GeneratedArtifact[];
  uploadBusy: boolean;
  generateBusy: boolean;
  busyMessage: string;
  busyProgress: number;
  deletingDocumentId: string | null;
  onUpload: (file: File) => Promise<ProjectDocument | null>;
  selectedDocumentId: string;
  onSelectedDocumentChange: (documentId: string) => void;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onUpdateArtifact: (
    artifact: GeneratedArtifact,
    value: { title: string; content_markdown: string },
  ) => Promise<void>;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requirementDocuments = useMemo(
    () => documents.filter(isRequirementDocument),
    [documents],
  );
  const selectableDocuments = useMemo(
    () =>
      [...documents].sort((left, right) => {
        const leftIsRequirement = isRequirementDocument(left);
        const rightIsRequirement = isRequirementDocument(right);
        if (leftIsRequirement !== rightIsRequirement) {
          return leftIsRequirement ? -1 : 1;
        }

        return left.title.localeCompare(right.title, "nb");
      }),
    [documents],
  );
  const requirementResponses = artifacts.filter(
    (artifact) => artifact.artifact_type === "forbedret_kravsvar",
  );
  const selectedDocument =
    selectableDocuments.find((document) => document.id === selectedDocumentId) ??
    null;
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(
    null,
  );
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [savingArtifactId, setSavingArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(
    null,
  );
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<
    string | null
  >(null);
  const [downloadError, setDownloadError] = useState("");
  const responseContentRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  async function deleteArtifact(artifact: GeneratedArtifact) {
    setDeletingArtifactId(artifact.id);
    try {
      await onDeleteArtifact(artifact);
      if (editingArtifactId === artifact.id) {
        setEditingArtifactId(null);
        setEditTitle("");
        setEditContent("");
      }
    } catch {
      // Parent action sets the visible error message.
    } finally {
      setDeletingArtifactId(null);
    }
  }

  async function downloadRequirementResponsePdf(artifact: GeneratedArtifact) {
    const element = responseContentRefs.current[artifact.id];
    if (!element || downloadingArtifactId) return;

    const title = artifact.title || "Kravbesvarelse";
    setDownloadingArtifactId(artifact.id);
    setDownloadError("");

    try {
      await downloadElementAsPdf({
        element,
        fileName: `${sanitizeDownloadFileBase(title, "kravbesvarelse")}.pdf`,
        subtitle: `Opprettet ${formatDate(artifact.created_at)}`,
        title,
      });
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : "Kunne ikke lage PDF. Prøv igjen.",
      );
    } finally {
      setDownloadingArtifactId(null);
    }
  }

  async function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    await uploadSelectedFile(event.dataTransfer.files?.[0] ?? null);
  }

  function stopSummaryToggle(event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  const savedRequirementResponses = (
    <section className="min-w-0">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">
        Lagrede kravbesvarelser
      </h3>
      {downloadError ? (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {downloadError}
        </p>
      ) : null}
      {requirementResponses.length === 0 ? (
        <p className="rounded-xl border py-10 text-center text-sm text-muted-foreground shadow-sm">
          Ingen kravbesvarelse ennå.
        </p>
      ) : (
        <div className="space-y-3">
          {requirementResponses.map((artifact, index) => {
            const metadata = artifactRequirementResponseMetadata(artifact);
            const confidenceLevel = metadata.ledgerConfidence?.level;
            const confidenceScore = metadata.ledgerConfidence?.score;
            const confidenceLabel = confidenceLevel
              ? `Tillit ${ledgerConfidenceLevelLabel(confidenceLevel)}${
                  typeof confidenceScore === "number"
                    ? ` ${Math.round(confidenceScore * 100)}%`
                    : ""
                }`
              : "";
            return (
            <details
              key={artifact.id}
              open={index === 0}
              className="group min-w-0 rounded-2xl border bg-card"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <span>Kravbesvarelse</span>
                    <span>·</span>
                    <span>{formatDate(artifact.created_at)}</span>
                  </div>
                  <h4 className="mt-2 text-xl font-semibold leading-8 text-foreground">
                    {artifact.title || "Kravbesvarelse uten tittel"}
                  </h4>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {confidenceLabel ? (
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                        {confidenceLabel}
                      </span>
                    ) : null}
                    {typeof metadata.ledgerConfidence?.requirement_count ===
                    "number" ? (
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700">
                        {metadata.ledgerConfidence.requirement_count} krav
                      </span>
                    ) : null}
                    {metadata.fallbackAfterHandoff > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800">
                        <AlertTriangle className="size-3.5" />
                        {metadata.fallbackAfterHandoff} til kontroll
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-start gap-3">
                  {editingArtifactId !== artifact.id ? (
                    <div
                      className="flex flex-wrap justify-end gap-2"
                      onClick={stopSummaryToggle}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-lg"
                        disabled={downloadingArtifactId !== null}
                        onClick={() => void downloadRequirementResponsePdf(artifact)}
                      >
                        {downloadingArtifactId === artifact.id ? (
                          <Spinner className="size-4" />
                        ) : (
                          <FileDown data-icon="inline-start" />
                        )}
                        {downloadingArtifactId === artifact.id
                          ? "Lager PDF"
                          : "Last ned PDF"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-lg"
                        onClick={() => startEdit(artifact)}
                      >
                        <Pencil data-icon="inline-start" />
                        Rediger
                      </Button>
                      <DeleteConfirmDialog
                        title="Slett kravbesvarelse?"
                        description={`Dette sletter "${artifact.title || "kravbesvarelse uten tittel"}" fra prosjektet. Handlingen kan ikke angres.`}
                        confirmLabel="Slett kravbesvarelse"
                        onConfirm={() => deleteArtifact(artifact)}
                      >
                        <Button
                          type="button"
                          variant="destructive"
                          className="h-9 rounded-lg"
                          disabled={deletingArtifactId === artifact.id}
                        >
                          {deletingArtifactId === artifact.id ? (
                            <Spinner className="size-4" />
                          ) : (
                            <Trash2 data-icon="inline-start" />
                          )}
                          Slett
                        </Button>
                      </DeleteConfirmDialog>
                    </div>
                  ) : null}
                  <ChevronDown className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </div>
              </summary>
              <div
                ref={(node) => {
                  responseContentRefs.current[artifact.id] = node;
                }}
                className="space-y-4 rounded-b-2xl border-t bg-card px-7 py-7"
              >
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
                        className="min-h-[28rem] resize-y rounded-xl bg-white text-sm leading-6 text-slate-900 shadow-none"
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
                    {metadata.fallbackAfterHandoff > 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        <div className="flex items-center gap-2 font-bold">
                          <AlertTriangle className="size-4" />
                          Manuell kontroll anbefales
                        </div>
                        <p className="mt-1 leading-6">
                          {metadata.fallbackAfterHandoff} kravsvar ble stående
                          som fallback etter reparasjon.
                        </p>
                        {metadata.unresolvedFallbackAnswers.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {metadata.unresolvedFallbackAnswers
                              .slice(0, 8)
                              .map((row) => (
                                <span
                                  key={`${artifact.id}-${row.nr}-${row.ref}`}
                                  className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-xs font-bold text-amber-900"
                                >
                                  {row.nr}. {row.ref}
                                </span>
                              ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <div className="min-w-0 space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="space-y-4">
          <div>
            <Label
              htmlFor="requirement-document-select"
              className="text-xs font-black uppercase tracking-[0.2em] text-slate-500"
            >
              Dokument som skal besvares
            </Label>
            {selectableDocuments.length ? (
              <>
                <div className="relative mt-3">
                  <select
                    id="requirement-document-select"
                    value={selectedDocumentId}
                    onChange={(event) =>
                      onSelectedDocumentChange(event.target.value)
                    }
                    disabled={generateBusy || uploadBusy}
                    className="h-11 w-full appearance-none rounded-lg border border-slate-200 bg-white px-3 pr-10 text-sm font-semibold text-slate-950 shadow-sm outline-none transition-colors focus:border-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                  >
                    {selectableDocuments.map((document) => (
                      <option key={document.id} value={document.id}>
                        {document.title}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-950" />
                </div>
                <div className="mt-3">
                  <DocumentSourceMeta
                    document={selectedDocument}
                    label="Kravgrunnlag"
                  />
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm font-medium text-slate-500">
                Ingen kravdokumenter er lastet opp ennå.
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-semibold text-slate-700">
              Last inn dokument
            </p>
            <label
              htmlFor="requirement-file"
              onDragEnter={(event) => {
                event.preventDefault();
                if (uploadBusy) return;
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                if (uploadBusy) return;
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              className={`mt-3 ${documentDropzoneClass({
                active: dragActive,
                disabled: uploadBusy,
              })}`}
            >
              <DocumentUploadDropzoneContent
                busy={uploadBusy}
                busyLabel="Laster opp kravdokument ..."
                selectedFileName={file?.name}
                selectedFileDescription={
                  file
                    ? uploadBusy
                      ? "Laster opp ..."
                      : `Tittel: ${fileTitle(file)}`
                    : undefined
                }
              />
            </label>
            <Input
              key={fileInputKey}
              id="requirement-file"
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
              className="sr-only"
              disabled={uploadBusy}
              onChange={(event) =>
                void uploadSelectedFile(event.target.files?.[0] ?? null)
              }
            />
          </div>

          <form onSubmit={onSubmit}>
            <Button
              type="submit"
              className="h-10 w-full justify-center rounded-lg bg-blue-900 text-sm font-bold text-white hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-500"
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
              <div className="mt-3">
                <GenerationProgress
                  message={busyMessage}
                  progress={busyProgress}
                />
              </div>
            ) : null}
          </form>
        </div>
      </section>

      {savedRequirementResponses}
    </div>
  );
}
