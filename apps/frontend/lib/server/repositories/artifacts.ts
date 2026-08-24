import "server-only";

import { buildValidatedManualArtifactInputSnapshot } from "@/lib/server/artifact-validation";
import { decryptJson, encryptJson } from "@/lib/server/crypto";
import { runLeaseFencedGeneratedArtifactMutation } from "@/lib/server/repositories/lease-fenced-persistence";
import { revalidateProjectCaches } from "@/lib/server/repositories/repository-cache";
import { createServiceClient } from "@/lib/server/data-api";
import type {
  GeneratedArtifact,
  GeneratedArtifactAuthorityByType,
  GeneratedArtifactType,
} from "@/lib/types";

const GENERATED_ARTIFACT_LIST_LIMIT = 250;
export const GENERATED_ARTIFACT_TYPES: GeneratedArtifactType[] = [
  "losningsutkast",
  "bilag1_rekonstruksjon",
  "forbedret_kravsvar",
  "tilbudsstrategi",
  "verdiargumentasjon",
  "anbefalt_arkitektur",
  "gjennomforing_og_risiko",
];

type ArtifactRow = {
  id: string;
  project_id: string;
  artifact_type: GeneratedArtifactType;
  title: string;
  content_markdown: string;
  input_snapshot: unknown;
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
};

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

export function isGeneratedArtifactType(
  value: unknown,
): value is GeneratedArtifactType {
  return GENERATED_ARTIFACT_TYPES.includes(value as GeneratedArtifactType);
}

function mapArtifact(row: ArtifactRow): GeneratedArtifact {
  const artifactType = isGeneratedArtifactType(row.artifact_type)
    ? row.artifact_type
    : "losningsutkast";
  const title =
    typeof row.title === "string" && row.title.trim()
      ? row.title.trim()
      : "Generatorutkast uten tittel";
  const legacyRow = row as unknown as Record<string, unknown>;
  const legacyContent =
    typeof legacyRow.content === "string"
      ? legacyRow.content
      : typeof legacyRow.markdown === "string"
        ? legacyRow.markdown
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
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc("get_artifact_source_revisions", {
    p_project_id: projectId,
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(
      error?.message ||
        "Artefaktens kilderevisjon mangler. Kjør siste PostgREST-migrering før generering.",
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
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc("get_artifact_authority_summary", {
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
      throw new Error(
        "Databasen returnerte ugyldig autoritetsstatus for en artefakt.",
      );
    }
    authority[record.artifact_type] = {
      id: record.id,
      artifact_version: artifactVersion,
      source_is_current: record.source_is_current,
    };
  }
  return authority;
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
  const saved = await runLeaseFencedGeneratedArtifactMutation<ArtifactRow>(
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
  if (!saved.fenced) {
    throw new Error(
      "Generatorartefakten må lagres gjennom en aktiv, versjonsfencet prosjektjobb.",
    );
  }
  revalidateProjectCaches(projectId);
  return mapArtifact(saved.data);
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
  if (!title) throw new Error("Kravbesvarelsen må ha en tittel.");
  if (!contentMarkdown) throw new Error("Kravbesvarelsen kan ikke være tom.");

  const dataApi = createServiceClient();
  const { data: parent, error: parentError } = await dataApi
    .from("generated_artifacts")
    .select("*")
    .eq("id", input.artifactId)
    .eq("project_id", input.projectId)
    .single<ArtifactRow>();
  if (parentError || !parent) {
    throw new Error(parentError?.message || "Fant ikke kravbesvarelsen.");
  }
  const editedAt = new Date().toISOString();
  const validatedInputSnapshot = buildValidatedManualArtifactInputSnapshot({
    artifactType: parent.artifact_type,
    title,
    contentMarkdown,
    parentContentMarkdown: parent.content_markdown,
    parentInputSnapshot: decryptJson(parent.input_snapshot, {}),
    parentArtifactId: input.artifactId,
    editedAt,
    acknowledgeDeterministicRepairs:
      input.acknowledgeDeterministicRepairs === true,
  });
  const revisions = await getArtifactSourceRevisions(input.projectId);
  const { data, error } = await dataApi.rpc("create_manual_artifact_version", {
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
  const dataApi = createServiceClient();
  const { error } = await dataApi.rpc("delete_artifact_version_serialized", {
    p_project_id: input.projectId,
    p_artifact_id: input.artifactId,
  });
  if (error) throw new Error(error.message || "Kunne ikke slette artefakten.");
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
  const dataApi = createServiceClient();
  let query = dataApi
    .from("generated_artifacts")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(GENERATED_ARTIFACT_LIST_LIMIT);
  if (options.artifactType) query = query.eq("artifact_type", options.artifactType);
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
  const dataApi = createServiceClient();
  const { data: manifestData, error: manifestError } = await dataApi.rpc(
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
  if (!eligibleIds.length) return [];
  const { data, error } = await dataApi
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
