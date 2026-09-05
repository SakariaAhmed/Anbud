import type { SolutionEvaluationResult } from "@/lib/types";

export function buildArchitectureActions(evaluation: SolutionEvaluationResult) {
  const referencedFindings = evaluation.document_findings
    .filter((finding) => finding.assessment !== "Godt")
    .map((finding) => ({
      location: finding.reference || "Arkitektløsningen generelt",
      action:
        finding.recommendation ||
        "Rett svaret slik at det kobles tydeligere til kundens behov, krav og evalueringssignaler.",
      reason: finding.finding || finding.evidence,
    }));

  const sourceItems = referencedFindings.length
    ? referencedFindings
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
