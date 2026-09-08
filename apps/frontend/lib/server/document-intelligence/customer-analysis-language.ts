import { normalizeGeneratedNorwegianProse } from "@/lib/server/document-intelligence/norwegian-language";
import type { CustomerAnalysisResult } from "@/lib/types";

/**
 * Applies conservative Norwegian typography cleanup to generated analysis
 * prose. Verbatim evidence, canonical references, signal words and Mermaid
 * code are intentionally preserved.
 */
export function normalizeCustomerAnalysisNorwegianProse(
  result: CustomerAnalysisResult,
  options: { generatedFields?: readonly string[] } = {},
): CustomerAnalysisResult {
  const preservedFields = new Set(["source_excerpt", "source_reference", "high_level_architecture_mermaid", "signal_words", "signal_word_counts", "section_histories"]);
  const validateProse = (value: unknown): void => {
    // Role delimiters inside generated prose indicate a corrupt model result.
    // Never trim original quotations or validate unrelated stored sections.
    if (typeof value === "string") {
      if (/(?:[【】]|<\|[^|\n]{1,30}\|>)\s*assistant\s+(?:to\s*=|analysis\b)/iu.test(value)) {
        throw new Error("AI_OUTPUT_CORRUPT: Modellsvaret inneholder ugyldige kontrollmarkører.");
      }
    } else if (Array.isArray(value)) {
      value.forEach(validateProse);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (!preservedFields.has(key)) validateProse(item);
      }
    }
  };
  for (const [field, value] of Object.entries(result)) {
    if (!preservedFields.has(field) && (!options.generatedFields || options.generatedFields.includes(field))) validateProse(value);
  }
  const prose = (value: string) => normalizeGeneratedNorwegianProse(value);
  const proseList = (values: string[] | undefined) =>
    (values ?? []).map(prose).filter(Boolean);

  return {
    ...result,
    customer_profile_summary: prose(result.customer_profile_summary),
    customer_goals_summary: prose(result.customer_goals_summary),
    high_level_solution_design: prose(result.high_level_solution_design),
    customer_profile: proseList(result.customer_profile),
    customer_goals: proseList(result.customer_goals),
    implicit_requirements: result.implicit_requirements.map((item) => ({
      ...item,
      title: prose(item.title),
      description: prose(item.description),
      category: prose(item.category),
      source_reference: item.source_reference,
      source_excerpt: item.source_excerpt,
    })),
    prioritized_requirements: result.prioritized_requirements.map((item) => ({
      ...item,
      requirement: prose(item.requirement),
      reason: prose(item.reason),
    })),
    ambiguities: proseList(result.ambiguities),
    risks: proseList(result.risks),
    risks_for_us: proseList(result.risks_for_us),
    risks_for_customer: proseList(result.risks_for_customer),
    likely_evaluation_criteria: proseList(result.likely_evaluation_criteria),
    expected_solution_direction: proseList(result.expected_solution_direction),
    recommended_services: result.recommended_services.map((item) => ({
      ...item,
      customer_need: prose(item.customer_need),
      recommendation_reason: prose(item.recommendation_reason),
      evidence: prose(item.evidence),
      risk_or_caveat: prose(item.risk_or_caveat),
    })),
    value_opportunities: result.value_opportunities.map((item) => ({
      ...item,
      title: prose(item.title),
      description: prose(item.description),
    })),
    positioning_recommendations: proseList(
      result.positioning_recommendations,
    ),
    executive_summary: prose(result.executive_summary),
  };
}
