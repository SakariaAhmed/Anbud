import { parseChatSourceReferences } from "@/lib/chat-source-references";
import { isRecord } from "@/lib/unknown-values";
import type { SourceEvidenceManifest } from "@/lib/types";

/** Only persisted evidence contract v1 can produce a verified source control. */
export function parseOutputSourceEvidence(value: unknown): SourceEvidenceManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.references)) return { version: 1, references: [] };
  const issues: NonNullable<SourceEvidenceManifest["issues"]> = Array.isArray(value.issues) ? value.issues.filter(isRecord).flatMap(issue =>
    typeof issue.path === "string" && (issue.code === "unverified_quote" || issue.code === "unknown_requirement" || issue.code === "unverified_locator") && typeof issue.message === "string"
      ? [{ path: issue.path, code: issue.code, message: issue.message.slice(0, 1000) }] : []) : [];
  const candidates = Array.isArray(value.row_confidence) ? value.row_confidence.filter(isRecord) : [];
  const confidence: NonNullable<SourceEvidenceManifest["row_confidence"]> = candidates.flatMap(row => {
    if (!Number.isSafeInteger(row.index) || Number(row.index) < 0 || typeof row.ref !== "string" || typeof row.row_hash !== "string" || !/^[a-f0-9]{64}$/u.test(row.row_hash) ||
      !["documented_excerpt", "needs_review", "unknown"].includes(String(row.level)) || !Array.isArray(row.reasons) || !row.reasons.length || row.reasons.some(reason => typeof reason !== "string") ||
      candidates.filter(other => other.index === row.index).length !== 1) return [];
    return [{ index: Number(row.index), ref: row.ref, row_hash: row.row_hash, level: row.level as "documented_excerpt" | "needs_review" | "unknown", reasons: row.reasons as string[] }];
  });
  return { version: 1, ...(confidence.length ? { row_confidence: confidence } : {}), ...(issues.length ? { issues } : {}), references: value.references.filter(isRecord).flatMap(entry => {
    if (typeof entry.path !== "string" || !entry.path.trim()) return [];
    const source = parseChatSourceReferences([entry.source])[0];
    if (!source?.source_id || !source.evidence_id || !source.original_quote?.trim() || !source.source_fingerprint || !Number.isSafeInteger(source.source_revision)) return [];
    return [{ path: entry.path, source }];
  }) };
}

/** Proof belongs to a cell's exact saved text, including manually edited rows.
 * Never turn an absent proof into a new verified quotation during a merge. */
export function unchangedRequirementRowEvidence(value: unknown,
  before: Array<{ ref: string; answer: string; evidence: string; rowHash?: string }>,
  after: Array<{ ref: string; answer: string; evidence: string; rowHash?: string }>,
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
  const confidence = evidence.row_confidence?.filter(row => unchanged(`rows.${row.index}.answer`) && unchanged(`rows.${row.index}.evidence`) && before[row.index]?.rowHash === row.row_hash && after[row.index]?.rowHash === row.row_hash);
  return { version: 1, references: evidence.references.filter(entry => unchanged(entry.path)), ...(issues?.length ? { issues } : {}), ...(confidence?.length ? { row_confidence: confidence } : {}) };
}
