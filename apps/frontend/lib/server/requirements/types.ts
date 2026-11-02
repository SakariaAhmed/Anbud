export type RequirementLedgerEntry = {
  id: string;
  /** Observed in the source, bounded inference, or a local review identifier. */
  idOrigin?: "source" | "inferred" | "generated";
  originalId?: string;
  text: string;
  /** Wording provenance is separate from whether the requirement ID was observed. */
  textOrigin?: "observed" | "reconstructed" | "unknown";
  textEvidence?: { originalText: string; start: number; end: number };
  pages: number[];
  heading: string;
  documentOrder?: number;
  documentEntryOrder?: number;
  sourceDocumentEntryOrder?: number;
  documentId?: string;
  documentTitle?: string;
  tableId?: string;
  service?: string;
  sourceExcerpt?: string;
  /** Logical ownership stays in documentId; added wording is sourced here. */
  correctionSource?: {
    documentId: string;
    documentTitle: string;
    pages: number[];
    excerpt: string;
    heading?: string;
  };
  answerExcerpt?: string;
  answerEvidenceExcerpt?: string;
  answerDocumentId?: string;
  answerDocumentTitle?: string;
  answerReference?: string;
};
