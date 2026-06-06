import "server-only";

export {
  deleteDocument,
  getDocumentDetail,
  getPrimaryDocument,
  listProjectDocumentSummaries,
  listProjectDocuments,
  listProjectDocumentsForAnalysis,
  listSupportingDocuments,
  markDocumentAsPrimarySolution,
  saveDocument,
} from "@/lib/server/repositories/supabase-store";
