import type { WorkflowRenderMetric } from "@/lib/workflow-render-metric";
/** Two animation frames allow the committed React content to reach a paint.
 * Cancellation belongs to the view/request that supplied this measurement. */
export function recordWorkflowRenderAfterPaint(projectId: string, metric: Omit<WorkflowRenderMetric, "durationMs">, startedAt: number, signal: AbortSignal) {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", cancel);
      if (!signal.aborted && document.visibilityState === "visible") void fetch(`/api/projects/${encodeURIComponent(projectId)}/performance`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ ...metric, durationMs: performance.now() - startedAt }),
      }).catch(() => undefined);
    });
  });
  const cancel = () => cancelAnimationFrame(frame);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
}
