import type {
  AnalysisRequirement,
  CustomerAnalysisResult,
  RecommendedService,
  ValueOpportunity,
} from "@/lib/types";

export type ProjectResultHistoryEntry = {
  id: string;
  kind: string;
  archived_at: string;
  reason: string;
  result_json: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseProjectResultHistory(payload: unknown): ProjectResultHistoryEntry[] {
  if (!record(payload) || !Array.isArray(payload.history)) {
    throw new Error("Kunne ikke lese historikken. Prøv å hente den på nytt.");
  }
  return payload.history.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.kind !== "string" ||
      typeof entry.reason !== "string" || typeof entry.archived_at !== "string" ||
      !Number.isFinite(Date.parse(entry.archived_at)) || !record(entry.result_json)) {
      throw new Error("Kunne ikke lese historikken. Prøv å hente den på nytt.");
    }
    return { id: entry.id, kind: entry.kind, reason: entry.reason,
      archived_at: entry.archived_at, result_json: entry.result_json };
  });
}

const invalidAnalysis = () => new Error("Denne versjonen har et analyseformat som ikke kan vises. Velg en annen versjon.");
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const importance = (value: unknown) => ["Kritisk", "Viktig", "Mindre viktig"].includes(String(value));
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => isString(value[key]));

function list<T>(value: unknown, valid: (item: unknown) => item is T): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(valid)) throw invalidAnalysis();
  return value;
}

/** Adapt older, partial snapshots for display without rewriting their stored content. */
export function archivedCustomerAnalysis(value: Record<string, unknown>): CustomerAnalysisResult {
  if (!["customer_profile_summary", "customer_profile", "executive_summary", "high_level_solution_design"]
    .some((key) => key in value)) throw invalidAnalysis();
  const text = (key: string) => {
    if (value[key] === undefined || value[key] === null) return "";
    if (!isString(value[key])) throw invalidAnalysis();
    return value[key];
  };
  const textList = (key: string) => list(value[key], isString);
  const profile = textList("customer_profile");
  const goals = textList("customer_goals");
  const counts = value.signal_word_counts;
  if (counts != null && (!record(counts) || !Object.values(counts).every(isNumber))) throw invalidAnalysis();
  return {
    customer_profile_summary: text("customer_profile_summary") || profile.join("\n\n"),
    customer_goals_summary: text("customer_goals_summary") || goals.join("\n\n"),
    customer_profile: profile,
    customer_goals: goals,
    high_level_solution_design: text("high_level_solution_design"),
    high_level_architecture_mermaid: text("high_level_architecture_mermaid"),
    executive_summary: text("executive_summary"),
    implicit_requirements: list(value.implicit_requirements, (item): item is AnalysisRequirement =>
      record(item) && strings(item, ["title", "description", "category", "source_reference", "source_excerpt"]) &&
      importance(item.importance) && (item.kind === "Eksplisitt" || item.kind === "Implisitt")),
    prioritized_requirements: list(value.prioritized_requirements,
      (item): item is CustomerAnalysisResult["prioritized_requirements"][number] =>
        record(item) && strings(item, ["requirement", "reason"]) && importance(item.priority)),
    ambiguities: textList("ambiguities"),
    risks: textList("risks"),
    risks_for_us: textList("risks_for_us"),
    risks_for_customer: textList("risks_for_customer"),
    likely_evaluation_criteria: textList("likely_evaluation_criteria"),
    signal_words: textList("signal_words"),
    signal_word_counts: counts == null ? {} : counts as Record<string, number>,
    expected_solution_direction: textList("expected_solution_direction"),
    positioning_recommendations: textList("positioning_recommendations"),
    recommended_services: list(value.recommended_services, (item): item is RecommendedService =>
      record(item) && strings(item, ["service_name", "customer_need", "recommendation_reason", "evidence", "risk_or_caveat"]) &&
      isNumber(item.usefulness_percent) && (item.service_id == null || isString(item.service_id))),
    value_opportunities: list(value.value_opportunities, (item): item is ValueOpportunity =>
      record(item) && strings(item, ["title", "description"]) && isNumber(item.profit_share_percent) &&
      Array.isArray(item.value_categories) && item.value_categories.every((category: unknown) =>
        ["Høyere produktivitet", "Lavere kostnader", "Redusert risiko", "Bedre brukeropplevelse"].includes(String(category)))),
    // The full archived version is the selected snapshot; nested section history
    // and live revision tokens do not belong to this read-only view.
  };
}
