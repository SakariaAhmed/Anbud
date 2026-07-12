import { isApprovedSolutionEvaluationDocument } from "@/lib/document-processing";
import type { ProjectDocument } from "@/lib/types";

export function selectSolutionEvaluationDocumentCandidates(
  documents: ProjectDocument[],
) {
  return documents.filter(isApprovedSolutionEvaluationDocument);
}
