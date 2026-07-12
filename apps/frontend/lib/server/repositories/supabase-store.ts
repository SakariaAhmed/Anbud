import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";

import { createServiceClient } from "@/lib/server/supabase";
import {
  buildStoredFilePrefix,
  buildStoredFilePath,
  downloadEncryptedBase64File,
  removeStoredFilePrefixes,
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
  deleteDocumentChunks,
  replaceProjectDocumentChunks,
  replaceServiceDocumentChunks,
} from "@/lib/server/document-chunks";
import { normalizeDocumentChunkStructureMap } from "@/lib/server/document-chunk-structure";
import {
  isMissingRelationColumn,
  isMissingSchemaColumn,
  missingColumnNameFromError,
  removeMissingStorageColumns,
} from "@/lib/server/repositories/supabase-compat";
import {
  appendCustomerAnalysisSectionHistory,
  CUSTOMER_ANALYSIS_SECTIONS,
} from "@/lib/customer-analysis-history";
import {
  rethrowAuthoritativeLeaseLoss,
  runLeaseFencedCustomerAnalysisMutation,
  runLeaseFencedExecutiveSummaryMutation,
  runLeaseFencedGeneratedArtifactMutation,
  runLeaseFencedProjectMutation,
  runLeaseFencedSolutionEvaluationMutation,
} from "@/lib/server/repositories/lease-fenced-persistence";
import { assertProjectWorkflowActive } from "@/lib/server/project-workflow-cancellation";
import { buildValidatedManualArtifactInputSnapshot } from "@/lib/server/artifact-validation";
import { isHistoricalSolutionDocument } from "@/lib/document-processing";
import {
  fetchStoredFileReferencesPaginated,
  runStorageFirstDeletion,
} from "@/lib/server/storage-deletion";
import type {
  ChatDomainHint,
  ChatMessage,
  ChatMessageRole,
  ChatSessionSummary,
  ChatSourceReference,
  CustomerAnalysisHistorySource,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  DocumentFileFormat,
  DocumentProcessingStatus,
  ExecutiveSummaryResult,
  GeneratedArtifact,
  GeneratedArtifactAuthorityByType,
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
  processing_status: DocumentProcessingStatus;
  processing_message: string | null;
  processing_error: string | null;
  parser_used: string | null;
  indexed_at: string | null;
  chunk_source_revision: number;
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
  processing_status?: DocumentProcessingStatus;
  processing_message?: string | null;
  processing_error?: string | null;
  parser_used?: string | null;
  indexed_at?: string | null;
  chunk_source_revision: number;
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
  source_document_ids: string[];
  customer_document_id: string | null;
  solution_document_id: string | null;
  analysis_id: string | null;
  evaluated_generated_artifact_id?: string | null;
  evaluation_provenance_mode?:
    | "document_only"
    | "generated_artifact"
    | "legacy_unknown";
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
  updated_at: string;
  artifact_version?: number | string | null;
  generation_job_id?: string | null;
  generation_submission_sequence?: number | string | null;
  input_artifact_source_revision?: number | string | null;
  input_service_library_revision?: number | string | null;
  used_solution_evaluation?: boolean | null;
  input_solution_evaluation_id?: string | null;
  input_solution_evaluation_updated_at?: string | null;
  input_solution_evaluation_hash?: string | null;
  generator_revision?: string | null;
  origin?: "generated" | "manual_edit" | "legacy" | null;
  parent_artifact_id?: string | null;
  source_snapshot_hash?: string | null;
  current_artifact_version?: number | string | null;
  current_artifact_source_revision?: number | string | null;
  current_service_library_revision?: number | string | null;
}

const GENERATED_ARTIFACT_TYPES: GeneratedArtifactType[] = [
  "losningsutkast",
  "bilag1_rekonstruksjon",
  "forbedret_kravsvar",
  "tilbudsstrategi",
  "verdiargumentasjon",
  "anbefalt_arkitektur",
  "gjennomforing_og_risiko",
];

function isGeneratedArtifactType(value: unknown): value is GeneratedArtifactType {
  return GENERATED_ARTIFACT_TYPES.includes(value as GeneratedArtifactType);
}

function artifactCountsByType(
  rows: Array<{ artifact_type: unknown }> | null | undefined,
) {
  const counts: Partial<Record<GeneratedArtifactType, number>> = {};
  for (const row of rows ?? []) {
    if (!isGeneratedArtifactType(row.artifact_type)) {
      continue;
    }
    counts[row.artifact_type] = (counts[row.artifact_type] ?? 0) + 1;
  }
  return counts;
}

interface ChatRow {
  id: string;
  project_id: string;
  session_id?: string | null;
  role: ChatMessageRole;
  content: string;
  context_snapshot: Json;
  created_at: string;
}

interface ChatSessionRow {
  id: string;
  project_id: string;
  title: string;
  summary_encrypted: string | null;
  domain_hints: string[] | null;
  pinned: boolean | null;
  status: string | null;
  message_count: number | null;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
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
  chunk_source_revision: number;
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
  chunk_source_revision: number;
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
  current_artifact_types: GeneratedArtifactType[];
  artifact_authority: GeneratedArtifactAuthorityByType;
}

const DOCUMENT_SELECT_SAFE =
  "id, project_id, role, supporting_subtype, subtype, title, file_name, file_format, content_type, file_size_bytes, page_count, file_storage_bucket, file_storage_path, file_base64, raw_text, structure_map, processing_status, processing_message, processing_error, parser_used, indexed_at, chunk_source_revision, created_at, updated_at";
const DOCUMENT_ANALYSIS_SELECT_SAFE =
  "id, project_id, role, supporting_subtype, subtype, title, file_name, file_format, content_type, file_size_bytes, page_count, file_storage_bucket, file_storage_path, raw_text, structure_map, processing_status, processing_message, processing_error, parser_used, indexed_at, chunk_source_revision, created_at, updated_at";
const ACTIVE_ANALYSIS_DOCUMENT_FILTER =
  "supporting_subtype.neq.tidligere_losning,and(supporting_subtype.is.null,subtype.neq.tidligere_losning),and(supporting_subtype.is.null,subtype.is.null)";
const DOCUMENT_SUMMARY_SELECT_COLUMNS = [
  "id",
  "project_id",
  "role",
  "supporting_subtype",
  "subtype",
  "title",
  "file_name",
  "file_format",
  "content_type",
  "file_size_bytes",
  "page_count",
  "processing_status",
  "processing_message",
  "processing_error",
  "parser_used",
  "indexed_at",
  "chunk_source_revision",
  "created_at",
  "updated_at",
] as const;
const DOCUMENT_SUMMARY_SELECT_LEGACY =
  "id, project_id, role, subtype, display_name, file_format, content_type, created_at";
const PROJECT_SELECT_SAFE =
  "id, name, customer_name, description, industry, context_keywords, customer_document_uploaded, customer_analysis_generated, solution_document_uploaded, solution_evaluation_generated, last_activity_at, created_at, updated_at";
const PROJECT_SELECT_LEGACY =
  "id, title, client_name, description, context_keywords, customer_document_uploaded, customer_analysis_generated, solution_document_uploaded, solution_evaluation_generated, last_activity_at, created_at, updated_at";
const SERVICE_DOCUMENT_SUMMARY_SELECT =
  "id, service_id, title, file_name, file_format, content_type, file_size_bytes, page_count, ai_summary, ai_summary_updated_at, chunk_source_revision, created_at, updated_at";
const SERVICE_DOCUMENT_SUMMARY_SELECT_BASE =
  "id, service_id, title, file_name, file_format, content_type, file_size_bytes, page_count, chunk_source_revision, created_at, updated_at";
const PROJECT_DOCUMENT_INSERT_COLUMN_NAMES = [
  "id",
  "project_id",
  "role",
  "supporting_subtype",
  "subtype",
  "title",
  "display_name",
  "file_name",
  "file_format",
  "content_type",
  "file_size_bytes",
  "page_count",
  "file_storage_bucket",
  "file_storage_path",
  "file_base64",
  "raw_text",
  "structure_map",
  "source_map",
  "processing_status",
  "processing_message",
  "processing_error",
  "parser_used",
  "indexed_at",
] as const;
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
  recommended_services: [],
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
  document_findings: [],
  requirement_coverage: {
    total_requirements: 0,
    assessed_requirements: 0,
    good: 0,
    weak: 0,
    missing: 0,
    unclear: 0,
    confidence: "Lav",
    coverage_summary: "",
    items: [],
  },
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

type RequirementCoverage = NonNullable<SolutionEvaluationResult["requirement_coverage"]>;

function sanitizeRequirementCoverage(
  coverage: RequirementCoverage | undefined,
): RequirementCoverage | undefined {
  if (!coverage?.items?.length) {
    return coverage;
  }

  // The evaluated array is already in authoritative ledger order. Preserve
  // every row (including generated fallback references) and rebuild the
  // persisted position from that array instead of trusting legacy/model
  // indexes. This keeps read/save round-trips zero-based and gap-free.
  const items = coverage.items.map((item, orderIndex) => ({
    ...item,
    order_index: orderIndex,
  }));

  return {
    ...coverage,
    items,
  };
}

