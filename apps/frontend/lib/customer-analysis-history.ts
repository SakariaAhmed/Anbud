import type {
  CustomerAnalysisHistorySource,
  CustomerAnalysisResult,
  CustomerAnalysisSection,
  CustomerAnalysisSectionHistories,
  CustomerAnalysisSectionHistoryEntry,
  CustomerAnalysisSectionSnapshotMap,
} from "@/lib/types";

export const CUSTOMER_ANALYSIS_SECTIONS = [
  "summary",
  "strategy",
  "clarifications",
  "design",
  "risks",
  "needs",
  "keywords",
  "value",
] as const satisfies CustomerAnalysisSection[];

export type CustomerAnalysisSectionSnapshot<
  TSection extends CustomerAnalysisSection = CustomerAnalysisSection,
> = CustomerAnalysisSectionSnapshotMap[TSection];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stripCustomerAnalysisHistory(
  analysis: CustomerAnalysisResult,
): CustomerAnalysisResult {
  const { section_histories: _sectionHistories, ...rest } = analysis;
  return rest;
}

export function getCustomerAnalysisSectionSnapshot<
  TSection extends CustomerAnalysisSection,
>(
  analysis: CustomerAnalysisResult,
  section: TSection,
): CustomerAnalysisSectionSnapshot<TSection> {
  const cleanAnalysis = stripCustomerAnalysisHistory(analysis);

  switch (section) {
    case "summary":
      return {
        customer_profile_summary: cleanAnalysis.customer_profile_summary,
        customer_goals_summary: cleanAnalysis.customer_goals_summary,
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "strategy":
      return {
        executive_summary: cleanAnalysis.executive_summary,
        positioning_recommendations: cloneJson(
          cleanAnalysis.positioning_recommendations,
        ),
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "clarifications":
      return {
        ambiguities: cloneJson(cleanAnalysis.ambiguities),
        expected_solution_direction: cloneJson(
          cleanAnalysis.expected_solution_direction,
        ),
        likely_evaluation_criteria: cloneJson(
          cleanAnalysis.likely_evaluation_criteria,
        ),
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "design":
      return {
        high_level_solution_design: cleanAnalysis.high_level_solution_design,
        high_level_architecture_mermaid:
          cleanAnalysis.high_level_architecture_mermaid,
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "risks":
      return {
        risks: cloneJson(cleanAnalysis.risks),
        risks_for_us: cloneJson(cleanAnalysis.risks_for_us ?? []),
        risks_for_customer: cloneJson(cleanAnalysis.risks_for_customer ?? []),
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "needs":
      return {
        implicit_requirements: cloneJson(cleanAnalysis.implicit_requirements),
        prioritized_requirements: cloneJson(
          cleanAnalysis.prioritized_requirements,
        ),
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "keywords":
      return {
        signal_words: cloneJson(cleanAnalysis.signal_words),
        signal_word_counts: cloneJson(cleanAnalysis.signal_word_counts ?? {}),
      } as CustomerAnalysisSectionSnapshot<TSection>;
    case "value":
      return {
        value_opportunities: cloneJson(cleanAnalysis.value_opportunities),
      } as CustomerAnalysisSectionSnapshot<TSection>;
  }
}

function isSnapshotEmpty(
  snapshot: CustomerAnalysisSectionSnapshot,
  section: CustomerAnalysisSection,
) {
  switch (section) {
    case "summary": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["summary"];
      return !(
        value.customer_profile_summary.trim() ||
        value.customer_goals_summary.trim()
      );
    }
    case "strategy": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["strategy"];
      return !(
        value.executive_summary.trim() ||
        value.positioning_recommendations.length
      );
    }
    case "clarifications": {
      const value =
        snapshot as CustomerAnalysisSectionSnapshotMap["clarifications"];
      return !(
        value.ambiguities.length ||
        value.expected_solution_direction.length ||
        value.likely_evaluation_criteria.length
      );
    }
    case "design": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["design"];
      return !(
        value.high_level_solution_design.trim() ||
        value.high_level_architecture_mermaid.trim()
      );
    }
    case "risks": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["risks"];
      return !(
        value.risks.length ||
        (value.risks_for_us?.length ?? 0) ||
        (value.risks_for_customer?.length ?? 0)
      );
    }
    case "needs": {
      const value = snapshot as CustomerAnalysisSectionSnapshotMap["needs"];
      return !(
        value.implicit_requirements.length ||
        value.prioritized_requirements.length
      );
    }
    case "keywords":
      return !(
        snapshot as CustomerAnalysisSectionSnapshotMap["keywords"]
      ).signal_words.length;
    case "value":
      return !(
        snapshot as CustomerAnalysisSectionSnapshotMap["value"]
      ).value_opportunities.length;
  }
}

function normalizeSectionHistories(
  histories: CustomerAnalysisSectionHistories | undefined,
): CustomerAnalysisSectionHistories {
  if (!histories) {
    return {};
  }

  const normalized: CustomerAnalysisSectionHistories = {};

  for (const section of CUSTOMER_ANALYSIS_SECTIONS) {
    const entries = histories[section];
    if (!Array.isArray(entries) || entries.length === 0) {
      continue;
    }

    normalized[section] = entries
      .filter(
        (entry): entry is CustomerAnalysisSectionHistoryEntry =>
          Boolean(
            entry &&
              typeof entry.id === "string" &&
              typeof entry.created_at === "string" &&
              entry.snapshot,
          ),
      )
      .map((entry) => ({
        ...entry,
        snapshot: cloneJson(entry.snapshot),
      }));
  }

  return normalized;
}

function snapshotsEqual(
  left: CustomerAnalysisSectionSnapshot,
  right: CustomerAnalysisSectionSnapshot,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function appendCustomerAnalysisSectionHistory(input: {
  previousAnalysis: CustomerAnalysisResult | null;
  nextAnalysis: CustomerAnalysisResult;
  sections: CustomerAnalysisSection[];
  source: CustomerAnalysisHistorySource;
  createdAt?: string;
}) {
  const nextAnalysis = stripCustomerAnalysisHistory(input.nextAnalysis);
  const previousAnalysis = input.previousAnalysis
    ? stripCustomerAnalysisHistory(input.previousAnalysis)
    : null;
  const histories = normalizeSectionHistories(
    input.previousAnalysis?.section_histories ?? input.nextAnalysis.section_histories,
  );

  if (!previousAnalysis) {
    return Object.keys(histories).length
      ? { ...nextAnalysis, section_histories: histories }
      : nextAnalysis;
  }

  const createdAt = input.createdAt ?? new Date().toISOString();

  for (const section of input.sections) {
    const previousSnapshot = getCustomerAnalysisSectionSnapshot(
      previousAnalysis,
      section,
    );
    const nextSnapshot = getCustomerAnalysisSectionSnapshot(nextAnalysis, section);

    if (
      isSnapshotEmpty(previousSnapshot, section) ||
      snapshotsEqual(previousSnapshot, nextSnapshot)
    ) {
      continue;
    }

    const nextEntries = [
      {
        id: `${section}-${createdAt}-${histories[section]?.length ?? 0}`,
        created_at: createdAt,
        source: input.source,
        snapshot: previousSnapshot,
      },
      ...(histories[section] ?? []),
    ];

    histories[section] = nextEntries;
  }

  return Object.keys(histories).length
    ? { ...nextAnalysis, section_histories: histories }
    : nextAnalysis;
}
