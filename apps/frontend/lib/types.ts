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
  | "tidligere_losning"
  | "annet";

export type DocumentFileFormat = "pdf" | "docx" | "txt" | "md" | "xlsx" | "xls";
export type ServiceInclusionMode = "fixed" | "selected";
export type DocumentProcessingStatus =
  | "queued"
  | "processing"
  | "basic_ready"
  | "enhanced_ready"
  | "failed";

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

export interface GeneratedArtifactAuthority {
  id: string;
  artifact_version: number;
  source_is_current: boolean;
}

export type GeneratedArtifactAuthorityByType = Partial<
  Record<GeneratedArtifactType, GeneratedArtifactAuthority>
>;

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
  artifact_counts_by_type?: Partial<Record<GeneratedArtifactType, number>>;
  /**
   * Artifact types whose latest saved version still matches every authoritative
   * source revision. Unlike artifact_counts_by_type, this never counts history
   * or stale versions as generated workflow output.
   */
  current_artifact_types?: GeneratedArtifactType[];
  artifact_authority?: GeneratedArtifactAuthorityByType;
  has_executive_summary?: boolean;
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
  current_artifact_types?: GeneratedArtifactType[];
  artifact_authority?: GeneratedArtifactAuthorityByType;
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
  processing_status: DocumentProcessingStatus;
  processing_message?: string | null;
  processing_error?: string | null;
  parser_used?: string | null;
  indexed_at?: string | null;
  chunk_source_revision: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectDocumentStructureEntry {
  reference: string;
  text: string;
  kind?:
    | "text"
    | "table"
    | "docling_text"
    | "docling_table_row"
    | "docling_markdown";
  parser?: string;
  page?: number | null;
  table_index?: number;
  row_index?: number;
  columns?: string[];
  cells?: Record<string, string>;
  docling_ref?: string;
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
  chunk_source_revision: number;
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

export interface RecommendedService {
  service_id?: string | null;
  service_name: string;
  usefulness_percent: number;
  customer_need: string;
  recommendation_reason: string;
  evidence: string;
  risk_or_caveat: string;
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
  | "services"
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
  services: {
    recommended_services: RecommendedService[];
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
  recommended_services: RecommendedService[];
  value_opportunities: ValueOpportunity[];
  positioning_recommendations: string[];
  executive_summary: string;
  section_histories?: CustomerAnalysisSectionHistories;
}

export interface SolutionEvaluationResult {
  customer_document_id?: string | null;
  solution_document_id?: string | null;
  evaluated_generated_artifact_id?: string | null;
  evaluation_provenance_mode?:
    | "document_only"
    | "generated_artifact"
    | "legacy_unknown";
  evaluation_context?: {
    customer_document_id: string;
    customer_document_title: string;
    solution_document_id: string;
    solution_document_title: string;
    system_solution_artifact_id?: string | null;
    system_solution_artifact_title?: string | null;
    system_solution_artifact_created_at?: string | null;
    requirement_source_document_ids?: string[];
    requirement_source_manifest_sha256?: string | null;
    source_revision?: number | null;
    generated_at: string;
  };
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
  document_findings: Array<{
    reference: string;
    reference_match?: "coverage" | "section" | "unmatched";
    matched_requirement_reference?: string | null;
    evidence_grounding?: "coverage_exact" | "document_exact";
    assessment: "Godt" | "Dårlig" | "Mangler" | "Uklart";
    finding: string;
    evidence: string;
    recommendation: string;
  }>;
  requirement_coverage?: {
    total_requirements: number;
    assessed_requirements: number;
    good: number;
    weak: number;
    missing: number;
    unclear: number;
    confidence: "Høy" | "Middels" | "Lav";
    coverage_summary: string;
    ledger_confidence?: {
      level: "high" | "medium" | "low";
      score: number;
      requirement_count: number;
      source_locator_coverage: number;
      structured_entry_ratio: number;
      explicit_reference_ratio: number;
      generated_reference_count: number;
      extraction_methods: string[];
      reasons: string[];
    };
    items: Array<{
      order_index?: number;
      reference: string;
      full_reference?: string;
      source_reference: string;
      source_document_id?: string | null;
      source_document_title?: string | null;
      answer_document_id?: string | null;
      answer_document_title?: string | null;
      requirement_subtitle?: string | null;
      heading_path?: string[];
      page_range?: string | null;
      table_id?: string | null;
      requirement: string;
      assessment: "Godt" | "Dårlig" | "Mangler" | "Uklart";
      rationale: string;
      evidence: string;
      recommendation: string;
    }>;
  };
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
  updated_at?: string;
  artifact_version?: number;
  generation_job_id?: string | null;
  generation_submission_sequence?: number | null;
  input_artifact_source_revision?: number | null;
  input_service_library_revision?: number | null;
  used_solution_evaluation?: boolean;
  input_solution_evaluation_id?: string | null;
  input_solution_evaluation_updated_at?: string | null;
  input_solution_evaluation_hash?: string | null;
  generator_revision?: string | null;
  origin?: "generated" | "manual_edit" | "legacy";
  parent_artifact_id?: string | null;
  source_snapshot_hash?: string | null;
  is_current?: boolean;
  source_is_current?: boolean;
}

export type ChatMessageRole = "user" | "assistant";

export type ChatDomainHint =
  | "Kunde og behov"
  | "Krav og etterlevelse"
  | "Risiko"
  | "Verdi og gevinst"
  | "Arkitektur og løsning"
  | "Tilbudsstrategi og posisjonering"
  | "Leveranse og drift"
  | "Kontrakt og kommersielt"
  | "Dokument og kildegrunnlag";

export interface ChatSourceReference {
  document_title: string;
  reference: string;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  source_type: "project_document" | "service_document";
  source_id: string;
}

export interface ChatMessage {
  id: string;
  project_id: string;
  session_id?: string | null;
  role: ChatMessageRole;
  content: string;
  context_snapshot: unknown;
  source_references?: ChatSourceReference[];
  domain_hints?: ChatDomainHint[];
  created_at: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  summary: string;
  domain_hints: ChatDomainHint[];
  pinned: boolean;
  status: "active" | "archived";
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message_preview: string;
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

export type ProjectJobKind =
  | "document_ingestion"
  | "document_docling_enhancement"
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
  artifact: null;
  used_generated_solution: false;
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

export interface DocumentIngestionJobResult {
  document: ProjectDocument;
  document_id: string;
  status: DocumentProcessingStatus;
  parser_used: string | null;
  project: ProjectSnapshotResult;
  docling_enhancement_requested?: boolean;
  docling_enhancement_job_id?: string;
}

export type ProjectJobResult =
  | DocumentIngestionJobResult
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
