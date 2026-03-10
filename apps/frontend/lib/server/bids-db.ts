import "server-only";

import { createServiceClient } from "@/lib/server/supabase";

export interface BidRow {
  id: string;
  tenant_id: string;
  customer_name: string;
  title: string;
  estimated_value: number | null;
  deadline: string;
  owner: string;
  custom_fields: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  timestamp: string;
  user_name: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface DocumentRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  file_name: string;
  content_type: string;
  raw_text: string;
  status: string;
  created_at: string;
}

export interface NoteRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  content: string;
  user_name: string;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  title: string;
  details: string;
  decided_at: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  title: string;
  details: string;
  due_date: string | null;
  status: "To Do" | "In Progress" | "Done";
  created_at: string;
  updated_at: string;
}

export interface RequirementRow {
  id: string;
  tenant_id: string;
  bid_id: string;
  title: string;
  detail: string;
  category: string;
  priority: "Low" | "Medium" | "High";
  status: "Open" | "In Progress" | "Covered";
  source_excerpt: string;
  source_document: string | null;
  completion_notes: string;
  created_at: string;
  updated_at: string;
}

export function mapBid(row: BidRow) {
  return {
    id: row.id,
    customer_name: row.customer_name,
    title: row.title,
    estimated_value: row.estimated_value,
    deadline: row.deadline,
    owner: row.owner,
    custom_fields: row.custom_fields ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function mapEvent(row: EventRow) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    user: row.user_name,
    type: row.type,
    payload: row.payload ?? {}
  };
}

export function mapDocument(row: DocumentRow) {
  return {
    id: row.id,
    file_name: row.file_name,
    content_type: row.content_type,
    status: row.status,
    preview_text: row.raw_text ? row.raw_text.slice(0, 320) : undefined,
    created_at: row.created_at
  };
}

export function mapNote(row: NoteRow) {
  return {
    id: row.id,
    content: row.content,
    user: row.user_name,
    created_at: row.created_at
  };
}

export function mapDecision(row: DecisionRow) {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    decided_at: row.decided_at,
    created_at: row.created_at
  };
}

export function mapTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    due_date: row.due_date,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function mapRequirement(row: RequirementRow) {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    category: row.category,
    priority: row.priority,
    status: row.status,
    source_excerpt: row.source_excerpt,
    source_document: row.source_document,
    completion_notes: row.completion_notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function getBidOrThrow(tenantId: string, bidId: string): Promise<BidRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bids")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", bidId)
    .maybeSingle<BidRow>();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Bid not found");
  }

  return data;
}

export async function touchBidActivity(tenantId: string, bidId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("bids")
    .update({ updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", bidId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function logBidEvent(input: {
  tenantId: string;
  bidId: string;
  actor: string;
  type: "bid_created" | "document_uploaded" | "chat_question" | "chat_answer";
  payload: Record<string, unknown>;
}): Promise<EventRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bid_events")
    .insert({
      tenant_id: input.tenantId,
      bid_id: input.bidId,
      user_name: input.actor,
      type: input.type,
      payload: input.payload
    })
    .select("*")
    .single<EventRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
