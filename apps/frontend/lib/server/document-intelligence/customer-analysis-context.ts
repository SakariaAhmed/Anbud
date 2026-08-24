import { DOCUMENT_INTELLIGENCE_COMPILER_VERSION } from "@/lib/server/document-intelligence/types";

export function isCurrentDocumentIntelligenceContext(input: {
  sourceRevision: number;
  documentSourceRevision: number;
  compilerVersion: string;
}) {
  return (
    input.sourceRevision === input.documentSourceRevision &&
    input.compilerVersion === DOCUMENT_INTELLIGENCE_COMPILER_VERSION
  );
}
