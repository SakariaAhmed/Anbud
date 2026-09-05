import "server-only";

import type { ReasoningEffort } from "@/lib/server/ai/json-completion";

const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_MODEL?.trim() || "gpt-5.4";
const DEFAULT_ANALYSIS_MODEL =
  process.env.OPENAI_ANALYSIS_MODEL?.trim() ||
  (/(?:mini|nano)$/i.test(DEFAULT_OPENAI_MODEL)
    ? "gpt-5.4"
    : DEFAULT_OPENAI_MODEL);
export const DOCUMENT_ANALYSIS_MODEL =
  process.env.OPENAI_DOCUMENT_ANALYSIS_MODEL?.trim() || "gpt-5.6-terra";
const WORKSPACE_MODEL_IDS = [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
  "gpt-5-mini",
] as const;

export const ANALYSIS_MODEL = DEFAULT_ANALYSIS_MODEL;
export const FAST_MODEL = "gpt-5.4-mini";
export const ANALYSIS_REASONING_EFFORT: ReasoningEffort = "medium";
export const EVALUATION_REASONING_EFFORT: ReasoningEffort = "medium";
export const FAST_REASONING_EFFORT: ReasoningEffort = "low";
export const GPT_MODELS_USE_DEFAULT_TEMPERATURE = /^gpt-5/i;

function normalizeModelId(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length > 120 || /[\s<>"'`]/.test(normalized)) {
    throw new Error("Ugyldig modellvalg.");
  }
  return normalized;
}

export async function resolveOpenAIModelOverride(
  value: string | null | undefined,
) {
  const modelId = normalizeModelId(value);
  if (!modelId) return undefined;

  if (/\bpro\b|5\.5/i.test(modelId)) {
    console.info(
      JSON.stringify({
        event: "openai_model_override_normalized",
        requested_model: modelId,
        selected_model: DEFAULT_OPENAI_MODEL,
        reason: "slow_or_expensive_model",
      }),
    );
    return DEFAULT_OPENAI_MODEL;
  }

  if (
    ![
      ...WORKSPACE_MODEL_IDS,
      DEFAULT_OPENAI_MODEL,
      ANALYSIS_MODEL,
      DOCUMENT_ANALYSIS_MODEL,
    ].includes(modelId as (typeof WORKSPACE_MODEL_IDS)[number])
  ) {
    throw new Error("Valgt modell er ikke tilgjengelig for denne API-nøkkelen.");
  }
  return modelId;
}
