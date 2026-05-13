export type ProjectDocumentRole =
  | "primary_customer_document"
  | "primary_solution_document"
  | "supporting_document";

export type SupportingDocumentSubtype =
  | "rfp"
  | "kravdokument"
  | "prosjektbeskrivelse"
  | "notat"
  | "motenotat"
  | "workshop"
  | "vedlegg"
  | "strategi"
  | "utkast"
  | "annet";

export type DocumentFileFormat = "pdf" | "docx" | "txt" | "md" | "xlsx" | "xls";
export type ServiceInclusionMode = "fixed" | "selected";

export type ValueCategory =
  | "Høyere produktivitet"
  | "Lavere kostnader"
  | "Redusert risiko"
  | "Bedre brukeropplevelse";

export type RequirementImportance = "Kritisk" | "Viktig" | "Mindre viktig";
export type RequirementKind = "Eksplisitt" | "Implisitt";

export type GeneratedArtifactType =
  | "losningsutkast"
  | "bilag1_rekonstruksjon"
  | "forbedret_kravsvar"
  | "tilbudsstrategi"
  | "verdiargumentasjon"
  | "anbefalt_arkitektur"
  | "gjennomforing_og_risiko";

export type ProjectStatus =
  | "Venter på dokument"
  | "Dokument lastet opp"
  | "Kundeanalyse klar"
  | "Klar for sparring";

export interface ProjectSummary {
  id: string;
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
  created_at: string;
  updated_at: string;
  document_count: number;
  supporting_document_count: number;
  artifact_count: number;
  has_chat: boolean;
}

