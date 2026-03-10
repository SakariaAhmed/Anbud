export interface Bid {
  id: string;
  customer_name: string;
  title: string;
  estimated_value: number | string | null;
  deadline: string;
  owner: string;
  custom_fields: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface BidDocument {
  id: string;
  file_name: string;
  content_type: string;
  status: string;
  preview_text?: string;
  created_at: string;
}

export interface BidNote {
  id: string;
  content: string;
  user: string;
  created_at: string;
}

export type RequirementStatus = "Open" | "In Progress" | "Covered";

export interface BidRequirement {
  id: string;
  title: string;
  detail: string;
  category: string;
  priority: "Low" | "Medium" | "High";
  status: RequirementStatus;
  source_excerpt: string;
  source_document: string | null;
  completion_notes: string;
  created_at: string;
  updated_at: string;
}

export type BidEventType = "bid_created" | "document_uploaded" | "chat_question" | "chat_answer";

export interface BidEvent {
  id: string;
  timestamp: string;
  user: string;
  type: BidEventType;
  payload: Record<string, unknown>;
}

export interface ChatCitation {
  document_name: string | null;
  excerpt: string;
}

export interface BidChatResponse {
  answer: string;
  confidence: "Low" | "Medium" | "High";
  citations: ChatCitation[];
  question_event?: BidEvent;
  answer_event?: BidEvent;
}

export interface BidDecision {
  id: string;
  title: string;
  details: string;
  decided_at: string;
  created_at: string;
}

export type TaskStatus = "To Do" | "In Progress" | "Done";

export interface BidTask {
  id: string;
  title: string;
  details: string;
  due_date: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface BidBootstrapResponse {
  bid: Bid;
  documents: BidDocument[];
  events: BidEvent[];
  notes: BidNote[];
  requirements: BidRequirement[];
  decisions: BidDecision[];
  tasks: BidTask[];
}

export interface BidDocumentCreateResponse {
  document: BidDocument;
  event?: BidEvent;
}

export interface GenerateRequirementsResponse {
  requirements: BidRequirement[];
}

export interface BidIntakeSuggestion {
  customer_name: string;
  title: string;
  estimated_value: string | number | null;
  deadline: string | null;
  owner: string;
  custom_fields: Record<string, string>;
}

// Legacy tender types kept during transition.
export type Phase =
  | "Intake"
  | "Discovery"
  | "Q&A"
  | "Solutioning"
  | "Pricing"
  | "Internal Review"
  | "Submit"
  | "Negotiation"
  | "Awarded"
  | "Lost";

export interface DashboardRow {
  tender_id: string;
  customer: string;
  title: string;
  phase: Phase | null;
  deadline: string;
  blockers: number;
  next_action: string;
  risk_score: string;
  overdue: boolean;
  negotiation_highlight: boolean;
}

export interface DashboardResponse {
  items: DashboardRow[];
}

export interface TenderIntakeSuggestion {
  customer_name: string;
  title: string;
  estimated_value: string | number | null;
  deadline: string | null;
  owner: string;
  custom_fields: Record<string, string>;
}

export interface TenderChatResponse {
  answer: string;
  confidence: string;
  citations: string[];
}
