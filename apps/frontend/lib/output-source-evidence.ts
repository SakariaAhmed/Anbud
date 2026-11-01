import { parseChatSourceReferences } from "@/lib/chat-source-references";
import { isRecord } from "@/lib/unknown-values";
import type { SourceEvidenceManifest } from "@/lib/types";

/** Only persisted evidence contract v1 can produce a verified source control. */
export function parseOutputSourceEvidence(value: unknown): SourceEvidenceManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.references)) return { version: 1, references: [] };
  return { version: 1, references: value.references.filter(isRecord).flatMap(entry => {
    if (typeof entry.path !== "string" || !entry.path.trim()) return [];
    const source = parseChatSourceReferences([entry.source])[0];
    if (!source?.source_id || !source.evidence_id || !source.original_quote?.trim() || !source.source_fingerprint || !Number.isSafeInteger(source.source_revision)) return [];
    return [{ path: entry.path, source }];
  }) };
}
