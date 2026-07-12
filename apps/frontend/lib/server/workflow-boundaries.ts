import "server-only";

import type {
  GeneratedArtifactType,
  ProjectDocumentDetail,
  SolutionEvaluationResult,
} from "@/lib/types";

export type SolutionEvaluationContextMode =
  | "explicit_feedback"
  | "excluded_requirement_answer_default"
  | "general_artifact_context";

export function solutionEvaluationContextModeForArtifact(input: {
  artifactType: GeneratedArtifactType;
  useSolutionEvaluationContext?: boolean;
}): SolutionEvaluationContextMode {
  if (input.artifactType !== "forbedret_kravsvar") {
    return "general_artifact_context";
  }

  return input.useSolutionEvaluationContext
    ? "explicit_feedback"
    : "excluded_requirement_answer_default";
}

export function shouldUseSolutionEvaluationForArtifact(input: {
  artifactType: GeneratedArtifactType;
  useSolutionEvaluationContext?: boolean;
}) {
  return (
    input.artifactType !== "forbedret_kravsvar" ||
    input.useSolutionEvaluationContext === true
  );
}

export function buildSolutionEvaluationProvenance(input: {
  customerDocument: ProjectDocumentDetail;
  solutionDocument: ProjectDocumentDetail;
  systemSolutionArtifact?: {
    id?: string;
    title: string;
    created_at?: string;
  } | null;
  requirementSourceDocumentIds?: string[];
  requirementSourceManifestSha256?: string | null;
  sourceRevision?: number | null;
}): NonNullable<SolutionEvaluationResult["evaluation_context"]> {
  return {
    customer_document_id: input.customerDocument.id,
    customer_document_title: input.customerDocument.title,
    solution_document_id: input.solutionDocument.id,
    solution_document_title: input.solutionDocument.title,
    system_solution_artifact_id: input.systemSolutionArtifact?.id ?? null,
    system_solution_artifact_title:
      input.systemSolutionArtifact?.title ?? null,
    system_solution_artifact_created_at:
      input.systemSolutionArtifact?.created_at ?? null,
    requirement_source_document_ids: input.requirementSourceDocumentIds ?? [],
    requirement_source_manifest_sha256:
      input.requirementSourceManifestSha256 ?? null,
    source_revision: input.sourceRevision ?? null,
    generated_at: new Date().toISOString(),
  };
}
