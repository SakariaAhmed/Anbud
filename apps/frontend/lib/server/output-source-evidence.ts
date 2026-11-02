import "server-only";
import { createHash } from "node:crypto";
import { unchangedRequirementRowEvidence } from "@/lib/output-source-evidence";
import { extractRequirementIdentifiers, isAmbiguousRequirementIdentifier } from "@/lib/server/ai/retrieval-query";
import { WorkflowIncompleteError } from "@/lib/server/workflow-errors";
import { SourceQuoteIndex, quotedSourcePassages, evidenceIdentity, sourceQuoteLength, isMeaningfulShortSourceQuote } from "@/lib/server/source-evidence";
import { bindDocumentSourceEvidence } from "@/lib/server/document-source-evidence";
import type { ChatSourceReference, ProjectDocumentDetail, ServiceDocumentDetail, SourceEvidenceManifest } from "@/lib/types";

export type OutputSourceEvidence = SourceEvidenceManifest;
export type AuthorizedEvidenceArtifact = { id: string; title: string; content_markdown: string; artifact_version?: number };
export type AuthorizedEvidenceDocument = { document: ProjectDocumentDetail | ServiceDocumentDetail; sourceType: "project_document" | "service_document" };
export class OutputEvidenceValidationError extends WorkflowIncompleteError {
  constructor(readonly code: "unverified_quote" | "unknown_requirement", message: string) { super(message); }
}

/** Original-quotation and identifier membership is deterministic. It does not
 * establish semantic entailment; that is measured by the release model tier.
 * Callers supply only their already scoped, revision-fenced source snapshot. */
export function bindOutputSourceEvidence(input: { fields: Array<{ path: string; text: string }>; documents: AuthorizedEvidenceDocument[]; authoritativeRequirementRefs?: string[]; artifacts?: AuthorizedEvidenceArtifact[]; verifiedReferences?: ChatSourceReference[]; interpretationOnly?: boolean }, onInvalidField?: (field: { path: string; text: string }, error: OutputEvidenceValidationError) => void): OutputSourceEvidence {
  const documents = input.documents.map(source => ({ ...source, index: new SourceQuoteIndex(source.document.raw_text), ids: new Set(extractRequirementIdentifiers(source.document.raw_text)) }));
  const artifacts = (input.artifacts ?? []).map(artifact => ({ ...artifact, index: new SourceQuoteIndex(artifact.content_markdown), ids: new Set(extractRequirementIdentifiers(artifact.content_markdown)) }));
  const priorReferences = (input.verifiedReferences ?? []).filter(source => source.evidence_id && source.original_quote && source.source_fingerprint && Number.isSafeInteger(source.source_revision)).map(source => ({ source, index: new SourceQuoteIndex(source.original_quote!), ids: new Set(extractRequirementIdentifiers(source.original_quote!)) }));
  const registerIds = new Set((input.authoritativeRequirementRefs ?? []).flatMap(extractRequirementIdentifiers));
  const shape = (id: string) => id.replace(/\d+/gu, "#");
  const registerShapes = new Set([...registerIds].map(shape));
  const references: OutputSourceEvidence["references"] = [];
  for (const field of input.fields) {
    const referenceStart = references.length;
    try {
    for (const id of extractRequirementIdentifiers(field.text)) {
      if (isAmbiguousRequirementIdentifier(id) && !registerIds.has(id) && !registerShapes.has(shape(id))) continue;
      if (!registerIds.has(id) && !documents.some(source => source.ids.has(id)) && !priorReferences.some(source => source.source.source_type !== "generated_artifact" && source.ids.has(id))) throw new OutputEvidenceValidationError("unknown_requirement", "En krav-ID i resultatet finnes ikke i det gjeldende kildegrunnlaget. Kontroller dokumentene før denne formuleringen brukes.");
    }
    const quotes = /(?:^|\.)reference$/u.test(field.path) ? [] : quotedSourcePassages(field.text);
    // Coverage evidence/requirement fields can themselves be verbatim excerpts,
    // without quotation marks. Bind exact matches without labelling prose as a quote.
    const direct = /(?:^|\.)(?:evidence|requirement)$/u.test(field.path) ? [field.text.trim()] : [];
    for (const quote of Array.from(new Set([...quotes, ...direct])).filter(Boolean)) {
      const short = sourceQuoteLength(quote) < 12;
      const meaningfulShort = isMeaningfulShortSourceQuote(quote);
      if (short && !meaningfulShort) continue;
      let knownShortOccurrence = false;
      const candidates = documents.flatMap(source => {
        const original = source.index.find(quote, { tokenBoundaries: short });
        if (!original) return [];
        knownShortOccurrence ||= short;
        const reference = bindDocumentSourceEvidence(source.document, quote, { sourceType: source.sourceType });
        return reference ? [reference] : [];
      });
      for (const artifact of artifacts) {
        if (short) { knownShortOccurrence ||= artifact.index.find(quote, { tokenBoundaries: true }) !== null; continue; }
        const original = artifact.index.find(quote);
        if (!original) continue;
        const fingerprint = createHash("sha256").update(artifact.content_markdown).digest("hex");
        const revision = artifact.artifact_version ?? 0;
        const reference = `Generert utkast · versjon ${revision || "ukjent"}`;
        candidates.push({ source_type: "generated_artifact", source_id: artifact.id, document_title: artifact.title, reference, heading_path: [], page_start: null, page_end: null, source_revision: revision, source_fingerprint: fingerprint, original_quote: original, classification: "interpretation", evidence_id: evidenceIdentity({ sourceType: "generated_artifact", sourceId: artifact.id, revision, fingerprint, reference, text: original }) });
      }
      for (const previous of priorReferences) {
        if (short) { if (previous.source.source_type === "generated_artifact") knownShortOccurrence ||= previous.index.find(quote, { tokenBoundaries: true }) !== null; continue; }
        const original = previous.index.find(quote);
        if (original) candidates.push({ ...previous.source, original_quote: original, quotation_excerpts: undefined,
          evidence_id: evidenceIdentity({ sourceType: previous.source.source_type, sourceId: previous.source.source_id, revision: previous.source.source_revision!, fingerprint: previous.source.source_fingerprint!, reference: previous.source.reference, text: original }) });
      }
      if (!candidates.length && (knownShortOccurrence || !quotes.includes(quote))) continue;
      if (!candidates.length && input.interpretationOnly) continue;
      if (!candidates.length) throw new OutputEvidenceValidationError("unverified_quote", "Et kildesitat i resultatet kunne ikke bekreftes ordrett i dokumentene. Kontroller originalkilden før denne formuleringen brukes.");
      for (const source of candidates) if (!references.some(item => item.path === field.path && item.source.evidence_id === source.evidence_id)) references.push({ path: field.path, source });
    }
    } catch (error) {
      if (!(error instanceof OutputEvidenceValidationError) || !onInvalidField) throw error;
      references.splice(referenceStart);
      onInvalidField(field, error);
    }
  }
  return { version: 1, references };
}