export function sanitizeSolutionEvaluationResult(
  result: SolutionEvaluationResult,
): SolutionEvaluationResult {
  const score = result.likely_score_assessment ??
    SOLUTION_EVALUATION_EMPTY.likely_score_assessment;
  const comparison = result.architecture_comparison ??
    SOLUTION_EVALUATION_EMPTY.architecture_comparison;
  const coverage = result.requirement_coverage
    ? {
        ...SOLUTION_EVALUATION_EMPTY.requirement_coverage,
        ...result.requirement_coverage,
        items: Array.isArray(result.requirement_coverage.items)
          ? result.requirement_coverage.items
          : [],
      }
    : undefined;
  return {
    ...SOLUTION_EVALUATION_EMPTY,
    ...result,
    strengths: Array.isArray(result.strengths) ? result.strengths : [],
    weaknesses: Array.isArray(result.weaknesses) ? result.weaknesses : [],
    generic_sections: Array.isArray(result.generic_sections)
      ? result.generic_sections
      : [],
    missing_elements: Array.isArray(result.missing_elements)
      ? result.missing_elements
      : [],
    risks_to_customer: Array.isArray(result.risks_to_customer)
      ? result.risks_to_customer
      : [],
    trust_signals: Array.isArray(result.trust_signals)
      ? result.trust_signals
      : [],
    likely_score_assessment: {
      quality: typeof score?.quality === "string" ? score.quality : "",
      delivery_confidence:
        typeof score?.delivery_confidence === "string"
          ? score.delivery_confidence
          : "",
      risk: typeof score?.risk === "string" ? score.risk : "",
      competitiveness:
        typeof score?.competitiveness === "string"
          ? score.competitiveness
          : "",
    },
    improvement_recommendations: Array.isArray(
      result.improvement_recommendations,
    )
      ? result.improvement_recommendations
      : [],
    value_assessment: Array.isArray(result.value_assessment)
      ? result.value_assessment.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    rewrite_suggestions: Array.isArray(result.rewrite_suggestions)
      ? result.rewrite_suggestions.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    document_findings: Array.isArray(result.document_findings)
      ? result.document_findings.filter(
          (item) => item && typeof item === "object",
        )
      : [],
    requirement_coverage: sanitizeRequirementCoverage(coverage),
    architecture_comparison: {
      winner:
        comparison?.winner === "Systemløsning" ||
        comparison?.winner === "Arkitektløsning" ||
        comparison?.winner === "Uavgjort"
          ? comparison.winner
          : "Uavgjort",
      architect_solution_score:
        typeof comparison?.architect_solution_score === "number" &&
        Number.isFinite(comparison.architect_solution_score)
          ? Math.min(100, Math.max(0, comparison.architect_solution_score))
          : 0,
      system_solution_score:
        typeof comparison?.system_solution_score === "number" &&
        Number.isFinite(comparison.system_solution_score)
          ? Math.min(100, Math.max(0, comparison.system_solution_score))
          : 0,
      verdict:
        typeof comparison?.verdict === "string" ? comparison.verdict : "",
      strong_critique: Array.isArray(comparison?.strong_critique)
        ? comparison.strong_critique
        : [],
      pragmatic_reflections: Array.isArray(comparison?.pragmatic_reflections)
        ? comparison.pragmatic_reflections
        : [],
      strategy_improvement_advice: Array.isArray(
        comparison?.strategy_improvement_advice,
      )
        ? comparison.strategy_improvement_advice
        : [],
    },
  };
}

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
const PROJECT_LIST_LIMIT = 500;
const GENERATED_ARTIFACT_LIST_LIMIT = 250;
const CHAT_MESSAGE_LIST_LIMIT = 1200;

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

const CHAT_DOMAIN_HINTS = new Set<ChatDomainHint>([
  "Kunde og behov",
  "Krav og etterlevelse",
  "Risiko",
  "Verdi og gevinst",
  "Arkitektur og løsning",
  "Tilbudsstrategi og posisjonering",
  "Leveranse og drift",
  "Kontrakt og kommersielt",
  "Dokument og kildegrunnlag",
]);

function normalizeChatDomainHints(value: unknown): ChatDomainHint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter(
        (item): item is ChatDomainHint =>
          typeof item === "string" &&
          CHAT_DOMAIN_HINTS.has(item as ChatDomainHint),
      ),
    ),
  ).slice(0, 4);
}

function normalizeChatSourceReferences(value: unknown): ChatSourceReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map((item) => {
      const sourceType: ChatSourceReference["source_type"] =
        item.source_type === "service_document"
          ? "service_document"
          : "project_document";

      return {
        document_title:
          typeof item.document_title === "string" ? item.document_title : "",
        reference: typeof item.reference === "string" ? item.reference : "",
        heading_path: Array.isArray(item.heading_path)
          ? item.heading_path.filter(
              (part): part is string => typeof part === "string",
            )
          : [],
        page_start:
          typeof item.page_start === "number" &&
          Number.isFinite(item.page_start)
            ? item.page_start
            : null,
        page_end:
          typeof item.page_end === "number" && Number.isFinite(item.page_end)
            ? item.page_end
            : null,
        source_type: sourceType,
        source_id: typeof item.source_id === "string" ? item.source_id : "",
      };
    })
    .filter((item) => item.document_title || item.reference)
    .slice(0, 8);
}

