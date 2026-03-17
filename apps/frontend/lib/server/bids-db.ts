import "server-only";

import { unstable_cache } from "next/cache";

import { createServiceClient } from "@/lib/server/supabase";
import {
  BidComplianceRow,
  BidCustomerAnalysis,
  BidDetail,
  BidDocument,
  BidRequirement,
  BidSummaryCounts,
  BidSummary,
  ComplianceStatus,
  DocumentRole,
  RequirementType,
} from "@/lib/types";

const DEFAULT_TENANT_ID = "default";
const REVALIDATE_SECONDS = 30;
const BID_BASE_SELECT = "id, tenant_id, customer_name, title, created_at, updated_at";
const DOCUMENT_LIST_SELECT = "id, tenant_id, bid_id, document_role, file_name, content_type, file_format, created_at";
const STORED_DOCUMENT_SELECT =
  "id, tenant_id, bid_id, document_role, file_name, content_type, file_format, file_base64, raw_text, source_map, created_at";
const REQUIREMENT_SELECT =
  "id, tenant_id, bid_id, code, category, requirement_type, scope_summary, source_reference, source_excerpt, sort_order, created_at, updated_at";
const COMPLIANCE_SELECT =
  "id, tenant_id, bid_id, requirement_id, status, found_in, answer_excerpt, notes, created_at, updated_at";
const CUSTOMER_ANALYSIS_SELECT =
  "bid_id, tenant_id, customer_priorities, clarifications, value_angles, generated_at";

