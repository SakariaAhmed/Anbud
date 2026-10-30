"use client";

import {
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
  FileText,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { MarkdownViewer } from "@/components/projects/markdown-viewer";
import { canEditGeneratedArtifact } from "@/components/projects/project-workflow-status";
import { DeleteConfirmDialog } from "@/components/projects/delete-confirm-dialog";
import {
  DocumentUploadDropzoneContent,
  formatDate,
  GenerationProgress,
  documentDropzoneClass,
} from "@/components/projects/project-workspace-shared";
import { Input } from "@/components/projects/primitives";
import { WorkflowBlockedHint } from "@/components/projects/workflow-blocked-hint";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { sanitizeDownloadFileBase } from "@/lib/client/download";
import { downloadElementAsPdf } from "@/lib/client/pdf-download";
import {
  canStartRequirementResponseGeneration,
  isRequirementDocument,
  isDocumentReadyForEvaluation,
  isFormalRequirementDocument,
} from "@/lib/document-processing";
import { isMarkdownTableDivider, splitMarkdownTableRow } from "@/lib/markdown-table-row";
import { requirementResponseTableColumns } from "@/lib/requirement-response-table";
import { compareRequirementOrder, sortByRequirementOrder } from "@/lib/requirement-order";
import { requirementResponseRequirementCount } from "@/lib/requirement-response-count";
import {
  deterministicControlPatternLabel,
  deterministicRepairStageLabel,
  requirementResponseArtifactMetadata,
  requirementResponseManualReviewBadgeLabel,
  shouldShowDeterministicRepairAcknowledgement,
} from "@/lib/requirement-response-metadata";
import type { GeneratedArtifact, ProjectDocument } from "@/lib/types";
import { cn } from "@/lib/utils";

function fileTitle(file: File) {
  return `Kravgrunnlag - ${file.name.replace(/\.[^.]+$/, "")}`;
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

function isRequirementTableHeader(line: string) {
  const columns = requirementTableColumns(line);
  return Boolean(columns);
}

function requirementTableColumns(line: string) {
  const columns = requirementResponseTableColumns(splitMarkdownTableRow(line));
  return columns.refIndex >= 0 &&
    columns.requirementIndex >= 0 &&
    columns.answerIndex >= 0 &&
    columns.sourceIndex >= 0
    ? columns
    : null;
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
      <span className="inline-flex items-center rounded-md border border-blue-100 bg-blue-50/70 px-2 py-0.5 text-xs font-semibold leading-5 tracking-tight tabular-nums text-blue-950">
        {sourceId || "-"}
      </span>
      {requirementType ? (
        <span className="block break-words text-xs font-medium leading-5 text-slate-500">
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
    if (!isRequirementTableHeader(line) || !isMarkdownTableDivider(lines[index + 1] ?? "")) {
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
    const rows = tableLines.slice(2).map((raw) => ({
      cells: splitMarkdownTableRow(raw),
      raw,
    }));
    const tableRequirementRows = rows
      .filter(({ cells }) =>
        Boolean((cells[columns.requirementIndex] ?? "").trim()),
      )
      .map(({ cells: row }, rowIndex) => ({
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
      ({ cells }) =>
        !Boolean((cells[columns.requirementIndex] ?? "").trim()),
    );
    if (regularRows.length) {
      markdownBuffer.push(
        [
          tableLines[0],
          tableLines[1],
          ...regularRows.map(({ raw }) => raw),
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
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/80 px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="h-4 w-1 shrink-0 rounded-full bg-blue-900"
                    />
                    <h5 className="min-w-0 truncate font-serif text-sm font-semibold tracking-tight text-slate-900">
                      {tableId}
                    </h5>
                  </div>
                  <span className="text-xs font-medium tabular-nums text-slate-500">
                    {rows.length} krav
                  </span>
                </div>
                <div
                  className="overflow-x-auto rounded-b-xl focus-visible:outline-2 focus-visible:outline-blue-600"
                  role="region"
                  aria-label={`Kravtabell: ${tableId}`}
                  tabIndex={0}
                >
                  <table className="w-full min-w-[760px] table-fixed border-collapse text-left [overflow-wrap:anywhere] lg:min-w-0">
                    <thead className="bg-white text-xs font-semibold tracking-normal text-slate-500">
                      <tr>
                        <th className="w-[10%] border-b border-slate-200 px-3 py-3">
                          ID
                        </th>
                        <th className="w-[25%] border-b border-slate-200 px-3 py-3">
                          Krav
                        </th>
                        <th className="w-[31%] border-b border-slate-200 px-3 py-3">
                          Atea svar
                        </th>
                        <th className="w-[17%] border-b border-slate-200 px-3 py-3">
                          Svargrunnlag
                        </th>
                        <th className="w-[17%] border-b border-slate-200 px-3 py-3">
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
                            className="align-top transition-colors duration-[180ms] odd:bg-white even:bg-slate-50/50 hover:bg-blue-50/40"
                          >
                            <td className="px-3 py-4">
                              {row.ref ? (
                                <RequirementIdCell
                                  section={tableId}
                                  reference={row.ref}
                                />
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="px-3 py-4">
                              <p className="max-w-[38rem] whitespace-pre-wrap text-sm leading-6 text-slate-700">
                                {row.requirement}
                              </p>
                            </td>
                            <td className="px-3 py-4">
                              <p className="max-w-[46rem] whitespace-pre-wrap text-sm leading-6 text-slate-900">
                                {row.answer}
                              </p>
                            </td>
                            <td className="px-3 py-4">
                              {row.evidence ? (
                                <p className="max-w-[17rem] whitespace-pre-wrap text-xs leading-5 text-slate-600">
                                  {row.evidence}
                                </p>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="px-3 py-4">
                              {source ? (
                                <p className="max-w-[17rem] break-words text-xs font-medium leading-5 text-slate-500">
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
  uploadInProgress = uploadBusy,
  generateBusy,
  busyMessage,
  busyProgress,
  workflowBlockedReason = null,
  onUpload,
  onUpdateArtifact,
  onDeleteArtifact,
  onSubmit,
}: {
  projectId: string;
  documents: ProjectDocument[];
  artifacts: GeneratedArtifact[];
  uploadBusy: boolean;
  uploadInProgress?: boolean;
  generateBusy: boolean;
  busyMessage: string;
  busyProgress: number;
  /** Set while the server would refuse a new requirement response job. */
  workflowBlockedReason?: string | null;
  deletingDocumentId: string | null;
  onUpload: (file: File) => Promise<ProjectDocument | null>;
  onDeleteDocument: (document: ProjectDocument) => Promise<void>;
  onUpdateArtifact: (
    artifact: GeneratedArtifact,
    value: {
      title: string;
      content_markdown: string;
      acknowledge_deterministic_repairs?: boolean;
    },
  ) => Promise<void>;
  onDeleteArtifact: (artifact: GeneratedArtifact) => Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const requirementDocuments = useMemo(
    () => documents.filter(isRequirementDocument),
    [documents],
  );
  const readyRequirementDocuments = useMemo(
    () => requirementDocuments.filter(isDocumentReadyForEvaluation),
    [requirementDocuments],
  );
  const readyFormalRequirementDocuments = useMemo(
    () => readyRequirementDocuments.filter(isFormalRequirementDocument),
    [readyRequirementDocuments],
  );
  const unreadyRequirementDocumentCount =
    requirementDocuments.length - readyRequirementDocuments.length;
  // Missing or unready sources already explain the disabled button below.
  const showWorkflowBlocked =
    Boolean(workflowBlockedReason) && !generateBusy &&
    unreadyRequirementDocumentCount === 0 && readyFormalRequirementDocuments.length > 0;
  const requirementResponses = artifacts
    .filter((artifact) => artifact.artifact_type === "forbedret_kravsvar")
    .sort(
      (left, right) =>
        (right.artifact_version ?? 0) - (left.artifact_version ?? 0) ||
        right.created_at.localeCompare(left.created_at) ||
        right.id.localeCompare(left.id),
    );
  const canGenerate =
    readyFormalRequirementDocuments.length > 0 &&
    !workflowBlockedReason &&
    canStartRequirementResponseGeneration(requirementDocuments, {
      uploadBusy,
      generateBusy,
    });
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const requirementFileInput = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(
    null,
  );
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [acknowledgeDeterministicRepairs, setAcknowledgeDeterministicRepairs] =
    useState(false);
  const [savingArtifactId, setSavingArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(
    null,
  );
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<
    string | null
  >(null);
  const [downloadError, setDownloadError] = useState("");
  const responseContentRefs = useRef<Record<string, HTMLDivElement | null>>({});

  async function uploadSelectedFile(nextFile: File | null) {
    if (!nextFile || uploadBusy) return;

    setFile(nextFile);
    const uploadedDocument = await onUpload(nextFile);
    void uploadedDocument;
    setFile(null);
    setFileInputKey((current) => current + 1);
  }

  function startEdit(artifact: GeneratedArtifact) {
    setEditingArtifactId(artifact.id);
    setEditTitle(artifact.title || "Kravbesvarelse");
    setEditContent(artifact.content_markdown || "");
    setAcknowledgeDeterministicRepairs(false);
  }

  async function saveEdit(artifact: GeneratedArtifact) {
    setSavingArtifactId(artifact.id);
    try {
      await onUpdateArtifact(artifact, {
        title: editTitle,
        content_markdown: editContent,
        acknowledge_deterministic_repairs:
          acknowledgeDeterministicRepairs,
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
    if (downloadingArtifactId) return;
    if (!element) {
      setDownloadError("Åpne kravbesvarelsen før du laster ned PDF.");
      return;
    }

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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-normal text-slate-500">
          Lagrede kravbesvarelser
        </h3>
        {requirementResponses.length > 0 ? (
          <span className="text-xs font-medium tabular-nums text-slate-500">
            ({requirementResponses.length})
          </span>
        ) : null}
      </div>
      {downloadError ? (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {downloadError}
        </p>
      ) : null}
      {requirementResponses.length === 0 ? (
        <p className="text-sm text-slate-500">Ingen kravbesvarelse ennå.</p>
      ) : (
        <div className="space-y-3">
          {requirementResponses.map((artifact, index) => {
            const metadata = requirementResponseArtifactMetadata(
              artifact.input_snapshot,
            );
            const requirementCount = requirementResponseRequirementCount(
              artifact.content_markdown,
              metadata.ledgerConfidence?.requirement_count,
            );
            const confidenceLevel = metadata.ledgerConfidence?.level;
            const confidenceScore = metadata.ledgerConfidence?.score;
            const confidenceLabel = confidenceLevel
              ? `Tillit ${ledgerConfidenceLevelLabel(confidenceLevel)}${
                  typeof confidenceScore === "number"
                    ? ` ${Math.round(confidenceScore * 100)}%`
                    : ""
                }`
              : "";
            const artifactIsEditable = canEditGeneratedArtifact(artifact);
            const neutralMetadata = [
              artifact.artifact_version
                ? `Versjon ${artifact.artifact_version}`
                : null,
              confidenceLabel || null,
              typeof requirementCount === "number"
                ? `${requirementCount} krav`
                : null,
            ].filter((value): value is string => Boolean(value));
            const editDisabledReason = artifact.is_current
              ? "Kildegrunnlaget er endret. Regenerer kravbesvarelsen før du redigerer."
              : "Historiske versjoner kan ikke redigeres. Du kan fortsatt åpne og laste dem ned.";
            return (
            <details
              key={artifact.id}
              open={index === 0}
              className="group min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm transition-[transform,box-shadow] duration-[180ms] hover:-translate-y-0.5 hover:shadow-md"
            >
              <summary className="flex cursor-pointer list-none flex-col items-start justify-between gap-4 px-5 py-5 text-left sm:px-6 lg:flex-row transition-colors duration-[180ms] hover:bg-slate-50/60 [&::-webkit-details-marker]:hidden">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-semibold tracking-normal text-blue-700">
                    <span>Kravbesvarelse</span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">
                      {formatDate(artifact.created_at)}
                    </span>
                  </div>
                  <h4 className="mt-2 font-serif text-xl font-semibold leading-8 tracking-tight text-slate-900">
                    {artifact.title || "Kravbesvarelse uten tittel"}
                  </h4>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {artifact.is_current ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
                          artifact.source_is_current
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : "border-amber-300 bg-amber-50 text-amber-900",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            artifact.source_is_current
                              ? "bg-emerald-500"
                              : "bg-amber-500",
                          )}
                        />
                        {artifact.source_is_current
                          ? "Gjeldende"
                          : "Grunnlaget er endret – regenerer"}
                      </span>
                    ) : null}
                    {neutralMetadata.length ? (
                      <span className="text-xs font-medium tabular-nums text-slate-500">
                        {neutralMetadata.join(" · ")}
                      </span>
                    ) : null}
                    {metadata.fallbackAfterHandoff > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                        <AlertTriangle className="size-3.5" />
                        {metadata.fallbackAfterHandoff} til kontroll
                      </span>
                    ) : null}
                    {metadata.manualReviewRequired ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950">
                        <AlertTriangle className="size-3.5" />
                        {requirementResponseManualReviewBadgeLabel(metadata)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex w-full min-w-0 items-start justify-between gap-3 lg:w-auto lg:shrink-0">
                  {editingArtifactId !== artifact.id ? (
                    <div
                      className="flex min-w-0 flex-wrap gap-2 lg:justify-end"
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
                      <span title={artifactIsEditable ? undefined : editDisabledReason}>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 rounded-lg"
                          disabled={!artifactIsEditable}
                          aria-label={
                            artifactIsEditable ? "Rediger" : editDisabledReason
                          }
                          onClick={() => startEdit(artifact)}
                        >
                          <Pencil data-icon="inline-start" />
                          Rediger
                        </Button>
                      </span>
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
                className="space-y-5 rounded-b-2xl border-t border-slate-200 bg-white px-3 py-5 sm:px-5 sm:py-6"
              >
                {editingArtifactId === artifact.id ? (
                  <form
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEdit(artifact);
                    }}
                  >
                    <div className="space-y-2">
                      <Label
                        htmlFor={`requirement-title-${artifact.id}`}
                        className="text-xs font-semibold tracking-normal text-slate-500"
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
                        className="text-xs font-semibold tracking-normal text-slate-500"
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
                    {shouldShowDeterministicRepairAcknowledgement(
                      metadata,
                      editingArtifactId === artifact.id,
                    ) ? (
                      <label className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={acknowledgeDeterministicRepairs}
                          onChange={(event) =>
                            setAcknowledgeDeterministicRepairs(
                              event.target.checked,
                            )
                          }
                        />
                        <span>
                          Jeg bekrefter at de deterministisk reparerte svarradene
                          jeg har endret, er manuelt kvalitetssikret. Ved lagring
                          fjernes kontrollmarkeringen bare fra endrede rader.
                        </span>
                      </label>
                    ) : null}
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
                        type="submit"
                        className="h-9 rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover"
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
                  </form>
                ) : (
                  <>
                    {metadata.manualReviewRequired ? (
                      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5 text-sm text-amber-950">
                        <div className="flex items-center gap-2 font-semibold">
                          <AlertTriangle className="size-4" />
                          Manuell gjennomgang påkrevd før innlevering
                        </div>
                        <p className="mt-1 leading-6">
                          {metadata.manualReviewNote ||
                            `${requirementResponseManualReviewBadgeLabel(metadata)}. Åpne detaljene nedenfor før innlevering.`}
                        </p>
                        {metadata.templateRepairRefs.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {metadata.templateRepairRefs.map((reference, index) => (
                              <span
                                key={`${artifact.id}-manual-review-${index}-${reference}`}
                                className="rounded-full border border-amber-400 bg-white px-2 py-0.5 text-xs font-bold text-amber-950"
                              >
                                {reference}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {metadata.controlRepairRefs.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {metadata.controlRepairRefs.map((reference, index) => (
                              <span
                                key={`${artifact.id}-control-review-${index}-${reference}`}
                                className="rounded-full border border-amber-400 bg-white px-2 py-0.5 text-xs font-bold text-amber-950"
                              >
                                {reference}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {metadata.controlRepairRows.some(
                          (row) =>
                            row.pattern || row.repairStage || row.sourceLocator,
                        ) ? (
                          <details className="mt-3 rounded-lg border border-amber-300 bg-white/80 px-3 py-2">
                            <summary className="cursor-pointer text-xs font-bold text-amber-950">
                              Vis detaljer om reparerte kontrollsvar
                            </summary>
                            <div className="mt-2 space-y-2">
                              {metadata.controlRepairRows.map((row) => {
                                const patternLabel =
                                  deterministicControlPatternLabel(row.pattern);
                                const stageLabel =
                                  deterministicRepairStageLabel(row.repairStage);
                                return (
                                  <div
                                    key={`${artifact.id}-control-detail-${row.orderIndex ?? row.ref}-${row.ref}`}
                                    className="rounded-md border border-amber-200 bg-white px-3 py-2"
                                  >
                                    <div className="font-bold">{row.ref}</div>
                                    {patternLabel || stageLabel ? (
                                      <div className="mt-0.5 text-xs text-amber-900">
                                        {[patternLabel, stageLabel]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </div>
                                    ) : null}
                                    {row.sourceLocator ? (
                                      <div className="mt-0.5 text-xs text-slate-600">
                                        Kilde: {row.sourceLocator}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        ) : null}
                        {metadata.proposalInputRequiredRefs.length ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {metadata.proposalInputRequiredRefs.map(
                              (reference, index) => (
                                <span
                                  key={`${artifact.id}-proposal-input-${index}-${reference}`}
                                  className="rounded-full border border-amber-400 bg-white px-2 py-0.5 text-xs font-bold text-amber-950"
                                >
                                  {reference}
                                </span>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {metadata.fallbackAfterHandoff > 0 ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-sm text-amber-900">
                        <div className="flex items-center gap-2 font-semibold">
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
    <div className="mx-auto min-w-0 w-full space-y-6">
      <section aria-label="Kravgrunnlag">
        <div className="space-y-4">
          <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Kravgrunnlag</h3>
            {requirementDocuments.length ? (
              <div className="mt-3 space-y-2">
                <div className="min-w-0">
                  {requirementDocuments.map((document) => {
                    const documentReady = isDocumentReadyForEvaluation(document);
                    return (
                      <div key={document.id} className="flex min-w-0 items-start gap-3 border-b border-slate-200 py-3 last:border-0">
                        <FileText className="mt-0.5 size-4 shrink-0 text-slate-500" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium text-slate-800">{document.title}</p>
                          <p className={cn("mt-0.5 text-xs", documentReady ? "text-slate-500" : "text-amber-700")}>
                            {!documentReady ? "Venter på dokumentbehandling" : document.role === "primary_customer_document" ? "Kundehovedkilde · inngår automatisk" : "Kravdokument"}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-slate-500">{document.file_format.toUpperCase()}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="mt-2 text-sm text-slate-500">
                Ingen kravdokumenter er lastet opp ennå.
              </div>
            )}
          </div>

          <div className="min-w-0">
            <label
              htmlFor="requirement-file"
              role="button"
              tabIndex={uploadBusy ? -1 : 0}
              aria-label="Last opp kravdokument"
              aria-disabled={uploadBusy}
              onKeyDown={(event) => {
                if (!uploadBusy && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  requirementFileInput.current?.click();
                }
              }}
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
              className={`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${documentDropzoneClass({
                active: dragActive,
                disabled: uploadBusy,
              })}`}
            >
              <DocumentUploadDropzoneContent
                busy={uploadInProgress}
                busyLabel="Laster opp kravdokument ..."
                selectedFileName={file?.name}
                selectedFileDescription={
                  file
                    ? uploadInProgress
                      ? "Laster opp ..."
                      : `Tittel: ${fileTitle(file)}`
                    : undefined
                }
              />
            </label>
            <input
              ref={requirementFileInput}
              key={fileInputKey}
              id="requirement-file"
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.txt,.md"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              disabled={uploadBusy}
              onChange={(event) =>
                void uploadSelectedFile(event.target.files?.[0] ?? null)
              }
            />
          </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-2">
            <Button
              type="submit"
              className="max-w-full whitespace-normal"
              aria-describedby={
                showWorkflowBlocked
                  ? "requirement-workflow-blocked"
                  : !canGenerate && !generateBusy ? "requirement-generation-help" : undefined
              }
              disabled={!canGenerate}
            >
              {generateBusy ? (
                <Spinner className="size-4" />
              ) : (
                <CheckSquare data-icon="inline-start" />
              )}
              Generer kravbesvarelse
            </Button>
            {showWorkflowBlocked ? (
              <WorkflowBlockedHint id="requirement-workflow-blocked" reason={workflowBlockedReason} />
            ) : null}
            {unreadyRequirementDocumentCount > 0 && !generateBusy ? (
              <p id="requirement-generation-help" className="text-sm text-slate-600">
                {unreadyRequirementDocumentCount} kravkilde
                {unreadyRequirementDocumentCount === 1 ? "" : "r"} er ikke
                ferdig behandlet. Generering blir tilgjengelig når alle
                kundekilder og kravdokumenter er klare.
              </p>
            ) : null}
            {!readyFormalRequirementDocuments.length &&
            unreadyRequirementDocumentCount === 0 &&
            !generateBusy ? (
              <p id="requirement-generation-help" className="text-sm text-slate-600">
                Last opp minst ett formelt kravdokument før du genererer
                kravbesvarelsen. Kundehovedkilden inngår deretter automatisk.
              </p>
            ) : null}
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
