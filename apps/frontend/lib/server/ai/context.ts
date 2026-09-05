import "server-only";

import type { RetrievedDocumentSnippet } from "@/lib/server/document-chunks";
import { buildDelimitedContext } from "@/lib/server/prompts";
import type {
  CustomerAnalysisResult,
  ProjectDocumentDetail,
  SolutionEvaluationResult,
} from "@/lib/types";

export function compactText(value: unknown, limit = 16000) {
  const source = typeof value === "string" ? value : "";
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

export function documentContext(
  label: string,
  document: ProjectDocumentDetail,
  options?: {
    textLimit?: number;
    structureLimit?: number;
    structureTextLimit?: number;
    structureSelection?: "head" | "distributed";
  },
) {
  const structureLimit = options?.structureLimit ?? 12;
  const structureTextLimit = options?.structureTextLimit ?? 220;
  const structureEntries = selectDocumentStructureEntries(
    document.structure_map,
    structureLimit,
    options?.structureSelection ?? "head",
  );
  const structurePreview = structureEntries
    .map(
      (section) =>
        `- ${section.reference}: ${compactText(section.text, structureTextLimit)}`,
    )
    .join("\n");

  return [
    buildDelimitedContext(
      `${label} metadata`,
      [
        `Tittel: ${document.title}`,
        `Filnavn: ${document.file_name}`,
        `Format: ${document.file_format.toUpperCase()}`,
        `Rolle: ${document.role}`,
      ].join("\n"),
    ),
    buildDelimitedContext(
      `${label} struktur`,
      structurePreview || "Ingen struktur tilgjengelig.",
    ),
    buildDelimitedContext(
      `${label} tekst`,
      compactText(document.raw_text, options?.textLimit ?? 22000),
    ),
  ].join("\n\n");
}

export function selectDocumentStructureEntries(
  entries: ProjectDocumentDetail["structure_map"],
  limit: number,
  selection: "head" | "distributed" = "head",
) {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (!normalizedLimit || !entries.length) {
    return [];
  }
  if (selection === "head" || entries.length <= normalizedLimit) {
    return entries.slice(0, normalizedLimit);
  }
  if (normalizedLimit === 1) {
    return entries.slice(0, 1);
  }

  const selectedIndexes = Array.from({ length: normalizedLimit }, (_, index) =>
    Math.round((index * (entries.length - 1)) / (normalizedLimit - 1)),
  );
  return selectedIndexes.map((index) => entries[index]);
}

export function retrievedSnippetContext(
  label: string,
  snippets: RetrievedDocumentSnippet[],
  options?: { textLimit?: number },
) {
  if (!snippets.length) {
    return "";
  }

  const textLimit = options?.textLimit ?? 1200;
  return buildDelimitedContext(
    label,
    snippets
      .map((snippet, index) =>
        [
          `${index + 1}. ${snippet.documentTitle}`,
          `Referanse: ${snippet.reference}`,
          snippet.headingPath.length
            ? `Seksjon: ${snippet.headingPath.join(" > ")}`
            : "",
          snippet.pageStart
            ? `Side: ${
                snippet.pageEnd && snippet.pageEnd !== snippet.pageStart
                  ? `${snippet.pageStart}-${snippet.pageEnd}`
                  : snippet.pageStart
              }`
            : "",
          snippet.similarity != null
            ? `Semantisk treff: ${snippet.similarity.toFixed(3)}`
            : `Nøkkelordtreff: ${snippet.lexicalScore}`,
          compactText(snippet.text, textLimit),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n"),
  );
}

export function summarizeCustomerAnalysis(analysis: CustomerAnalysisResult) {
  return JSON.stringify({
    customer_profile_summary: compactText(
      analysis.customer_profile_summary,
      500,
    ),
    customer_goals_summary: compactText(analysis.customer_goals_summary, 500),
    high_level_solution_design: compactText(
      analysis.high_level_solution_design,
      700,
    ),
    high_level_architecture_mermaid: compactText(
      analysis.high_level_architecture_mermaid,
      1000,
    ),
    customer_profile: analysis.customer_profile.slice(0, 5),
    customer_goals: analysis.customer_goals.slice(0, 5),
    implicit_requirements: analysis.implicit_requirements
      .slice(0, 6)
      .map((item) => ({
        title: item.title,
        category: item.category,
        importance: item.importance,
        description: compactText(item.description, 220),
      })),
    risks_for_us: (analysis.risks_for_us ?? []).slice(0, 5),
    risks_for_customer: (analysis.risks_for_customer ?? []).slice(0, 5),
    risks: analysis.risks.slice(0, 5),
    likely_evaluation_criteria: analysis.likely_evaluation_criteria.slice(
      0,
      5,
    ),
    expected_solution_direction: analysis.expected_solution_direction.slice(0, 5),
    recommended_services: (analysis.recommended_services ?? [])
      .slice(0, 5)
      .map((item) => ({
        service_name: item.service_name,
        usefulness_percent: item.usefulness_percent,
        customer_need: compactText(item.customer_need, 180),
        recommendation_reason: compactText(item.recommendation_reason, 240),
      })),
    value_opportunities: analysis.value_opportunities.slice(0, 4),
    executive_summary: compactText(analysis.executive_summary, 500),
  });
}

export function summarizeSolutionEvaluation(evaluation: SolutionEvaluationResult) {
  return JSON.stringify({
    fit_to_customer_needs: compactText(evaluation.fit_to_customer_needs, 500),
    strengths: evaluation.strengths.slice(0, 5),
    weaknesses: evaluation.weaknesses.slice(0, 5),
    missing_elements: evaluation.missing_elements.slice(0, 5),
    risks_to_customer: evaluation.risks_to_customer.slice(0, 5),
    improvement_recommendations: evaluation.improvement_recommendations.slice(
      0,
      5,
    ),
    requirement_coverage: evaluation.requirement_coverage
      ? {
          total_requirements: evaluation.requirement_coverage.total_requirements,
          assessed_requirements:
            evaluation.requirement_coverage.assessed_requirements,
          good: evaluation.requirement_coverage.good,
          weak: evaluation.requirement_coverage.weak,
          missing: evaluation.requirement_coverage.missing,
          unclear: evaluation.requirement_coverage.unclear,
          coverage_summary: compactText(
            evaluation.requirement_coverage.coverage_summary,
            500,
          ),
        }
      : null,
    likely_score_assessment: evaluation.likely_score_assessment,
    executive_summary: compactText(evaluation.executive_summary, 500),
  });
}
