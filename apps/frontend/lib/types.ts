export type DocumentRole = "bilag1" | "bilag2";

export type RequirementType = "Må" | "Bør";

export type ComplianceStatus = "Besvart" | "Delvis besvart" | "Ikke besvart";

export interface BidSummary {
  id: string;
  customer_name: string;
  title: string;
  created_at: string;
  updated_at: string;
  bilag1_uploaded: boolean;
  bilag2_uploaded: boolean;
  analysis_generated: boolean;
  missing_requirements: number;
  total_requirements: number;
}

export interface BidDocument {
  id: string;
  document_role: DocumentRole;
  file_name: string;
  content_type: string;
  file_format: string;
  created_at: string;
}

export interface BidRequirement {
  id: string;
  code: string;
  category: string;
  requirement_type: RequirementType;
  scope_summary: string;
  source_reference: string;
  source_excerpt: string;
  created_at: string;
  updated_at: string;
}

export interface BidCustomerAnalysis {
  customer_priorities: string[];
  clarifications: string[];
  value_angles: string[];
  generated_at: string;
}

export interface BidComplianceRow {
  requirement_id: string;
  requirement_code: string;
  requirement_summary: string;
  category: string;
  requirement_type: RequirementType;
  status: ComplianceStatus;
  found_in: string | null;
  source_reference: string;
  source_excerpt: string;
  answer_excerpt: string;
  notes: string;
}

export interface BidSummaryCounts {
  total_requirements: number;
  besvart: number;
  delvis_besvart: number;
  ikke_besvart: number;
}

export interface BidDetail {
  id: string;
  customer_name: string;
  title: string;
  created_at: string;
  updated_at: string;
  documents: BidDocument[];
  requirements: BidRequirement[];
  customer_analysis: BidCustomerAnalysis | null;
  compliance_matrix: BidComplianceRow[];
  summary: BidSummaryCounts;
}

export interface BidCreateInput {
  customer_name: string;
  title?: string | null;
}

export interface BidDocumentCreateResponse {
  document: BidDocument;
}

export interface BidAnalysisResponse {
  requirements: BidRequirement[];
  customer_analysis: BidCustomerAnalysis;
  compliance_matrix: BidComplianceRow[];
  summary: BidSummaryCounts;
}
