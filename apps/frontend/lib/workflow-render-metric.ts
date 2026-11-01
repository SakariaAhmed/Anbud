import { isRecord } from "@/lib/unknown-values";
export type WorkflowRenderMetric = { phase: "requirement_register_render" | "chat_first_render"; traceId: string; documentId?: string; durationMs: number };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export function parseWorkflowRenderMetric(value: unknown): WorkflowRenderMetric | null {
  if (!isRecord(value) || !["requirement_register_render", "chat_first_render"].includes(String(value.phase)) || typeof value.traceId !== "string" || !uuid.test(value.traceId) || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 600_000 || (value.documentId !== undefined && (typeof value.documentId !== "string" || !uuid.test(value.documentId)))) return null;
  if (value.phase === "requirement_register_render" && value.documentId !== value.traceId) return null;
  if (value.phase === "chat_first_render" && value.documentId !== undefined) return null;
  return { phase: value.phase as WorkflowRenderMetric["phase"], traceId: value.traceId, ...(typeof value.documentId === "string" ? { documentId: value.documentId } : {}), durationMs: value.durationMs };
}
