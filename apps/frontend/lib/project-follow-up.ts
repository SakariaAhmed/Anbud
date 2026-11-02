import { requirementReviewRows } from "@/lib/requirement-review";
import type { CustomerAnalysisResult, GeneratedArtifact, SolutionEvaluationResult } from "@/lib/types";

export type ProjectFollowUp = { key: string; kind: "requirement" | "coverage" | "clarification" | "criterion"; reference: string; description: string; nextAction: string };
/** Derived from saved results only. Absence of an evaluation is not evidence
 * that a criterion is covered or uncovered. Keep unknowns explicit. */
export function projectFollowUpItems(input: { artifacts: GeneratedArtifact[]; analysis: CustomerAnalysisResult | null; evaluation: SolutionEvaluationResult | null }): ProjectFollowUp[] {
  const items: ProjectFollowUp[] = [];
  for (const artifact of input.artifacts.filter(artifact => artifact.artifact_type === "forbedret_kravsvar" && artifact.is_current === true && artifact.source_is_current === true)) {
    for (const row of requirementReviewRows(artifact.content_markdown, artifact.input_snapshot).filter(row => row.needsReview)) items.push({ key: `requirement:${artifact.id}:${row.index}`, kind: "requirement", reference: row.ref || `Krav ${row.index + 1}`,
      description: row.unanswered ? "Kravet mangler svar." : row.missingSource ? "Svaret mangler kildehenvisning." : "Svaret trenger manuell gjennomgang eller tilbudsinput.",
      nextAction: "Åpne kravbesvarelsen, kontroller kildene og oppdater svaret." });
  }
  for (const [index, item] of (input.evaluation?.requirement_coverage?.items ?? []).entries()) {
    if (item.assessment === "Godt") continue;
    items.push({ key: `coverage:${item.source_document_id ?? "unknown"}:${item.order_index ?? index}`, kind: "coverage", reference: item.full_reference || item.reference,
      description: `${item.assessment}: ${item.rationale || item.requirement}`, nextAction: item.recommendation || "Suppler dokumentasjonen og vurder kravet på nytt." });
  }
  for (const [index, item] of (input.evaluation?.missing_elements ?? []).entries()) items.push({ key: `missing:${index}`, kind: "coverage", reference: "Mangler i løsningsforslaget", description: item, nextAction: "Suppler løsningsforslaget og kjør en ny vurdering." });
  for (const [index, item] of (input.analysis?.ambiguities ?? []).entries()) items.push({ key: `clarification:${index}`, kind: "clarification", reference: "Åpen avklaring", description: item, nextAction: "Avklar med kunden og oppdater dokumentgrunnlaget." });
  for (const [index, item] of (input.analysis?.likely_evaluation_criteria ?? []).entries()) items.push({ key: `criterion:${index}`, kind: "criterion", reference: `Mulig evalueringskriterium: ${item}`,
    description: "Kundeanalysen foreslår dette kriteriet. Det finnes ingen lagret dekningsvurdering per evalueringskriterium; dekningen er ukjent.",
    nextAction: "Kontroller kriteriet i konkurransegrunnlaget og dokumenter hvordan tilbudet besvarer det." });
  return items;
}