/** An unsupported generated field is withheld, never published as a quotation
 * or invented requirement. Other independently checked fields remain useful. */
export function reviewOutputSourceEvidence(input: Parameters<typeof bindOutputSourceEvidence>[0]) {
  const issues: NonNullable<SourceEvidenceManifest["issues"]> = [];
  const replacements = new Map<string, string>();
  const bound = bindOutputSourceEvidence(input, (field, error) => {
    issues.push({ path: field.path, code: error.code, message: error.publicMessage });
    replacements.set(field.path, "Må avklares. Denne formuleringen ble holdt tilbake fordi kildegrunnlaget ikke kunne bekreftes. Kontroller originaldokumentet og oppdater dette feltet før bruk.");
  });
  const fields = input.fields.map(field => ({ ...field, text: replacements.get(field.path) ?? field.text }));
  return { fields, evidence: { ...bound, ...(issues.length ? { issues } : {}) } };
}

export function reviewStructuredOutputEvidence<T>(value: T, input: Omit<Parameters<typeof bindOutputSourceEvidence>[0], "fields">): { result: T; evidence: SourceEvidenceManifest } {
  const reviewed = reviewOutputSourceEvidence({ ...input, fields: outputEvidenceFields(value) });
  const replacements = new Map(reviewed.fields.map(field => [field.path, field.text]));
  const replace = (item: unknown, at: string): unknown => {
    if (typeof item === "string") return replacements.get(at) ?? item;
    if (Array.isArray(item)) return item.map((child, index) => replace(child, `${at}.${index}`));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, outputProvenanceFields.has(key) ? child : replace(child, `${at}.${key}`)]));
    return item;
  };
  return { result: replace(value, "result") as T, evidence: reviewed.evidence };
}

/** Traverse result strings without serializing JSON punctuation as quotations.
 * Context/snapshot metadata is supplied separately and never treated as output. */
export function outputEvidenceFields(value: unknown, prefix = "result"): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => outputEvidenceFields(item, `${prefix}.${index}`));
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => !outputProvenanceFields.has(key)).flatMap(([key, item]) => outputEvidenceFields(item, `${prefix}.${key}`));
  return [];
}

const outputProvenanceFields = new Set([
  "source_evidence", "source_references", "evaluation_context", "evaluation_provenance_mode",
  "customer_document_id", "solution_document_id", "evaluated_generated_artifact_id",
  "source_document_id", "source_document_title", "answer_document_id", "answer_document_title",
  "heading_path", "page_range", "table_id", "source_reference", "full_reference",
]);

export function reviewRequirementRowOutputEvidence(input: Omit<Parameters<typeof bindOutputSourceEvidence>[0], "fields"> & {
  rows: Array<{ index: number; ref: string; answer: string; evidence: string }>;
  parentRows?: Array<{ ref: string; answer: string; evidence: string }>;
  parentEvidence?: unknown; regeneratedIndexes?: ReadonlySet<number>;
}) {
  const generated = input.rows.filter(row => !input.regeneratedIndexes || input.regeneratedIndexes.has(row.index));
  const reviewed = reviewOutputSourceEvidence({ ...input, fields: generated.flatMap(row => [
    { path: `rows.${row.index}.answer`, text: row.answer }, { path: `rows.${row.index}.evidence`, text: row.evidence },
  ]) });
  const preserved: SourceEvidenceManifest = input.regeneratedIndexes ? unchangedRequirementRowEvidence(input.parentEvidence, input.parentRows ?? [], input.rows, input.regeneratedIndexes) : { version: 1 as const, references: [] };
  const issues = [...preserved.issues ?? [], ...reviewed.evidence.issues ?? []];
  return { fields: reviewed.fields, evidence: { version: 1 as const, references: [...preserved.references, ...reviewed.evidence.references], ...(issues.length ? { issues } : {}) } };
}