function sessionIdFromSnapshot(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const value = (snapshot as { chat_session_id?: unknown }).chat_session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const rawText = decryptString(row.raw_text);
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
    raw_text: rawText,
    structure_map: decryptJson(row.structure_map, []),
    processing_status: normalizeDocumentProcessingStatus(
      row.processing_status,
      rawText,
    ),
    processing_message: row.processing_message,
    processing_error: row.processing_error,
    parser_used: row.parser_used,
    indexed_at: row.indexed_at,
    chunk_source_revision: row.chunk_source_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveDocumentRow(
  row: DocumentRow,
  options?: { includeFileBase64?: boolean },
): Promise<ProjectDocumentDetail> {
  const document = decryptDocumentRow(row);
  if (options?.includeFileBase64 === false) {
    return {
      ...document,
      file_base64: "",
    };
  }

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

function normalizeDocumentProcessingStatus(
  value: unknown,
  rawText?: string,
): DocumentProcessingStatus {
  if (
    value === "queued" ||
    value === "processing" ||
    value === "basic_ready" ||
    value === "enhanced_ready" ||
    value === "failed"
  ) {
    return value;
  }

  return rawText?.trim() ? "enhanced_ready" : "queued";
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
    processing_status: normalizeDocumentProcessingStatus(
      row.processing_status,
      rawText,
    ),
    processing_message: row.processing_message ?? null,
    processing_error: row.processing_error ?? null,
    parser_used: row.parser_used ?? null,
    indexed_at: row.indexed_at ?? null,
    chunk_source_revision: row.chunk_source_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listProjectDocumentRoleRows(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
) {
  const { data, error } = await supabase
    .from("documents")
    .select("role")
    .eq("project_id", projectId);
  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as Array<{ role: ProjectDocumentRole | null }>;
}

async function deleteProjectSolutionEvaluations(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
) {
  const { error } = await supabase
    .from("solution_evaluations")
    .delete()
    .eq("project_id", projectId);
  if (error) {
    throw new Error(error.message || "Kunne ikke invalidere løsningsvurderingen.");
  }
}

async function deleteProjectCustomerAnalyses(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
) {
  const { error } = await supabase
    .from("customer_analyses")
    .delete()
    .eq("project_id", projectId);
  if (error) {
    throw new Error(error.message || "Kunne ikke invalidere kundeanalysen.");
  }
}

async function deleteProjectExecutiveSummaries(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
) {
  const { error } = await supabase
    .from("executive_summaries")
    .delete()
    .eq("project_id", projectId);
  if (error && !isMissingRelationColumn(error, "executive_summaries")) {
    throw new Error(error.message || "Kunne ikke invalidere lederoppsummeringen.");
  }
}

type DocumentDeletionSnapshot = {
  id: string;
  role: ProjectDocumentRole;
  supporting_subtype: SupportingDocumentSubtype | null;
  file_storage_bucket?: string | null;
  file_storage_path?: string | null;
};

function storedFileDeletionPrefixes(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId?: string | null;
  files: Array<{ file_storage_bucket?: string | null }>;
}) {
  const buckets = new Set<string | null>([null]);
  for (const file of input.files) {
    if (file.file_storage_bucket) buckets.add(file.file_storage_bucket);
  }
  const prefix = buildStoredFilePrefix(input);
  return [...buckets].map((bucket) => ({ bucket, prefix }));
}

async function getDocumentDeletionSnapshot(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
  documentId: string,
): Promise<DocumentDeletionSnapshot | null> {
  const currentResult = await supabase
    .from("documents")
    .select(
      "id, role, supporting_subtype, file_storage_bucket, file_storage_path",
    )
    .eq("project_id", projectId)
    .eq("id", documentId)
    .single<DocumentDeletionSnapshot>();

  if (!currentResult.error) {
    return currentResult.data ?? null;
  }
  if (!isMissingLegacyDocumentColumn(currentResult.error)) {
    throw new Error(
      currentResult.error.message || "Kunne ikke lese dokumentmetadata.",
    );
  }

  const legacyResult = await supabase
    .from("documents")
    .select("id, role, subtype, file_storage_bucket, file_storage_path")
    .eq("project_id", projectId)
    .eq("id", documentId)
    .single<{
      id: string;
      role: ProjectDocumentRole;
      subtype?: SupportingDocumentSubtype | null;
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>();

  if (legacyResult.error || !legacyResult.data) {
    if (legacyResult.error) {
      throw new Error(
        legacyResult.error.message || "Kunne ikke lese dokumentmetadata.",
      );
    }
    return null;
  }

  return {
    id: legacyResult.data.id,
    role: legacyResult.data.role,
    supporting_subtype: legacyResult.data.subtype ?? null,
    file_storage_bucket: legacyResult.data.file_storage_bucket,
    file_storage_path: legacyResult.data.file_storage_path,
  };
}

async function getSelectedSolutionDocumentId(
  supabase: ReturnType<typeof createServiceClient>,
  projectId: string,
): Promise<string | null> {
  const currentResult = await supabase
    .from("solution_evaluations")
    .select("solution_document_id, source_document_ids")
    .eq("project_id", projectId)
    .limit(1);

  let row = (currentResult.data?.[0] as
    | {
        solution_document_id?: unknown;
        source_document_ids?: unknown;
      }
    | undefined) ?? null;
  let queryError = currentResult.error;

  if (
    queryError &&
    isMissingRelationColumn(queryError, "solution_evaluations")
  ) {
    const legacyResult = await supabase
      .from("solution_evaluations")
      .select("source_document_ids")
      .eq("project_id", projectId)
      .limit(1);
    row = (legacyResult.data?.[0] as
      | { source_document_ids?: unknown }
      | undefined) ?? null;
    queryError = legacyResult.error;
  }

  if (queryError) {
    if (isMissingRelationColumn(queryError, "solution_evaluations")) {
      return null;
    }
    throw new Error(
      queryError.message || "Kunne ikke lese valgt løsningsdokument.",
    );
  }

  if (typeof row?.solution_document_id === "string") {
    return row.solution_document_id;
  }

  const sourceDocumentIds = Array.isArray(row?.source_document_ids)
    ? row.source_document_ids
    : [];
  // Legacy rows preserve the filtered [customer, solution] order, so the
  // explicitly evaluated solution is the final available source document.
  const lastSourceDocumentId = sourceDocumentIds.at(-1);
  return typeof lastSourceDocumentId === "string" ? lastSourceDocumentId : null;
}

function projectDocumentStatusPatch(
  rows: Array<{ role: ProjectDocumentRole | null }>,
) {
  return {
    customer_document_uploaded: rows.length > 0,
    solution_document_uploaded: rows.some(
      (row) => row.role === "primary_solution_document",
    ),
  };
}

function mapSolutionEvaluationRow(row: SolutionEvaluationRow) {
  return sanitizeSolutionEvaluationResult({
    ...SOLUTION_EVALUATION_EMPTY,
    ...decryptJson(row.result_json, SOLUTION_EVALUATION_EMPTY),
    customer_document_id: row.customer_document_id,
    solution_document_id: row.solution_document_id,
    evaluated_generated_artifact_id:
      row.evaluated_generated_artifact_id ?? null,
    evaluation_provenance_mode:
      row.evaluation_provenance_mode ?? "legacy_unknown",
  });
}

function mapExecutiveSummaryRow(row: ExecutiveSummaryRow) {
  return decryptJson(row.result_json, EXECUTIVE_SUMMARY_EMPTY);
}

function mapArtifact(row: ArtifactRow): GeneratedArtifact {
  const artifactType = isGeneratedArtifactType(row.artifact_type)
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

  const artifactVersion = Number(row.artifact_version ?? 0);
  const currentVersion = Number(row.current_artifact_version ?? artifactVersion);
  const inputArtifactRevision =
    row.input_artifact_source_revision == null
      ? null
      : Number(row.input_artifact_source_revision);
  const currentArtifactRevision =
    row.current_artifact_source_revision == null
      ? inputArtifactRevision
      : Number(row.current_artifact_source_revision);
  const inputServiceRevision =
    row.input_service_library_revision == null
      ? null
      : Number(row.input_service_library_revision);
  const currentServiceRevision =
    row.current_service_library_revision == null
      ? inputServiceRevision
      : Number(row.current_service_library_revision);

  return {
    id: row.id,
    project_id: row.project_id,
    artifact_type: artifactType,
    title,
    content_markdown: contentMarkdown,
    input_snapshot: decryptJson(row.input_snapshot, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    artifact_version:
      Number.isSafeInteger(artifactVersion) && artifactVersion > 0
        ? artifactVersion
        : undefined,
    generation_job_id: row.generation_job_id ?? null,
    generation_submission_sequence:
      row.generation_submission_sequence == null
        ? null
        : Number(row.generation_submission_sequence),
    input_artifact_source_revision: inputArtifactRevision,
    input_service_library_revision: inputServiceRevision,
    used_solution_evaluation: Boolean(row.used_solution_evaluation),
    input_solution_evaluation_id: row.input_solution_evaluation_id ?? null,
    input_solution_evaluation_updated_at:
      row.input_solution_evaluation_updated_at
        ? new Date(row.input_solution_evaluation_updated_at).toISOString()
        : null,
    input_solution_evaluation_hash: row.input_solution_evaluation_hash ?? null,
    generator_revision: row.generator_revision ?? null,
    origin: row.origin ?? "legacy",
    parent_artifact_id: row.parent_artifact_id ?? null,
    source_snapshot_hash: row.source_snapshot_hash ?? null,
    is_current:
      Number.isSafeInteger(artifactVersion) &&
      Number.isSafeInteger(currentVersion) &&
      artifactVersion === currentVersion,
    source_is_current:
      inputArtifactRevision != null &&
      currentArtifactRevision != null &&
      inputServiceRevision != null &&
      currentServiceRevision != null &&
      inputArtifactRevision === currentArtifactRevision &&
      inputServiceRevision === currentServiceRevision,
  };
}

function mapChatMessage(row: ChatRow): ChatMessage {
  const contextSnapshot = decryptJson(row.context_snapshot, {});
  const snapshotRecord =
    contextSnapshot && typeof contextSnapshot === "object"
      ? (contextSnapshot as Record<string, unknown>)
      : {};

  return {
    id: row.id,
    project_id: row.project_id,
    session_id: row.session_id ?? sessionIdFromSnapshot(contextSnapshot),
    role: row.role,
    content: row.content,
    context_snapshot: contextSnapshot,
    source_references: normalizeChatSourceReferences(
      snapshotRecord.source_references,
    ),
    domain_hints: normalizeChatDomainHints(snapshotRecord.domain_hints),
    created_at: row.created_at,
  };
}

function mapChatSession(row: ChatSessionRow): ChatSessionSummary {
  const status = row.status === "archived" ? "archived" : "active";

  return {
    id: row.id,
    title: row.title,
    summary:
      typeof row.summary_encrypted === "string"
        ? decryptString(row.summary_encrypted)
        : "",
    domain_hints: normalizeChatDomainHints(row.domain_hints),
    pinned: Boolean(row.pinned),
    status,
    message_count: Math.max(0, Number(row.message_count ?? 0)),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message_preview: row.last_message_preview ?? "",
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
    chunk_source_revision: row.chunk_source_revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

type ServiceDocumentSummaryQuery = (
  select: string,
) => PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}>;

async function fetchServiceDocumentSummaryRows(
  query: ServiceDocumentSummaryQuery,
  options: { emptyWhenServiceDocumentRelationMissing?: boolean } = {},
) {
  let { data, error } = await query(SERVICE_DOCUMENT_SUMMARY_SELECT);

  if (error && isMissingRelationColumn(error, "ai_summary")) {
    ({ data, error } = await query(SERVICE_DOCUMENT_SUMMARY_SELECT_BASE));
  }

  if (error) {
    if (
      options.emptyWhenServiceDocumentRelationMissing &&
      isMissingRelationColumn(error, "service_documents")
    ) {
      return [];
    }
    throw new Error(error.message || "Kunne ikke hente tjenestedokumenter.");
  }

  return (Array.isArray(data) ? data : []) as ServiceDocumentSummaryRow[];
}

function fromUnknownServiceDocumentSummaryRow(
  row: Record<string, unknown>,
): ServiceDocumentSummaryRow {
  let fileSizeBytes =
    typeof row.file_size_bytes === "number" &&
    Number.isFinite(row.file_size_bytes)
      ? row.file_size_bytes
      : 0;
  if (fileSizeBytes <= 0 && typeof row.file_base64 === "string") {
    try {
      fileSizeBytes = Buffer.from(decryptString(row.file_base64), "base64")
        .length;
    } catch {
      fileSizeBytes = 0;
    }
  }
  const createdAt = String(row.created_at ?? new Date().toISOString());

  return {
    id: String(row.id ?? ""),
    service_id: String(row.service_id ?? ""),
    title: String(row.title ?? row.file_name ?? "Tjenestedokument"),
    file_name: String(row.file_name ?? row.title ?? "document.txt"),
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
    structure_map: (row.structure_map ?? []) as Json,
    ai_summary:
      typeof row.ai_summary === "string" ? row.ai_summary : undefined,
    ai_summary_updated_at:
      row.ai_summary_updated_at == null
        ? null
        : String(row.ai_summary_updated_at),
    chunk_source_revision: Math.max(
      0,
      Number(row.chunk_source_revision ?? 0),
    ),
    created_at: createdAt,
    updated_at: String(row.updated_at ?? createdAt),
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
    chunk_source_revision: row.chunk_source_revision,
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

function mapProjectSnapshot(
  row: ProjectRow,
  artifactAuthority: GeneratedArtifactAuthorityByType,
  solutionEvaluationCurrent: boolean,
): ProjectCacheSnapshot {
  const currentArtifactTypes = currentArtifactTypesFromAuthority(artifactAuthority);
  return {
    name: row.name,
    customer_name: row.customer_name,
    description: row.description,
    industry: row.industry,
    status: mapProjectStatus(row),
    customer_document_uploaded: row.customer_document_uploaded,
    customer_analysis_generated: row.customer_analysis_generated,
    solution_document_uploaded: row.solution_document_uploaded,
    solution_evaluation_generated: solutionEvaluationCurrent,
    last_activity_at: row.last_activity_at,
    current_artifact_types: currentArtifactTypes,
    artifact_authority: artifactAuthority,
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
  const message = (error?.message ?? "").toLowerCase();
  const mentionsMissingColumn = isMissingSchemaColumn(error);

  return (
    mentionsMissingColumn &&
    PROJECT_DOCUMENT_INSERT_COLUMN_NAMES.some((columnName) =>
      message.includes(columnName),
    )
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
    processing_status: normalizeDocumentProcessingStatus(
      row.processing_status,
      typeof row.raw_text === "string" ? decryptOptionalString(row.raw_text) : "",
    ),
    processing_message:
      row.processing_message == null ? null : String(row.processing_message),
    processing_error:
      row.processing_error == null ? null : String(row.processing_error),
    parser_used: row.parser_used == null ? null : String(row.parser_used),
    indexed_at: row.indexed_at == null ? null : String(row.indexed_at),
    chunk_source_revision: Math.max(
      0,
      Number(row.chunk_source_revision ?? 0),
    ),
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
    processing_status: summary.processing_status ?? "queued",
    processing_message: summary.processing_message ?? null,
    processing_error: summary.processing_error ?? null,
    parser_used: summary.parser_used ?? null,
    indexed_at: summary.indexed_at ?? null,
  };
}

async function fetchDocumentRows(
  build: (select: string) => PromiseLike<{
    data: unknown[] | null;
    error: { message?: string } | null;
  }>,
  safeSelect = DOCUMENT_SELECT_SAFE,
  legacyBuild = build,
): Promise<DocumentRow[]> {
  const first = await build(safeSelect);
  if (!first.error) {
    return ((first.data ?? []) as Record<string, unknown>[]).map(
      fromUnknownDocumentRow,
    );
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await legacyBuild("*");
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
  let selectedColumns = [...DOCUMENT_SUMMARY_SELECT_COLUMNS];
  let lastError: { message?: string } | null = null;

  for (
    let attempt = 0;
    attempt < DOCUMENT_SUMMARY_SELECT_COLUMNS.length + 1;
    attempt += 1
  ) {
    const result = await build(selectedColumns.join(", "));
    if (!result.error) {
      return ((result.data ?? []) as Record<string, unknown>[]).map(
        fromUnknownDocumentSummaryRow,
      );
    }

    lastError = result.error;
    if (!isMissingLegacyDocumentColumn(result.error)) {
      break;
    }

    const missingColumn = missingColumnNameFromError(
      result.error,
      DOCUMENT_SUMMARY_SELECT_COLUMNS,
    );
    if (!missingColumn || !selectedColumns.includes(missingColumn)) {
      break;
    }
    selectedColumns = selectedColumns.filter((column) => column !== missingColumn);
  }

  if (isMissingLegacyDocumentColumn(lastError)) {
    const retry = await build(DOCUMENT_SUMMARY_SELECT_LEGACY);
    if (!retry.error) {
      return ((retry.data ?? []) as Record<string, unknown>[]).map(
        fromUnknownDocumentSummaryRow,
      );
    }
    throw new Error(retry.error.message || "Kunne ikke hente dokumentene.");
  }

  throw new Error(lastError?.message || "Kunne ikke hente dokumentene.");
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

export async function getProjectSourceRevision(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("source_revision")
    .eq("id", projectId)
    .single<{ source_revision: number | string | null }>();

  if (error || data?.source_revision == null) {
    throw new Error(
      error?.message ||
        "Prosjektets source_revision mangler. Kjør siste Supabase-migrering før løsningsvurdering.",
    );
  }

  const revision = Number(data.source_revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Prosjektets source_revision er ugyldig.");
  }
  return revision;
}

export type ArtifactSourceRevisions = {
  artifactSourceRevision: number;
  serviceLibraryRevision: number;
  solutionEvaluationDependency: {
    id: string;
    updated_at: string;
    content_hash: string;
    evaluated_generated_artifact_id: string | null;
    provenance_mode:
      | "document_only"
      | "generated_artifact"
      | "legacy_unknown";
  } | null;
};

function parseSolutionEvaluationDependency(
  value: unknown,
): ArtifactSourceRevisions["solutionEvaluationDependency"] {
  const dependency =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  if (
    !dependency ||
    typeof dependency.id !== "string" ||
    typeof dependency.updated_at !== "string" ||
    typeof dependency.content_hash !== "string" ||
    !(
      dependency.evaluated_generated_artifact_id === null ||
      typeof dependency.evaluated_generated_artifact_id === "string"
    ) ||
    !(
      dependency.provenance_mode === "document_only" ||
      dependency.provenance_mode === "generated_artifact" ||
      dependency.provenance_mode === "legacy_unknown"
    )
  ) {
    return null;
  }
  return {
    id: dependency.id,
    updated_at: new Date(dependency.updated_at).toISOString(),
    content_hash: dependency.content_hash,
    evaluated_generated_artifact_id:
      dependency.evaluated_generated_artifact_id,
    provenance_mode: dependency.provenance_mode,
  };
}

export async function getArtifactSourceRevisions(
  projectId: string,
): Promise<ArtifactSourceRevisions> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_artifact_source_revisions", {
    p_project_id: projectId,
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(
      error?.message ||
        "Artefaktens kilderevisjon mangler. Kjør siste Supabase-migrering før generering.",
    );
  }

  const record = data as Record<string, unknown>;
  const artifactSourceRevision = Number(record.artifact_source_revision);
  const serviceLibraryRevision = Number(record.service_library_revision);
  const solutionEvaluationDependency = parseSolutionEvaluationDependency(
    record.solution_evaluation_dependency,
  );
  if (
    !Number.isSafeInteger(artifactSourceRevision) ||
    artifactSourceRevision < 0 ||
    !Number.isSafeInteger(serviceLibraryRevision) ||
    serviceLibraryRevision < 0
  ) {
    throw new Error("Artefaktens kilderevisjoner er ugyldige.");
  }

  return {
    artifactSourceRevision,
    serviceLibraryRevision,
    solutionEvaluationDependency,
  };
}

export function currentArtifactTypesFromAuthority(
  authority: GeneratedArtifactAuthorityByType,
) {
  return GENERATED_ARTIFACT_TYPES.filter(
    (artifactType) => authority[artifactType]?.source_is_current === true,
  );
}

export async function getArtifactAuthoritySummary(
  projectId: string,
): Promise<GeneratedArtifactAuthorityByType> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("get_artifact_authority_summary", {
    p_project_id: projectId,
  });
  if (error || !Array.isArray(data)) {
    throw new Error(
      error?.message ||
        "Kunne ikke hente autoritativ status for generatorartefaktene.",
    );
  }
  const authority: GeneratedArtifactAuthorityByType = {};
  for (const value of data) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const artifactVersion = Number(record.artifact_version);
    if (
      !isGeneratedArtifactType(record.artifact_type) ||
      typeof record.id !== "string" ||
      !Number.isSafeInteger(artifactVersion) ||
      artifactVersion < 1 ||
      typeof record.source_is_current !== "boolean"
    ) {
      throw new Error("Databasen returnerte ugyldig autoritetsstatus for en artefakt.");
    }
    authority[record.artifact_type] = {
      id: record.id,
      artifact_version: artifactVersion,
      source_is_current: record.source_is_current,
    };
  }
  return authority;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const getCachedProjects = unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const projectQuery = async (select: string) =>
        supabase
          .from("projects")
          .select(select)
          .order("last_activity_at", { ascending: false })
          .limit(PROJECT_LIST_LIMIT);
      const [
        projectsResult,
        documentRows,
        { data: artifacts },
      ] = await Promise.all([
        projectQuery(PROJECT_SELECT_SAFE),
        fetchDocumentSummaryRows((select) =>
          supabase.from("documents").select(select).limit(PROJECT_LIST_LIMIT * 10),
        ),
        supabase
          .from("generated_artifacts")
          .select("id, project_id")
          .order("created_at", { ascending: false })
          .limit(PROJECT_LIST_LIMIT * 20),
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
  );
  const projects = await getCachedProjects();
  if (!projects.length) return projects;
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc(
    "get_solution_evaluation_currentness",
    { p_project_ids: projects.map((project) => project.id) },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error(
      error?.message || "Kunne ikke hente gyldig vurderingsstatus for prosjektene.",
    );
  }
  const currentness = data as Record<string, unknown>;
  return projects.map((project) => ({
    ...project,
    solution_evaluation_generated: currentness[project.id] === true,
  }));
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
  const storedFiles = await fetchStoredFileReferencesPaginated((from, to) =>
    supabase
      .from("documents")
      .select("file_storage_bucket, file_storage_path")
      .eq("project_id", projectId)
      .order("id", { ascending: true })
      .range(from, to),
  );

  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles(
        storedFiles.map((file) => ({
          bucket: file.file_storage_bucket,
          path: file.file_storage_path,
        })),
      );
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "projects",
          ownerId: projectId,
          files: storedFiles,
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await supabase
        .from("projects")
        .delete()
        .eq("id", projectId);
      if (error) {
        throw new Error(error.message || "Kunne ikke slette prosjektet.");
      }
    },
  });
  revalidateProjectCaches(projectId);
  revalidatePath("/projects/new");
}

export async function listServiceDescriptions(): Promise<ServiceDescription[]> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();
      const [servicesResult, documents] = await Promise.all([
        supabase
          .from("service_descriptions")
          .select("*")
          .order("name", { ascending: true }),
        fetchServiceDocumentSummaryRows(
          (select) =>
            supabase
              .from("service_documents")
              .select(select)
              .order("created_at", { ascending: false }),
          { emptyWhenServiceDocumentRelationMissing: true },
        ),
      ]);
      const { data: services, error: servicesError } = servicesResult;

      if (servicesError) {
        if (
          isMissingRelationColumn(servicesError, "service_descriptions")
        ) {
          return [];
        }
        throw new Error(
          servicesError.message || "Kunne ikke hente tjenestebeskrivelser.",
        );
      }

      const documentsByService = new Map<string, ServiceDocumentSummaryRow[]>();
      for (const document of documents) {
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
  const normalizedTitle =
    input.title?.trim() ||
    input.fileName.replace(/\.[^.]+$/, "").trim() ||
    "Tjenestedokument";
  const pageCount =
    pageCountFromStructureMap(input.structureMap, input.fileFormat) ??
    pageCountFromRawText(input.rawText, input.fileFormat);
  const encryptedBase64 = encryptString(input.fileBase64);
  const encryptedRawText = encryptString(input.rawText);
  const encryptedStructureMap = encryptJson(input.structureMap);
  const storedFile = await uploadEncryptedBase64File({
    path: buildStoredFilePath({
      scope: "services",
      ownerId: input.serviceId,
      fileId: documentId,
      fileName: input.fileName,
    }),
    encryptedBase64,
  });
  const insertPayload: Record<string, unknown> = {
    id: documentId,
    service_id: input.serviceId,
    title: normalizedTitle,
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    file_size_bytes: input.fileSizeBytes,
    page_count: pageCount,
    file_storage_bucket: storedFile.bucket,
    file_storage_path: storedFile.path,
    file_base64: "",
    raw_text: encryptedRawText,
    structure_map: encryptedStructureMap,
  };
  const nextKeywords = keywordsFromText(
    `${normalizedTitle} ${input.fileName} ${input.rawText}`,
  );
  const insertResult = await supabase.rpc(
    "insert_service_document_with_keywords",
    {
      p_service_id: input.serviceId,
      p_payload: insertPayload,
      p_keywords: nextKeywords,
    },
  );
  const insertedRow = Array.isArray(insertResult.data)
    ? insertResult.data[0]
    : insertResult.data;
  if (
    insertResult.error ||
    !insertedRow ||
    typeof insertedRow !== "object"
  ) {
    await removeStoredFiles([storedFile]);
    throw new Error(
      insertResult.error?.message || "Kunne ikke lagre tjenestedokumentet.",
    );
  }
  const data = fromUnknownServiceDocumentSummaryRow(
    insertedRow as Record<string, unknown>,
  );

  await replaceServiceDocumentChunks({
    documentId,
    serviceId: input.serviceId,
    title: normalizedTitle,
    fileName: input.fileName,
    fileFormat: input.fileFormat,
    rawText: input.rawText,
    structureMap: normalizeDocumentChunkStructureMap(input.structureMap),
    sourceRevision: data.chunk_source_revision,
  }).catch(() => {
    // Chunk indexing should improve retrieval, not block uploads.
  });

  revalidateServiceCaches();
  return mapServiceDocument(data);
}

export async function deleteServiceDocument(
  serviceId: string,
  documentId: string,
) {
  const supabase = createServiceClient();
  const { data: storedFile, error: storedFileError } = await supabase
    .from("service_documents")
    .select("file_storage_bucket, file_storage_path")
    .eq("service_id", serviceId)
    .eq("id", documentId)
    .maybeSingle<{
      file_storage_bucket?: string | null;
      file_storage_path?: string | null;
    }>();
  if (storedFileError) {
    throw new Error(
      storedFileError.message ||
        "Kunne ikke lese tjenestedokumentets lagringsreferanse.",
    );
  }
  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles(
        storedFile
          ? [
              {
                bucket: storedFile.file_storage_bucket,
                path: storedFile.file_storage_path,
              },
            ]
          : [],
      );
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "services",
          ownerId: serviceId,
          fileId: documentId,
          files: storedFile ? [storedFile] : [],
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await supabase
        .from("service_documents")
        .delete()
        .eq("service_id", serviceId)
        .eq("id", documentId);
      if (error) {
        throw new Error(error.message);
      }
    },
  });
  await deleteDocumentChunks({
    sourceType: "service_document",
    sourceId: documentId,
  }).catch(() => {
    // Best-effort cleanup for deployments before the chunk table exists.
  });
  revalidateServiceCaches();
}

export async function deleteServiceDescription(serviceId: string) {
  const supabase = createServiceClient();
  const storedFiles = await fetchStoredFileReferencesPaginated((from, to) =>
    supabase
      .from("service_documents")
      .select("file_storage_bucket, file_storage_path")
      .eq("service_id", serviceId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles(
        storedFiles.map((file) => ({
          bucket: file.file_storage_bucket,
          path: file.file_storage_path,
        })),
      );
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "services",
          ownerId: serviceId,
          files: storedFiles,
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await supabase
        .from("service_descriptions")
        .delete()
        .eq("id", serviceId);
      if (error) {
        throw new Error(error.message);
      }
    },
  });
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
  const documentIdFilter = Array.isArray(options?.documentIds)
    ? options.documentIds
    : null;
  const documentIds = documentIdFilter ? documentIdFilter.filter(Boolean) : [];

  if (documentIdFilter && !documentIds.length) {
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

  const rows = await fetchServiceDocumentSummaryRows((select) =>
    supabase
      .from("service_documents")
      .select(select)
      .in("service_id", serviceIds)
      .order("created_at", { ascending: false }),
  );

  return rows.map(mapServiceDocument);
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
  const { error } = await supabase.rpc("replace_project_service_selections", {
    p_project_id: projectId,
    p_service_ids: uniqueIds,
  });

  if (error) {
    throw new Error(
      error.message || "Kunne ikke lagre prosjektets valgte tjenester.",
    );
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

  const fencedUpdate = await runLeaseFencedProjectMutation<Record<string, unknown>>(
    projectId,
    "project_metadata",
    standardPatch,
  );
  if (fencedUpdate.fenced) {
    revalidateProjectCaches(projectId);
    return fromUnknownProjectRow(fencedUpdate.data);
  }

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
          ...documents
            .filter(
              (document) =>
                document.role !== "primary_solution_document" &&
                !isHistoricalSolutionDocument(document),
            )
            .map((document) => `${document.title} ${document.file_name}`),
          analysis?.customer_profile_summary ?? "",
          analysis?.customer_goals_summary ?? "",
          analysis?.high_level_solution_design ?? "",
        ].join(" "),
      ),
      analysis?.signal_words ?? [],
    );
    const fencedUpdate = await runLeaseFencedProjectMutation(
      projectId,
      "project_context_keywords",
      { context_keywords: keywords },
    );
    if (!fencedUpdate.fenced) {
      const { error } = await supabase
        .from("projects")
        .update({ context_keywords: keywords })
        .eq("id", projectId);
      if (error && !isMissingLegacyProjectColumn(error)) {
        throw new Error(error.message);
      }
    }
  } catch (error) {
    rethrowAuthoritativeLeaseLoss(error);
    assertProjectWorkflowActive();
    // Keyword cache is an optimization; never block the main workflow.
  }
}

