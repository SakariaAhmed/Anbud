import "server-only";
import { createHash } from "node:crypto";
import { isRecord, stringList, stringOr } from "@/lib/unknown-values";
import { bindDocumentSourceEvidence } from "@/lib/server/document-source-evidence";
import { compileDocumentIntelligenceArtifact } from "@/lib/server/document-intelligence/evidence-compiler";
import { SourceQuoteIndex } from "@/lib/server/source-evidence";
import type { ChatSourceReference, ProjectDocumentDetail, SolutionEvaluationResult } from "@/lib/types";

type Coverage = NonNullable<SolutionEvaluationResult["requirement_coverage"]>;
type Criterion = NonNullable<SolutionEvaluationResult["criterion_coverage"]>[number];
const rank = { Mangler: 0, Uklart: 1, Dårlig: 2, Godt: 3 } as const;
const isAssessment = (value: unknown): value is keyof typeof rank => typeof value === "string" && Object.hasOwn(rank, value);
const identity = (row: Coverage["items"][number]) => row.full_reference;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const comparable = (text: string) => text.normalize("NFC").replace(/\s+/gu, " ").trim().replace(/[.\s]+$/u, "");

function uniqueSource(document: ProjectDocumentDetail, quote: string): ChatSourceReference | null {
  const index = new SourceQuoteIndex(document.raw_text);
  const first = index.locate(quote, { tokenBoundaries: true, normalized: true });
  if (!first || index.locate(quote, { tokenBoundaries: true, normalized: true, startAt: first.end })) return null;
  return bindDocumentSourceEvidence(document, quote, { index });
}

/** Use the existing structured/canonical evidence, not a second extraction pass.
 * Exact labels only: semantic similarity cannot establish award-criterion status.
 * This intentionally leaves unsupported or conditional wording as suggestions. */
