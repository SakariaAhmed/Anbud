import type { ProjectDocumentStructureEntry } from "@/lib/types";

export const DOCUMENT_INTELLIGENCE_SCHEMA_VERSION = "evidence-graph.v1";
export const DOCUMENT_INTELLIGENCE_COMPILER_VERSION = "evidence-compiler.1.1.0";

export type DocumentEvidenceKind =
  | "requirement"
  | "evaluation_criterion"
  | "deadline"
  | "commercial_term"
  | "risk"
  | "dependency"
  | "architecture"
  | "goal"
  | "table"
  | "decision";

export type DocumentParserRoute =
  | "native"
  | "azure_layout"
  | "docling";

export interface DocumentParseQuality {
  score: number;
  textCoverage: number;
  readability: number;
  structureCoverage: number;
  sourceEntryCount: number;
  pageCount: number;
  tableCount: number;
  suspiciousCharacterRatio: number;
  hasRequirementSignals: boolean;
  hasEvaluationSignals: boolean;
  hasUnresolvedVisualReferences: boolean;
  norwegianAnomalies: Array<
    | "mojibake"
    | "replacement_character"
    | "split_word"
    | "joined_party_word"
    | "spaced_requirement_id"
    | "unstructured_requirement_table"
  >;
}

export interface DocumentRoutingDecision {
  route: DocumentParserRoute;
  reason: string;
  quality: DocumentParseQuality;
  recommendVisionReview: boolean;
}

export interface DocumentEvidenceProvenance {
  reference: string;
  page: number | null;
  parser: string;
  sourceKind: ProjectDocumentStructureEntry["kind"] | "raw_text";
  sourceId?: string;
  role?: string;
  confidence?: number;
  polygon?: number[];
  headingPath?: string[];
}

export interface DocumentEvidenceUnit {
  id: string;
  kind: DocumentEvidenceKind;
  text: string;
  normalizedText: string;
  provenance: DocumentEvidenceProvenance;
  signals: string[];
}

export interface DocumentIntelligenceArtifact {
  schemaVersion: typeof DOCUMENT_INTELLIGENCE_SCHEMA_VERSION;
  compilerVersion: typeof DOCUMENT_INTELLIGENCE_COMPILER_VERSION;
  documentId: string;
  projectId: string;
  title: string;
  fileName: string;
  sourceRevision: number;
  contentHash: string;
  compiledAt: string;
  parserUsed: string;
  routing: DocumentRoutingDecision;
  evidence: DocumentEvidenceUnit[];
  evidenceCounts: Partial<Record<DocumentEvidenceKind, number>>;
  analysisContext: string;
}