export interface ProjectSnapshotResult {
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

export interface ProjectDocument {
  id: string;
  project_id: string;
  role: ProjectDocumentRole;
  supporting_subtype: SupportingDocumentSubtype | null;
  title: string;
  file_name: string;
  file_format: DocumentFileFormat;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectDocumentStructureEntry {
  reference: string;
  text: string;
}

export interface ProjectDocumentDetail extends ProjectDocument {
  raw_text: string;
  file_base64: string;
  structure_map: ProjectDocumentStructureEntry[];
}

export interface ServiceDocument {
  id: string;
  service_id: string;
  title: string;
  file_name: string;
  file_format: DocumentFileFormat;
  content_type: string;
  file_size_bytes: number;
  page_count?: number | null;
  ai_summary?: string;
  ai_summary_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceDocumentDetail extends ServiceDocument {
  raw_text: string;
  file_base64: string;
  structure_map: ProjectDocumentStructureEntry[];
}

export interface ServiceDescription {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  inclusion_mode: ServiceInclusionMode;
  created_at: string;
  updated_at: string;
  documents: ServiceDocument[];
}

export interface ProjectServiceDescription extends ServiceDescription {
  selected: boolean;
  recommended: boolean;
  recommendation_score: number;
  recommendation_reason: string;
}

export interface AnalysisRequirement {
  title: string;
  description: string;
  category: string;
  importance: RequirementImportance;
  kind: RequirementKind;
  source_reference: string;
  source_excerpt: string;
}

export interface ValueOpportunity {
  title: string;
  description: string;
  value_categories: ValueCategory[];
  profit_share_percent: number;
}

export type CustomerAnalysisHistorySource =
  | "full_regeneration"
  | "section_regeneration"
  | "manual_edit"
  | "high_level_design_update";

export type CustomerAnalysisSection =
  | "summary"
  | "strategy"
  | "clarifications"
  | "design"
  | "risks"
  | "needs"
  | "keywords"
  | "value";

export interface CustomerAnalysisSectionSnapshotMap {
  summary: {
    customer_profile_summary: string;
    customer_goals_summary: string;
  };
  strategy: {
    executive_summary: string;
    positioning_recommendations: string[];
  };
  clarifications: {
    ambiguities: string[];
    expected_solution_direction: string[];
    likely_evaluation_criteria: string[];
  };
  design: {
    high_level_solution_design: string;
    high_level_architecture_mermaid: string;
  };
  risks: {
    risks: string[];
    risks_for_us?: string[];
    risks_for_customer?: string[];
  };
  needs: {
    implicit_requirements: AnalysisRequirement[];
    prioritized_requirements: Array<{
      requirement: string;
      priority: RequirementImportance;
      reason: string;
    }>;
  };
  keywords: {
    signal_words: string[];
    signal_word_counts?: Record<string, number>;
  };
  value: {
    value_opportunities: ValueOpportunity[];
  };
}

export interface CustomerAnalysisSectionHistoryEntry {
  id: string;
  created_at: string;
  source: CustomerAnalysisHistorySource;
  snapshot: CustomerAnalysisSectionSnapshotMap[CustomerAnalysisSection];
}

export type CustomerAnalysisSectionHistories = Partial<
  Record<CustomerAnalysisSection, CustomerAnalysisSectionHistoryEntry[]>
>;

export interface CustomerAnalysisResult {
  customer_profile_summary: string;
  customer_goals_summary: string;
  high_level_solution_design: string;
  high_level_architecture_mermaid: string;
  customer_profile: string[];
  customer_goals: string[];
  implicit_requirements: AnalysisRequirement[];
  prioritized_requirements: Array<{
    requirement: string;
    priority: RequirementImportance;
    reason: string;
  }>;
  ambiguities: string[];
  risks: string[];
  risks_for_us?: string[];
  risks_for_customer?: string[];
  likely_evaluation_criteria: string[];
  signal_words: string[];
  signal_word_counts?: Record<string, number>;
  expected_solution_direction: string[];
  value_opportunities: ValueOpportunity[];
  positioning_recommendations: string[];
  executive_summary: string;
  section_histories?: CustomerAnalysisSectionHistories;
}

export interface SolutionEvaluationResult {
  customer_document_id?: string | null;
  solution_document_id?: string | null;
  fit_to_customer_needs: string;
  strengths: string[];
  weaknesses: string[];
  generic_sections: string[];
  missing_elements: string[];
  risks_to_customer: string[];
  trust_signals: string[];
  likely_score_assessment: {
    quality: string;
    delivery_confidence: string;
    risk: string;
    competitiveness: string;
  };
  improvement_recommendations: string[];
  value_assessment: ValueOpportunity[];
  rewrite_suggestions: Array<{
    target: string;
    suggestion: string;
  }>;
  architecture_comparison?: {
    winner: "Systemløsning" | "Arkitektløsning" | "Uavgjort";
    architect_solution_score: number;
    system_solution_score: number;
    verdict: string;
    strong_critique: string[];
    pragmatic_reflections: string[];
    strategy_improvement_advice: string[];
  };
  executive_summary: string;
}

export interface ExecutiveSummaryResult {
  source_solution_evaluation_present: boolean;
  executive_summary: string;
  fit_to_customer_needs: string;
  likely_score_assessment: {
    quality: string;
    delivery_confidence: string;
    risk: string;
    competitiveness: string;
  };
  strengths: string[];
  weaknesses: string[];
}

export interface GeneratedArtifact {
  id: string;
  project_id: string;
  artifact_type: GeneratedArtifactType;
  title: string;
  content_markdown: string;
  input_snapshot: unknown;
  created_at: string;
}

export type ChatMessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  project_id: string;
  role: ChatMessageRole;
  content: string;
  context_snapshot: unknown;
  created_at: string;
}

export interface ProjectDetail extends ProjectSummary {
  documents: ProjectDocument[];
  customer_analysis: CustomerAnalysisResult | null;
  solution_evaluation: SolutionEvaluationResult | null;
  executive_summary: ExecutiveSummaryResult | null;
  generated_artifacts: GeneratedArtifact[];
  chat_messages: ChatMessage[];
}

export interface ProjectCreateInput {
  name?: string | null;
  customer_name?: string | null;
  description?: string | null;
  industry?: string | null;
  selected_service_ids?: string[];
}

export interface ProjectMetadataInference {
  name: string | null;
  customer_name: string | null;
  industry: string | null;
  description: string | null;
}

export interface ProjectDocumentCreateResponse {
  document: ProjectDocument;
}

export interface CustomerAnalysisResponse {
  analysis: CustomerAnalysisResult;
}

export interface SolutionEvaluationResponse {
  evaluation: SolutionEvaluationResult;
}

export interface GeneratedArtifactResponse {
  artifact: GeneratedArtifact;
}

export interface ChatRequestInput {
  message: string;
}

export type ProjectJobKind =
  | "customer_analysis"
  | "solution_evaluation"
  | "artifact_generation"
  | "high_level_design"
  | "perfect_system_solution"
  | "executive_summary";
export type ProjectJobStatus = "queued" | "running" | "completed" | "failed";

export interface ArtifactGenerationJobResult {
  artifact: GeneratedArtifact;
  project: ProjectSnapshotResult;
}

export interface SolutionEvaluationJobResult {
  evaluation: SolutionEvaluationResult;
  project: ProjectSnapshotResult;
  artifact: GeneratedArtifact | null;
  used_generated_solution: boolean;
}

export interface HighLevelDesignJobResult {
  analysis: CustomerAnalysisResult;
  project: ProjectSnapshotResult;
}

export interface CustomerAnalysisJobResult {
  analysis: CustomerAnalysisResult;
  project: ProjectSnapshotResult;
}

export interface ExecutiveSummaryJobResult {
  executive_summary: ExecutiveSummaryResult;
  project: ProjectSnapshotResult;
}

export type ProjectJobResult =
  | ArtifactGenerationJobResult
  | SolutionEvaluationJobResult
  | HighLevelDesignJobResult
  | CustomerAnalysisJobResult
  | ExecutiveSummaryJobResult
  | Record<string, unknown>;

export interface ProjectJobRecord {
  id: string;
  project_id: string;
  kind: ProjectJobKind;
  status: ProjectJobStatus;
  message: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  result: ProjectJobResult | null;
}