export async function getProjectDetail(
  projectId: string,
): Promise<ProjectDetail> {
  const supabase = createServiceClient();

  const [
    projectRow,
    documentRows,
    { data: analyses, error: analysesError },
    derivedSnapshot,
    { data: artifactRows, error: artifactsError },
    artifactAuthority,
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
      .eq("provenance_verified", true)
      .order("created_at", { ascending: false })
      .limit(1),
    getFreshProjectDerivedSnapshot(projectId),
    supabase
      .from("generated_artifacts")
      .select("artifact_type")
      .eq("project_id", projectId),
    getArtifactAuthoritySummary(projectId),
  ]);

  if (
    analysesError ||
    artifactsError
  ) {
    throw new Error(
      analysesError?.message ||
        artifactsError?.message ||
        "Kunne ikke laste prosjektet.",
    );
  }

  const analysisRow =
    ((analyses ?? [])[0] as CustomerAnalysisRow | undefined) ?? null;

  return {
    id: projectRow.id,
    name: projectRow.name,
    customer_name: projectRow.customer_name,
    description: projectRow.description,
    industry: projectRow.industry,
    status: mapProjectStatus(projectRow),
    customer_document_uploaded: projectRow.customer_document_uploaded,
    customer_analysis_generated: Boolean(analysisRow),
    solution_document_uploaded: projectRow.solution_document_uploaded,
    solution_evaluation_generated: Boolean(derivedSnapshot),
    last_activity_at: projectRow.last_activity_at,
    created_at: projectRow.created_at,
    updated_at: projectRow.updated_at,
    document_count: documentRows.length,
    supporting_document_count: documentRows.filter(
      (document) => document.role === "supporting_document",
    ).length,
    artifact_count: (artifactRows ?? []).length,
    artifact_counts_by_type: artifactCountsByType(
      (artifactRows ?? []) as Array<{ artifact_type: unknown }>,
    ),
    current_artifact_types: currentArtifactTypesFromAuthority(artifactAuthority),
    artifact_authority: artifactAuthority,
    has_executive_summary:
      Boolean(derivedSnapshot?.executiveSummary),
    has_chat: false,
    documents: documentRows.map(mapDocumentSummary),
    customer_analysis: analysisRow
      ? decryptJson(analysisRow.result_json, CUSTOMER_ANALYSIS_EMPTY)
      : null,
    solution_evaluation: derivedSnapshot?.evaluation ?? null,
    executive_summary: derivedSnapshot?.executiveSummary ?? null,
    generated_artifacts: [],
    chat_messages: [],
  };
}

