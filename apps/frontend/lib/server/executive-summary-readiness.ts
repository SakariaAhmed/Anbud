import "server-only";

import { summarizeRequirementCoverageCounters } from "@/lib/requirement-coverage-summary";
import { analyzeRequirementCoverageSelfConsistency } from "@/lib/server/requirements/evaluation-coverage-integrity";
import type { SolutionEvaluationResult } from "@/lib/types";

export type ExecutiveSummaryReadiness = {
  ready: boolean;
  reason: "ready" | "missing_coverage" | "incomplete" | "inconsistent";
  message: string;
};

function unavailable(message: string): ExecutiveSummaryReadiness {
  return {
    ready: false,
    reason: "incomplete",
    message: `Lederoppsummeringen er utilgjengelig fordi ${message} Regenerer vurderingen først.`,
  };
}

// Exported for readiness-state contract tests.
// fallow-ignore-next-line unused-export, complexity
export function executiveSummaryReadiness(
  evaluation: SolutionEvaluationResult,
): ExecutiveSummaryReadiness {
  if (!evaluation.requirement_coverage) {
    return {
      ready: false,
      reason: "missing_coverage",
      message:
        "Lederoppsummeringen er utilgjengelig fordi vurderingen mangler kravdekning. Regenerer vurderingen først.",
    };
  }

  const coverage = summarizeRequirementCoverageCounters(
    evaluation.requirement_coverage,
  );
  if (coverage.status === "inconsistent") {
    return {
      ready: false,
      reason: "inconsistent",
      message: `Lederoppsummeringen er utilgjengelig fordi vurderingen har inkonsistent kravdekning: ${coverage.issues.join(
        " ",
      )} Regenerer vurderingen først.`,
    };
  }
  if (coverage.status === "incomplete") {
    return unavailable(
      coverage.total > 0
        ? `bare ${coverage.assessed} av ${coverage.total} krav er vurdert.`
        : "den ikke inneholder et komplett, vurderbart kravgrunnlag.",
    );
  }

  const integrity = analyzeRequirementCoverageSelfConsistency(
    evaluation.requirement_coverage,
  );
  if (!integrity.ok) {
    return {
      ready: false,
      reason: "inconsistent",
      message: `Lederoppsummeringen er utilgjengelig fordi vurderingen har inkonsistente kravrader: ${integrity.issues
        .slice(0, 4)
        .map((issue) => issue.message)
        .join(" ")} Regenerer vurderingen først.`,
    };
  }

  const requiredTextFields = [
    evaluation.executive_summary,
    evaluation.fit_to_customer_needs,
    evaluation.likely_score_assessment?.quality,
    evaluation.likely_score_assessment?.delivery_confidence,
    evaluation.likely_score_assessment?.risk,
    evaluation.likely_score_assessment?.competitiveness,
  ];
  if (requiredTextFields.some((value) => !value?.trim())) {
    return unavailable("vurderingen mangler ett eller flere styrende sammendrag.");
  }

  return {
    ready: true,
    reason: "ready",
    message: "",
  };
}

export function assertExecutiveSummaryEvaluationReady(
  evaluation: SolutionEvaluationResult,
) {
  const readiness = executiveSummaryReadiness(evaluation);
  if (!readiness.ready) {
    throw new Error(readiness.message);
  }
}
