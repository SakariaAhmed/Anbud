import { requirementReviewRows } from "@/lib/requirement-review";
import type { CustomerAnalysisResult, GeneratedArtifact, ProjectDocument, SolutionEvaluationResult } from "@/lib/types";

/** Legacy coverage has no provable input identity; changed analyses need a new evaluation. */
export function currentCriterionCoverage(item: NonNullable<SolutionEvaluationResult["criterion_coverage"]>[number], input: { analysis?: CustomerAnalysisResult; documents?: ProjectDocument[] } = {}) {
  const scope = item.criterion_scope;
  if (!scope || scope.version !== 1 || scope.analysis_criteria[item.criterion_index ?? -1] !== item.criterion) return undefined;
  if (input.analysis && (scope.analysis_revision !== (input.analysis.revision ?? null) || JSON.stringify(scope.analysis_criteria) !== JSON.stringify(input.analysis.likely_evaluation_criteria))) return undefined;
  const documents = input.documents;
  if (documents && [...scope.documents, ...(scope.solution ? [scope.solution] : [])].some(snapshot => !documents.some(document => document.id === snapshot.id && document.chunk_source_revision === snapshot.revision))) return undefined;
  return item;
}

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
  for (const [index, item] of (input.analysis?.likely_evaluation_criteria ?? []).entries()) {
    const stored = input.evaluation?.criterion_coverage?.[index];
    const current = stored?.criterion === item ? currentCriterionCoverage(stored, { analysis: input.analysis ?? undefined }) : undefined;
    if (current?.assessment === "Godt" && !current.review_required) continue;
    items.push({ key: `criterion:${current?.criterion_id ?? index}`, kind: "criterion", reference: `${current?.origin === "observed" ? "Dokumentert evalueringskriterium" : "Mulig evalueringskriterium"}: ${item}`,
      description: current ? `${current.assessment}: ${current.rationale}` : stored ? "Den lagrede vurderingen gjelder et annet eller ubekreftet analysegrunnlag; dekningen er ukjent." : "Kundeanalysen foreslår dette kriteriet. Det finnes ingen lagret dekningsvurdering per evalueringskriterium; dekningen er ukjent.",
      nextAction: "Kontroller kriteriet i konkurransegrunnlaget og dokumenter hvordan tilbudet besvarer det." });
  }
  return items;
}
