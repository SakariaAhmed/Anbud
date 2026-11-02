import { isRecord } from "@/lib/unknown-values";

/** Each sample is one episode. A later navigation records a new sample; nothing
 * here accumulates across episodes. Provider TTFT stays a separate server event. */
export type WorkflowRenderMetric = {
  phase: "requirement_register_render" | "chat_first_render" | "upload_to_ready";
  traceId: string;
  documentId?: string;
  sourceRevision?: number;
  cacheState?: "cold" | "warm";
  status?: "completed" | "failed";
  durationMs: number;
};

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const PHASES: ReadonlyArray<WorkflowRenderMetric["phase"]> = ["requirement_register_render", "chat_first_render", "upload_to_ready"];

function isSourceRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseWorkflowRenderMetric(value: unknown): WorkflowRenderMetric | null {
  if (!isRecord(value) || typeof value.phase !== "string" || !PHASES.some(phase => phase === value.phase)) return null;
  const phase = value.phase as WorkflowRenderMetric["phase"];
  const { traceId, documentId, sourceRevision, cacheState, status, durationMs } = value;
  if (typeof traceId !== "string" || !uuid.test(traceId)) return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3_600_000) return null;
  if (documentId !== undefined && (typeof documentId !== "string" || !uuid.test(documentId))) return null;
  if (sourceRevision !== undefined && !isSourceRevision(sourceRevision)) return null;
  if (cacheState !== undefined && cacheState !== "cold" && cacheState !== "warm") return null;
  if (status !== undefined && status !== "completed" && status !== "failed") return null;
  const failed = status === "failed";

  if (phase === "chat_first_render") {
    // A failure before the first token has no first render to measure.
    if (documentId !== undefined || sourceRevision !== undefined || !cacheState || failed) return null;
    if (durationMs > 600_000) return null;
  } else if (phase === "requirement_register_render") {
    if (documentId !== traceId || sourceRevision === undefined || !cacheState || failed) return null;
    if (durationMs > 600_000) return null;
  } else {
    // A document is new at upload, so cold/warm does not describe it. A failed
    // ingestion never published a ready revision.
    if (documentId !== traceId || cacheState !== undefined || failed === (sourceRevision !== undefined)) return null;
  }

  return {
    phase, traceId, durationMs,
    ...(typeof documentId === "string" ? { documentId } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    ...(cacheState ? { cacheState } : {}),
    ...(failed ? { status: "failed" as const } : {}),
  };
}

/** A chat answer draws on the whole project, so its class is the project's corpus. */
export function workflowCorpusClass<T extends string>(formats: readonly T[]): T | "mixed" | undefined {
  const distinct = new Set(formats);
  return distinct.size > 1 ? "mixed" : formats[0];
}
