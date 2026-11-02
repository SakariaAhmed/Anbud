import "server-only";
import { createHash } from "node:crypto";
import { isRecord, stringList, stringOr } from "@/lib/unknown-values";
import { bindDocumentSourceEvidence } from "@/lib/server/document-source-evidence";
import type { ProjectDocumentDetail, SolutionEvaluationResult } from "@/lib/types";

type Coverage = NonNullable<SolutionEvaluationResult["requirement_coverage"]>;
type Criterion = NonNullable<SolutionEvaluationResult["criterion_coverage"]>[number];
const rank = { Mangler: 0, Uklart: 1, Dårlig: 2, Godt: 3 } as const;
const isAssessment = (value: unknown): value is keyof typeof rank => typeof value === "string" && Object.hasOwn(rank, value);
const identity = (row: Coverage["items"][number]) => row.full_reference || row.source_reference || row.reference;

/** Only identities from the captured analysis/requirement snapshot survive.
 * Likely criteria remain suggestions even when they have a supporting quote. */
export function normalizeCriterionCoverage(value: unknown, input: { criteria: string[]; coverage: Coverage; customerDocuments: ProjectDocumentDetail[]; solutionDocument?: ProjectDocumentDetail }): Criterion[] {
  const rows = Array.isArray(value) ? value.filter(isRecord) : [];
  const documents = [...new Map(input.customerDocuments.map(document => [document.id, document])).values()];
  return input.criteria.map((criterion, index) => {
    const candidates = rows.filter(row => row.criterion === criterion && row.criterion_index === index);
    const row = candidates.length === 1 ? candidates[0] : {};
    const refs = [...new Set(stringList(row.requirement_references))];
    const quote = stringOr(row.source_quote);
    const sources = quote.trim() ? documents.flatMap(document => {
      const source = bindDocumentSourceEvidence(document, quote);
      return source ? [source] : [];
    }) : [];
    const proposed = isAssessment(row.assessment) ? row.assessment : "Uklart";
    const evidence = stringOr(row.evidence);
    const hasAnswerEvidence = input.solutionDocument && evidence.trim() ? bindDocumentSourceEvidence(input.solutionDocument, evidence) !== null : false;
    const item: Criterion = {
      criterion_id: createHash("sha256").update(JSON.stringify([index, criterion])).digest("hex"),
      criterion, origin: "suggested", assessment: proposed,
      rationale: stringOr(row.rationale), evidence,
      requirement_references: refs,
      ...(sources.length === 1 ? { criterion_source: sources[0] } : {}),
      review_required: candidates.length !== 1 || sources.length !== 1 || !isAssessment(row.assessment) || !stringOr(row.rationale).trim() || (proposed === "Godt" && !hasAnswerEvidence),
    };
    return reconcileCriterionCoverage([item], input.coverage)[0];
  });
}

export function reconcileCriterionCoverage(criteria: Criterion[], coverage: Coverage): Criterion[] {
  return criteria.map(item => {
    const matches = item.requirement_references.map(ref => coverage.items.filter(row => identity(row) === ref));
    const ambiguous = !matches.length || matches.some(rows => rows.length !== 1);
    const review = item.review_required || ambiguous || !item.criterion_source;
    let assessment = item.assessment;
    if (review && rank[assessment] > rank.Uklart) assessment = "Uklart";
    if (!ambiguous) for (const [row] of matches) if (rank[row.assessment] < rank[assessment]) assessment = row.assessment;
    const changed = assessment !== item.assessment;
    return { ...item, assessment,
      review_required: review || changed,
      rationale: review || changed ? "Må avklares. Kriteriets kilde, kravkobling eller svargrunnlag er ikke tilstrekkelig bekreftet. Kontroller originaldokumentene." : item.rationale,
    };
  });
}
