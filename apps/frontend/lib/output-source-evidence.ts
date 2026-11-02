import { parseChatSourceReferences } from "@/lib/chat-source-references";
import { isRecord } from "@/lib/unknown-values";
import type { SourceEvidenceManifest } from "@/lib/types";

/** Only persisted evidence contract v1 can produce a verified source control. */
export function parseOutputSourceEvidence(value: unknown): SourceEvidenceManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.references)) return { version: 1, references: [] };
  const issues: NonNullable<SourceEvidenceManifest["issues"]> = Array.isArray(value.issues) ? value.issues.filter(isRecord).flatMap(issue =>
    typeof issue.path === "string" && (issue.code === "unverified_quote" || issue.code === "unknown_requirement") && typeof issue.message === "string"
      ? [{ path: issue.path, code: issue.code, message: issue.message.slice(0, 1000) }] : []) : [];
  return { version: 1, ...(issues.length ? { issues } : {}), references: value.references.filter(isRecord).flatMap(entry => {
    if (typeof entry.path !== "string" || !entry.path.trim()) return [];
    const source = parseChatSourceReferences([entry.source])[0];
    if (!source?.source_id || !source.evidence_id || !source.original_quote?.trim() || !source.source_fingerprint || !Number.isSafeInteger(source.source_revision)) return [];
    return [{ path: entry.path, source }];
  }) };
}

/** Proof belongs to a cell's exact saved text, including manually edited rows.
 * Never turn an absent proof into a new verified quotation during a merge. */
export function unchangedRequirementRowEvidence(value: unknown,
  before: Array<{ ref: string; answer: string; evidence: string }>,
  after: Array<{ ref: string; answer: string; evidence: string }>,
  excludedIndexes: ReadonlySet<number> = new Set(),
): SourceEvidenceManifest {
  const unchanged = (path: string) => {
    const match = path.match(/^rows\.(\d+)\.(answer|evidence)$/u);
    if (!match) return false;
    const index = Number(match[1]), field = match[2] as "answer" | "evidence";
    return !excludedIndexes.has(index) && Boolean(before[index] && after[index] &&
      before[index].ref === after[index].ref && before[index][field] === after[index][field]);
  };
  const evidence = parseOutputSourceEvidence(value);
  const issues = evidence.issues?.filter(entry => unchanged(entry.path));
  return { version: 1, references: evidence.references.filter(entry => unchanged(entry.path)), ...(issues?.length ? { issues } : {}) };
}
