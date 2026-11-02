import { isRecord } from "@/lib/unknown-values";
import type { ChatSourceReference } from "@/lib/types";

/** The same boundary is used after database decryption and in legacy browser
 * snapshots, so save/reload cannot strip citation identities or quotations. */
export function parseChatSourceReferences(value: unknown): ChatSourceReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap(item => {
    if (item.source_type !== undefined && !["project_document", "service_document", "chat_attachment", "generated_artifact"].includes(String(item.source_type))) return [];
    const text = (key: string) => typeof item[key] === "string" ? item[key] as string : undefined;
    const integer = (key: string, minimum = 0) => Number.isSafeInteger(item[key]) && Number(item[key]) >= minimum ? Number(item[key]) : undefined;
    const reference: ChatSourceReference = {
      document_title: text("document_title") ?? "", reference: text("reference") ?? "",
      heading_path: Array.isArray(item.heading_path) ? item.heading_path.filter((part): part is string => typeof part === "string") : [],
      page_start: integer("page_start", 1) ?? null, page_end: integer("page_end", 1) ?? null,
      source_type: (item.source_type ?? "project_document") as ChatSourceReference["source_type"], source_id: text("source_id") ?? "",
      ...(text("evidence_id") ? { evidence_id: text("evidence_id") } : {}),
      ...(text("requirement_id") ? { requirement_id: text("requirement_id") } : {}),
      ...(item.chunk_id === null ? { chunk_id: null } : text("chunk_id") ? { chunk_id: text("chunk_id") } : {}),
      ...(integer("citation_number", 1) !== undefined ? { citation_number: integer("citation_number", 1) } : {}),
      ...(integer("source_revision") !== undefined ? { source_revision: integer("source_revision") } : {}),
      ...(text("source_fingerprint") ? { source_fingerprint: text("source_fingerprint") } : {}),
      ...(text("original_quote") ? { original_quote: text("original_quote") } : {}),
      ...(["documented", "interpretation", "needs_clarification"].includes(String(item.classification)) ? { classification: item.classification as ChatSourceReference["classification"] } : {}),
      ...(["primary_customer_document", "primary_solution_document", "supporting_document"].includes(String(item.document_role)) ? { document_role: item.document_role as ChatSourceReference["document_role"] } : {}),
      ...(Array.isArray(item.quotation_excerpts) ? { quotation_excerpts: item.quotation_excerpts.filter((part): part is string => typeof part === "string" && Boolean(part.trim())) } : {}),
    };
    if (reference.source_type === "generated_artifact") reference.classification = "interpretation";
    return reference.document_title || reference.reference ? [reference] : [];
  });
}
