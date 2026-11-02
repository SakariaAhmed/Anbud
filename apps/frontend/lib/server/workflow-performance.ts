import "server-only";
import type { DocumentFileFormat } from "@/lib/types";

/** Metadata only. No filenames, document text, prompts, answers or credentials. */
export function recordWorkflowPerformance(input: {
  traceId: string;
  projectId: string;
  jobId?: string;
  jobKind?: string;
  documentId?: string;
  documentClass?: DocumentFileFormat | "mixed";
  sourceRevision?: number;
  cacheState?: "cold" | "warm";
  operation: "document" | "chat" | "generation" | "browser";
  phase: string;
  durationMs: number;
  status?: "completed" | "failed";
}) {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  console.info(JSON.stringify({ event: "workflow_performance", trace_id: input.traceId,
    project_id: input.projectId, job_id: input.jobId, job_kind: input.jobKind, document_id: input.documentId,
    document_class: input.documentClass, source_revision: input.sourceRevision, cache_state: input.cacheState,
    operation: input.operation, phase: input.phase,
    duration_ms: Math.round(input.durationMs), status: input.status ?? "completed" }));
}
