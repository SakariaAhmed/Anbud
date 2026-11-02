import "server-only";
import { isRequirementDocument } from "@/lib/document-processing";
import type { ProjectDocumentDetail } from "@/lib/types";
import { assertProjectWorkflowActive } from "@/lib/server/project-workflow-cancellation";
import { rethrowAuthoritativeLeaseLoss } from "@/lib/server/repositories/lease-fenced-persistence";
import { safeErrorTelemetry } from "@/lib/server/safe-errors";
import { extractRequirementLedgerForDocument } from "@/lib/server/requirements/source-ledger";
import { SourceQuoteIndex } from "@/lib/server/source-evidence";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

export function annotateRequirementTextProvenance(rows: RequirementLedgerEntry[], rawText: string): RequirementLedgerEntry[] {
  const index = new SourceQuoteIndex(rawText);
  return rows.map(row => {
    const span = index.locate(row.text, { tokenBoundaries: true });
    return { ...row, textOrigin: span ? "observed" : "reconstructed",
      textEvidence: span ? { originalText: span.text, start: span.start, end: span.end } : undefined };
  });
}

/** A register accelerates later lookup. Failure must not discard the parsed
 * original or its index, and must not masquerade as a valid empty register. */
export async function buildIngestionRequirementRegister(document: ProjectDocumentDetail, options: { indexChunks?: boolean } = {}) {
  if (options.indexChunks === false || !isRequirementDocument(document)) return undefined;
  try { return annotateRequirementTextProvenance(await extractRequirementLedgerForDocument(document), document.raw_text); }
  catch (error) {
    rethrowAuthoritativeLeaseLoss(error);
    assertProjectWorkflowActive();
    if (error instanceof Error && error.name === "AbortError") throw error;
    console.warn(JSON.stringify({ event: "requirement_register_extraction_failed", document_id: document.id, ...safeErrorTelemetry(error) }));
    return undefined;
  }
}
