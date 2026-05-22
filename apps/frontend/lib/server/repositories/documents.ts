import "server-only";

export {
  deleteDocument,
  getDocumentDetail,
  getPrimaryDocument,
  listProjectDocumentSummaries,
  listProjectDocuments,
  listSupportingDocuments,
  markDocumentAsPrimarySolution,
  saveDocument,
} from "@/lib/server/repositories/supabase-store";