export async function getProjectShell(
  projectId: string,
  options: {
    includeCustomerAnalysis?: boolean;
    includeSolutionEvaluation?: boolean;
    includeExecutiveSummary?: boolean;
  } = {},
): Promise<ProjectDetail> {
  const projectRow = await queryProjectRow(projectId);
  const getCachedShell = unstable_cache(
    async () => {
      const supabase = createServiceClient();

      const [
        documentRows,
        { data: artifactRows, error: artifactsError },
        { data: analyses, error: analysesError },
      ] = await Promise.all([
        fetchDocumentSummaryRows((select) =>
          supabase
            .from("documents")
            .select(select)
            .eq("project_id", projectId)
            .order("created_at", { ascending: false }),
        ),
        supabase
          .from("generated_artifacts")
          .select("artifact_type")
          .eq("project_id", projectId),
        options.includeCustomerAnalysis
          ? supabase
              .from("customer_analyses")
              .select("*")
              .eq("project_id", projectId)
              .eq("provenance_verified", true)
              .order("created_at", { ascending: false })
              .limit(1)
          : Promise.resolve({ data: null, error: null }),
      ]);

      if (artifactsError || analysesError) {
        throw new Error(
          artifactsError?.message ||
            analysesError?.message ||
            "Kunne ikke laste prosjektet.",
        );
      }

      const analysisRow =
        ((analyses ?? [])[0] as CustomerAnalysisRow | undefined) ?? null;

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
        artifact_counts_by_type: artifactCountsByType(
          (artifactRows ?? []) as Array<{ artifact_type: unknown }>,
        ),
        has_executive_summary: false,
        has_chat: false,
        documents: documentRows.map(mapDocumentSummary),
        customer_analysis: analysisRow
          ? decryptJson(analysisRow.result_json, CUSTOMER_ANALYSIS_EMPTY)
          : null,
        solution_evaluation: null,
        executive_summary: null,
        generated_artifacts: [],
        chat_messages: [],
      };
    },
    [
      "project-shell-v3",
      projectId,
      projectRow.last_activity_at,
      projectRow.updated_at,
      options.includeCustomerAnalysis ? "analysis" : "no-analysis",
      options.includeSolutionEvaluation ? "evaluation" : "no-evaluation",
      options.includeExecutiveSummary ? "executive-summary" : "no-executive-summary",
    ],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  );
  const [shell, artifactAuthority, derivedSnapshot] = await Promise.all([
    getCachedShell(),
    getArtifactAuthoritySummary(projectId),
    getFreshProjectDerivedSnapshot(projectId),
  ]);
  const solutionEvaluationCurrent = Boolean(derivedSnapshot);
  return {
    ...shell,
    customer_analysis_generated: options.includeCustomerAnalysis
      ? Boolean(shell.customer_analysis)
      : shell.customer_analysis_generated,
    solution_evaluation_generated: solutionEvaluationCurrent,
    solution_evaluation:
      solutionEvaluationCurrent && options.includeSolutionEvaluation
      ? derivedSnapshot?.evaluation ?? null
      : null,
    executive_summary:
      solutionEvaluationCurrent && options.includeExecutiveSummary
        ? derivedSnapshot?.executiveSummary ?? null
        : null,
    has_executive_summary: Boolean(derivedSnapshot?.executiveSummary),
    current_artifact_types: currentArtifactTypesFromAuthority(artifactAuthority),
    artifact_authority: artifactAuthority,
  };
}

