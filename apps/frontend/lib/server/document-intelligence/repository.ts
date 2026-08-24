import "server-only";

import { decryptString, encryptJson, encryptString } from "@/lib/server/crypto";
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
