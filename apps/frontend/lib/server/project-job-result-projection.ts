import "server-only";

import type { ProjectDocument, ProjectJobResult } from "@/lib/types";

// Job APIs require project.read, not document.download. Never carry hydrated
// document detail across this boundary, including results saved by older builds.
export function projectJobDocumentSummary(document: ProjectDocument): ProjectDocument {
  return {
    id: document.id,
    project_id: document.project_id,
    role: document.role,
    supporting_subtype: document.supporting_subtype,
    title: document.title,
    file_name: document.file_name,
    file_format: document.file_format,
    content_type: document.content_type,
    file_size_bytes: document.file_size_bytes,
    page_count: document.page_count,
    processing_status: document.processing_status,
    processing_message: document.processing_message,
    processing_error: document.processing_error,
    parser_used: document.parser_used,
    indexed_at: document.indexed_at,
    chunk_source_revision: document.chunk_source_revision,
    created_at: document.created_at,
    updated_at: document.updated_at,
  };
}

export function projectJobResultForRead(result: ProjectJobResult | null): ProjectJobResult | null {
  if (!result || typeof result !== "object" || !("document" in result)) return result;
  const document: unknown = result.document;
  return {
    ...result,
    document: document && typeof document === "object" && !Array.isArray(document)
      ? projectJobDocumentSummary(document as ProjectDocument)
      : null,
  };
}
