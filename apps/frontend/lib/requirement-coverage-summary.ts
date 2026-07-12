import type { SolutionEvaluationResult } from "@/lib/types";

type RequirementCoverage = NonNullable<
  SolutionEvaluationResult["requirement_coverage"]
>;

export type RequirementCoverageCounterStatus =
  | "complete"
  | "incomplete"
  | "inconsistent";

export type RequirementCoverageCounterSummary = {
  total: number;
  assessed: number;
  assessedPercent: number;
  itemCount: number;
  status: RequirementCoverageCounterStatus;
  issues: string[];
};

function validCounter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function summarizeRequirementCoverageCounters(
  coverage: RequirementCoverage,
): RequirementCoverageCounterSummary {
  const itemCount = Array.isArray(coverage.items) ? coverage.items.length : 0;
  const rawTotal = validCounter(coverage.total_requirements)
    ? coverage.total_requirements
    : null;
  const rawAssessed = validCounter(coverage.assessed_requirements)
    ? coverage.assessed_requirements
    : null;
  const total = Math.max(rawTotal ?? 0, itemCount);
  const assessed = Math.min(total, rawAssessed ?? 0);
  const issues: string[] = [];

  if (rawTotal === null) {
    issues.push("Totalt antall krav mangler eller er ugyldig.");
  } else if (rawTotal !== itemCount) {
    issues.push(
      `Telleren oppgir ${rawTotal} krav, mens vurderingen inneholder ${itemCount} kravrader.`,
    );
  }
  if (rawAssessed === null) {
    issues.push("Antall vurderte krav mangler eller er ugyldig.");
  } else if (rawTotal !== null && rawAssessed > rawTotal) {
    issues.push(
      `Antall vurderte krav (${rawAssessed}) er større enn totalt antall krav (${rawTotal}).`,
    );
  }

  const categoryCounters = [
    coverage.good,
    coverage.weak,
    coverage.missing,
    coverage.unclear,
  ];
  if (categoryCounters.every(validCounter)) {
    const categoryTotal = categoryCounters.reduce((sum, value) => sum + value, 0);
    if (categoryTotal !== itemCount) {
      issues.push(
        `Godt/Dårlig/Mangler/Uklart summerer til ${categoryTotal}, men vurderingen inneholder ${itemCount} kravrader.`,
      );
    }
  } else {
    issues.push("En eller flere vurderingstellere mangler eller er ugyldige.");
  }

  const status: RequirementCoverageCounterStatus = issues.length
    ? "inconsistent"
    : total === 0 || assessed < total
      ? "incomplete"
      : "complete";

  return {
    total,
    assessed,
    assessedPercent: total ? Math.round((assessed / total) * 100) : 0,
    itemCount,
    status,
    issues,
  };
}
