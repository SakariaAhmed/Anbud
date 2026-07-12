import type { ProjectDocument, ProjectDocumentDetail } from "@/lib/types";

type DocumentScopeMetadata = Pick<
  ProjectDocument,
  | "id"
  | "role"
  | "supporting_subtype"
  | "title"
  | "file_name"
  | "processing_status"
>;

const REQUIREMENT_SOURCE_METADATA_PATTERN =
  /\b(?:bilag\s*[12]|krav[\p{L}\d_-]*|requirements?|konkurransegrunnlag|rfp)\b/iu;
const STRONG_REQUIREMENT_SOURCE_METADATA_PATTERN =
  /\b(?:bilag\s*1|krav[\p{L}\d_-]*|requirements?|konkurransegrunnlag|rfp)\b/iu;
const UNAMBIGUOUS_REQUIREMENT_SOURCE_METADATA_PATTERN =
  /\b(?:bilag\s*1|krav\s*(?:[-–—_:]\s*)?(?:spesifikasjon|dokument|grunnlag)|requirements?\s*(?:[-–—_:]\s*)?(?:specification|document|baseline)|konkurransegrunnlag|rfp)\b/iu;
const SOLUTION_RESPONSE_METADATA_PATTERN =
  /\b(?:krav\s*(?:[-–—_:]\s*)?(?:(?:og|&)\s*)?(?:svar|besvarelse|respons)|requirements?\s*(?:[-–—_:]\s*)?(?:response|answers?)|l[\u00f8o]snings\s*(?:[-–—_:]\s*)?besvarelse|solution\s*(?:[-–—_:]\s*)?response|tender\s*(?:[-–—_:]\s*)?response)\b/iu;

function normalizedDocumentScopeMetadata(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[_‐‑‒–—-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isHistoricalSolutionDocument(
  document: Pick<ProjectDocument, "supporting_subtype">,
) {
  return document.supporting_subtype === "tidligere_losning";
}

export function hasRequirementDocumentSignal(
  document: Pick<
    ProjectDocument,
    "supporting_subtype" | "title" | "file_name"
  >,
) {
  if (isHistoricalSolutionDocument(document)) {
    return false;
  }

  if (
    document.supporting_subtype === "kravdokument" ||
    document.supporting_subtype === "rfp"
  ) {
    return true;
  }

  const metadata = normalizedDocumentScopeMetadata(
    `${document.title} ${document.file_name}`,
  );
  if (
    SOLUTION_RESPONSE_METADATA_PATTERN.test(metadata) &&
    !UNAMBIGUOUS_REQUIREMENT_SOURCE_METADATA_PATTERN.test(metadata)
  ) {
    return false;
  }

  return (
    REQUIREMENT_SOURCE_METADATA_PATTERN.test(metadata)
  );
}

export function isFormalRequirementDocument(
  document: Pick<
    ProjectDocument,
    "role" | "supporting_subtype" | "title" | "file_name"
  >,
) {
  return (
    document.role !== "primary_customer_document" &&
    document.role !== "primary_solution_document" &&
    !isHistoricalSolutionDocument(document) &&
    hasRequirementDocumentSignal(document)
  );
}

export function isRequirementDocument(
  document: Pick<
    ProjectDocument,
    "role" | "supporting_subtype" | "title" | "file_name"
  >,
) {
  return (
    !isHistoricalSolutionDocument(document) &&
    (document.role === "primary_customer_document" ||
      isFormalRequirementDocument(document))
  );
}

export function isDocumentReadyForEvaluation(
  document:
    | Pick<ProjectDocument, "processing_status">
    | null
    | undefined,
): document is Pick<ProjectDocument, "processing_status"> & {
  processing_status: "basic_ready" | "enhanced_ready";
} {
  return (
    document?.processing_status === "basic_ready" ||
    document?.processing_status === "enhanced_ready"
  );
}

export function hasReadableRequirementDocumentContent(
  document: Pick<ProjectDocumentDetail, "raw_text" | "structure_map">,
) {
  if (document.raw_text.trim()) {
    return true;
  }

  return document.structure_map.some((entry) => {
    if (entry.text?.trim()) {
      return true;
    }
    return Object.values(entry.cells ?? {}).some((value) => value.trim());
  });
}

export function canStartRequirementResponseGeneration(
  documents: Array<Pick<ProjectDocument, "processing_status">>,
  options: { uploadBusy: boolean; generateBusy: boolean },
) {
  return (
    !options.uploadBusy &&
    !options.generateBusy &&
    documents.length > 0 &&
    documents.every(isDocumentReadyForEvaluation)
  );
}

export function requirementDocumentIdsForGeneration(
  documents: DocumentScopeMetadata[],
) {
  return documents
    .filter(isFormalRequirementDocument)
    .filter(isDocumentReadyForEvaluation)
    .map((document) => document.id);
}

export function isApprovedSolutionEvaluationDocument(
  document: DocumentScopeMetadata,
) {
  const metadata = normalizedDocumentScopeMetadata(
    `${document.title} ${document.file_name}`,
  );
  const isExplicitSolutionResponse =
    SOLUTION_RESPONSE_METADATA_PATTERN.test(metadata);
  return (
    document.role === "primary_solution_document" &&
    !isHistoricalSolutionDocument(document) &&
    document.supporting_subtype !== "kravdokument" &&
    document.supporting_subtype !== "rfp" &&
    !UNAMBIGUOUS_REQUIREMENT_SOURCE_METADATA_PATTERN.test(metadata) &&
    (isExplicitSolutionResponse ||
      !STRONG_REQUIREMENT_SOURCE_METADATA_PATTERN.test(metadata))
  );
}

export function isSolutionEvaluationCandidate(
  document: DocumentScopeMetadata,
) {
  return (
    isApprovedSolutionEvaluationDocument(document) &&
    isDocumentReadyForEvaluation(document)
  );
}
