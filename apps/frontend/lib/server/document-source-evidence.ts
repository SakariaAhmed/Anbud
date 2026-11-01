import "server-only";
import { createHash } from "node:crypto";
import { SourceQuoteIndex, evidenceIdentity } from "@/lib/server/source-evidence";
import { findPdfPageMarkers } from "@/lib/server/requirements/pdf-normalization";
import type { ChatSourceReference, ProjectDocumentDetail, ServiceDocumentDetail } from "@/lib/types";

/** Resolve quotation membership and locators from the current source itself.
 * Requested page/heading values never become evidence. Repeated passages have
 * no precise locator unless the source structure identifies one unique place. */
export function bindDocumentSourceEvidence(document: ProjectDocumentDetail | ServiceDocumentDetail, quote: string, options: { sourceType?: "project_document" | "service_document" } = {}): ChatSourceReference | null {
  const original = new SourceQuoteIndex(document.raw_text).find(quote);
  if (!original) return null;
  const at = document.raw_text.indexOf(original);
  const repeated = document.raw_text.indexOf(original, at + original.length) >= 0;
  const sections = repeated ? [] : document.structure_map.filter(section => section.text.includes(original));
  const section = sections.length === 1 ? sections[0] : undefined;
  let page = !repeated && section?.page && Number.isSafeInteger(section.page) && section.page > 0 ? section.page : null;
  if (!page && !repeated) {
    const markers = findPdfPageMarkers(document.raw_text);
    const marker = markers.find((marker, index) => at >= marker.index + marker.marker.length && at + original.length <= (markers[index + 1]?.index ?? document.raw_text.length));
    if (marker && marker.startPage === marker.endPage) page = marker.startPage;
  }
  const reference = section?.reference || (page ? `Side ${page}` : "Verifisert utdrag · nøyaktig plassering ikke oppgitt");
  const fingerprint = createHash("sha256").update(document.raw_text).digest("hex");
  const sourceType = options.sourceType ?? "project_document";
  return { source_type: sourceType, source_id: document.id, document_title: document.title,
    source_revision: document.chunk_source_revision ?? 0, source_fingerprint: fingerprint,
    evidence_id: evidenceIdentity({ sourceType, sourceId: document.id, revision: document.chunk_source_revision ?? 0, fingerprint, reference, text: original }),
    original_quote: original, document_role: "role" in document ? document.role : undefined, heading_path: section?.heading_path ?? [], page_start: page, page_end: page, reference, classification: "documented" };
}
