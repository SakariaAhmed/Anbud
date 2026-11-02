import "server-only";

import { decryptJson, decryptString, encryptJson, encryptString } from "@/lib/server/crypto";
import { isRecord } from "@/lib/unknown-values";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type {
  DocumentEvidenceKind,
  DocumentIntelligenceArtifact,
  DocumentParseQuality,
} from "@/lib/server/document-intelligence/types";
import { isMissingRelationColumn } from "@/lib/server/repositories/postgrest-compat";
import { createServiceClient } from "@/lib/server/data-api";

const ARTIFACT_TABLE = "document_intelligence_artifacts";
const EVENT_TABLE = "document_intelligence_events";
const SAVE_ARTIFACT_FUNCTION = "save_document_intelligence_artifact";

/** Legacy artifacts have no register. Corrupted or mismatched registers must
 * fail instead of masquerading as an empty authoritative requirement list. */
export function parsePersistedRequirementRegister(value: unknown, expected: { documentId: string; projectId: string; sourceRevision: number }): RequirementLedgerEntry[] | null {
  if (!isRecord(value) || value.documentId !== expected.documentId || value.projectId !== expected.projectId || value.sourceRevision !== expected.sourceRevision) {
    throw new Error("Kravregisteret samsvarer ikke med dokumentversjonen.");
  }
  if (value.requirementRegister === undefined) return null;
  if (!isRecord(value.requirementRegister) || (value.requirementRegister.version !== 1 && value.requirementRegister.version !== 2) || !Array.isArray(value.requirementRegister.rows)) throw new Error("Det lagrede kravregisteret kan ikke valideres.");
  const registerVersion = value.requirementRegister.version;
  return value.requirementRegister.rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim() || typeof row.text !== "string" || !row.text.trim() ||
      typeof row.heading !== "string" || !Array.isArray(row.pages) || row.pages.some(page => !Number.isSafeInteger(page) || Number(page) <= 0 || Number(page) > 100_000) ||
      (row.documentId !== undefined && row.documentId !== expected.documentId) ||
      (row.idOrigin !== undefined && !["source", "inferred", "generated"].includes(String(row.idOrigin)))) {
      throw new Error("Det lagrede kravregisteret kan ikke valideres.");
    }
    const correction = row.correctionSource;
    const textOrigin = registerVersion === 2 ? row.textOrigin ?? "unknown" : "unknown";
    const textEvidence = row.textEvidence;
    if (!["observed", "reconstructed", "unknown"].includes(String(textOrigin)) ||
      (textOrigin === "observed" && (!isRecord(textEvidence) || typeof textEvidence.originalText !== "string" || !textEvidence.originalText.trim() ||
      !Number.isSafeInteger(textEvidence.start) || Number(textEvidence.start) < 0 || !Number.isSafeInteger(textEvidence.end) || Number(textEvidence.end) - Number(textEvidence.start) !== textEvidence.originalText.length))) throw new Error("Kravtekstens opprinnelse kunne ikke valideres.");
    if (correction !== undefined && (!isRecord(correction) || correction.documentId !== expected.documentId || typeof correction.documentTitle !== "string" || typeof correction.excerpt !== "string" ||
      !Array.isArray(correction.pages) || correction.pages.some(page => !Number.isSafeInteger(page) || Number(page) <= 0 || Number(page) > 100_000))) throw new Error("Kravrettelsens kilde kunne ikke valideres.");
    return { id: row.id, text: row.text, heading: row.heading, pages: row.pages as number[],
      textOrigin: textOrigin as RequirementLedgerEntry["textOrigin"],
      ...(textOrigin === "observed" && isRecord(textEvidence) ? { textEvidence: { originalText: String(textEvidence.originalText), start: Number(textEvidence.start), end: Number(textEvidence.end) } } : {}),
      documentId: expected.documentId, documentTitle: typeof row.documentTitle === "string" ? row.documentTitle : undefined,
      idOrigin: row.idOrigin as RequirementLedgerEntry["idOrigin"], originalId: typeof row.originalId === "string" ? row.originalId : undefined,
      sourceExcerpt: typeof row.sourceExcerpt === "string" ? row.sourceExcerpt : undefined,
      tableId: typeof row.tableId === "string" ? row.tableId : undefined,
      ...(isRecord(correction) ? { correctionSource: { documentId: String(correction.documentId), documentTitle: String(correction.documentTitle), excerpt: String(correction.excerpt), pages: correction.pages as number[], heading: typeof correction.heading === "string" ? correction.heading : undefined } } : {}),
    };
  });
}

