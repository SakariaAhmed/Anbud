import type { ProjectDocumentRole } from "@/lib/types";

// Exported budget constants form part of the analysis test contract.
// fallow-ignore-next-line unused-export
export const DEFAULT_COMPILED_CONTEXT_CHARS = 18_000;
// fallow-ignore-next-line unused-export
export const MAX_COMPILED_CONTEXT_CHARS = 40_000;
// fallow-ignore-next-line unused-export
export const PRIMARY_PROMPT_CONTEXT_CHARS = 18_000;
// fallow-ignore-next-line unused-export
export const SUPPORTING_PROMPT_CONTEXT_TOTAL_CHARS = 16_000;
// fallow-ignore-next-line unused-export
export const MAX_SUPPORTING_PROMPT_CONTEXT_CHARS = 4_000;
export const CANONICAL_CONTEXT_RATIO = 0.72;

export function compiledAnalysisContextLimit() {
  const configured = Number(
    process.env.DOCUMENT_ANALYSIS_CONTEXT_CHARS ??
      process.env.DOCUMENT_INTELLIGENCE_CONTEXT_CHARS,
  );
  return Number.isFinite(configured) && configured >= 4_000
    ? Math.min(MAX_COMPILED_CONTEXT_CHARS, Math.floor(configured))
    : DEFAULT_COMPILED_CONTEXT_CHARS;
}

// Exported for context-budget boundary tests.
// fallow-ignore-next-line unused-export
export function supportingPromptContextLimit(supportingDocumentCount: number) {
  const count =
    Number.isFinite(supportingDocumentCount) && supportingDocumentCount > 0
      ? Math.floor(supportingDocumentCount)
      : 1;
  return Math.min(
    MAX_SUPPORTING_PROMPT_CONTEXT_CHARS,
    Math.floor(SUPPORTING_PROMPT_CONTEXT_TOTAL_CHARS / count),
  );
}

export function customerAnalysisPromptContextLimit(input: {
  role: ProjectDocumentRole;
  supportingDocumentCount: number;
}) {
  return input.role === "primary_customer_document"
    ? PRIMARY_PROMPT_CONTEXT_CHARS
    : supportingPromptContextLimit(input.supportingDocumentCount);
}

export function boundedContext(
  value: string,
  limit: number,
  marker = "[avkortet]",
) {
  const content = value.trim();
  if (content.length <= limit) return content;
  const reserved = marker.length + 2;
  return `${content.slice(0, Math.max(0, limit - reserved)).trimEnd()}\n${marker}`;
}
