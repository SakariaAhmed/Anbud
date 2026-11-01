import "server-only";
import { createHash } from "node:crypto";
import { extractRequirementIdentifiers } from "@/lib/server/ai/retrieval-query";
import { SourceQuoteIndex, quotedSourcePassages, evidenceIdentity } from "@/lib/server/source-evidence";
import { bindDocumentSourceEvidence } from "@/lib/server/document-source-evidence";
import type { ChatSourceReference, ProjectDocumentDetail, ServiceDocumentDetail, SourceEvidenceManifest } from "@/lib/types";

export type OutputSourceEvidence = SourceEvidenceManifest;
export type AuthorizedEvidenceArtifact = { id: string; title: string; content_markdown: string; artifact_version?: number };
export type AuthorizedEvidenceDocument = { document: ProjectDocumentDetail | ServiceDocumentDetail; sourceType: "project_document" | "service_document" };

/** Original-quotation and identifier membership is deterministic. It does not
 * establish semantic entailment; that is measured by the release model tier.
 * Callers supply only their already scoped, revision-fenced source snapshot. */
export function bindOutputSourceEvidence(input: { fields: Array<{ path: string; text: string }>; documents: AuthorizedEvidenceDocument[]; authoritativeRequirementRefs?: string[]; artifacts?: AuthorizedEvidenceArtifact[]; verifiedReferences?: ChatSourceReference[] }): OutputSourceEvidence {
  const documents = input.documents.map(source => ({ ...source, index: new SourceQuoteIndex(source.document.raw_text), ids: new Set(extractRequirementIdentifiers(source.document.raw_text)) }));
  const artifacts = (input.artifacts ?? []).map(artifact => ({ ...artifact, index: new SourceQuoteIndex(artifact.content_markdown), ids: new Set(extractRequirementIdentifiers(artifact.content_markdown)) }));
  const priorReferences = (input.verifiedReferences ?? []).filter(source => source.evidence_id && source.original_quote && source.source_fingerprint && Number.isSafeInteger(source.source_revision)).map(source => ({ source, index: new SourceQuoteIndex(source.original_quote!), ids: new Set(extractRequirementIdentifiers(source.original_quote!)) }));
  const registerIds = new Set((input.authoritativeRequirementRefs ?? []).flatMap(extractRequirementIdentifiers));
  const references: OutputSourceEvidence["references"] = [];
  for (const field of input.fields) {
    for (const id of extractRequirementIdentifiers(field.text)) {
      if (!registerIds.has(id) && !documents.some(source => source.ids.has(id)) && !priorReferences.some(source => source.source.source_type !== "generated_artifact" && source.ids.has(id))) throw new Error("En krav-ID i resultatet finnes ikke i det gjeldende kildegrunnlaget. Kontroller dokumentene og generer resultatet på nytt.");
    }
    const quotes = quotedSourcePassages(field.text);
    // Coverage evidence/requirement fields can themselves be verbatim excerpts,
    // without quotation marks. Bind exact matches without labelling prose as a quote.
    const direct = /(?:^|\.)(?:evidence|requirement)$/u.test(field.path) ? [field.text.trim()] : [];
    for (const quote of Array.from(new Set([...quotes, ...direct])).filter(Boolean)) {
      const candidates = documents.flatMap(source => {
        const original = source.index.find(quote);
        if (!original) return [];
        const reference = bindDocumentSourceEvidence(source.document, original, { sourceType: source.sourceType });
        return reference ? [reference] : [];
      });
      for (const artifact of artifacts) {
        const original = artifact.index.find(quote);
        if (!original) continue;
        const fingerprint = createHash("sha256").update(artifact.content_markdown).digest("hex");
        const revision = artifact.artifact_version ?? 0;
        const reference = `Generert utkast · versjon ${revision || "ukjent"}`;
        candidates.push({ source_type: "generated_artifact", source_id: artifact.id, document_title: artifact.title, reference, heading_path: [], page_start: null, page_end: null, source_revision: revision, source_fingerprint: fingerprint, original_quote: original, classification: "interpretation", evidence_id: evidenceIdentity({ sourceType: "generated_artifact", sourceId: artifact.id, revision, fingerprint, reference, text: original }) });
      }
      for (const previous of priorReferences) {
        const original = previous.index.find(quote);
        if (original) candidates.push({ ...previous.source, original_quote: original, quotation_excerpts: undefined,
          evidence_id: evidenceIdentity({ sourceType: previous.source.source_type, sourceId: previous.source.source_id, revision: previous.source.source_revision!, fingerprint: previous.source.source_fingerprint!, reference: previous.source.reference, text: original }) });
      }
      if (!candidates.length && !quotes.includes(quote)) continue;
      if (!candidates.length) throw new Error("Et kildesitat i resultatet kunne ikke bekreftes ordrett i dokumentene. Kontroller grunnlaget og generer resultatet på nytt.");
      for (const source of candidates) if (!references.some(item => item.path === field.path && item.source.evidence_id === source.evidence_id)) references.push({ path: field.path, source });
    }
  }
  return { version: 1, references };
}

/** Traverse result strings without serializing JSON punctuation as quotations.
 * Context/snapshot metadata is supplied separately and never treated as output. */
export function outputEvidenceFields(value: unknown, prefix = "result"): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => outputEvidenceFields(item, `${prefix}.${index}`));
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => key !== "source_evidence" && key !== "source_references").flatMap(([key, item]) => outputEvidenceFields(item, `${prefix}.${key}`));
  return [];
}
