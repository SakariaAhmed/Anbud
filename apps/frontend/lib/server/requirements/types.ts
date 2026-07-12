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
  answerExcerpt?: string;
  answerEvidenceExcerpt?: string;
  answerDocumentId?: string;
  answerDocumentTitle?: string;
  answerReference?: string;
};