function observedCriterionSources(document: ProjectDocumentDetail) {
  if (document.role !== "primary_customer_document" && !(document.role === "supporting_document" && ["rfp", "kravdokument"].includes(document.supporting_subtype ?? ""))) return [];
  const artifact = compileDocumentIntelligenceArtifact({
    documentId: document.id, projectId: document.project_id, title: document.title,
    fileName: document.file_name, fileFormat: document.file_format, fileSizeBytes: document.file_size_bytes,
    sourceRevision: document.chunk_source_revision, parserUsed: document.parser_used ?? "unknown",
    rawText: document.raw_text, structureMap: document.structure_map, isHighImpactDocument: true,
  });
  const candidates = [
    ...artifact.evidence.filter(unit => unit.kind === "evaluation_criterion").map(unit => ({ text: unit.text, original: unit.sourceText })),
    ...artifact.canonicalBlocks.map(block => ({ text: block.canonicalText, original: block.sourceText })),
  ];
  const sources = new Map<string, { labels: Set<string>; source: ChatSourceReference }>();
  // A compiler category alone is a language signal, not proof of an award rule.
  const declaration = /^(?:\s*(?:#{1,6}\s*)?)(?:tildelingskriteri(?:um|er)|evalueringskriteri(?:um|er)|award criteria|evaluation criteria)\s*[:\n–-]\s*\S/iu;
  const conditional = /\b(?:foresl[aå]r?|foreslått\p{L}*|forslag|potensiell\p{L}*|utkast|utgått\p{L}*|erstattet|tidligere|historisk\p{L}*|anbefal\p{L}*|hypotetisk\p{L}*|eksempel\p{L}*|mulig\p{L}*|eventuell\p{L}*|dersom|hvis|kan|kunne|bør|ikke|kvalifikasjonskrav\p{L}*|qualification|proposed|suggested|hypothetical|should|could|would|may|if|example|possible|draft|supplier|leverandør\p{L}*)\b/iu;
  for (const candidate of candidates) {
    const explicitWeighting = /^\s*Tildelingen\s+(?:vekter|vektlegger)\s+\S/iu.test(candidate.original);
    if ((!declaration.test(candidate.original) && !explicitWeighting) || conditional.test(candidate.original)) continue;
    const source = uniqueSource(document, candidate.original);
    if (!source || !source.source_revision || (!source.page_start && !document.structure_map.some(section => section.reference === source.reference))) continue;
    const labels = [candidate.text, candidate.original].flatMap(text => [comparable(text), comparable(text.replace(/^\s*(?:#{1,6}\s*)?(?:tildelingskriteri(?:um|er)|evalueringskriteri(?:um|er)|award criteria|evaluation criteria)\s*[:\n–-]\s*/iu, ""))]);
    const key = source.evidence_id!;
    const found = sources.get(key) ?? { labels: new Set<string>(), source };
    labels.forEach(label => found.labels.add(label));
    sources.set(key, found);
  }
  return [...sources.values()];
}

/** Only identities from the captured analysis/requirement snapshot survive. */
export function normalizeCriterionCoverage(value: unknown, input: { criteria: string[]; coverage: Coverage; customerDocuments: ProjectDocumentDetail[]; solutionDocument?: ProjectDocumentDetail; analysisRevision?: string; sourceRevision?: number }): Criterion[] {
  const rows = Array.isArray(value) ? value.filter(isRecord) : [];
  const documents = [...new Map(input.customerDocuments.map(document => [document.id, document])).values()];
  const snapshot = (document: ProjectDocumentDetail) => ({ id: document.id, revision: document.chunk_source_revision, fingerprint: hash(JSON.stringify([document.raw_text, document.structure_map])) });
  const scope: NonNullable<Criterion["criterion_scope"]> = {
    version: 1, analysis_revision: input.analysisRevision ?? null, analysis_criteria: [...input.criteria],
    project_source_revision: input.sourceRevision ?? null,
    documents: documents.map(snapshot).sort((left, right) => left.id.localeCompare(right.id)),
    solution: input.solutionDocument ? snapshot(input.solutionDocument) : null,
  };
  const observed = documents.flatMap(observedCriterionSources);
  return input.criteria.map((criterion, index) => {
    const candidates = rows.filter(row => row.criterion === criterion && row.criterion_index === index);
    const row = candidates.length === 1 ? candidates[0] : {};
    const refs = [...new Set(stringList(row.requirement_references))];
    const observedSources = observed.filter(item => item.labels.has(comparable(criterion))).map(item => item.source);
    const quote = stringOr(row.source_quote);
    const sources = quote.trim() ? documents.flatMap(document => {
      const source = uniqueSource(document, quote);
      return source ? [source] : [];
    }) : [];
    const duplicateIdentity = input.criteria.filter(value => value === criterion).length !== 1 || observedSources.length > 1;
    const source = duplicateIdentity ? undefined : observedSources.length === 1 ? observedSources[0] : sources.length === 1 ? sources[0] : undefined;
    const proposed = isAssessment(row.assessment) ? row.assessment : "Uklart";
    const evidence = stringOr(row.evidence);
    const answerSource = input.solutionDocument && evidence.trim() ? uniqueSource(input.solutionDocument, evidence) : null;
    const reviewRequired = candidates.length !== 1 || !source || observedSources.length > 1 || !isAssessment(row.assessment) || !stringOr(row.rationale).trim() || (proposed === "Godt" && !answerSource);
    const item: Criterion = {
      criterion_id: hash(JSON.stringify([scope, index, criterion])), criterion_index: index, criterion_scope: scope,
      criterion, origin: observedSources.length === 1 ? "observed" : "suggested", assessment: reviewRequired ? "Uklart" : proposed,
      rationale: stringOr(row.rationale), evidence, requirement_references: refs,
      ...(source ? { criterion_source: source } : {}), ...(answerSource ? { answer_source: answerSource } : {}),
      review_required: reviewRequired,
    };
    return reconcileCriterionCoverage([item], input.coverage)[0];
  });
}

export function reconcileCriterionCoverage(criteria: Criterion[], coverage: Coverage, documents?: ProjectDocumentDetail[]): Criterion[] {
  return criteria.map(item => {
    const matches = item.requirement_references.map(ref => coverage.items.filter(row => identity(row) === ref));
    const ambiguous = !matches.length || matches.some(rows => rows.length !== 1);
    const scope = item.criterion_scope;
    const stale = documents && scope && [...scope.documents, ...(scope.solution ? [scope.solution] : [])].some(snapshot => {
      const document = documents.find(document => document.id === snapshot.id);
      return !document || document.chunk_source_revision !== snapshot.revision || hash(JSON.stringify([document.raw_text, document.structure_map])) !== snapshot.fingerprint;
    });
    const unknownIdentity = ambiguous || !item.criterion_source || !scope || scope.analysis_criteria[item.criterion_index ?? -1] !== item.criterion || !!stale;
    const review = item.review_required || unknownIdentity;
    let assessment = item.assessment;
    if (unknownIdentity || (review && rank[assessment] > rank.Uklart)) assessment = "Uklart";
    if (!unknownIdentity) for (const [row] of matches) if (rank[row.assessment] < rank[assessment]) assessment = row.assessment;
    const changed = assessment !== item.assessment;
    return { ...item, assessment, ...(unknownIdentity ? { origin: "unknown" as const } : {}),
      review_required: review || changed,
      rationale: review || changed ? "Må avklares. Kriteriets kilde, kravkobling eller svargrunnlag er ikke tilstrekkelig bekreftet. Kontroller originaldokumentene." : item.rationale,
    };
  });
}

/** Compare the model snapshot before normalization can withhold its rating. */
export function criterionCoverageLostGoodRating(original: unknown, current: Criterion[]): boolean {
  const rows = Array.isArray(original) ? original.filter(isRecord) : [];
  return current.some(item => item.assessment !== "Godt" && rows.some(row =>
    row.criterion_index === item.criterion_index && row.criterion === item.criterion && row.assessment === "Godt"));
}
