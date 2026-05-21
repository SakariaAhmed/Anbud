import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";

import { createServiceClient } from "@/lib/server/supabase";
import {
  buildStoredFilePath,
  downloadEncryptedBase64File,
  removeStoredFiles,
  uploadEncryptedBase64File,
} from "@/lib/server/file-storage";
import {
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
} from "@/lib/server/crypto";
import {
  appendCustomerAnalysisSectionHistory,
  CUSTOMER_ANALYSIS_SECTIONS,
} from "@/lib/customer-analysis-history";
import type {
  ChatMessage,
  ChatMessageRole,
  CustomerAnalysisHistorySource,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectMetadataInference,
  ProjectCreateInput,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentDetail,
  ProjectDocumentRole,
  ProjectServiceDescription,
  ProjectStatus,
  ProjectSummary,
  ServiceDescription,
  ServiceDocument,
  ServiceDocumentDetail,
  ServiceInclusionMode,
  SolutionEvaluationResult,
  SupportingDocumentSubtype,
} from "@/lib/types";

type Json =
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null;

interface ProjectRow {
  id: string;
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
  context_keywords: string[];
  customer_document_uploaded: boolean;
  customer_analysis_generated: boolean;
  solution_document_uploaded: boolean;
  solution_evaluation_generated: boolean;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  project_id: string;
  role: ProjectDocumentRole;
  supporting_subtype: SupportingDocumentSubtype | null;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count: number | null;
  file_storage_bucket: string | null;
  file_storage_path: string | null;
  file_base64: string;
  raw_text: string;
  structure_map: Json;
  created_at: string;
  updated_at: string;
}

interface DocumentSummaryRow {
  id: string;
  project_id: string;
  role: ProjectDocumentRole;
  supporting_subtype: SupportingDocumentSubtype | null;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
  file_base64?: string;
  raw_text?: string;
  structure_map?: Json;
  created_at: string;
  updated_at: string;
}

interface CustomerAnalysisRow {
  id: string;
  project_id: string;
  source_document_ids: string[];
  result_json: Json;
  created_at: string;
  updated_at: string;
}

interface SolutionEvaluationRow {
  id: string;
  project_id: string;
  customer_document_id: string | null;
  solution_document_id: string | null;
  analysis_id: string | null;
  result_json: Json;
  created_at: string;
  updated_at: string;
}

interface ExecutiveSummaryRow {
  id: string;
  project_id: string;
  result_json: Json;
  input_snapshot: Json;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  artifact_type: GeneratedArtifactType;
  title: string;
  content_markdown: string;
  input_snapshot: Json;
  created_at: string;
  updated_at?: string;
}

interface ChatRow {
  id: string;
  project_id: string;
  role: ChatMessageRole;
  content: string;
  context_snapshot: Json;
  created_at: string;
}

interface ServiceDescriptionRow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  inclusion_mode: ServiceInclusionMode;
  created_at: string;
  updated_at: string;
}

