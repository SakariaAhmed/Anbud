import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkflowPerformance } from "./workflow_performance_report.mjs";
test("reports correlated class percentiles, failed samples and verified weighted cache usage separately", () => {
  const row = (duration_ms, extra = {}) => ({ event: "workflow_performance", operation: "document", trace_id: "same-document", phase: "queue_wait", duration_ms, ...extra });
  const report = summarizeWorkflowPerformance([row(100), row(200), row(10, { status: "failed" }), row(-1), row(NaN), row(300, { phase: "parse", document_class: "pdf" }), null,
    { event: "chat_completion", input_tokens: 100, cached_tokens: 60 }, { event: "chat_completion", input_tokens: 900, cached_tokens: 900 },
    { event: "chat_completion", input_tokens: 10, cached_tokens: 20 }, { event: "chat_completion", input_tokens: 10 }], "local synthetic");
  const queue = report.phases.find(row => row.phase === "queue_wait");
  assert.deepEqual(queue, { operation: "document", phase: "queue_wait", document_class: "pdf", failed: 1, samples: 2, p50_ms: 100, p95_ms: 200 });
  assert.equal(report.chat_cache.cached_fraction, 0.96);
  assert.equal(report.chat_cache.measured_responses, 2);
  assert.doesNotMatch(JSON.stringify(report), /same-document/u);
  assert.equal(summarizeWorkflowPerformance([]).chat_cache.cached_fraction, null);
});
