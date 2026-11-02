import { isRecord } from "@/lib/unknown-values";
import type { AutomaticAnalysisRequest } from "@/lib/types";

export function parseAutomaticAnalysisRequest(value: unknown): AutomaticAnalysisRequest | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.request_id !== "string" || typeof value.status !== "string" || !["pending", "scheduled", "completed", "failed", "cancelled"].includes(value.status) || typeof value.updated_at !== "string") throw new Error("Automatisk analysestatus er ugyldig.");
  return { request_id: value.request_id, status: value.status as AutomaticAnalysisRequest["status"], job_id: typeof value.job_id === "string" ? value.job_id : null, source_revision: Number.isSafeInteger(value.source_revision) ? Number(value.source_revision) : null, reason_code: typeof value.reason_code === "string" ? value.reason_code : null, updated_at: value.updated_at };
}