export async function savePendingDocument(input: {
  projectId: string;
  title: string;
  role: ProjectDocumentRole;
  supportingSubtype?: SupportingDocumentSubtype | null;
  fileName: string;
  fileFormat: DocumentFileFormat;
  contentType: string;
  fileSizeBytes: number;
  fileBase64: string;
}) {
  const supabase = createServiceClient();
  const documentId = randomUUID();
  const normalizedTitle =
    input.title?.trim() ||
    input.fileName.replace(/\.[^.]+$/, "").trim() ||
    "Dokument";
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
  const requestedPrimaryRole =
    input.role === "primary_customer_document" ||
    input.role === "primary_solution_document"
      ? input.role
      : null;
  const supportingSubtype =
    input.role === "supporting_document"
      ? (input.supportingSubtype ?? null)
      : null;
  const insertPayload: Record<string, unknown> = {
    id: documentId,
    project_id: input.projectId,
    role: input.role,
    supporting_subtype: supportingSubtype,
    subtype: supportingSubtype,
    title: normalizedTitle,
    display_name: normalizedTitle,
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    file_size_bytes: input.fileSizeBytes,
    page_count: null,
    file_storage_bucket: storedFile.bucket,
    file_storage_path: storedFile.path,
    file_base64: "",
    raw_text: "",
    structure_map: encryptJson([]),
    processing_status: "queued",
    processing_message: "Venter på indeksering.",
    processing_error: null,
    parser_used: null,
    indexed_at: null,
  };

  if (requestedPrimaryRole) {
    const { data: insertedPrimary, error: insertPrimaryError } =
      await supabase.rpc("insert_primary_project_document", {
        p_project_id: input.projectId,
        p_primary_role: requestedPrimaryRole,
        p_payload: insertPayload,
      });
    if (insertPrimaryError || !insertedPrimary) {
      let cleanupError: string | null = null;
      try {
        await removeStoredFiles([storedFile]);
      } catch (error) {
        cleanupError =
          error instanceof Error ? error.message : "ukjent lagringsfeil";
      }
      throw new Error(
        [
          insertPrimaryError?.message || "Kunne ikke lagre primærdokumentet.",
          cleanupError
            ? `Opprydding av dokumentfilen feilet: ${cleanupError}`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    const inserted = fromUnknownDocumentRow(
      insertedPrimary as unknown as Record<string, unknown>,
    );
    if (requestedPrimaryRole !== "primary_solution_document") {
      await updateProjectContextKeywords(input.projectId);
    }
    revalidateProjectCaches(input.projectId);
    return mapDocumentSummary(inserted);
  }

  let insertResult: {
    data: Record<string, unknown> | null;
    error: { message?: string } | null;
  } | null = null;
  let shouldRemoveStoredFileAfterInsert = false;
  for (
    let attempt = 0;
    attempt < PROJECT_DOCUMENT_INSERT_COLUMN_NAMES.length + 2;
    attempt += 1
  ) {
    const payloadForAttempt = { ...insertPayload };
    const hasStorageColumns =
      "file_storage_bucket" in payloadForAttempt &&
      "file_storage_path" in payloadForAttempt;
    if (!hasStorageColumns && "file_base64" in payloadForAttempt) {
      payloadForAttempt.file_base64 = encryptedBase64;
      shouldRemoveStoredFileAfterInsert = true;
    }

    insertResult = await supabase
      .from("documents")
      .insert(payloadForAttempt)
      .select("*")
      .single<Record<string, unknown>>();

    if (
      !insertResult.error ||
      !isMissingLegacyDocumentColumn(insertResult.error)
    ) {
      break;
    }

    const missingColumn = missingColumnNameFromError(
      insertResult.error,
      PROJECT_DOCUMENT_INSERT_COLUMN_NAMES,
    );
    if (!missingColumn || !(missingColumn in insertPayload)) {
      break;
    }

    if (
      missingColumn === "file_storage_bucket" ||
      missingColumn === "file_storage_path"
    ) {
      removeMissingStorageColumns(insertPayload);
    } else {
      delete insertPayload[missingColumn];
      if (missingColumn === "structure_map") {
        insertPayload.source_map = encryptJson([]);
      }
    }
  }

  if (insertResult?.error || !insertResult?.data) {
    await removeStoredFiles([storedFile]);
    throw new Error(
      insertResult?.error?.message || "Kunne ikke lagre dokumentet.",
    );
  }
  const inserted = fromUnknownDocumentRow(insertResult.data);
  if (shouldRemoveStoredFileAfterInsert) {
    await removeStoredFiles([storedFile]);
  }

  const projectPatch: Partial<ProjectRow> = {
    last_activity_at: new Date().toISOString(),
  };
  projectPatch.customer_analysis_generated = false;
  await deleteProjectCustomerAnalyses(supabase, input.projectId);
  projectPatch.solution_evaluation_generated = false;
  await deleteProjectSolutionEvaluations(supabase, input.projectId);

  await deleteProjectExecutiveSummaries(supabase, input.projectId);

  Object.assign(
    projectPatch,
    projectDocumentStatusPatch(
      await listProjectDocumentRoleRows(supabase, input.projectId),
    ),
  );

  const projectUpdate = await supabase
    .from("projects")
    .update(projectPatch)
    .eq("id", input.projectId);
  if (projectUpdate.error) {
    throw new Error(projectUpdate.error.message);
  }

  await updateProjectContextKeywords(input.projectId);
  revalidateProjectCaches(input.projectId);

  return mapDocumentSummary(inserted);
}

export async function updateDocumentProcessingState(input: {
  projectId: string;
  documentId: string;
  status: DocumentProcessingStatus;
  message?: string | null;
  error?: string | null;
  parserUsed?: string | null;
  indexedAt?: string | null;
}) {
  const payload: Record<string, unknown> = {
    processing_status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.message !== undefined) payload.processing_message = input.message;
  if (input.error !== undefined) payload.processing_error = input.error;
  if (input.parserUsed !== undefined) payload.parser_used = input.parserUsed;
  if (input.indexedAt !== undefined) payload.indexed_at = input.indexedAt;

  const fencedUpdate = await runLeaseFencedProjectMutation(
    input.projectId,
    "document_processing_state",
    {
      document_id: input.documentId,
      status: input.status,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.parserUsed !== undefined
        ? { parser_used: input.parserUsed }
        : {}),
      ...(input.indexedAt !== undefined ? { indexed_at: input.indexedAt } : {}),
      updated_at: payload.updated_at,
    },
  );
  if (fencedUpdate.fenced) {
    revalidateProjectCaches(input.projectId);
    return;
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("documents")
    .update(payload)
    .eq("project_id", input.projectId)
    .eq("id", input.documentId);

  if (error && !isMissingLegacyDocumentColumn(error)) {
    throw new Error(error.message);
  }

  revalidateProjectCaches(input.projectId);
}

export async function saveDocumentIngestionResult(input: {
  projectId: string;
  documentId: string;
  role: ProjectDocumentRole;
  supportingSubtype?: SupportingDocumentSubtype | null;
  title: string;
  fileName: string;
  fileFormat: DocumentFileFormat;
  contentType: string;
  rawText: string;
  structureMap: unknown;
  parserUsed: string | null;
  pageCountFallback?: number | null;
  status: Extract<
    DocumentProcessingStatus,
    "processing" | "basic_ready" | "enhanced_ready"
  >;
  message: string;
  indexChunks?: boolean;
}) {
  const supabase = createServiceClient();
  const shouldIndexChunks = input.indexChunks !== false;
  const pageCount =
    pageCountFromStructureMap(input.structureMap, input.fileFormat) ??
    pageCountFromRawText(input.rawText, input.fileFormat) ??
    input.pageCountFallback ??
    null;
  const encryptedRawText = encryptString(input.rawText);
  const encryptedStructureMap = encryptJson(input.structureMap);
  const updatedAt = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    page_count: pageCount,
    raw_text: encryptedRawText,
    structure_map: encryptedStructureMap,
    processing_status: input.status,
    processing_message: input.message,
    processing_error: null,
    parser_used: input.parserUsed,
    indexed_at: shouldIndexChunks ? updatedAt : null,
    updated_at: updatedAt,
  };

  const fencedUpdate = await runLeaseFencedProjectMutation<Record<string, unknown>>(
    input.projectId,
    "document_ingestion_result",
    {
      document_id: input.documentId,
      file_name: input.fileName,
      file_format: input.fileFormat,
      content_type: input.contentType,
      page_count: pageCount,
      raw_text: encryptedRawText,
      structure_map: encryptedStructureMap,
      status: input.status,
      message: input.message,
      parser_used: input.parserUsed,
      indexed_at: shouldIndexChunks ? updatedAt : null,
      updated_at: updatedAt,
    },
  );

  let updateResult: {
    data: Record<string, unknown> | null;
    error: { message?: string } | null;
  } | null = null;
  if (fencedUpdate.fenced) {
    updateResult = { data: fencedUpdate.data, error: null };
  } else {
    for (
      let attempt = 0;
      attempt < PROJECT_DOCUMENT_INSERT_COLUMN_NAMES.length + 2;
      attempt += 1
    ) {
      updateResult = await supabase
        .from("documents")
        .update(updatePayload)
        .eq("project_id", input.projectId)
        .eq("id", input.documentId)
        .select("*")
        .single<Record<string, unknown>>();

      if (
        !updateResult.error ||
        !isMissingLegacyDocumentColumn(updateResult.error)
      ) {
        break;
      }

      const missingColumn = missingColumnNameFromError(
        updateResult.error,
        PROJECT_DOCUMENT_INSERT_COLUMN_NAMES,
      );
      if (!missingColumn || !(missingColumn in updatePayload)) {
        break;
      }

      delete updatePayload[missingColumn];
      if (missingColumn === "structure_map") {
        updatePayload.source_map = encryptedStructureMap;
      }
    }
  }

  if (updateResult?.error || !updateResult?.data) {
    throw new Error(
      updateResult?.error?.message || "Kunne ikke oppdatere dokumentet.",
    );
  }

  const updated = fromUnknownDocumentRow(updateResult.data);
  if (shouldIndexChunks) {
    await replaceProjectDocumentChunks({
      documentId: input.documentId,
      projectId: input.projectId,
      role: updated.role,
      supportingSubtype: updated.supporting_subtype,
      title: updated.title,
      fileName: input.fileName,
      fileFormat: input.fileFormat,
      rawText: input.rawText,
      structureMap: normalizeDocumentChunkStructureMap(input.structureMap),
      sourceRevision: updated.chunk_source_revision,
    }).catch(async (error) => {
      rethrowAuthoritativeLeaseLoss(error);
      const chunkError =
        error instanceof Error ? error.message : String(error ?? "Ukjent feil");
      await updateDocumentProcessingState({
        projectId: input.projectId,
        documentId: input.documentId,
        status: "failed",
        message: "Dokumentet kunne ikke indekseres sikkert.",
        error: `Chunk-indeksering feilet: ${chunkError.slice(0, 600)}`,
        parserUsed: input.parserUsed,
        indexedAt: null,
      });
      throw new Error(`Dokumentindeksering feilet: ${chunkError}`);
    });
  }

  if (
    updated.role !== "primary_solution_document" &&
    !isHistoricalSolutionDocument(updated)
  ) {
    await updateProjectContextKeywords(input.projectId);
  }
  revalidateProjectCaches(input.projectId);

  return mapDocumentSummary(updated);
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
  const [beforeDelete, selectedSolutionDocumentId] = await Promise.all([
    getDocumentDeletionSnapshot(supabase, projectId, documentId),
    getSelectedSolutionDocumentId(supabase, projectId),
  ]);

  await runStorageFirstDeletion({
    removeStorage: async () => {
      await removeStoredFiles([
        {
          bucket: beforeDelete?.file_storage_bucket,
          path: beforeDelete?.file_storage_path,
        },
      ]);
      await removeStoredFilePrefixes(
        storedFileDeletionPrefixes({
          scope: "projects",
          ownerId: projectId,
          fileId: documentId,
          files: beforeDelete ? [beforeDelete] : [],
        }),
      );
    },
    deleteDatabaseRows: async () => {
      const { error } = await supabase
        .from("documents")
        .delete()
        .eq("project_id", projectId)
        .eq("id", documentId);
      if (error) {
        throw new Error(error.message);
      }
    },
  });
  await deleteDocumentChunks({
    sourceType: "project_document",
    sourceId: documentId,
  }).catch(() => {
    // Best-effort cleanup for deployments before the chunk table exists.
  });

  const { data: remaining } = await supabase
    .from("documents")
    .select("role")
    .eq("project_id", projectId);
  const rows = (remaining ?? []) as Array<{ role: ProjectDocumentRole | null }>;
  const statusPatch = projectDocumentStatusPatch(rows);
  const shouldClearCustomerAnalysis =
    !statusPatch.customer_document_uploaded ||
    beforeDelete?.role === "primary_customer_document" ||
    (beforeDelete?.role === "supporting_document" &&
      !isHistoricalSolutionDocument(beforeDelete));
  const shouldClearSolutionEvaluation =
    Boolean(beforeDelete) ||
    !statusPatch.solution_document_uploaded ||
    beforeDelete?.role === "primary_solution_document" ||
    beforeDelete?.supporting_subtype === "kravdokument" ||
    selectedSolutionDocumentId === documentId ||
    shouldClearCustomerAnalysis;
  const projectPatch: Partial<ProjectRow> = {
    ...statusPatch,
    last_activity_at: new Date().toISOString(),
  };

  if (shouldClearCustomerAnalysis) {
    await deleteProjectCustomerAnalyses(supabase, projectId);
    projectPatch.customer_analysis_generated = false;
  }

  if (shouldClearSolutionEvaluation) {
    await deleteProjectSolutionEvaluations(supabase, projectId);
    await deleteProjectExecutiveSummaries(supabase, projectId);
    projectPatch.solution_evaluation_generated = false;
  }

  const projectUpdate = await supabase
    .from("projects")
    .update(projectPatch)
    .eq("id", projectId);
  if (projectUpdate.error) {
    throw new Error(projectUpdate.error.message);
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

  if (selected.role === "primary_customer_document") {
    throw new Error("Kundedokumentet kan ikke brukes som Bilag 2 / arkitektløsning.");
  }

  const { data: promoted, error: promoteError } = await supabase.rpc(
    "set_primary_project_document",
    {
      p_project_id: projectId,
      p_document_id: documentId,
      p_primary_role: "primary_solution_document",
    },
  );
  if (promoteError || !promoted) {
    throw new Error(
      promoteError?.message || "Kunne ikke velge arkitektløsningen.",
    );
  }

  revalidateProjectCaches(projectId);

  return mapDocumentSummary(
    fromUnknownDocumentSummaryRow(
      promoted as unknown as Record<string, unknown>,
    ),
  );
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

export async function listProjectDocumentsForAnalysis(projectId: string) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows(
    (select) =>
      supabase
        .from("documents")
        .select(select)
        .eq("project_id", projectId)
        .or(ACTIVE_ANALYSIS_DOCUMENT_FILTER)
        .order("created_at", { ascending: false }),
    DOCUMENT_ANALYSIS_SELECT_SAFE,
    (select) =>
      supabase
        .from("documents")
        .select(select)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
  );

  const activeRows = rows.filter(
    (row) => !isHistoricalSolutionDocument(row),
  );

  return Promise.all(
    activeRows.map((row) =>
      resolveDocumentRow(row, { includeFileBase64: false }),
    ),
  );
}

export async function saveCustomerAnalysis(
  projectId: string,
  sourceDocumentIds: string[],
  result: CustomerAnalysisResult,
  options: {
    expectedSourceRevision: number;
    previousAnalysis?: CustomerAnalysisResult | null;
    updatedSections?: CustomerAnalysisSection[];
    historySource?: CustomerAnalysisHistorySource;
  },
) {
  if (
    !Number.isSafeInteger(options.expectedSourceRevision) ||
    options.expectedSourceRevision < 0
  ) {
    throw new Error("Kundeanalysen mangler en gyldig source_revision.");
  }
  const supabase = createServiceClient();
  const previousAnalysis =
    "previousAnalysis" in options
      ? (options.previousAnalysis ?? null)
      : await getFreshCustomerAnalysis(projectId);
  const resultWithHistory = appendCustomerAnalysisSectionHistory({
    previousAnalysis,
    nextAnalysis: result,
    sections: options.updatedSections ?? [...CUSTOMER_ANALYSIS_SECTIONS],
    source: options.historySource ?? "full_regeneration",
  });

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

  const payload = {
    source_document_ids: sourceDocumentIds,
    expected_source_revision: options.expectedSourceRevision,
    result_json: encryptJson(resultWithHistory),
    last_activity_at: new Date().toISOString(),
    context_keywords: projectKeywords,
  };
  const fencedSave =
    await runLeaseFencedCustomerAnalysisMutation<CustomerAnalysisRow>(
      projectId,
      payload,
    );
  if (fencedSave.fenced) {
    revalidateProjectCaches(projectId);
    return decryptJson(fencedSave.data.result_json, CUSTOMER_ANALYSIS_EMPTY);
  }

  const { data, error } = await supabase.rpc(
    "save_customer_analysis_if_source_revision",
    {
      p_project_id: projectId,
      p_payload: payload,
    },
  );

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kundeanalysen.");
  }

  revalidateProjectCaches(projectId);

  return decryptJson(
    (data as CustomerAnalysisRow).result_json,
    CUSTOMER_ANALYSIS_EMPTY,
  );
}

export async function getFreshCustomerAnalysis(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("customer_analyses")
    .select("*")
    .eq("project_id", projectId)
    .eq("provenance_verified", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  const row = (data?.[0] as CustomerAnalysisRow | undefined) ?? null;
  return row ? decryptJson(row.result_json, CUSTOMER_ANALYSIS_EMPTY) : null;
}

export async function getCustomerAnalysis(projectId: string) {
  return unstable_cache(
    () => getFreshCustomerAnalysis(projectId),
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
    sourceDocumentIds?: string[];
    analysisId?: string | null;
    expectedSourceRevision: number;
    evaluatedGeneratedArtifactId?: string | null;
    result: SolutionEvaluationResult;
  },
) {
  if (
    !Number.isSafeInteger(input.expectedSourceRevision) ||
    input.expectedSourceRevision < 0
  ) {
    throw new Error("Løsningsvurderingen mangler en gyldig source_revision.");
  }
  const encryptedResult = encryptJson(
    sanitizeSolutionEvaluationResult(input.result),
  );
  const sourceDocumentIds = [
    ...new Set(
      [
        input.customerDocumentId,
        ...(input.sourceDocumentIds ?? []).filter(
          (documentId) => documentId !== input.solutionDocumentId,
        ),
        input.solutionDocumentId,
      ].filter((documentId): documentId is string => Boolean(documentId)),
    ),
  ];
  const fencedSave =
    await runLeaseFencedSolutionEvaluationMutation<SolutionEvaluationRow>(
      projectId,
      {
        customer_document_id: input.customerDocumentId,
        solution_document_id: input.solutionDocumentId,
        analysis_id: input.analysisId ?? null,
        source_document_ids: sourceDocumentIds,
        expected_source_revision: input.expectedSourceRevision,
        evaluated_generated_artifact_id:
          input.evaluatedGeneratedArtifactId ?? null,
        result_json: encryptedResult,
        last_activity_at: new Date().toISOString(),
      },
    );
  if (!fencedSave.fenced) {
    throw new Error(
      "Løsningsvurderingen må lagres gjennom en aktiv, lease-fenced prosjektjobb.",
    );
  }

  revalidateProjectCaches(projectId);
  return mapSolutionEvaluationRow(fencedSave.data);
}

export async function saveExecutiveSummary(
  projectId: string,
  result: ExecutiveSummaryResult,
  inputSnapshot: unknown,
  solutionEvaluationDependency: NonNullable<
    ArtifactSourceRevisions["solutionEvaluationDependency"]
  >,
) {
  const fencedSave = await runLeaseFencedExecutiveSummaryMutation<ExecutiveSummaryRow>(
    projectId,
    {
      result_json: encryptJson(result),
      input_snapshot: encryptJson(inputSnapshot),
      solution_evaluation_dependency: solutionEvaluationDependency,
      last_activity_at: new Date().toISOString(),
    },
  );
  if (!fencedSave.fenced) {
    throw new Error(
      "Lederoppsummeringen må lagres gjennom en aktiv, evalueringsfencet prosjektjobb.",
    );
  }
  revalidateProjectCaches(projectId);
  return mapExecutiveSummaryRow(fencedSave.data);
}

export async function getFreshExecutiveSummary(projectId: string) {
  return (await getFreshProjectDerivedSnapshot(projectId))?.executiveSummary ?? null;
}

export async function getExecutiveSummary(projectId: string) {
  return unstable_cache(
    () => getFreshExecutiveSummary(projectId),
    ["project-executive-summary", projectId],
    {
      tags: [projectTag(projectId)],
      revalidate: 60,
    },
  )();
}

export async function isSolutionEvaluationCurrent(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc(
    "solution_evaluation_is_current",
    { p_project_id: projectId },
  );
  if (error || typeof data !== "boolean") {
    throw new Error(
      error?.message || "Kunne ikke verifisere vurderingens kildegrunnlag.",
    );
  }
  return data;
}

export async function getFreshSolutionEvaluationSnapshot(projectId: string) {
  const snapshot = await getFreshProjectDerivedSnapshot(projectId);
  return snapshot
    ? { evaluation: snapshot.evaluation, dependency: snapshot.dependency }
    : null;
}

export async function getFreshProjectDerivedSnapshot(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc(
    "get_current_project_derived_snapshot",
    { p_project_id: projectId },
  );
  if (error) {
    throw new Error(error.message);
  }
  if (data == null) return null;
  if (typeof data !== "object") {
    throw new Error("Databasen returnerte ugyldig vurderingsprovenance.");
  }
  const snapshot = data as Record<string, unknown>;
  if (!snapshot.evaluation_row || typeof snapshot.evaluation_row !== "object") {
    throw new Error("Databasen returnerte en vurdering uten autoritativ rad.");
  }
  const dependency = parseSolutionEvaluationDependency(snapshot.dependency);
  if (!dependency) {
    throw new Error("Databasen returnerte en vurdering uten autoritativ dependency.");
  }
  const row = snapshot.evaluation_row as unknown as SolutionEvaluationRow;
  if (
    row.id !== dependency.id ||
    new Date(row.updated_at).toISOString() !== dependency.updated_at
  ) {
    throw new Error("Vurderingsrad og dependency er ikke fra samme snapshot.");
  }
  return {
    evaluation: mapSolutionEvaluationRow(row),
    dependency,
    executiveSummary:
      snapshot.executive_summary_row &&
      typeof snapshot.executive_summary_row === "object"
        ? mapExecutiveSummaryRow(
            snapshot.executive_summary_row as unknown as ExecutiveSummaryRow,
          )
        : null,
  };
}

export async function getFreshSolutionEvaluation(projectId: string) {
  return (await getFreshSolutionEvaluationSnapshot(projectId))?.evaluation ?? null;
}

export async function getSolutionEvaluation(projectId: string) {
  return unstable_cache(
    () => getFreshSolutionEvaluation(projectId),
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
  authority: {
    expectedArtifactSourceRevision: number;
    expectedServiceLibraryRevision: number;
    knowledgeArtifactManifest: Array<{
      id: string;
      artifact_type: GeneratedArtifactType;
      artifact_version: number;
      updated_at: string;
      content_hash: string;
    }>;
    generatorRevision: string;
    sourceSnapshotHash: string;
    usedSolutionEvaluation: boolean;
    solutionEvaluationDependency: ArtifactSourceRevisions["solutionEvaluationDependency"];
  },
) {
  const fencedSave = await runLeaseFencedGeneratedArtifactMutation<ArtifactRow>(
    projectId,
    {
      artifact_type: artifactType,
      title,
      content_markdown: contentMarkdown,
      input_snapshot: encryptJson(inputSnapshot),
      expected_artifact_source_revision:
        authority.expectedArtifactSourceRevision,
      expected_service_library_revision:
        authority.expectedServiceLibraryRevision,
      knowledge_artifact_manifest: authority.knowledgeArtifactManifest,
      generator_revision: authority.generatorRevision,
      source_snapshot_hash: authority.sourceSnapshotHash,
      used_solution_evaluation: authority.usedSolutionEvaluation,
      solution_evaluation_dependency:
        authority.solutionEvaluationDependency,
      last_activity_at: new Date().toISOString(),
    },
  );
  if (!fencedSave.fenced) {
    throw new Error(
      "Generatorartefakten må lagres gjennom en aktiv, versjonsfencet prosjektjobb.",
    );
  }
  revalidateProjectCaches(projectId);
  return mapArtifact(fencedSave.data);
}

export async function updateGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
  title: string;
  contentMarkdown: string;
  acknowledgeDeterministicRepairs?: boolean;
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
  const { data: parent, error: parentError } = await supabase
    .from("generated_artifacts")
    .select("*")
    .eq("id", input.artifactId)
    .eq("project_id", input.projectId)
    .single<ArtifactRow>();
  if (parentError || !parent) {
    throw new Error(parentError?.message || "Fant ikke kravbesvarelsen.");
  }
  const originalSnapshot = decryptJson(parent.input_snapshot, {});
  const editedAt = new Date().toISOString();
  const validatedInputSnapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: parent.artifact_type,
    title,
    contentMarkdown,
    parentContentMarkdown: parent.content_markdown,
    parentInputSnapshot: originalSnapshot,
    parentArtifactId: input.artifactId,
    editedAt,
    acknowledgeDeterministicRepairs:
      input.acknowledgeDeterministicRepairs === true,
  });
  const revisions = await getArtifactSourceRevisions(input.projectId);
  const { data, error } = await supabase.rpc("create_manual_artifact_version", {
    p_project_id: input.projectId,
    p_parent_artifact_id: input.artifactId,
    p_payload: {
      title,
      content_markdown: contentMarkdown,
      input_snapshot: encryptJson(validatedInputSnapshot),
      expected_artifact_source_revision: revisions.artifactSourceRevision,
      expected_service_library_revision: revisions.serviceLibraryRevision,
      generator_revision: "manual-edit-v2",
    },
  });

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kravbesvarelsen.");
  }

  revalidateProjectCaches(input.projectId);
  return mapArtifact(data as ArtifactRow);
}