export async function readDocumentRequirementRegister(input: { documentId: string; projectId: string; sourceRevision: number }) {
  const { data, error } = await createServiceClient().from(ARTIFACT_TABLE)
    .select("artifact_encrypted").eq("project_id", input.projectId).eq("document_id", input.documentId)
    .eq("source_revision", input.sourceRevision).maybeSingle();
  if (error && isMissingRelationColumn(error, ARTIFACT_TABLE)) return null;
  if (error) throw new Error("Kunne ikke hente det lagrede kravregisteret.");
  if (!data) return null;
  return parsePersistedRequirementRegister(decryptJson<unknown>(data.artifact_encrypted, null), input);
}

function isMissingDocumentIntelligenceSchema(error: { message?: string } | null) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    (message.includes(ARTIFACT_TABLE) || message.includes(SAVE_ARTIFACT_FUNCTION)) &&
    (message.includes("schema cache") ||
      message.includes("does not exist") ||
      message.includes("could not find"))
  );
}

export type DocumentIntelligenceEventType =
  | "parse_compiled"
  | "parser_escalated"
  | "parser_fallback"
  | "customer_analysis_used"
  | "analysis_regenerated"
  | "analysis_manually_edited";

export async function storeDocumentIntelligenceArtifact(
  artifact: DocumentIntelligenceArtifact,
) {
  const dataApi = createServiceClient();
  const { data, error } = await dataApi.rpc(SAVE_ARTIFACT_FUNCTION, {
    p_document_id: artifact.documentId,
    p_project_id: artifact.projectId,
    p_source_revision: artifact.sourceRevision,
    p_compiler_version: artifact.compilerVersion,
    p_content_hash: artifact.contentHash,
    p_parser_used: artifact.parserUsed,
    p_quality: artifact.routing.quality,
    p_evidence_counts: artifact.evidenceCounts,
    p_artifact_encrypted: encryptJson(artifact),
    p_analysis_context_encrypted: encryptString(artifact.analysisContext),
    p_updated_at: artifact.compiledAt,
  });
  if (error && isMissingDocumentIntelligenceSchema(error)) return false;
  if (error) throw new Error(error.message || "Kunne ikke lagre dokumentevidens.");
  return data === true;
}

export type DocumentIntelligenceContext = {
  documentId: string;
  sourceRevision: number;
  compilerVersion: string;
  parserUsed: string;
  quality: DocumentParseQuality | Record<string, never>;
  evidenceCounts: Partial<Record<DocumentEvidenceKind, number>>;
  analysisContext: string;
};

export async function listDocumentIntelligenceContexts(input: {
  projectId: string;
  documentIds: string[];
}): Promise<DocumentIntelligenceContext[]> {
  const documentIds = [...new Set(input.documentIds.filter(Boolean))];
  if (!documentIds.length) return [];
  const dataApi = createServiceClient();
  const { data, error } = await dataApi
    .from(ARTIFACT_TABLE)
    .select(
      "document_id, source_revision, compiler_version, parser_used, quality, evidence_counts, analysis_context_encrypted",
    )
    .eq("project_id", input.projectId)
    .in("document_id", documentIds);
  if (error && isMissingRelationColumn(error, ARTIFACT_TABLE)) return [];
  if (error) throw new Error(error.message || "Kunne ikke hente dokumentevidens.");

  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
    const documentId = String(row.document_id ?? "");
    const encryptedContext = String(row.analysis_context_encrypted ?? "");
    const sourceRevision = Number(row.source_revision ?? -1);
    if (!documentId || !encryptedContext || !Number.isInteger(sourceRevision)) {
      return [];
    }
    return [
      {
        documentId,
        sourceRevision,
        compilerVersion: String(row.compiler_version ?? ""),
        parserUsed: String(row.parser_used ?? ""),
        quality:
          row.quality && typeof row.quality === "object"
            ? (row.quality as DocumentParseQuality)
            : {},
        evidenceCounts:
          row.evidence_counts && typeof row.evidence_counts === "object"
            ? (row.evidence_counts as Partial<
                Record<DocumentEvidenceKind, number>
              >)
            : {},
        analysisContext: decryptString(encryptedContext),
      },
    ];
  });
}

export async function recordDocumentIntelligenceEvent(input: {
  projectId: string;
  documentId?: string | null;
  eventType: DocumentIntelligenceEventType;
  sourceRevision?: number | null;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const dataApi = createServiceClient();
  const { error } = await dataApi.from(EVENT_TABLE).insert({
    project_id: input.projectId,
    document_id: input.documentId ?? null,
    event_type: input.eventType,
    source_revision: input.sourceRevision ?? null,
    metadata: input.metadata ?? {},
  });
  if (error && isMissingRelationColumn(error, EVENT_TABLE)) return false;
  if (error) throw new Error(error.message || "Kunne ikke registrere dokumenthendelse.");
  return true;
}