type BidRow = {
  id: string;
  tenant_id: string;
  customer_name: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type DocumentRow = {
  id: string;
  tenant_id: string;
  bid_id: string;
  document_role: DocumentRole;
  file_name: string;
  content_type: string;
  file_format: string;
  file_base64?: string;
  raw_text?: string;
  source_map?: unknown;
  created_at: string;
};

type RequirementRow = {
  id: string;
  tenant_id: string;
  bid_id: string;
  code: string;
  category: string;
  requirement_type: RequirementType;
  scope_summary: string;
  source_reference: string;
  source_excerpt: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ComplianceRow = {
  id: string;
  tenant_id: string;
  bid_id: string;
  requirement_id: string;
  status: ComplianceStatus;
  found_in: string | null;
  answer_excerpt: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

type CustomerAnalysisRow = {
  bid_id: string;
  tenant_id: string;
  customer_priorities: string[] | null;
  clarifications: string[] | null;
  value_angles: string[] | null;
  generated_at: string;
};

type DocumentStatusRow = {
  bid_id: string;
  document_role: "bilag1" | "bilag2";
};

type RequirementStatusRow = {
  bid_id: string;
  id: string;
};

type ComplianceStatusRow = {
  bid_id: string;
  status: "Besvart" | "Delvis besvart" | "Ikke besvart";
};

export interface StoredDocument extends BidDocument {
  raw_text: string;
  file_base64: string;
  source_map: unknown;
}

export function mapBidSummary(row: BidRow): BidSummary {
  return {
    id: row.id,
    customer_name: row.customer_name,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    bilag1_uploaded: false,
    bilag2_uploaded: false,
    analysis_generated: false,
    missing_requirements: 0,
    total_requirements: 0,
  };
}

export function mapDocument(row: DocumentRow): BidDocument {
  return {
    id: row.id,
    document_role: row.document_role,
    file_name: row.file_name,
    content_type: row.content_type,
    file_format: row.file_format,
    created_at: row.created_at,
  };
}

export function mapStoredDocument(row: DocumentRow): StoredDocument {
  return {
    ...mapDocument(row),
    raw_text: row.raw_text ?? "",
    file_base64: row.file_base64 ?? "",
    source_map: row.source_map ?? [],
  };
}

export function mapRequirement(row: RequirementRow): BidRequirement {
  return {
    id: row.id,
    code: row.code,
    category: row.category,
    requirement_type: row.requirement_type,
    scope_summary: row.scope_summary,
    source_reference: row.source_reference,
    source_excerpt: row.source_excerpt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mapCustomerAnalysis(row: CustomerAnalysisRow | null): BidCustomerAnalysis | null {
  if (!row) {
    return null;
  }

  return {
    customer_priorities: row.customer_priorities ?? [],
    clarifications: row.clarifications ?? [],
    value_angles: row.value_angles ?? [],
    generated_at: row.generated_at,
  };
}

export function buildSummaryFromCompliance(requirements: BidRequirement[], rows: BidComplianceRow[]): BidSummaryCounts {
  const summary: BidSummaryCounts = {
    total_requirements: requirements.length,
    besvart: 0,
    delvis_besvart: 0,
    ikke_besvart: 0,
  };

  for (const row of rows) {
    if (row.status === "Besvart") summary.besvart += 1;
    if (row.status === "Delvis besvart") summary.delvis_besvart += 1;
    if (row.status === "Ikke besvart") summary.ikke_besvart += 1;
  }

  if (!rows.length && requirements.length) {
    summary.ikke_besvart = requirements.length;
  }

  return summary;
}

export function joinComplianceRows(
  requirements: BidRequirement[],
  complianceRows: ComplianceRow[]
): BidComplianceRow[] {
  const byRequirementId = new Map(complianceRows.map((row) => [row.requirement_id, row]));

  return requirements.map((requirement) => {
    const match = byRequirementId.get(requirement.id);
    return {
      requirement_id: requirement.id,
      requirement_code: requirement.code,
      requirement_summary: requirement.scope_summary,
      category: requirement.category,
      requirement_type: requirement.requirement_type,
      status: match?.status ?? "Ikke besvart",
      found_in: match?.found_in ?? null,
      source_reference: requirement.source_reference,
      source_excerpt: requirement.source_excerpt,
      answer_excerpt: match?.answer_excerpt ?? "",
      notes: match?.notes ?? "",
    };
  });
}

export async function getBidOrThrow(tenantId: string, bidId: string): Promise<BidRow> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bids")
    .select(BID_BASE_SELECT)
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

export async function getBidDocuments(tenantId: string, bidId: string): Promise<StoredDocument[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bid_documents")
    .select(STORED_DOCUMENT_SELECT)
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => mapStoredDocument(row as DocumentRow));
}

export async function getLatestDocumentByRole(
  tenantId: string,
  bidId: string,
  documentRole: DocumentRole
): Promise<StoredDocument | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bid_documents")
    .select(STORED_DOCUMENT_SELECT)
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId)
    .eq("document_role", documentRole)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? mapStoredDocument(data as DocumentRow) : null;
}

export async function getBidAnalysisData(tenantId: string, bidId: string): Promise<BidDetail> {
  const supabase = createServiceClient();
  const bid = await getBidOrThrow(tenantId, bidId);

  const [documentsResult, requirementsResult, analysisResult, complianceResult] = await Promise.all([
    supabase
      .from("bid_documents")
      .select(DOCUMENT_LIST_SELECT)
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .order("created_at", { ascending: false }),
    supabase
      .from("bid_requirements")
      .select(REQUIREMENT_SELECT)
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("bid_customer_analysis")
      .select(CUSTOMER_ANALYSIS_SELECT)
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .maybeSingle(),
    supabase
      .from("bid_compliance_results")
      .select(COMPLIANCE_SELECT)
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .order("updated_at", { ascending: true }),
  ]);

  if (documentsResult.error) throw new Error(documentsResult.error.message);
  if (requirementsResult.error) throw new Error(requirementsResult.error.message);
  if (analysisResult.error) throw new Error(analysisResult.error.message);
  if (complianceResult.error) throw new Error(complianceResult.error.message);

  const requirements = (requirementsResult.data ?? []).map((row) => mapRequirement(row as RequirementRow));
  const compliance = joinComplianceRows(requirements, (complianceResult.data ?? []) as ComplianceRow[]);

  return {
    id: bid.id,
    customer_name: bid.customer_name,
    title: bid.title,
    created_at: bid.created_at,
    updated_at: bid.updated_at,
    documents: (documentsResult.data ?? []).map((row) => mapDocument(row as DocumentRow)),
    requirements,
    customer_analysis: mapCustomerAnalysis((analysisResult.data as CustomerAnalysisRow | null) ?? null),
    compliance_matrix: compliance,
    summary: buildSummaryFromCompliance(requirements, compliance),
  };
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

export async function replaceBidAnalysis(
  tenantId: string,
  bidId: string,
  requirements: Array<Omit<BidRequirement, "id" | "created_at" | "updated_at">>,
  customerAnalysis: BidCustomerAnalysis,
  complianceMatrix: Array<{
    requirement_code: string;
    status: ComplianceStatus;
    found_in: string | null;
    answer_excerpt: string;
    notes: string;
  }>
): Promise<BidDetail> {
  const supabase = createServiceClient();

  const deleteRequirements = supabase
    .from("bid_requirements")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId);
  const deleteCompliance = supabase
    .from("bid_compliance_results")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId);

  const [{ error: requirementDeleteError }, { error: complianceDeleteError }] = await Promise.all([
    deleteRequirements,
    deleteCompliance,
  ]);

  if (requirementDeleteError) throw new Error(requirementDeleteError.message);
  if (complianceDeleteError) throw new Error(complianceDeleteError.message);

  const now = new Date().toISOString();
  const requirementRows = requirements.map((requirement, index) => ({
    tenant_id: tenantId,
    bid_id: bidId,
    title: requirement.scope_summary,
    detail: requirement.scope_summary,
    code: requirement.code,
    category: requirement.category,
    priority: requirement.requirement_type === "Bør" ? "Low" : "High",
    status: "Open",
    requirement_type: requirement.requirement_type,
    scope_summary: requirement.scope_summary,
    source_reference: requirement.source_reference,
    source_excerpt: requirement.source_excerpt,
    source_document: requirement.source_reference || null,
    completion_notes: "",
    sort_order: index,
    updated_at: now,
  }));

  const { data: insertedRequirements, error: insertRequirementsError } = await supabase
    .from("bid_requirements")
    .insert(requirementRows)
    .select("id, code");

  if (insertRequirementsError) throw new Error(insertRequirementsError.message);

  const requirementIdByCode = new Map(
    (insertedRequirements ?? []).map((row) => [String((row as RequirementRow).code), String((row as RequirementRow).id)])
  );

  const complianceRows = complianceMatrix
    .map((row) => {
      const requirementId = requirementIdByCode.get(row.requirement_code);
      if (!requirementId) {
        return null;
      }

      return {
        tenant_id: tenantId,
        bid_id: bidId,
        requirement_id: requirementId,
        status: row.status,
        found_in: row.found_in,
        answer_excerpt: row.answer_excerpt,
        notes: row.notes,
        updated_at: now,
      };
    })
    .filter(Boolean);

  if (complianceRows.length) {
    const { error } = await supabase.from("bid_compliance_results").insert(complianceRows);
    if (error) throw new Error(error.message);
  }

  const { error: analysisError } = await supabase
    .from("bid_customer_analysis")
    .upsert({
      bid_id: bidId,
      tenant_id: tenantId,
      customer_priorities: customerAnalysis.customer_priorities,
      clarifications: customerAnalysis.clarifications,
      value_angles: customerAnalysis.value_angles,
      generated_at: customerAnalysis.generated_at,
    });

  if (analysisError) throw new Error(analysisError.message);

  await touchBidActivity(tenantId, bidId);

  return getBidAnalysisData(tenantId, bidId);
}

export async function createManualRequirement(
  tenantId: string,
  bidId: string,
  input: {
    code: string;
    category: string;
    requirement_type: RequirementType;
    scope_summary: string;
    source_reference: string;
    source_excerpt?: string;
  }
): Promise<BidDetail> {
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  await getBidOrThrow(tenantId, bidId);

  const { data: latestRequirement, error: latestRequirementError } = await supabase
    .from("bid_requirements")
    .select("sort_order")
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle<{ sort_order: number }>();

  if (latestRequirementError) {
    throw new Error(latestRequirementError.message);
  }

  const sortOrder = (latestRequirement?.sort_order ?? -1) + 1;

  const { error: insertError } = await supabase.from("bid_requirements").insert({
    tenant_id: tenantId,
    bid_id: bidId,
    title: input.scope_summary,
    detail: input.scope_summary,
    code: input.code,
    category: input.category,
    priority: input.requirement_type === "Bør" ? "Low" : "High",
    status: "Open",
    requirement_type: input.requirement_type,
    scope_summary: input.scope_summary,
    source_reference: input.source_reference,
    source_excerpt: input.source_excerpt ?? "",
    source_document: input.source_reference,
    completion_notes: "",
    sort_order: sortOrder,
    updated_at: now,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }

  await touchBidActivity(tenantId, bidId);
  return getBidAnalysisData(tenantId, bidId);
}

export async function deleteRequirement(
  tenantId: string,
  bidId: string,
  requirementId: string
): Promise<BidDetail> {
  const supabase = createServiceClient();

  await getBidOrThrow(tenantId, bidId);

  const { data: requirement, error: requirementError } = await supabase
    .from("bid_requirements")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("bid_id", bidId)
    .eq("id", requirementId)
    .maybeSingle<{ id: string }>();

  if (requirementError) {
    throw new Error(requirementError.message);
  }

  if (!requirement) {
    throw new Error("Requirement not found");
  }

  const [{ error: complianceDeleteError }, { error: requirementDeleteError }] = await Promise.all([
    supabase
      .from("bid_compliance_results")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .eq("requirement_id", requirementId),
    supabase
      .from("bid_requirements")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("bid_id", bidId)
      .eq("id", requirementId),
  ]);

  if (complianceDeleteError) {
    throw new Error(complianceDeleteError.message);
  }

  if (requirementDeleteError) {
    throw new Error(requirementDeleteError.message);
  }

  await touchBidActivity(tenantId, bidId);
  return getBidAnalysisData(tenantId, bidId);
}

async function fetchBidSummaries(tenantId: string): Promise<BidSummary[]> {
  const supabase = createServiceClient();

  const { data: bids, error: bidsError } = await supabase
    .from("bids")
    .select(BID_BASE_SELECT)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });

  if (bidsError) {
    throw new Error(bidsError.message);
  }

  const baseRows = (bids ?? []).map((row) => mapBidSummary(row as BidRow));
  if (!baseRows.length) {
    return [];
  }

  const bidIds = baseRows.map((row) => row.id);

  const [documentsResult, requirementsResult, complianceResult] = await Promise.all([
    supabase.from("bid_documents").select("bid_id, document_role").eq("tenant_id", tenantId).in("bid_id", bidIds),
    supabase.from("bid_requirements").select("bid_id, id").eq("tenant_id", tenantId).in("bid_id", bidIds),
    supabase.from("bid_compliance_results").select("bid_id, status").eq("tenant_id", tenantId).in("bid_id", bidIds),
  ]);

  if (documentsResult.error) throw new Error(documentsResult.error.message);
  if (requirementsResult.error) throw new Error(requirementsResult.error.message);
  if (complianceResult.error) throw new Error(complianceResult.error.message);

  const documentFlagsByBid = new Map<string, { bilag1: boolean; bilag2: boolean }>();
  const requirementCountByBid = new Map<string, number>();
  const missingCountByBid = new Map<string, number>();

  for (const document of documentsResult.data ?? []) {
    const row = document as DocumentStatusRow;
    const flags = documentFlagsByBid.get(row.bid_id) ?? { bilag1: false, bilag2: false };
    if (row.document_role === "bilag1") flags.bilag1 = true;
    if (row.document_role === "bilag2") flags.bilag2 = true;
    documentFlagsByBid.set(row.bid_id, flags);
  }

  for (const requirement of requirementsResult.data ?? []) {
    const row = requirement as RequirementStatusRow;
    requirementCountByBid.set(row.bid_id, (requirementCountByBid.get(row.bid_id) ?? 0) + 1);
  }

  for (const compliance of complianceResult.data ?? []) {
    const row = compliance as ComplianceStatusRow;
    if (row.status === "Ikke besvart") {
      missingCountByBid.set(row.bid_id, (missingCountByBid.get(row.bid_id) ?? 0) + 1);
    }
  }

  return baseRows.map((row) => {
    const documentFlags = documentFlagsByBid.get(row.id) ?? { bilag1: false, bilag2: false };
    const requirementCount = requirementCountByBid.get(row.id) ?? 0;

    return {
      ...row,
      bilag1_uploaded: documentFlags.bilag1,
      bilag2_uploaded: documentFlags.bilag2,
      analysis_generated: requirementCount > 0,
      missing_requirements: missingCountByBid.get(row.id) ?? 0,
      total_requirements: requirementCount,
    };
  });
}

export async function getBidsForPage(): Promise<BidSummary[]> {
  const cached = unstable_cache(async () => fetchBidSummaries(DEFAULT_TENANT_ID), ["analysis-bids"], {
    revalidate: REVALIDATE_SECONDS,
    tags: ["bids"],
  });

  return cached();
}

export async function getBidForPage(bidId: string): Promise<BidDetail> {
  const cached = unstable_cache(async () => getBidAnalysisData(DEFAULT_TENANT_ID, bidId), [`analysis-bid:${bidId}`], {
    revalidate: REVALIDATE_SECONDS,
    tags: ["bids", `bid:${bidId}`],
  });

  return cached();
}
