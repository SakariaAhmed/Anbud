export type RequirementLedgerEntry = {
  id: string;
  text: string;
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
  };
  answerExcerpt?: string;
  answerEvidenceExcerpt?: string;
  answerDocumentId?: string;
  answerDocumentTitle?: string;
  answerReference?: string;
};
