import "server-only";

import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";

import { createServiceClient } from "@/lib/server/supabase";
import { decryptJson, decryptString, encryptJson, encryptString } from "@/lib/server/crypto";
import type {
  ChatMessage,
  ChatMessageRole,
  CustomerAnalysisResult,
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectMetadataInference,
  ProjectCreateInput,
  ProjectDetail,
  ProjectDocument,
  ProjectDocumentDetail,
  ProjectDocumentRole,
  ProjectStatus,
  ProjectSummary,
  SolutionEvaluationResult,
  SupportingDocumentSubtype,
} from "@/lib/types";

type Json = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

interface ProjectRow {
  id: string;
  name: string;
  customer_name: string | null;
  description: string | null;
  industry: string | null;
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

interface ArtifactRow {
  id: string;
  project_id: string;
  artifact_type: GeneratedArtifactType;
  title: string;
  content_markdown: string;
  input_snapshot: Json;
  created_at: string;
}

interface ChatRow {
  id: string;
  project_id: string;
  role: ChatMessageRole;
  content: string;
  context_snapshot: Json;
  created_at: string;
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
  "id, project_id, role, file_name, file_format, content_type, file_size_bytes, file_base64, raw_text, created_at, updated_at";
const DOCUMENT_SUMMARY_SELECT_SAFE =
  "id, project_id, role, file_name, file_format, content_type, file_size_bytes, created_at, updated_at";

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
  likely_evaluation_criteria: [],
  signal_words: [],
  expected_solution_direction: [],
  value_opportunities: [],
  positioning_recommendations: [],
  executive_summary: "",
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
  executive_summary: "",
};

const PROJECTS_LIST_TAG = "projects:list";

function projectTag(projectId: string) {
  return `project:${projectId}`;
}

function revalidateProjectCaches(projectId: string) {
  revalidateTag(PROJECTS_LIST_TAG);
  revalidateTag(projectTag(projectId));
  revalidatePath("/");
  revalidatePath(`/projects/${projectId}`);
}

function mapProjectStatus(row: ProjectRow): ProjectStatus {
  if (row.solution_document_uploaded) {
    return "Løsningsdokument lastet opp";
  }
  if (row.customer_analysis_generated) {
    return "Kundeanalyse klar";
  }
  if (row.customer_document_uploaded) {
    return "Kundedokument lastet opp";
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

function isMissingRelationColumn(error: { message?: string } | null, relation: string) {
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
    customer_document_uploaded: Boolean(row.customer_document_uploaded ?? false),
    customer_analysis_generated: Boolean(row.customer_analysis_generated ?? false),
    solution_document_uploaded: Boolean(row.solution_document_uploaded ?? false),
    solution_evaluation_generated: Boolean(row.solution_evaluation_generated ?? false),
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
    file_base64: decryptString(row.file_base64),
    raw_text: decryptString(row.raw_text),
    structure_map: decryptJson(row.structure_map, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapDocumentSummary(row: DocumentSummaryRow): ProjectDocument {
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapArtifact(row: ArtifactRow): GeneratedArtifact {
  const artifactType = [
    "losningsutkast",
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

function mapProjectSummary(row: ProjectRow, documents: DocumentSummaryRow[]): ProjectSummary {
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
    supporting_document_count: documents.filter((document) => document.role === "supporting_document").length,
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
  return normalized === "" || normalized === "ny analyse" || normalized === "nytt prosjekt";
}

function isCustomerPlaceholder(value: string | null) {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "kunde ikke satt";
}

function shouldUseInferredValue(current: string | null, inferred: string | null, isPlaceholder: (value: string | null) => boolean) {
  return Boolean(inferred?.trim()) && isPlaceholder(current);
}

function isMissingLegacyDocumentColumn(error: { message?: string } | null) {
  const message = error?.message ?? "";
  return (
    message.includes('column documents.') ||
    message.includes("supporting_subtype") ||
    message.includes("title") ||
    message.includes("display_name") ||
    message.includes("file_name") ||
    message.includes("file_size_bytes") ||
    message.includes("structure_map") ||
    message.includes("source_map")
  );
}

function fromUnknownDocumentSummaryRow(row: Record<string, unknown>): DocumentSummaryRow {
  return {
    id: String(row.id ?? ""),
    project_id: String(row.project_id ?? ""),
    role: (row.role as ProjectDocumentRole) ?? "supporting_document",
    supporting_subtype:
      (row.supporting_subtype as SupportingDocumentSubtype | null | undefined) ??
      (row.subtype as SupportingDocumentSubtype | null | undefined) ??
      null,
    title: String(row.title ?? row.display_name ?? row.file_name ?? "Dokument"),
    file_name: String(row.file_name ?? row.display_name ?? row.title ?? "document.txt"),
    file_format: String(row.file_format ?? "txt"),
    content_type: String(row.content_type ?? "application/octet-stream"),
    file_size_bytes: Number(row.file_size_bytes ?? 0),
    created_at: String(row.created_at ?? new Date().toISOString()),
    updated_at: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
  };
}

function fromUnknownDocumentRow(row: Record<string, unknown>): DocumentRow {
  return {
    ...fromUnknownDocumentSummaryRow(row),
    file_base64: String(row.file_base64 ?? ""),
    raw_text: String(row.raw_text ?? ""),
    structure_map: (row.structure_map ?? row.source_map ?? []) as Json,
  };
}

async function fetchDocumentRows(
  build: (select: string) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>,
): Promise<DocumentRow[]> {
  const first = await build(DOCUMENT_SELECT_SAFE);
  if (!first.error) {
    return ((first.data ?? []) as Record<string, unknown>[]).map(fromUnknownDocumentRow);
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build("*");
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentene.");
    }
    return ((retry.data ?? []) as Record<string, unknown>[]).map(fromUnknownDocumentRow);
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentene.");
}

async function fetchDocumentSummaryRows(
  build: (select: string) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>,
): Promise<DocumentSummaryRow[]> {
  const first = await build(DOCUMENT_SUMMARY_SELECT_SAFE);
  if (!first.error) {
    return ((first.data ?? []) as Record<string, unknown>[]).map(fromUnknownDocumentSummaryRow);
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build("*");
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentene.");
    }
    return ((retry.data ?? []) as Record<string, unknown>[]).map(fromUnknownDocumentSummaryRow);
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentene.");
}

async function fetchSingleDocumentRow(
  build: (select: string) => PromiseLike<{ data: unknown | null; error: { message?: string } | null }>,
): Promise<DocumentRow | null> {
  const first = await build(DOCUMENT_SELECT_SAFE);
  if (!first.error) {
    return first.data ? fromUnknownDocumentRow(first.data as Record<string, unknown>) : null;
  }

  if (isMissingLegacyDocumentColumn(first.error)) {
    const retry = await build("*");
    if (retry.error) {
      throw new Error(retry.error.message || "Kunne ikke hente dokumentet.");
    }
    return retry.data ? fromUnknownDocumentRow(retry.data as Record<string, unknown>) : null;
  }

  throw new Error(first.error.message || "Kunne ikke hente dokumentet.");
}

async function queryProjectRow(projectId: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single<Record<string, unknown>>();

  if (error || !data) {
    throw new Error("Fant ikke prosjektet.");
  }

  return fromUnknownProjectRow(data);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return unstable_cache(
    async () => {
  const supabase = createServiceClient();
  const [{ data: projects, error: projectsError }, documentRows, { data: artifacts }] =
    await Promise.all([
      supabase.from("projects").select("*").order("last_activity_at", { ascending: false }),
      fetchDocumentSummaryRows((select) => supabase.from("documents").select(select)),
      supabase.from("generated_artifacts").select("id, project_id"),
    ]);

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
    artifactCount.set(row.project_id, (artifactCount.get(row.project_id) ?? 0) + 1);
  }

  return ((projects ?? []) as Record<string, unknown>[]).map((row) => {
    const project = fromUnknownProjectRow(row);
    return {
      ...mapProjectSummary(project, documentsByProject.get(project.id) ?? []),
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

export async function createProject(input: ProjectCreateInput): Promise<ProjectSummary> {
  const supabase = createServiceClient();
  const normalizedName = input.name?.trim() || "Ny analyse";
  const payload = {
    name: normalizedName,
    customer_name: input.customer_name?.trim() || null,
    description: input.description?.trim() || null,
    industry: input.industry?.trim() || null,
  };
  let insertResult = await supabase.from("projects").insert(payload).select("*").single<Record<string, unknown>>();

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
    throw new Error(insertResult.error?.message || "Kunne ikke opprette prosjekt.");
  }

  revalidateTag(PROJECTS_LIST_TAG);
  revalidatePath("/");
  revalidatePath("/projects/new");

  return mapProjectSummary(fromUnknownProjectRow(insertResult.data), []);
}

export async function updateProjectMetadataFromInference(projectId: string, inferred: ProjectMetadataInference) {
  const supabase = createServiceClient();
  const project = await queryProjectRow(projectId);

  const nextName = shouldUseInferredValue(project.name, inferred.name, isProjectNamePlaceholder)
    ? inferred.name?.trim() ?? null
    : null;
  const nextCustomerName = shouldUseInferredValue(project.customer_name, inferred.customer_name, isCustomerPlaceholder)
    ? inferred.customer_name?.trim() ?? null
    : null;
  const nextIndustry =
    !project.industry?.trim() && inferred.industry?.trim() ? inferred.industry.trim() : null;
  const nextDescription =
    !project.description?.trim() && inferred.description?.trim() ? inferred.description.trim() : null;

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

  let updateResult = await supabase.from("projects").update(standardPatch).eq("id", projectId).select("*").single<Record<string, unknown>>();

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
    throw new Error(updateResult.error?.message || "Kunne ikke oppdatere prosjektmetadata.");
  }

  revalidateProjectCaches(projectId);

  return fromUnknownProjectRow(updateResult.data);
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  return unstable_cache(
    async () => {
      const supabase = createServiceClient();

      const [
        projectRow,
        documentRows,
        { data: analyses, error: analysesError },
        { data: artifactRows, error: artifactsError },
      ] = await Promise.all([
        queryProjectRow(projectId),
        fetchDocumentSummaryRows((select) =>
          supabase.from("documents").select(select).eq("project_id", projectId).order("created_at", { ascending: false }),
        ),
        supabase
          .from("customer_analyses")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase.from("generated_artifacts").select("id").eq("project_id", projectId),
      ]);

      if (analysesError || artifactsError) {
        throw new Error(
          analysesError?.message ||
            artifactsError?.message ||
            "Kunne ikke laste prosjektet.",
        );
      }

      const analysisRow = ((analyses ?? [])[0] as CustomerAnalysisRow | undefined) ?? null;

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
        supporting_document_count: documentRows.filter((document) => document.role === "supporting_document").length,
        artifact_count: (artifactRows ?? []).length,
        has_chat: false,
        documents: documentRows.map(mapDocumentSummary),
        customer_analysis: analysisRow ? decryptJson(analysisRow.result_json, CUSTOMER_ANALYSIS_EMPTY) : null,
        solution_evaluation: null,
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
  const payloadWithSubtype = {
    project_id: input.projectId,
    role: input.role,
    supporting_subtype: input.role === "supporting_document" ? input.supportingSubtype ?? null : null,
    title: input.title,
    file_name: input.fileName,
    file_format: input.fileFormat,
    content_type: input.contentType,
    file_size_bytes: input.fileSizeBytes,
    file_base64: encryptString(input.fileBase64),
    raw_text: encryptString(input.rawText),
    structure_map: encryptJson(input.structureMap),
  };

  let inserted: DocumentRow | null = null;
  let insertResult = await supabase.from("documents").insert(payloadWithSubtype).select("*").single<DocumentRow>();

  if (insertResult.error && isMissingLegacyDocumentColumn(insertResult.error)) {
    const payloadLegacy: Record<string, unknown> = {
      ...payloadWithSubtype,
      display_name: input.title,
      subtype: input.role === "supporting_document" ? input.supportingSubtype ?? null : null,
    };
    delete payloadLegacy.supporting_subtype;
    delete payloadLegacy.title;
    delete payloadLegacy.file_name;
    delete payloadLegacy.file_size_bytes;
    insertResult = await supabase.from("documents").insert(payloadLegacy).select("*").single<DocumentRow>();
  }

  if (insertResult.error || !insertResult.data) {
    throw new Error(insertResult.error?.message || "Kunne ikke lagre dokumentet.");
  }
  inserted = fromUnknownDocumentRow(insertResult.data as unknown as Record<string, unknown>);

  const projectPatch: Partial<ProjectRow> = {
    last_activity_at: new Date().toISOString(),
  };
  if (input.role === "primary_customer_document") {
    projectPatch.customer_document_uploaded = true;
  }
  if (input.role === "primary_solution_document") {
    projectPatch.solution_document_uploaded = true;
  }

  await supabase.from("projects").update(projectPatch).eq("id", input.projectId);

  revalidateProjectCaches(input.projectId);

  return mapDocumentSummary(inserted);
}

export async function getDocumentDetail(projectId: string, documentId: string): Promise<ProjectDocumentDetail> {
  const supabase = createServiceClient();
  const data = await fetchSingleDocumentRow((select) =>
    supabase.from("documents").select(select).eq("project_id", projectId).eq("id", documentId).single(),
  );

  if (!data) {
    throw new Error("Fant ikke dokumentet.");
  }

  return decryptDocumentRow(data);
}

export async function deleteDocument(projectId: string, documentId: string) {
  const supabase = createServiceClient();
  const { data: beforeDelete } = await supabase
    .from("documents")
    .select("id, role")
    .eq("project_id", projectId)
    .eq("id", documentId)
    .single<{ id: string; role: ProjectDocumentRole }>();

  const { error } = await supabase.from("documents").delete().eq("project_id", projectId).eq("id", documentId);
  if (error) {
    throw new Error(error.message);
  }

  const { data: remaining } = await supabase.from("documents").select("role").eq("project_id", projectId);
  const rows = remaining ?? [];

  await supabase
    .from("projects")
    .update({
      customer_document_uploaded: rows.some((row) => row.role === "primary_customer_document"),
      solution_document_uploaded: rows.some((row) => row.role === "primary_solution_document"),
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (beforeDelete?.role === "primary_customer_document") {
    await supabase.from("customer_analyses").delete().eq("project_id", projectId);
    await supabase
      .from("projects")
      .update({ customer_analysis_generated: false })
      .eq("id", projectId);
  }

  if (beforeDelete?.role === "primary_solution_document") {
    await supabase.from("solution_evaluations").delete().eq("project_id", projectId);
    await supabase
      .from("projects")
      .update({ solution_evaluation_generated: false })
      .eq("id", projectId);
  }

  revalidateProjectCaches(projectId);
}

export async function getPrimaryDocument(projectId: string, role: Extract<ProjectDocumentRole, "primary_customer_document" | "primary_solution_document">) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows((select) =>
    supabase.from("documents").select(select).eq("project_id", projectId).eq("role", role).order("created_at", { ascending: false }).limit(1),
  );
  const row = rows[0] ?? null;
  return row ? decryptDocumentRow(row) : null;
}

export async function listSupportingDocuments(projectId: string) {
  const supabase = createServiceClient();
  const rows = await fetchDocumentRows((select) =>
    supabase.from("documents").select(select).eq("project_id", projectId).eq("role", "supporting_document").order("created_at", { ascending: false }),
  );

  return rows.map(decryptDocumentRow);
}

export async function saveCustomerAnalysis(projectId: string, sourceDocumentIds: string[], result: CustomerAnalysisResult) {
  const supabase = createServiceClient();
  await supabase.from("customer_analyses").delete().eq("project_id", projectId);

  const { data, error } = await supabase
    .from("customer_analyses")
    .insert({
      project_id: projectId,
      source_document_ids: sourceDocumentIds,
      result_json: encryptJson(result),
    })
    .select("*")
    .single<CustomerAnalysisRow>();

  if (error || !data) {
    throw new Error(error?.message || "Kunne ikke lagre kundeanalysen.");
  }

  await supabase
    .from("projects")
    .update({
      customer_analysis_generated: true,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  revalidateProjectCaches(projectId);

  return decryptJson(data.result_json, CUSTOMER_ANALYSIS_EMPTY);
}

export async function getCustomerAnalysis(projectId: string) {
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
  await supabase.from("solution_evaluations").delete().eq("project_id", projectId);
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
        source_document_ids: [input.customerDocumentId, input.solutionDocumentId].filter(Boolean),
        result_json: encryptJson(input.result),
      })
      .select("*")
      .single<SolutionEvaluationRow>();
  }

  if (insertResult.error || !insertResult.data) {
    throw new Error(insertResult.error?.message || "Kunne ikke lagre løsningsvurderingen.");
  }

  await supabase
    .from("projects")
    .update({
      solution_evaluation_generated: true,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  revalidateProjectCaches(projectId);

  return decryptJson(insertResult.data.result_json, SOLUTION_EVALUATION_EMPTY);
}

export async function saveGeneratedArtifact(projectId: string, artifactType: GeneratedArtifactType, title: string, contentMarkdown: string, inputSnapshot: unknown) {
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

  await supabase.from("projects").update({ last_activity_at: new Date().toISOString() }).eq("id", projectId);
  revalidateProjectCaches(projectId);
  return mapArtifact(data);
}

export async function listGeneratedArtifacts(projectId: string) {
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
}

export async function appendChatMessage(projectId: string, role: ChatMessageRole, content: string, contextSnapshot: unknown) {
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

  await supabase.from("projects").update({ last_activity_at: new Date().toISOString() }).eq("id", projectId);
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

export async function getProjectSnapshot(projectId: string): Promise<ProjectCacheSnapshot> {
  const project = await queryProjectRow(projectId);
  return mapProjectSnapshot(project);
}
