import type { SolutionEvaluationResult } from "@/lib/types";

export function buildArchitectureActions(evaluation: SolutionEvaluationResult) {
  const coverageItems = (evaluation.requirement_coverage?.items ?? [])
    .filter((item) => item.assessment !== "Godt");
  const coveredReferences = new Set(coverageItems.flatMap((item) =>
    [item.reference, item.full_reference, item.source_reference].filter(Boolean)));
  const coverageActions = coverageItems.map((item) => ({
    location: item.full_reference || item.reference || item.source_reference,
    action: item.recommendation || "Avklar og rett dette kravet før innlevering.",
    reason: item.rationale || item.evidence,
  }));
  const referencedFindings = evaluation.document_findings
    .filter((finding) => finding.assessment !== "Godt" &&
      !coveredReferences.has(finding.reference) &&
      !coveredReferences.has(finding.matched_requirement_reference ?? ""))
    .map((finding) => ({
      location: finding.reference || "Arkitektløsningen generelt",
      action:
        finding.recommendation ||
        "Rett svaret slik at det kobles tydeligere til kundens behov, krav og evalueringssignaler.",
      reason: finding.finding || finding.evidence,
    }));

  const groundedActions = [...coverageActions, ...referencedFindings];
  const sourceItems = groundedActions.length
    ? groundedActions
    : evaluation.rewrite_suggestions.length
    ? evaluation.rewrite_suggestions.map((suggestion) => ({
        location: suggestion.target || "Arkitektløsningen generelt",
        action: suggestion.suggestion,
        reason: "",
      }))
    : evaluation.weaknesses.slice(0, 4).map((weakness) => ({
        location: "Arkitektløsningen generelt",
        action: "Avklar og rett dette funnet med konkret ansvar, kontroll og dokumentasjon.",
        reason: weakness,
      }));

  return sourceItems.slice(0, 4);
}