export async function deleteGeneratedArtifact(input: {
  projectId: string;
  artifactId: string;
}) {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("delete_artifact_version_serialized", {
    p_project_id: input.projectId,
    p_artifact_id: input.artifactId,
  });

  if (error) {
    throw new Error(error.message || "Kunne ikke slette artefakten.");
  }

  revalidateProjectCaches(input.projectId);
}

export async function listGeneratedArtifacts(
  projectId: string,
  options: { artifactType?: GeneratedArtifactType } = {},
) {
  return listGeneratedArtifactsFresh(projectId, options);
}

function decorateArtifactAuthority(
  artifacts: GeneratedArtifact[],
  authority: GeneratedArtifactAuthorityByType,
) {
  return artifacts.map((artifact) => {
    const record = authority[artifact.artifact_type];
    const isCurrent =
      record?.id === artifact.id &&
      record.artifact_version === artifact.artifact_version;
    return {
      ...artifact,
      is_current: isCurrent,
      source_is_current: isCurrent && record.source_is_current,
    };
  });
}

export async function listGeneratedArtifactsFresh(
  projectId: string,
  options: { artifactType?: GeneratedArtifactType } = {},
) {
  const supabase = createServiceClient();
  let query = supabase
    .from("generated_artifacts")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(GENERATED_ARTIFACT_LIST_LIMIT);
  if (options.artifactType) {
    query = query.eq("artifact_type", options.artifactType);
  }
  const [{ data, error }, authority] = await Promise.all([
    query,
    getArtifactAuthoritySummary(projectId),
  ]);
  if (error) {
    throw new Error(error.message || "Kunne ikke hente generatorartefakter.");
  }
  return decorateArtifactAuthority(
    ((data ?? []) as ArtifactRow[]).map(mapArtifact),
    authority,
  );
}

