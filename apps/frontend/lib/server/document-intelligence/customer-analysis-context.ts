import { DOCUMENT_INTELLIGENCE_COMPILER_VERSION } from "@/lib/server/document-intelligence/types";

const PRIMARY_NATIVE_SOURCE_CEILING = 18_000;
const SUPPORTING_NATIVE_SOURCE_CEILING = 8_000;

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

/**
 * Keeps source-rich local context for documents that fit comfortably in the
 * existing customer-analysis prompt. Compiled evidence is reserved for source
 * sizes where compression is necessary and materially reduces prompt size.
 */
export function shouldUseCompiledCustomerAnalysisContext(input: {
  rawTextLength: number;
  analysisContextLength: number;
  isPrimaryDocument: boolean;
}) {
  const rawBudget = input.isPrimaryDocument ? 12_000 : 4_000;
  const evidenceBudget = input.isPrimaryDocument ? 8_000 : 3_000;
  const nativeSourceCeiling = input.isPrimaryDocument
    ? PRIMARY_NATIVE_SOURCE_CEILING
    : SUPPORTING_NATIVE_SOURCE_CEILING;

  if (input.rawTextLength <= nativeSourceCeiling) return false;

  const legacyContextChars = Math.min(rawBudget, input.rawTextLength);
  const compiledContextChars = Math.min(
    evidenceBudget,
    input.analysisContextLength,
  );
  return (
    compiledContextChars + 800 <= Math.max(1_600, legacyContextChars * 0.95)
  );
}