interface ServiceDocumentRow {
  id: string;
  service_id: string;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
  file_base64: string;
  raw_text: string;
  structure_map: Json;
  ai_summary?: string | null;
  ai_summary_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface ServiceDocumentSummaryRow {
  id: string;
  service_id: string;
  title: string;
  file_name: string;
  file_format: string;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
  raw_text?: string;
  structure_map?: Json;
  ai_summary?: string | null;
  ai_summary_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectCacheSnapshot {
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
  status: ProjectStatus;
  customer_document_uploaded: boolean;
  customer_analysis_generated: boolean;
  solution_document_uploaded: boolean;
  solution_evaluation_generated: boolean;
  last_activity_at: string;
}

const DOCUMENT_SELECT_SAFE =
  "id, project_id, role, supporting_subtype, title, file_name, file_format, content_type, file_size_bytes, page_count, file_storage_bucket, file_storage_path, file_base64, raw_text, structure_map, created_at, updated_at";
const DOCUMENT_SUMMARY_SELECT_SAFE =
  "id, project_id, role, supporting_subtype, title, file_name, file_format, content_type, file_size_bytes, page_count, created_at, updated_at";
const DOCUMENT_SUMMARY_SELECT_LEGACY =
  "id, project_id, role, subtype, display_name, file_format, content_type, created_at";
const PROJECT_SELECT_SAFE =
  "id, name, customer_name, description, industry, context_keywords, customer_document_uploaded, customer_analysis_generated, solution_document_uploaded, solution_evaluation_generated, last_activity_at, created_at, updated_at";
const PROJECT_SELECT_LEGACY =
  "id, title, client_name, description, context_keywords, customer_document_uploaded, customer_analysis_generated, solution_document_uploaded, solution_evaluation_generated, last_activity_at, created_at, updated_at";
const SERVICE_DOCUMENT_SUMMARY_SELECT =
  "id, service_id, title, file_name, file_format, content_type, file_size_bytes, page_count, ai_summary, ai_summary_updated_at, created_at, updated_at";

const CUSTOMER_ANALYSIS_EMPTY: CustomerAnalysisResult = {
  customer_profile_summary: "",
  customer_goals_summary: "",
  high_level_solution_design: "",
  high_level_architecture_mermaid: "",
  customer_profile: [],
  customer_goals: [],
  implicit_requirements: [],
  prioritized_requirements: [],
  ambiguities: [],
  risks: [],
  risks_for_us: [],
  risks_for_customer: [],
  likely_evaluation_criteria: [],
  signal_words: [],
  signal_word_counts: {},
  expected_solution_direction: [],
  value_opportunities: [],
  positioning_recommendations: [],
  executive_summary: "",
  section_histories: {},
};

const SOLUTION_EVALUATION_EMPTY: SolutionEvaluationResult = {
  fit_to_customer_needs: "",
  strengths: [],
  weaknesses: [],
  generic_sections: [],
  missing_elements: [],
  risks_to_customer: [],
  trust_signals: [],
  likely_score_assessment: {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  },
  improvement_recommendations: [],
  value_assessment: [],
  rewrite_suggestions: [],
  architecture_comparison: {
    winner: "Uavgjort",
    architect_solution_score: 0,
    system_solution_score: 0,
    verdict: "",
    strong_critique: [],
    pragmatic_reflections: [],
    strategy_improvement_advice: [],
  },
  executive_summary: "",
};

const EXECUTIVE_SUMMARY_EMPTY: ExecutiveSummaryResult = {
  source_solution_evaluation_present: false,
  executive_summary: "",
  fit_to_customer_needs: "",
  likely_score_assessment: {
    quality: "",
    delivery_confidence: "",
    risk: "",
    competitiveness: "",
  },
  strengths: [],
  weaknesses: [],
};

const PROJECTS_LIST_TAG = "projects:list";
const SERVICE_DESCRIPTIONS_TAG = "service-descriptions:list";

function projectTag(projectId: string) {
  return `project:${projectId}`;
}

function revalidateProjectCaches(projectId: string) {
  revalidateTag(PROJECTS_LIST_TAG);
  revalidateTag(projectTag(projectId));
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

function revalidateServiceCaches(projectId?: string) {
  revalidateTag(SERVICE_DESCRIPTIONS_TAG);
  revalidatePath("/");
  revalidatePath("/projects/new");
  if (projectId) {
    revalidateProjectCaches(projectId);
  }
}

function mapProjectStatus(row: ProjectRow): ProjectStatus {
  if (row.customer_analysis_generated) {
    return "Kundeanalyse klar";
  }
  if (row.customer_document_uploaded || row.solution_document_uploaded) {
    return "Dokument lastet opp";
  }
  return "Venter på dokument";
}

function isMissingLegacyProjectColumn(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return (
    message.includes("column projects.") ||
    message.includes("name") ||
    message.includes("customer_name") ||
    message.includes("industry") ||
    message.includes("client_name") ||
    message.includes("title")
  );
}

function isMissingRelationColumn(
  error: { message?: string } | null,
  relation: string,
) {
  const message = (error?.message ?? "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes(`column ${relation}.`) ||
    message.includes(`of '${relation}'`) ||
    (message.includes(relation) && message.includes("schema cache")) ||
    (message.includes(relation) && message.includes("does not exist"))
  );
}

function fromUnknownProjectRow(row: Record<string, unknown>): ProjectRow {
  const createdAt = String(row.created_at ?? new Date().toISOString());
  const updatedAt = String(row.updated_at ?? createdAt);
  const lastActivityAt = String(row.last_activity_at ?? updatedAt ?? createdAt);

  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? row.title ?? "Nytt prosjekt"),
    customer_name:
      row.customer_name == null && row.client_name == null
        ? null
        : String(row.customer_name ?? row.client_name ?? ""),
    description: row.description == null ? null : String(row.description),
    industry: row.industry == null ? null : String(row.industry),
    context_keywords: Array.isArray(row.context_keywords)
      ? row.context_keywords.map(String)
      : [],
    customer_document_uploaded: Boolean(
      row.customer_document_uploaded ?? false,
    ),
    customer_analysis_generated: Boolean(
      row.customer_analysis_generated ?? false,
    ),
    solution_document_uploaded: Boolean(
      row.solution_document_uploaded ?? false,
    ),
    solution_evaluation_generated: Boolean(
      row.solution_evaluation_generated ?? false,
    ),
    last_activity_at: lastActivityAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function decryptDocumentRow(row: DocumentRow): ProjectDocumentDetail {
  return {
    id: row.id,
    project_id: row.project_id,
    role: row.role,
    supporting_subtype: row.supporting_subtype,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ProjectDocumentDetail["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count: row.page_count,
    file_base64: decryptString(row.file_base64),
    raw_text: decryptString(row.raw_text),
    structure_map: decryptJson(row.structure_map, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveDocumentRow(row: DocumentRow): Promise<ProjectDocumentDetail> {
  const document = decryptDocumentRow(row);
  if (document.file_base64 || !row.file_storage_path) {
    return document;
  }

  return {
    ...document,
    file_base64: decryptString(
      await downloadEncryptedBase64File({
        bucket: row.file_storage_bucket,
        path: row.file_storage_path,
      }),
    ),
  };
}

function pageCountFromStructureMap(
  structureMap: unknown,
  fileFormat: string,
): number | null {
  if (fileFormat !== "pdf" || !Array.isArray(structureMap)) {
    return null;
  }

  const pageNumbers = structureMap
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const reference = String(
        (entry as { reference?: unknown }).reference ?? "",
      );
      const match = reference.match(/\bside\s+(\d{1,5})\b/i);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => Number.isFinite(value));

  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

function pageCountFromRawText(rawText: string | undefined, fileFormat: string) {
  if (fileFormat !== "pdf" || !rawText) {
    return null;
  }

  const pageNumbers = [...rawText.matchAll(/\[\[SIDE:(\d{1,5})\]\]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

function decryptOptionalString(value: string | undefined) {
  if (!value) {
    return "";
  }

  try {
    return decryptString(value);
  } catch {
    return "";
  }
}

function mapDocumentSummary(row: DocumentSummaryRow): ProjectDocument {
  const structureMap = row.structure_map
    ? decryptJson(row.structure_map, [])
    : [];
  const structurePageCount = pageCountFromStructureMap(
    structureMap,
    row.file_format,
  );
  const rawText = decryptOptionalString(row.raw_text);

  return {
    id: row.id,
    project_id: row.project_id,
    role: row.role,
    supporting_subtype: row.supporting_subtype,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ProjectDocument["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count:
      row.page_count ??
      structurePageCount ??
      pageCountFromRawText(rawText, row.file_format),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapSolutionEvaluationRow(row: SolutionEvaluationRow) {
  return {
    ...decryptJson(row.result_json, SOLUTION_EVALUATION_EMPTY),
    customer_document_id: row.customer_document_id,
    solution_document_id: row.solution_document_id,
  };
}

function mapExecutiveSummaryRow(row: ExecutiveSummaryRow) {
  return decryptJson(row.result_json, EXECUTIVE_SUMMARY_EMPTY);
}

function mapArtifact(row: ArtifactRow): GeneratedArtifact {
  const artifactType = [
    "losningsutkast",
    "bilag1_rekonstruksjon",
    "forbedret_kravsvar",
    "tilbudsstrategi",
    "verdiargumentasjon",
    "anbefalt_arkitektur",
    "gjennomforing_og_risiko",
  ].includes(String(row.artifact_type))
    ? row.artifact_type
    : "losningsutkast";
  const title =
    typeof row.title === "string" && row.title.trim()
      ? row.title.trim()
      : "Generatorutkast uten tittel";
  const legacyContent =
    typeof (row as unknown as Record<string, unknown>).content === "string"
      ? ((row as unknown as Record<string, unknown>).content as string)
      : typeof (row as unknown as Record<string, unknown>).markdown === "string"
        ? ((row as unknown as Record<string, unknown>).markdown as string)
        : "";
  const contentMarkdown =
    typeof row.content_markdown === "string" && row.content_markdown.trim()
      ? row.content_markdown
      : legacyContent.trim()
        ? legacyContent
        : "Dette generatorutkastet mangler lagret innhold. Generer det på nytt for å få et komplett resultat.";

  return {
    id: row.id,
    project_id: row.project_id,
    artifact_type: artifactType,
    title,
    content_markdown: contentMarkdown,
    input_snapshot: decryptJson(row.input_snapshot, {}),
    created_at: row.created_at,
  };
}

function mapChatMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    project_id: row.project_id,
    role: row.role,
    content: row.content,
    context_snapshot: decryptJson(row.context_snapshot, {}),
    created_at: row.created_at,
  };
}

function mapServiceDocument(row: ServiceDocumentSummaryRow): ServiceDocument {
  const structureMap = row.structure_map
    ? decryptJson(row.structure_map, [])
    : [];
  const structurePageCount = pageCountFromStructureMap(
    structureMap,
    row.file_format,
  );
  const rawText = decryptOptionalString(row.raw_text);

  return {
    id: row.id,
    service_id: row.service_id,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ServiceDocument["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count:
      row.page_count ??
      structurePageCount ??
      pageCountFromRawText(rawText, row.file_format),
    ai_summary:
      typeof row.ai_summary === "string" ? decryptString(row.ai_summary) : "",
    ai_summary_updated_at: row.ai_summary_updated_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapServiceDescription(
  row: ServiceDescriptionRow,
  documents: ServiceDocumentSummaryRow[],
): ServiceDescription {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    inclusion_mode: row.inclusion_mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
    documents: documents.map(mapServiceDocument),
  };
}

function decryptServiceDocumentRow(
  row: ServiceDocumentRow,
): ServiceDocumentDetail {
  return {
    id: row.id,
    service_id: row.service_id,
    title: row.title,
    file_name: row.file_name,
    file_format: row.file_format as ServiceDocumentDetail["file_format"],
    content_type: row.content_type,
    file_size_bytes: row.file_size_bytes,
    page_count: row.page_count ?? null,
    file_base64: decryptString(row.file_base64),
    raw_text: decryptString(row.raw_text),
    structure_map: decryptJson(row.structure_map, []),
    ai_summary:
      typeof row.ai_summary === "string" ? decryptString(row.ai_summary) : "",
    ai_summary_updated_at: row.ai_summary_updated_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveServiceDocumentRow(
  row: ServiceDocumentRow,
): Promise<ServiceDocumentDetail> {
  const document = decryptServiceDocumentRow(row);
  if (document.file_base64 || !row.file_storage_path) {
    return document;
  }

  return {
    ...document,
    file_base64: decryptString(
      await downloadEncryptedBase64File({
        bucket: row.file_storage_bucket,
        path: row.file_storage_path,
      }),
    ),
  };
}

function mapProjectSummary(
  row: ProjectRow,
  documents: DocumentSummaryRow[],
): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    customer_name: row.customer_name,
    description: row.description,
    industry: row.industry,
    status: mapProjectStatus(row),
    customer_document_uploaded: row.customer_document_uploaded,
    customer_analysis_generated: row.customer_analysis_generated,
    solution_document_uploaded: row.solution_document_uploaded,
    solution_evaluation_generated: row.solution_evaluation_generated,
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    document_count: documents.length,
    supporting_document_count: documents.filter(
      (document) => document.role === "supporting_document",
    ).length,
    artifact_count: 0,
    has_chat: false,
  };
}

function mapProjectSnapshot(row: ProjectRow): ProjectCacheSnapshot {
  return {
    name: row.name,
    customer_name: row.customer_name,
    description: row.description,
    industry: row.industry,
    status: mapProjectStatus(row),
    customer_document_uploaded: row.customer_document_uploaded,
    customer_analysis_generated: row.customer_analysis_generated,
    solution_document_uploaded: row.solution_document_uploaded,
    solution_evaluation_generated: row.solution_evaluation_generated,
    last_activity_at: row.last_activity_at,
  };
}

function isProjectNamePlaceholder(value: string | null) {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "ny analyse" ||
    normalized === "nytt prosjekt"
  );
}

function isCustomerPlaceholder(value: string | null) {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "kunde ikke satt";
}

function shouldUseInferredValue(
  current: string | null,
  inferred: string | null,
  isPlaceholder: (value: string | null) => boolean,
) {
  return Boolean(inferred?.trim()) && isPlaceholder(current);
}

function isMissingLegacyDocumentColumn(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return (
    message.includes("column documents.") ||
    message.includes("supporting_subtype") ||
    message.includes("title") ||
    message.includes("display_name") ||
    message.includes("file_name") ||
    message.includes("file_size_bytes") ||
    message.includes("page_count") ||
    message.includes("file_storage_bucket") ||
    message.includes("file_storage_path") ||
    message.includes("structure_map") ||
    message.includes("source_map")
  );
}

function keywordsFromText(value: string, limit = 64) {
  const stopWords = new Set([
    "eller",
    "ikke",
    "skal",
    "med",
    "som",
    "for",
    "til",
    "det",
    "den",
    "dette",
    "har",
    "kan",
    "ved",
    "fra",
    "over",
    "under",
    "innen",
    "kunden",
    "tjeneste",
    "tjenester",
    "beskrivelse",
  ]);
  const counts = new Map<string, number>();
  for (const word of value
    .toLowerCase()
    .replace(/[^a-zæøå0-9\s-]/gi, " ")
    .split(/\s+/)) {
    if (word.length < 4 || stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "nb"))
    .slice(0, limit)
    .map(([word]) => word);
}

function mergeKeywords(...lists: Array<Array<string | null | undefined>>) {
  return Array.from(
    new Set(
      lists
        .flat()
        .filter((word): word is string => Boolean(word?.trim()))
        .map((word) => word.toLowerCase().trim()),
    ),
  ).slice(0, 96);
}

function fromUnknownDocumentSummaryRow(
  row: Record<string, unknown>,
): DocumentSummaryRow {
  const rawFileSize = Number(row.file_size_bytes ?? 0);
  let fileSizeBytes = Number.isFinite(rawFileSize) ? rawFileSize : 0;
  if (fileSizeBytes <= 0 && typeof row.file_base64 === "string") {
    try {
      const fileBase64 = decryptString(row.file_base64);
      fileSizeBytes = Buffer.from(fileBase64, "base64").length;
    } catch {
      fileSizeBytes = 0;
    }
  }

  return {
    id: String(row.id ?? ""),
    project_id: String(row.project_id ?? ""),
    role: (row.role as ProjectDocumentRole) ?? "supporting_document",
    supporting_subtype:
      (row.supporting_subtype as
        | SupportingDocumentSubtype
        | null
        | undefined) ??
      (row.subtype as SupportingDocumentSubtype | null | undefined) ??
      null,
    title: String(row.title ?? row.display_name ?? row.file_name ?? "Dokument"),
    file_name: String(
      row.file_name ?? row.display_name ?? row.title ?? "document.txt",
    ),
    file_format: String(row.file_format ?? "txt"),
    content_type: String(row.content_type ?? "application/octet-stream"),
    file_size_bytes: fileSizeBytes,
    page_count:
      typeof row.page_count === "number" && Number.isFinite(row.page_count)
        ? row.page_count
        : null,
    file_storage_bucket:
      row.file_storage_bucket == null ? null : String(row.file_storage_bucket),
    file_storage_path:
      row.file_storage_path == null ? null : String(row.file_storage_path),
    raw_text: typeof row.raw_text === "string" ? row.raw_text : undefined,
    structure_map: (row.structure_map ?? row.source_map ?? []) as Json,
    created_at: String(row.created_at ?? new Date().toISOString()),
    updated_at: String(
      row.updated_at ?? row.created_at ?? new Date().toISOString(),
    ),
  };
}

function fromUnknownDocumentRow(row: Record<string, unknown>): DocumentRow {
  const summary = fromUnknownDocumentSummaryRow(row);
  return {
    ...summary,
    page_count: summary.page_count ?? null,
    file_storage_bucket: summary.file_storage_bucket ?? null,
    file_storage_path: summary.file_storage_path ?? null,
    file_base64: String(row.file_base64 ?? ""),
    raw_text: String(row.raw_text ?? ""),
    structure_map: (row.structure_map ?? row.source_map ?? []) as Json,
  };
}

async function fetchDocumentRows(
  build: (select: string) => PromiseLike<{
    data: unknown[] | null;
    error: { message?: string } | null;
  }>,
): Promise<DocumentRow[]> {
  const first = await build(DOCUMENT_SELECT_SAFE);
  if (!first.error) {
    return ((first.data ?? []) as Record<string, unknown>[]).map(
      fromUnknownDocumentRow,
    );
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build("*");
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentene.");
    }
    return ((retry.data ?? []) as Record<string, unknown>[]).map(
      fromUnknownDocumentRow,
    );
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentene.");
}

async function fetchDocumentSummaryRows(
  build: (select: string) => PromiseLike<{
    data: unknown[] | null;
    error: { message?: string } | null;
  }>,
): Promise<DocumentSummaryRow[]> {
  const first = await build(DOCUMENT_SUMMARY_SELECT_SAFE);
  if (!first.error) {
    return ((first.data ?? []) as Record<string, unknown>[]).map(
      fromUnknownDocumentSummaryRow,
    );
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build(DOCUMENT_SUMMARY_SELECT_LEGACY);
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentene.");
    }
    return ((retry.data ?? []) as Record<string, unknown>[]).map(
      fromUnknownDocumentSummaryRow,
    );
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentene.");
}

async function fetchSingleDocumentRow(
  build: (select: string) => PromiseLike<{
    data: unknown | null;
    error: { message?: string } | null;
  }>,
): Promise<DocumentRow | null> {
  const first = await build(DOCUMENT_SELECT_SAFE);
  if (!first.error) {
    return first.data
      ? fromUnknownDocumentRow(first.data as Record<string, unknown>)
      : null;
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build("*");
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentet.");
    }
    return retry.data
      ? fromUnknownDocumentRow(retry.data as Record<string, unknown>)
      : null;
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentet.");
}

async function queryProjectRow(projectId: string) {
  const supabase = createServiceClient();
  const first = await supabase
    .from("projects")
    .select(PROJECT_SELECT_SAFE)
    .eq("id", projectId)
    .single<Record<string, unknown>>();

  if (!first.error && first.data) {
    return fromUnknownProjectRow(first.data);
  }

  if (isMissingLegacyProjectColumn(first.error)) {
    const retry = await supabase
      .from("projects")
      .select(PROJECT_SELECT_LEGACY)
      .eq("id", projectId)
      .single<Record<string, unknown>>();

    if (!retry.error && retry.data) {
      return fromUnknownProjectRow(retry.data);
    }
  }

  throw new Error("Fant ikke prosjektet.");
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const projectQuery = async (select: string) =>
        supabase
          .from("projects")
          .select(select)
          .order("last_activity_at", { ascending: false });
      const [
        projectsResult,
        documentRows,
        { data: artifacts },
      ] = await Promise.all([
        projectQuery(PROJECT_SELECT_SAFE),
        fetchDocumentSummaryRows((select) =>
          supabase.from("documents").select(select),
        ),
        supabase.from("generated_artifacts").select("id, project_id"),
      ]);
      let { data: projects, error: projectsError } = projectsResult;

      if (projectsError && isMissingLegacyProjectColumn(projectsError)) {
        const retry = await projectQuery(PROJECT_SELECT_LEGACY);
        projects = retry.data;
        projectsError = retry.error;
      }

      if (projectsError) {
        throw new Error(projectsError.message);
      }

      const documentsByProject = new Map<string, DocumentSummaryRow[]>();
      for (const row of documentRows) {
        const list = documentsByProject.get(row.project_id) ?? [];
        list.push(row);
        documentsByProject.set(row.project_id, list);
      }

      const artifactCount = new Map<string, number>();
      for (const row of artifacts ?? []) {
        artifactCount.set(
          row.project_id,
          (artifactCount.get(row.project_id) ?? 0) + 1,
        );
      }

      return ((projects ?? []) as unknown as Record<string, unknown>[]).map((row) => {
        const project = fromUnknownProjectRow(row);
        return {
          ...mapProjectSummary(
            project,
            documentsByProject.get(project.id) ?? [],
          ),
          artifact_count: artifactCount.get(project.id) ?? 0,
          has_chat: false,
        };
      });
    },
    ["projects-list"],
    {
      tags: [PROJECTS_LIST_TAG],
      revalidate: 60,
    },
  )();
}

export async function createProject(
  input: ProjectCreateInput,
): Promise<ProjectSummary> {
  const supabase = createServiceClient();
  const normalizedName = input.name?.trim() || "Ny analyse";
  const payload = {
    name: normalizedName,
    customer_name: input.customer_name?.trim() || null,
    description: input.description?.trim() || null,
    industry: input.industry?.trim() || null,
  };
  let insertResult = await supabase
    .from("projects")
    .insert(payload)
    .select("*")
    .single<Record<string, unknown>>();

  if (insertResult.error && isMissingLegacyProjectColumn(insertResult.error)) {
    insertResult = await supabase
      .from("projects")
      .insert({
        title: normalizedName,
        client_name: input.customer_name?.trim() || "Kunde ikke satt",
        description: input.description?.trim() || "",
      })
      .select("*")
      .single<Record<string, unknown>>();
  }

  if (insertResult.error || !insertResult.data) {
    throw new Error(
      insertResult.error?.message || "Kunne ikke opprette prosjekt.",
    );
  }

  revalidateTag(PROJECTS_LIST_TAG);
  revalidatePath("/");
  revalidatePath("/projects/new");

  const project = fromUnknownProjectRow(insertResult.data);
  const selectedServiceIds = Array.isArray(input.selected_service_ids)
    ? input.selected_service_ids.filter(Boolean)
    : [];
  if (selectedServiceIds.length) {
    await setProjectServiceSelections(project.id, selectedServiceIds);
  }

  return mapProjectSummary(project, []);
}

export async function deleteProject(projectId: string) {
  const supabase = createServiceClient();
  const { data: storedFiles } = await supabase
    .from("documents")
    .select("file_storage_bucket, file_storage_path")
    .eq("project_id", projectId);
  const { error } = await supabase.from("projects").delete().eq("id", projectId);

  if (error) {
    throw new Error(error.message || "Kunne ikke slette prosjektet.");
  }

  await removeStoredFiles(
    ((storedFiles ?? []) as Array<{
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>).map((file) => ({
      bucket: file.file_storage_bucket,
      path: file.file_storage_path,
    })),
  );
  revalidateProjectCaches(projectId);
  revalidatePath("/projects/new");
}

export async function listServiceDescriptions(): Promise<ServiceDescription[]> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const [{ data: services, error: servicesError }, { data: documents, error: documentsError }] =
        await Promise.all([
          supabase
            .from("service_descriptions")
            .select("*")
            .order("name", { ascending: true }),
          supabase
            .from("service_documents")
            .select(SERVICE_DOCUMENT_SUMMARY_SELECT)
            .order("created_at", { ascending: false }),
        ]);

      if (servicesError || documentsError) {
        if (
          isMissingRelationColumn(servicesError, "service_descriptions") ||
          isMissingRelationColumn(documentsError, "service_documents")
        ) {
          return [];
        }
        throw new Error(
          servicesError?.message ||
            documentsError?.message ||
            "Kunne ikke hente tjenestebeskrivelser.",
        );
      }

      const documentsByService = new Map<string, ServiceDocumentSummaryRow[]>();
      for (const document of (documents ?? []) as ServiceDocumentSummaryRow[]) {
        const list = documentsByService.get(document.service_id) ?? [];
        list.push(document);
        documentsByService.set(document.service_id, list);
      }

      return ((services ?? []) as ServiceDescriptionRow[]).map((service) =>
        mapServiceDescription(service, documentsByService.get(service.id) ?? []),
      );
    },
    ["service-descriptions"],
    {
      tags: [SERVICE_DESCRIPTIONS_TAG],
      revalidate: 3600,
    },
  )();
}

export async function getServiceDescription(
  serviceId: string,
): Promise<ServiceDescription> {
  const services = await listServiceDescriptions();
  const service = services.find((item) => item.id === serviceId);
  if (!service) {
    throw new Error("Fant ikke tjenesten.");
  }
  return service;
}

export async function upsertServiceDescription(input: {
  serviceId?: string | null;
  name: string;
  description?: string | null;
}) {
  const supabase = createServiceClient();
  const payload = {
    name: input.name.trim(),
    description: input.description?.trim() || "",
    keywords: keywordsFromText(
      `${input.name} ${input.description?.trim() || ""}`,
    ),
    inclusion_mode: "selected" as ServiceInclusionMode,
    updated_at: new Date().toISOString(),
  };

  if (!payload.name) {
    throw new Error("Tjenesten må ha et navn.");
  }

  let query = input.serviceId
    ? supabase
        .from("service_descriptions")
        .update(payload)
        .eq("id", input.serviceId)
        .select("*")
        .single<ServiceDescriptionRow>()
    : supabase
        .from("service_descriptions")
        .insert(payload)
        .select("*")
        .single<ServiceDescriptionRow>();
  let { data, error } = await query;

  if (error && isMissingRelationColumn(error, "service_descriptions")) {
    const legacyPayload = {
      name: payload.name,
      description: payload.description,
      inclusion_mode: payload.inclusion_mode,
      updated_at: payload.updated_at,
    };
    query = input.serviceId
      ? supabase
          .from("service_descriptions")
          .update(legacyPayload)
          .eq("id", input.serviceId)
          .select("*")
          .single<ServiceDescriptionRow>()
      : supabase
          .from("service_descriptions")
          .insert(legacyPayload)
          .select("*")
          .single<ServiceDescriptionRow>();
    const retry = await query;
    data = retry.data;
    error = retry.error;
  }

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre tjenesten.");
  }

  revalidateServiceCaches();
  return mapServiceDescription(data, []);
}

export async function saveServiceDocument(input: {
  serviceId: string;
  title: string;
  fileName: string;
  fileFormat: ServiceDocument["file_format"];
  contentType: string;
  fileSizeBytes: number;
  fileBase64: string;
  rawText: string;
  structureMap: unknown;
}) {
  const supabase = createServiceClient();
  const documentId = randomUUID();
  const pageCount =
    pageCountFromStructureMap(input.structureMap, input.fileFormat) ??
    pageCountFromRawText(input.rawText, input.fileFormat);
  const encryptedBase64 = encryptString(input.fileBase64);
  const storedFile = await uploadEncryptedBase64File({
    path: buildStoredFilePath({
      scope: "services",
      ownerId: input.serviceId,
      fileId: documentId,
      fileName: input.fileName,
    }),
    encryptedBase64,
  });
  const { data, error } = await supabase
    .from("service_documents")
    .insert({
      id: documentId,
      service_id: input.serviceId,
      title: input.title,
      file_name: input.fileName,
      file_format: input.fileFormat,
      content_type: input.contentType,
      file_size_bytes: input.fileSizeBytes,
      page_count: pageCount,
      file_storage_bucket: storedFile.bucket,
      file_storage_path: storedFile.path,
      file_base64: "",
      raw_text: encryptString(input.rawText),
      structure_map: encryptJson(input.structureMap),
    })
    .select(SERVICE_DOCUMENT_SUMMARY_SELECT)
    .single<ServiceDocumentSummaryRow>();

  if (error || !data) {
    await removeStoredFiles([storedFile]);
    throw new Error(error?.message || "Kunne ikke lagre tjenestedokumentet.");
  }

  const nextKeywords = keywordsFromText(
    `${input.title} ${input.fileName} ${input.rawText}`,
  );
  const currentService = await getServiceDescription(input.serviceId).catch(
    () => null,
  );
  const serviceKeywords = mergeKeywords(
    currentService?.keywords ?? [],
    nextKeywords,
  );
  const updateResult = await supabase
    .from("service_descriptions")
    .update({ updated_at: new Date().toISOString(), keywords: serviceKeywords })
    .eq("id", input.serviceId);
  if (
    updateResult.error &&
    !isMissingRelationColumn(updateResult.error, "service_descriptions")
  ) {
    throw new Error(updateResult.error.message);
  }
  if (
    updateResult.error &&
    isMissingRelationColumn(updateResult.error, "service_descriptions")
  ) {
    await supabase
      .from("service_descriptions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", input.serviceId);
  }

  revalidateServiceCaches();
  return mapServiceDocument(data);
}

export async function deleteServiceDocument(
  serviceId: string,
  documentId: string,
) {
  const supabase = createServiceClient();
  const { data: storedFile } = await supabase
    .from("service_documents")
    .select("file_storage_bucket, file_storage_path")
    .eq("service_id", serviceId)
    .eq("id", documentId)
    .maybeSingle<{
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>();
  const { error } = await supabase
    .from("service_documents")
    .delete()
    .eq("service_id", serviceId)
    .eq("id", documentId);
  if (error) {
    throw new Error(error.message);
  }
  if (storedFile) {
    await removeStoredFiles([
      {
        bucket: storedFile.file_storage_bucket,
        path: storedFile.file_storage_path,
      },
    ]);
  }
  revalidateServiceCaches();
}

export async function deleteServiceDescription(serviceId: string) {
  const supabase = createServiceClient();
  const { data: storedFiles } = await supabase
    .from("service_documents")
    .select("file_storage_bucket, file_storage_path")
    .eq("service_id", serviceId);
  const { error } = await supabase
    .from("service_descriptions")
    .delete()
    .eq("id", serviceId);
  if (error) {
    throw new Error(error.message);
  }
  await removeStoredFiles(
    ((storedFiles ?? []) as Array<{
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>).map((file) => ({
      bucket: file.file_storage_bucket,
      path: file.file_storage_path,
    })),
  );
  revalidateServiceCaches();
}

export async function listServiceDocumentDetailsForProject(
  projectId: string,
  options?: {
    limit?: number;
    documentIds?: string[];
  },
): Promise<ServiceDocumentDetail[]> {
  const limit =
    typeof options?.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;

  if (limit === 0) {
    return [];
  }

  const supabase = createServiceClient();
  const hasDocumentIdFilter = Array.isArray(options?.documentIds);
  const documentIds = hasDocumentIdFilter
    ? options.documentIds!.filter(Boolean)
    : [];

  if (hasDocumentIdFilter && !documentIds.length) {
    return [];
  }

  if (documentIds.length) {
    let query = supabase
      .from("service_documents")
      .select("*")
      .in("id", documentIds)
      .order("created_at", { ascending: false });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    return Promise.all(
      ((data ?? []) as ServiceDocumentRow[]).map(resolveServiceDocumentRow),
    );
  }

  const { data: selections, error: selectionsError } = await supabase
    .from("project_service_selections")
    .select("service_id")
    .eq("project_id", projectId)
    .eq("selected", true);

  if (isMissingRelationColumn(selectionsError, "project_service_selections")) {
    return [];
  }
  if (selectionsError) {
    throw new Error(
      selectionsError.message || "Kunne ikke hente valgte tjenester.",
    );
  }

  const serviceIds = Array.from(
    new Set(
      ((selections ?? []) as Array<{ service_id: string }>)
        .map((item) => item.service_id)
        .filter(Boolean),
    ),
  );

  if (!serviceIds.length) {
    return [];
  }

  let query = supabase
    .from("service_documents")
    .select("*")
    .in("service_id", serviceIds)
    .order("created_at", { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return Promise.all(
    ((data ?? []) as ServiceDocumentRow[]).map(resolveServiceDocumentRow),
  );
}

export async function listServiceDocumentSummariesForProject(
  projectId: string,
): Promise<ServiceDocument[]> {
  const supabase = createServiceClient();
  const { data: selections, error: selectionsError } = await supabase
    .from("project_service_selections")
    .select("service_id")
    .eq("project_id", projectId)
    .eq("selected", true);

  if (isMissingRelationColumn(selectionsError, "project_service_selections")) {
    return [];
  }
  if (selectionsError) {
    throw new Error(
      selectionsError.message || "Kunne ikke hente valgte tjenester.",
    );
  }

  const serviceIds = Array.from(
    new Set(
      ((selections ?? []) as Array<{ service_id: string }>)
        .map((item) => item.service_id)
        .filter(Boolean),
    ),
  );

  if (!serviceIds.length) {
    return [];
  }

  const { data, error } = await supabase
    .from("service_documents")
    .select(SERVICE_DOCUMENT_SUMMARY_SELECT)
    .in("service_id", serviceIds)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingRelationColumn(error, "ai_summary")) {
      return [];
    }
    throw new Error(error.message);
  }

  return ((data ?? []) as ServiceDocumentSummaryRow[]).map(mapServiceDocument);
}

export async function updateServiceDocumentAiSummary(input: {
  documentId: string;
  aiSummary: string;
}) {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("service_documents")
    .update({
      ai_summary: encryptString(input.aiSummary),
      ai_summary_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error && !isMissingRelationColumn(error, "ai_summary")) {
    throw new Error(error.message);
  }

  revalidateServiceCaches();
}

export async function listProjectServiceDescriptions(
  projectId: string,
): Promise<ProjectServiceDescription[]> {
  const supabase = createServiceClient();
  const [services, project, documentRows, { data: selections, error: selectionsError }] =
    await Promise.all([
      listServiceDescriptions(),
      queryProjectRow(projectId),
      fetchDocumentSummaryRows((select) =>
        supabase
          .from("documents")
          .select(select)
          .eq("project_id", projectId),
      ).catch(() => []),
      supabase
        .from("project_service_selections")
        .select("service_id, selected")
        .eq("project_id", projectId),
    ]);

  if (
    selectionsError &&
    !isMissingRelationColumn(selectionsError, "project_service_selections")
  ) {
    throw new Error(selectionsError.message);
  }

  const selected = new Map(
    ((selections ?? []) as Array<{ service_id: string; selected: boolean }>).map(
      (item) => [item.service_id, item.selected],
    ),
  );
  const projectKeywords = new Set(
    mergeKeywords(
      project.context_keywords,
      keywordsFromText(
        [
          project.name,
          project.customer_name ?? "",
          project.description ?? "",
          project.industry ?? "",
          ...documentRows.map(
            (document) => `${document.title} ${document.file_name}`,
          ),
        ].join(" "),
      ),
    ),
  );

  return services.map((service) => {
    const serviceKeywords = mergeKeywords(
      service.keywords,
      keywordsFromText(
        [
          service.name,
          service.description,
          ...service.documents.map(
            (document) => `${document.title} ${document.file_name}`,
          ),
        ].join(" "),
      ),
    );
    const overlap = serviceKeywords.filter((word) =>
      projectKeywords.has(word),
    );
    const score = Math.min(
      100,
      Math.round((overlap.length / Math.max(4, serviceKeywords.length)) * 100),
    );
    return {
      ...service,
      selected: selected.get(service.id) ?? false,
      recommended: score >= 18,
      recommendation_score: score,
      recommendation_reason: overlap.length
        ? `Matcher prosjektet på ${overlap.slice(0, 4).join(", ")}.`
        : "Ingen tydelig match mot prosjektkonteksten ennå.",
    };
  });
}

export async function setProjectServiceSelections(
  projectId: string,
  serviceIds: string[],
) {
  const supabase = createServiceClient();
  const uniqueIds = Array.from(new Set(serviceIds.filter(Boolean)));
  const services = await listServiceDescriptions();
  const selectableIds = new Set(services.map((service) => service.id));

  await supabase.from("project_service_selections").delete().eq("project_id", projectId);

  const rows = uniqueIds
    .filter((serviceId) => selectableIds.has(serviceId))
    .map((serviceId) => ({
      project_id: projectId,
      service_id: serviceId,
      selected: true,
    }));

  if (rows.length) {
    const { error } = await supabase
      .from("project_service_selections")
      .insert(rows);
    if (error) {
      throw new Error(error.message);
    }
  }

  revalidateProjectCaches(projectId);
}

export async function updateProjectMetadataFromInference(
  projectId: string,
  inferred: ProjectMetadataInference,
) {
  const supabase = createServiceClient();
  const project = await queryProjectRow(projectId);

  const nextName = shouldUseInferredValue(
    project.name,
    inferred.name,
    isProjectNamePlaceholder,
  )
    ? (inferred.name?.trim() ?? null)
    : null;
  const nextCustomerName = shouldUseInferredValue(
    project.customer_name,
    inferred.customer_name,
    isCustomerPlaceholder,
  )
    ? (inferred.customer_name?.trim() ?? null)
    : null;
  const nextIndustry =
    !project.industry?.trim() && inferred.industry?.trim()
      ? inferred.industry.trim()
      : null;
  const nextDescription =
    !project.description?.trim() && inferred.description?.trim()
      ? inferred.description.trim()
      : null;

  if (!nextName && !nextCustomerName && !nextIndustry && !nextDescription) {
    return project;
  }

  const standardPatch: Record<string, unknown> = {
    last_activity_at: new Date().toISOString(),
  };

  if (nextName) {
    standardPatch.name = nextName;
  }
  if (nextCustomerName) {
    standardPatch.customer_name = nextCustomerName;
  }
  if (nextIndustry) {
    standardPatch.industry = nextIndustry;
  }
  if (nextDescription) {
    standardPatch.description = nextDescription;
  }
  standardPatch.context_keywords = mergeKeywords(
    project.context_keywords,
    keywordsFromText(
      [nextName, nextCustomerName, nextIndustry, nextDescription]
        .filter(Boolean)
        .join(" "),
    ),
  );

  let updateResult = await supabase
    .from("projects")
    .update(standardPatch)
    .eq("id", projectId)
    .select("*")
    .single<Record<string, unknown>>();

  if (updateResult.error && isMissingLegacyProjectColumn(updateResult.error)) {
    const legacyPatch: Record<string, unknown> = {
      last_activity_at: standardPatch.last_activity_at,
    };
    if (nextName) {
      legacyPatch.title = nextName;
    }
    if (nextCustomerName) {
      legacyPatch.client_name = nextCustomerName;
    }
    if (nextDescription) {
      legacyPatch.description = nextDescription;
    }

    updateResult = await supabase
      .from("projects")
      .update(legacyPatch)
      .eq("id", projectId)
      .select("*")
      .single<Record<string, unknown>>();
  }

  if (updateResult.error || !updateResult.data) {
    throw new Error(
      updateResult.error?.message || "Kunne ikke oppdatere prosjektmetadata.",
    );
  }

  revalidateProjectCaches(projectId);

  return fromUnknownProjectRow(updateResult.data);
}

async function updateProjectContextKeywords(projectId: string) {
  const supabase = createServiceClient();
  try {
    const [project, documents, analysis] = await Promise.all([
      queryProjectRow(projectId),
      fetchDocumentSummaryRows((select) =>
        supabase
          .from("documents")
          .select(select)
          .eq("project_id", projectId),
      ).catch(() => []),
      getCustomerAnalysis(projectId).catch(() => null),
    ]);
    const keywords = mergeKeywords(
      project.context_keywords,
      keywordsFromText(
        [
          project.name,
          project.customer_name ?? "",
          project.description ?? "",
          project.industry ?? "",
          ...documents.map((document) => `${document.title} ${document.file_name}`),
          analysis?.customer_profile_summary ?? "",
          analysis?.customer_goals_summary ?? "",
          analysis?.high_level_solution_design ?? "",
        ].join(" "),
      ),
      analysis?.signal_words ?? [],
    );
    const { error } = await supabase
      .from("projects")
      .update({ context_keywords: keywords })
      .eq("id", projectId);
    if (error && !isMissingLegacyProjectColumn(error)) {
      throw new Error(error.message);
    }
  } catch {
    // Keyword cache is an optimization; never block the main workflow.
  }
}

export async function getProjectDetail(
  projectId: string,
): Promise<ProjectDetail> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();

      const [
        projectRow,
        documentRows,
        { data: analyses, error: analysesError },
        { data: evaluations, error: evaluationsError },
        { data: executiveSummaries, error: executiveSummariesError },
        { data: artifactRows, error: artifactsError },
      ] = await Promise.all([
        queryProjectRow(projectId),
        fetchDocumentSummaryRows((select) =>
          supabase
            .from("documents")
            .select(select)
            .eq("project_id", projectId)
            .order("created_at", { ascending: false }),
        ),
        supabase
          .from("customer_analyses")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("solution_evaluations")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("executive_summaries")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("generated_artifacts")
          .select("id")
          .eq("project_id", projectId),
      ]);

      if (
        analysesError ||
        evaluationsError ||
        artifactsError ||
        (executiveSummariesError &&
          !isMissingRelationColumn(
            executiveSummariesError,
            "executive_summaries",
          ))
      ) {
        throw new Error(
          analysesError?.message ||
            evaluationsError?.message ||
            executiveSummariesError?.message ||
            artifactsError?.message ||
            "Kunne ikke laste prosjektet.",
        );
      }

      const analysisRow =
        ((analyses ?? [])[0] as CustomerAnalysisRow | undefined) ?? null;
      const evaluationRow =
        ((evaluations ?? [])[0] as SolutionEvaluationRow | undefined) ?? null;
      const executiveSummaryRow =
        ((executiveSummaries ?? [])[0] as ExecutiveSummaryRow | undefined) ??
        null;

      return {
        id: projectRow.id,
        name: projectRow.name,
        customer_name: projectRow.customer_name,
        description: projectRow.description,
        industry: projectRow.industry,
        status: mapProjectStatus(projectRow),
        customer_document_uploaded: projectRow.customer_document_uploaded,
        customer_analysis_generated: projectRow.customer_analysis_generated,
        solution_document_uploaded: projectRow.solution_document_uploaded,
        solution_evaluation_generated: projectRow.solution_evaluation_generated,
        last_activity_at: projectRow.last_activity_at,
        created_at: projectRow.created_at,
        updated_at: projectRow.updated_at,
        document_count: documentRows.length,
        supporting_document_count: documentRows.filter(
          (document) => document.role === "supporting_document",
        ).length,
        artifact_count: (artifactRows ?? []).length,
        has_chat: false,
        documents: documentRows.map(mapDocumentSummary),
        customer_analysis: analysisRow
          ? decryptJson(analysisRow.result_json, CUSTOMER_ANALYSIS_EMPTY)
          : null,
        solution_evaluation: evaluationRow
          ? mapSolutionEvaluationRow(evaluationRow)
          : null,
        executive_summary: executiveSummaryRow
          ? mapExecutiveSummaryRow(executiveSummaryRow)
          : null,
        generated_artifacts: [],
        chat_messages: [],
      };
    },
    ["project-detail", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function getProjectShell(
  projectId: string,
  options: {
    includeCustomerAnalysis?: boolean;
    includeSolutionEvaluation?: boolean;
    includeExecutiveSummary?: boolean;
  } = {},
): Promise<ProjectDetail> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();

      const [
        projectRow,
        documentRows,
        { data: artifactRows, error: artifactsError },
        { data: analyses, error: analysesError },
        { data: evaluations, error: evaluationsError },
        { data: executiveSummaries, error: executiveSummariesError },
      ] = await Promise.all([
        queryProjectRow(projectId),
        fetchDocumentSummaryRows((select) =>
          supabase
            .from("documents")
            .select(select)
            .eq("project_id", projectId)
            .order("created_at", { ascending: false }),
        ),
        supabase
          .from("generated_artifacts")
          .select("id")
          .eq("project_id", projectId),
        options.includeCustomerAnalysis
          ? supabase
              .from("customer_analyses")
              .select("*")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
        options.includeSolutionEvaluation
          ? supabase
              .from("solution_evaluations")
              .select("*")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
        options.includeExecutiveSummary
          ? supabase
              .from("executive_summaries")
              .select("*")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (
        artifactsError ||
        analysesError ||
        evaluationsError ||
        (executiveSummariesError &&
          !isMissingRelationColumn(
            executiveSummariesError,
            "executive_summaries",
          ))
      ) {
        throw new Error(
          artifactsError?.message ||
            analysesError?.message ||
            evaluationsError?.message ||
            executiveSummariesError?.message ||
            "Kunne ikke laste prosjektet.",
        );
      }

      const analysisRow =
        ((analyses ?? [])[0] as CustomerAnalysisRow | undefined) ?? null;
      const evaluationRow =
        ((evaluations ?? [])[0] as SolutionEvaluationRow | undefined) ?? null;
      const executiveSummaryRow =
        ((executiveSummaries ?? [])[0] as ExecutiveSummaryRow | undefined) ??
        null;

      return {
        id: projectRow.id,
        name: projectRow.name,
        customer_name: projectRow.customer_name,
        description: projectRow.description,
        industry: projectRow.industry,
        status: mapProjectStatus(projectRow),
        customer_document_uploaded: projectRow.customer_document_uploaded,
        customer_analysis_generated: projectRow.customer_analysis_generated,
        solution_document_uploaded: projectRow.solution_document_uploaded,
        solution_evaluation_generated: projectRow.solution_evaluation_generated,
        last_activity_at: projectRow.last_activity_at,
        created_at: projectRow.created_at,
        updated_at: projectRow.updated_at,
        document_count: documentRows.length,
        supporting_document_count: documentRows.filter(
          (document) => document.role === "supporting_document",
        ).length,
        artifact_count: (artifactRows ?? []).length,
        has_chat: false,
        documents: documentRows.map(mapDocumentSummary),
        customer_analysis: analysisRow
          ? decryptJson(analysisRow.result_json, CUSTOMER_ANALYSIS_EMPTY)
          : null,
        solution_evaluation: evaluationRow
          ? mapSolutionEvaluationRow(evaluationRow)
          : null,
        executive_summary: executiveSummaryRow
          ? mapExecutiveSummaryRow(executiveSummaryRow)
          : null,
        generated_artifacts: [],
        chat_messages: [],
      };
    },
    [
      "project-shell",
      projectId,
      options.includeCustomerAnalysis ? "analysis" : "no-analysis",
      options.includeSolutionEvaluation ? "evaluation" : "no-evaluation",
      options.includeExecutiveSummary ? "executive-summary" : "no-executive-summary",
    ],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function saveDocument(input: {
  projectId: string;
  title: string;
  role: ProjectDocumentRole;
  supportingSubtype?: SupportingDocumentSubtype | null;
  fileName: string;
  fileFormat: ProjectDocumentDetail["file_format"];
  contentType: string;
  fileSizeBytes: number;
  fileBase64: string;
  rawText: string;
  structureMap: unknown;
}) {
  const supabase = createServiceClient();
  const documentId = randomUUID();
  const pageCount =
    pageCountFromStructureMap(input.structureMap, input.fileFormat) ??
    pageCountFromRawText(input.rawText, input.fileFormat);
  const encryptedBase64 = encryptString(input.fileBase64);
  const storedFile = await uploadEncryptedBase64File({
    path: buildStoredFilePath({
      scope: "projects",
      ownerId: input.projectId,
      fileId: documentId,
      fileName: input.fileName,
    }),
    encryptedBase64,
  });
  const payloadWithSubtype = {
    id: documentId,
    project_id: input.projectId,
    role: input.role,
    supporting_subtype:
      input.role === "supporting_document"
        ? (input.supportingSubtype ?? null)
        : null,
    title: input.title,
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    file_size_bytes: input.fileSizeBytes,
    page_count: pageCount,
    file_storage_bucket: storedFile.bucket,
    file_storage_path: storedFile.path,
    file_base64: "",
    raw_text: encryptString(input.rawText),
    structure_map: encryptJson(input.structureMap),
  };

  let inserted: DocumentRow | null = null;
  let usedLegacyDocumentInsert = false;
  let insertResult = await supabase
    .from("documents")
    .insert(payloadWithSubtype)
    .select("*")
    .single<DocumentRow>();

  if (insertResult.error && isMissingLegacyDocumentColumn(insertResult.error)) {
    usedLegacyDocumentInsert = true;
    const payloadLegacy: Record<string, unknown> = {
      ...payloadWithSubtype,
      file_base64: encryptedBase64,
      display_name: input.title,
      subtype:
        input.role === "supporting_document"
          ? (input.supportingSubtype ?? null)
          : null,
    };
    delete payloadLegacy.supporting_subtype;
    delete payloadLegacy.title;
    delete payloadLegacy.file_name;
    delete payloadLegacy.file_size_bytes;
    delete payloadLegacy.page_count;
    delete payloadLegacy.file_storage_bucket;
    delete payloadLegacy.file_storage_path;
    insertResult = await supabase
      .from("documents")
      .insert(payloadLegacy)
      .select("*")
      .single<DocumentRow>();
  }

  if (insertResult.error || !insertResult.data) {
    await removeStoredFiles([storedFile]);
    throw new Error(
      insertResult.error?.message || "Kunne ikke lagre dokumentet.",
    );
  }
  inserted = fromUnknownDocumentRow(
    insertResult.data as unknown as Record<string, unknown>,
  );
  if (usedLegacyDocumentInsert) {
    await removeStoredFiles([storedFile]);
  }

  const projectPatch: Partial<ProjectRow> = {
    customer_document_uploaded: true,
    last_activity_at: new Date().toISOString(),
  };
  if (input.role === "primary_solution_document") {
    let demoteResult = await supabase
      .from("documents")
      .update({
        role: "supporting_document",
        supporting_subtype: "utkast",
      })
      .eq("project_id", input.projectId)
      .eq("role", "primary_solution_document")
      .neq("id", inserted.id);

    if (demoteResult.error && isMissingLegacyDocumentColumn(demoteResult.error)) {
      demoteResult = await supabase
        .from("documents")
        .update({
          role: "supporting_document",
          subtype: "utkast",
        })
        .eq("project_id", input.projectId)
        .eq("role", "primary_solution_document")
        .neq("id", inserted.id);
    }

    if (demoteResult.error) {
      throw new Error(demoteResult.error.message);
    }

    projectPatch.solution_document_uploaded = true;
    projectPatch.solution_evaluation_generated = false;
    await supabase
      .from("solution_evaluations")
      .delete()
      .eq("project_id", input.projectId);
  }

  await supabase
    .from("executive_summaries")
    .delete()
    .eq("project_id", input.projectId);

  await supabase
    .from("projects")
    .update(projectPatch)
    .eq("id", input.projectId);

  await updateProjectContextKeywords(input.projectId);
  revalidateProjectCaches(input.projectId);

  return mapDocumentSummary(inserted);
}

export async function getDocumentDetail(
  projectId: string,
  documentId: string,
): Promise<ProjectDocumentDetail> {
  const supabase = createServiceClient();
  const data = await fetchSingleDocumentRow((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .eq("id", documentId)
      .single(),
  );

  if (!data) {
    throw new Error("Fant ikke dokumentet.");
  }

  return resolveDocumentRow(data);
}

export async function deleteDocument(projectId: string, documentId: string) {
  const supabase = createServiceClient();
  const { data: beforeDelete } = await supabase
    .from("documents")
    .select("id, role, file_storage_bucket, file_storage_path")
    .eq("project_id", projectId)
    .eq("id", documentId)
    .single<{
      id: string;
      role: ProjectDocumentRole;
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>();

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .eq("id", documentId);
  if (error) {
    throw new Error(error.message);
  }
  await removeStoredFiles([
    {
      bucket: beforeDelete?.file_storage_bucket,
      path: beforeDelete?.file_storage_path,
    },
  ]);

  const { data: remaining } = await supabase
    .from("documents")
    .select("role")
    .eq("project_id", projectId);
  const rows = remaining ?? [];
  const hasDocuments = rows.length > 0;

  await supabase
    .from("projects")
    .update({
      customer_document_uploaded: hasDocuments,
      solution_document_uploaded: rows.some(
        (row) => row.role === "primary_solution_document",
      ),
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (!hasDocuments || beforeDelete?.role === "primary_customer_document") {
    await supabase
      .from("customer_analyses")
      .delete()
      .eq("project_id", projectId);
    await supabase
      .from("projects")
      .update({ customer_analysis_generated: false })
      .eq("id", projectId);
  }

  if (!hasDocuments || beforeDelete?.role === "primary_solution_document") {
    await supabase
      .from("solution_evaluations")
      .delete()
      .eq("project_id", projectId);
    await supabase
      .from("projects")
      .update({ solution_evaluation_generated: false })
      .eq("id", projectId);
  }

  revalidateProjectCaches(projectId);
}

export async function markDocumentAsPrimarySolution(
  projectId: string,
  documentId: string,
) {
  const supabase = createServiceClient();

  const selected = await fetchSingleDocumentRow((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .eq("id", documentId)
      .single(),
  );

  if (!selected) {
    throw new Error("Fant ikke dokumentet som skal brukes som arkitektløsning.");
  }

  let demoteResult = await supabase
    .from("documents")
    .update({
      role: "supporting_document",
      supporting_subtype: "utkast",
    })
    .eq("project_id", projectId)
    .eq("role", "primary_solution_document")
    .neq("id", documentId);

  if (demoteResult.error && isMissingLegacyDocumentColumn(demoteResult.error)) {
    demoteResult = await supabase
      .from("documents")
      .update({
        role: "supporting_document",
        subtype: "utkast",
      })
      .eq("project_id", projectId)
      .eq("role", "primary_solution_document")
      .neq("id", documentId);
  }

  if (demoteResult.error) {
    throw new Error(demoteResult.error.message);
  }

  let promoteResult = await supabase
    .from("documents")
    .update({
      role: "primary_solution_document",
      supporting_subtype: null,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", projectId)
    .eq("id", documentId)
    .select("*")
    .single<DocumentRow>();

  if (promoteResult.error && isMissingLegacyDocumentColumn(promoteResult.error)) {
    promoteResult = await supabase
      .from("documents")
      .update({
        role: "primary_solution_document",
        subtype: null,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", projectId)
      .eq("id", documentId)
      .select("*")
      .single<DocumentRow>();
  }

  if (promoteResult.error || !promoteResult.data) {
    throw new Error(
      promoteResult.error?.message || "Kunne ikke velge arkitektløsningen.",
    );
  }

  await supabase
    .from("solution_evaluations")
    .delete()
    .eq("project_id", projectId);

  await supabase
    .from("projects")
    .update({
      solution_document_uploaded: true,
      solution_evaluation_generated: false,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  revalidateProjectCaches(projectId);

  return mapDocumentSummary(
    fromUnknownDocumentSummaryRow(
      promoteResult.data as unknown as Record<string, unknown>,
    ),
  );
}

export async function getPrimaryDocument(
  projectId: string,
  role: Extract<
    ProjectDocumentRole,
    "primary_customer_document" | "primary_solution_document"
  >,
) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .eq("role", role)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  const row = rows[0] ?? null;
  return row ? resolveDocumentRow(row) : null;
}

export async function listSupportingDocuments(projectId: string) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .eq("role", "supporting_document")
      .order("created_at", { ascending: false }),
  );

  return Promise.all(rows.map(resolveDocumentRow));
}

export async function listProjectDocumentSummaries(projectId: string) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentSummaryRows((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
  );

  return rows.map(mapDocumentSummary);
}

export async function listProjectDocuments(projectId: string) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows((select) =>
    supabase
      .from("documents")
      .select(select)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
  );

  return Promise.all(rows.map(resolveDocumentRow));
}

export async function saveCustomerAnalysis(
  projectId: string,
  sourceDocumentIds: string[],
  result: CustomerAnalysisResult,
  options?: {
    previousAnalysis?: CustomerAnalysisResult | null;
    updatedSections?: CustomerAnalysisSection[];
    historySource?: CustomerAnalysisHistorySource;
  },
) {
  const supabase = createServiceClient();
  const previousAnalysis =
    options && "previousAnalysis" in options
      ? (options.previousAnalysis ?? null)
      : await getCustomerAnalysis(projectId);
  const resultWithHistory = appendCustomerAnalysisSectionHistory({
    previousAnalysis,
    nextAnalysis: result,
    sections: options?.updatedSections ?? [...CUSTOMER_ANALYSIS_SECTIONS],
    source: options?.historySource ?? "full_regeneration",
  });

  await supabase.from("customer_analyses").delete().eq("project_id", projectId);

  const { data, error } = await supabase
    .from("customer_analyses")
    .insert({
      project_id: projectId,
      source_document_ids: sourceDocumentIds,
      result_json: encryptJson(resultWithHistory),
    })
    .select("*")
    .single<CustomerAnalysisRow>();

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kundeanalysen.");
  }

  const projectKeywords = mergeKeywords(
    keywordsFromText(
      [
        result.customer_profile_summary,
        result.customer_goals_summary,
        result.high_level_solution_design,
        result.executive_summary,
      ].join(" "),
    ),
    result.signal_words ?? [],
  );

  const projectUpdate = await supabase
    .from("projects")
    .update({
      customer_analysis_generated: true,
      last_activity_at: new Date().toISOString(),
      context_keywords: projectKeywords,
    })
    .eq("id", projectId);
  if (
    projectUpdate.error &&
    !isMissingLegacyProjectColumn(projectUpdate.error)
  ) {
    throw new Error(projectUpdate.error.message);
  }
  if (projectUpdate.error && isMissingLegacyProjectColumn(projectUpdate.error)) {
    await supabase
      .from("projects")
      .update({
        customer_analysis_generated: true,
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", projectId);
  }

  revalidateProjectCaches(projectId);

  return decryptJson(data.result_json, CUSTOMER_ANALYSIS_EMPTY);
}

export async function getCustomerAnalysis(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("customer_analyses")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) {
        throw new Error(error.message);
      }

      const row = (data?.[0] as CustomerAnalysisRow | undefined) ?? null;
      return row ? decryptJson(row.result_json, CUSTOMER_ANALYSIS_EMPTY) : null;
    },
    ["project-customer-analysis", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function saveSolutionEvaluation(
  projectId: string,
  input: {
    customerDocumentId: string | null;
    solutionDocumentId: string | null;
    analysisId?: string | null;
    result: SolutionEvaluationResult;
  },
) {
  const supabase = createServiceClient();
  await supabase
    .from("solution_evaluations")
    .delete()
    .eq("project_id", projectId);
  let insertResult = await supabase
    .from("solution_evaluations")
    .insert({
      project_id: projectId,
      customer_document_id: input.customerDocumentId,
      solution_document_id: input.solutionDocumentId,
      analysis_id: input.analysisId ?? null,
      result_json: encryptJson(input.result),
    })
    .select("*")
    .single<SolutionEvaluationRow>();

  if (isMissingRelationColumn(insertResult.error, "solution_evaluations")) {
    insertResult = await supabase
      .from("solution_evaluations")
      .insert({
        project_id: projectId,
        source_document_ids: [
          input.customerDocumentId,
          input.solutionDocumentId,
        ].filter(Boolean),
        result_json: encryptJson(input.result),
      })
      .select("*")
      .single<SolutionEvaluationRow>();
  }

  if (insertResult.error || !insertResult.data) {
    throw new Error(
      insertResult.error?.message || "Kunne ikke lagre løsningsvurderingen.",
    );
  }

  await supabase.from("executive_summaries").delete().eq("project_id", projectId);

  await supabase
    .from("projects")
    .update({
      solution_evaluation_generated: true,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  revalidateProjectCaches(projectId);

  return mapSolutionEvaluationRow(insertResult.data);
}

export async function saveExecutiveSummary(
  projectId: string,
  result: ExecutiveSummaryResult,
  inputSnapshot: unknown,
) {
  const supabase = createServiceClient();
  await supabase.from("executive_summaries").delete().eq("project_id", projectId);
  const { data, error } = await supabase
    .from("executive_summaries")
    .insert({
      project_id: projectId,
      result_json: encryptJson(result),
      input_snapshot: encryptJson(inputSnapshot),
    })
    .select("*")
    .single<ExecutiveSummaryRow>();

  if (isMissingRelationColumn(error, "executive_summaries")) {
    throw new Error(
      "Tabellen executive_summaries mangler. Oppdater Supabase schema før lederoppsummering kan lagres separat.",
    );
  }

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre lederoppsummeringen.");
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", projectId);

  revalidateProjectCaches(projectId);
  return mapExecutiveSummaryRow(data);
}

export async function getExecutiveSummary(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("executive_summaries")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (isMissingRelationColumn(error, "executive_summaries")) {
        return null;
      }

      if (error) {
        throw new Error(error.message);
      }

      const row = (data?.[0] as ExecutiveSummaryRow | undefined) ?? null;
      return row ? mapExecutiveSummaryRow(row) : null;
    },
    ["project-executive-summary", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function getSolutionEvaluation(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("solution_evaluations")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) {
        throw new Error(error.message);
      }

      const row = (data?.[0] as SolutionEvaluationRow | undefined) ?? null;
      return row ? mapSolutionEvaluationRow(row) : null;
    },
    ["project-solution-evaluation", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function saveGeneratedArtifact(
  projectId: string,
  artifactType: GeneratedArtifactType,
  title: string,
  contentMarkdown: string,
  inputSnapshot: unknown,
) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("generated_artifacts")
    .insert({
      project_id: projectId,
      artifact_type: artifactType,
      title,
      content_markdown: contentMarkdown,
      input_snapshot: encryptJson(inputSnapshot),
    })
    .select("*")
    .single<ArtifactRow>();

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre generatorresultatet.");
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", projectId);
  revalidateProjectCaches(projectId);
  return mapArtifact(data);
}

export async function updateGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
  title: string;
  contentMarkdown: string;
}) {
  const title = input.title.trim();
  const contentMarkdown = input.contentMarkdown.trim();

  if (!title) {
    throw new Error("Kravbesvarelsen må ha en tittel.");
  }

  if (!contentMarkdown) {
    throw new Error("Kravbesvarelsen kan ikke være tom.");
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("generated_artifacts")
    .update({
      title,
      content_markdown: contentMarkdown,
      input_snapshot: encryptJson({
        edited_manually: true,
        edited_at: new Date().toISOString(),
      }),
    })
    .eq("id", input.artifactId)
    .eq("project_id", input.projectId)
    .select("*")
    .single<ArtifactRow>();

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kravbesvarelsen.");
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", input.projectId);
  revalidateProjectCaches(input.projectId);
  return mapArtifact(data);
}

export async function deleteGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
}) {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("generated_artifacts")
    .delete()
    .eq("id", input.artifactId)
    .eq("project_id", input.projectId);

  if (error) {
    throw new Error(error.message || "Kunne ikke slette artefakten.");
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", input.projectId);
  revalidateProjectCaches(input.projectId);
}

export async function listGeneratedArtifacts(projectId: string) {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("generated_artifacts")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(error.message || "Kunne ikke hente generatorartefakter.");
      }

      return ((data ?? []) as ArtifactRow[]).map(mapArtifact);
    },
    ["project-generated-artifacts", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function appendChatMessage(
  projectId: string,
  role: ChatMessageRole,
  content: string,
  contextSnapshot: unknown,
) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      project_id: projectId,
      role,
      content,
      context_snapshot: encryptJson(contextSnapshot),
    })
    .select("*")
    .single<ChatRow>();

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre chatmeldingen.");
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", projectId);
  revalidateProjectCaches(projectId);
  return mapChatMessage(data);
}

export async function listChatMessages(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message || "Kunne ikke hente chatmeldinger.");
  }

  return ((data ?? []) as ChatRow[]).map(mapChatMessage);
}

export async function getProjectSnapshot(
  projectId: string,
): Promise<ProjectCacheSnapshot> {
  const project = await queryProjectRow(projectId);
  return mapProjectSnapshot(project);
}