export async function listArtifactKnowledgeCandidatesFresh(
  projectId: string,
  artifactType: GeneratedArtifactType,
) {
  const supabase = createServiceClient();
  const { data: manifestData, error: manifestError } = await supabase.rpc(
    "artifact_knowledge_manifest",
    { p_project_id: projectId, p_artifact_type: artifactType },
  );
  if (manifestError) {
    throw new Error(
      manifestError.message || "Kunne ikke verifisere artefaktkunnskap.",
    );
  }
  if (!Array.isArray(manifestData)) {
    throw new Error("Databasen returnerte et ugyldig kunnskapsmanifest.");
  }
  const eligibleIds = manifestData.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("Databasen returnerte et ugyldig kunnskapsmanifest.");
    }
    return (entry as Record<string, unknown>).id as string;
  });
  if (!eligibleIds.length) {
    return [];
  }
  const { data, error } = await supabase
    .from("generated_artifacts")
    .select("*")
    .eq("project_id", projectId)
    .in("id", eligibleIds);
  if (error) {
    throw new Error(error.message || "Kunne ikke hente artefaktkunnskap.");
  }
  const artifactsById = new Map(
    ((data ?? []) as ArtifactRow[]).map((row) => [row.id, mapArtifact(row)]),
  );
  return eligibleIds.map((id) => {
    const artifact = artifactsById.get(id);
    if (!artifact) {
      throw new Error(
        "Kunnskapsartefakten ble endret under innlesing. Start genereringen på nytt.",
      );
    }
    return artifact;
  });
}

export async function appendChatMessage(
  projectId: string,
  role: ChatMessageRole,
  content: string,
  contextSnapshot: unknown,
  options: { sessionId?: string | null } = {},
) {
  const supabase = createServiceClient();
  const insertPayload = {
    project_id: projectId,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    role,
    content,
    context_snapshot: encryptJson(contextSnapshot),
  };
  let insertResult = await supabase
    .from("chat_messages")
    .insert(insertPayload)
    .select("*")
    .single<ChatRow>();

  if (
    insertResult.error &&
    options.sessionId &&
    isMissingRelationColumn(insertResult.error, "chat_messages")
  ) {
    insertResult = await supabase
      .from("chat_messages")
      .insert({
        project_id: projectId,
        role,
        content,
        context_snapshot: encryptJson(contextSnapshot),
      })
      .select("*")
      .single<ChatRow>();
  }

  if (insertResult.error || !insertResult.data) {
    throw new Error(
      insertResult.error?.message || "Kunne ikke lagre chatmeldingen.",
    );
  }

  await supabase
    .from("projects")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", projectId);
  revalidateProjectCaches(projectId);
  return mapChatMessage(insertResult.data);
}

export async function listChatMessages(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("chat_messages")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(CHAT_MESSAGE_LIST_LIMIT);

  if (error) {
    throw new Error(error.message || "Kunne ikke hente chatmeldinger.");
  }

  return ((data ?? []) as ChatRow[]).reverse().map(mapChatMessage);
}

export async function listChatSessions(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("project_id", projectId)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    if (isMissingRelationColumn(error, "chat_sessions")) {
      return [];
    }
    throw new Error(error.message || "Kunne ikke hente chat-sessions.");
  }

  return ((data ?? []) as ChatSessionRow[]).map(mapChatSession);
}

export async function upsertChatSession(input: {
  projectId: string;
  sessionId: string;
  title: string;
  domainHints?: ChatDomainHint[];
  lastMessagePreview?: string;
  messageCount?: number;
}) {
  const supabase = createServiceClient();
  const { error } = await supabase.from("chat_sessions").upsert(
    {
      id: input.sessionId,
      project_id: input.projectId,
      title: input.title,
      domain_hints: input.domainHints ?? [],
      last_message_preview: input.lastMessagePreview ?? "",
      message_count: input.messageCount ?? 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "project_id,id" },
  );

  if (error) {
    if (isMissingRelationColumn(error, "chat_sessions")) {
      return;
    }
    throw new Error(error.message || "Kunne ikke lagre chat-session.");
  }
}

export async function updateChatSessionMemory(input: {
  projectId: string;
  sessionId: string;
  summary: string;
  domainHints: ChatDomainHint[];
  lastMessagePreview: string;
  messageCount: number;
}) {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("chat_sessions")
    .update({
      summary_encrypted: encryptString(input.summary),
      domain_hints: input.domainHints,
      last_message_preview: input.lastMessagePreview,
      message_count: input.messageCount,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", input.projectId)
    .eq("id", input.sessionId);

  if (error && !isMissingRelationColumn(error, "chat_sessions")) {
    throw new Error(error.message || "Kunne ikke oppdatere chat-minne.");
  }
}

export async function getProjectSnapshot(
  projectId: string,
): Promise<ProjectCacheSnapshot> {
  const [project, artifactAuthority, evaluationSnapshot] = await Promise.all([
    queryProjectRow(projectId),
    getArtifactAuthoritySummary(projectId),
    getFreshSolutionEvaluationSnapshot(projectId),
  ]);
  return mapProjectSnapshot(
    project,
    artifactAuthority,
    Boolean(evaluationSnapshot),
  );
}
