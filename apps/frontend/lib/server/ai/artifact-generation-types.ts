import "server-only";

import type { RequirementLedgerConfidence } from "@/lib/server/ai/requirement-coverage";
import type {
  buildContinuationPageMap,
  buildRequirementPageEvidence,
} from "@/lib/server/requirements/source-ledger";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type {
  CustomerAnalysisResult,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ServiceDocument,
  ServiceDocumentDetail,
  SolutionEvaluationResult,
} from "@/lib/types";

export type ArtifactFoundationFact = {
  label: string;
  text: string;
  source: string;
};

type ArtifactKnowledgeItem = {
  title: string;
  content_markdown: string;
  artifact_type: GeneratedArtifactType;
};

export type ProjectArtifactGenerationInput = {
  artifactType: GeneratedArtifactType;
  requirementRegeneration?: { parent: import("@/lib/types").GeneratedArtifact; selection: import("@/lib/requirement-regeneration").RequirementRegenerationSelection };
  projectName: string;
  customerAnalysis: CustomerAnalysisResult | null;
  solutionEvaluation: SolutionEvaluationResult | null;
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  serviceDescriptionDocument?: ProjectDocumentDetail | null;
  serviceDescriptionDocuments?: ServiceDocumentDetail[];
  serviceDocumentSummaries?: ServiceDocument[];
  supportingDocuments: ProjectDocumentDetail[];
  requirementDocuments?: ProjectDocumentDetail[];
  knowledgeArtifacts: ArtifactKnowledgeItem[];
  instructions?: string;
  model?: string;
  onProgress?: (message: string) => void;
  documentLedgerContext?: string;
};

export type GeneratedArtifactDraft = {
  title: string;
  content_markdown: string;
  generation_metadata?: unknown;
};

export type RequirementArtifactContext = {
  requirementDocuments: ProjectDocumentDetail[];
  requirementLedger: RequirementLedgerEntry[];
  requirementLedgerConfidence: RequirementLedgerConfidence;
  useRequirementLedgerGeneration: boolean;
  requirementDocumentContext: string;
  requirementContinuityContext: string;
  requirementSourceLedgerContext: string;
  requirementFileDocuments: ProjectDocumentDetail[];
  continuationPages: ReturnType<typeof buildContinuationPageMap>;
  pageEvidence: ReturnType<typeof buildRequirementPageEvidence>;
  alignmentRequirementLedger: RequirementLedgerEntry[];
  alignmentRequirementRefs: string[];
};
