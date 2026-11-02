import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkflowPerformance } from "./workflow_performance_report.mjs";

const protocol = { id: "test", minimum_samples_per_cell: 2, percentile_method: "nearest-rank", cells: [
  { operation: "browser", phase: "upload_to_ready", document_classes: ["pdf"], cache_states: ["n/a"] },
  { operation: "document", job_kind: "document_ingestion", phase: "total", document_classes: ["pdf"], cache_states: ["n/a"] },
] };
const summarize = (events, label = "local synthetic") => summarizeWorkflowPerformance(events, { label, protocol });
const row = (duration_ms, extra = {}) => ({ event: "workflow_performance", operation: "document", trace_id: "same-document", phase: "queue_wait", duration_ms, ...extra });

test("class correlation, failed samples and invalid durations are reported separately", () => {
  const report = summarize([row(100), row(200), row(10, { status: "failed" }), row(-1), row(NaN), row(300, { phase: "parse", document_class: "pdf" }), null]);
  const queue = report.phases.find(item => item.phase === "queue_wait");
  assert.equal(queue.document_class, "pdf");
  assert.equal(queue.cache_state, "n/a");
  assert.deepEqual([queue.samples, queue.failed, queue.attempts, queue.p50_ms, queue.p95_ms, queue.failed_p50_ms, queue.all_p50_ms], [2, 1, 3, 100, 200, 10, 100]);
  assert.equal(queue.failure_rate, 1 / 3);
  assert.doesNotMatch(JSON.stringify(report), /same-document/u);
});

test("cache fraction is token-weighted, excludes unverifiable usage and stays per class", () => {
  const report = summarize([
    { event: "workflow_performance", operation: "browser", phase: "chat_first_render", trace_id: "a", document_class: "pdf", cache_state: "cold", duration_ms: 5 },
    { event: "chat_completion", trace_id: "a", input_tokens: 100, cached_tokens: 60 },
    { event: "chat_completion", trace_id: "b", input_tokens: 900, cached_tokens: 900 },
    { event: "chat_completion", input_tokens: 10, cached_tokens: 20 }, { event: "chat_completion", input_tokens: 10 },
  ]);
  assert.equal(report.chat_cache.cached_fraction, 0.96, "A mean of per-response fractions would say 0.8.");
  assert.equal(report.chat_cache.measured_responses, 2);
  assert.equal(report.chat_cache.by_document_class.pdf.cached_fraction, 0.6);
  assert.equal(report.chat_cache.by_document_class.unknown.cached_fraction, 1);
  assert.equal(summarize([]).chat_cache.cached_fraction, null);
});

test("provider TTFT, app first token and user first render never share a group", () => {
  const trace = { trace_id: "chat", document_class: "pdf" };
  const report = summarize([
    { event: "chat_first_token", ...trace, duration_ms: 400 },
    { event: "workflow_performance", operation: "chat", phase: "first_token", ...trace, duration_ms: 900 },
    { event: "workflow_performance", operation: "browser", phase: "chat_first_render", cache_state: "cold", ...trace, duration_ms: 1000 },
    { event: "workflow_performance", operation: "browser", phase: "chat_first_render", cache_state: "warm", trace_id: "chat-2", document_class: "pdf", duration_ms: 500 },
  ]);
  const names = report.phases.map(item => `${item.operation}/${item.phase}/${item.cache_state}:${item.p50_ms}`).sort();
  assert.deepEqual(names, ["browser/chat_first_render/cold:1000", "browser/chat_first_render/warm:500", "chat/first_token/n/a:900", "provider_chat/first_token/n/a:400"]);
});

test("episodes stay separate samples and one action is not counted twice", () => {
  const browser = (phase, duration_ms, extra) => ({ event: "workflow_performance", operation: "browser", phase, duration_ms, trace_id: "doc", document_class: "pdf", ...extra });
  const report = summarize([
    browser("upload_to_ready", 1000, { source_revision: 2 }), browser("upload_to_ready", 9000, { source_revision: 2 }),
    browser("upload_to_ready", 4000, { source_revision: 3 }),
    browser("requirement_register_render", 50, { source_revision: 2, cache_state: "warm" }), browser("requirement_register_render", 70, { source_revision: 2, cache_state: "warm" }),
  ]);
  const ready = report.phases.find(item => item.phase === "upload_to_ready");
  assert.deepEqual([ready.samples, ready.p50_ms, ready.distinct_source_revisions], [2, 1000, 2], "The replayed report must not enter the percentile.");
  assert.equal(report.data_quality.duplicate_action_samples_dropped, 1);
  const register = report.phases.find(item => item.phase === "requirement_register_render");
  assert.deepEqual([register.samples, register.p50_ms, register.p95_ms], [2, 50, 70], "Two navigations are two samples, never 120 ms.");
  assert.equal(report.data_quality.browser_samples_without_server_trace, 4);
});

test("ingestion and later enhancement of one document are different operations", () => {
  const report = summarize([
    row(1000, { phase: "total", document_class: "pdf", job_kind: "document_ingestion", trace_id: "d" }),
    row(90000, { phase: "total", document_class: "pdf", job_kind: "document_docling_enhancement", trace_id: "d" }),
  ]);
  const totals = report.phases.filter(item => item.phase === "total").map(item => [item.job_kind, item.p50_ms]).sort();
  assert.deepEqual(totals, [["document_docling_enhancement", 90000], ["document_ingestion", 1000]]);
});

test("a baseline is insufficient until every frozen cell has its minimum sample count", () => {
  const server = n => row(n, { phase: "total", document_class: "pdf", job_kind: "document_ingestion", trace_id: `t${n}` });
  const ready = n => ({ event: "workflow_performance", operation: "browser", phase: "upload_to_ready", duration_ms: n, trace_id: `t${n}`, document_class: "pdf", source_revision: 1 });
  const partial = summarize([server(1), server(2), ready(1)]);
  assert.equal(partial.baseline_status, "insufficient_samples");
  assert.deepEqual(partial.missing_cells, [{ operation: "browser", phase: "upload_to_ready", document_class: "pdf", cache_state: "n/a", samples: 1, required: 2 }]);
  assert.equal(partial.phases.find(item => item.phase === "upload_to_ready").meets_protocol_minimum, false);
  const complete = summarize([server(1), server(2), ready(1), ready(2)]);
  assert.equal(complete.baseline_status, "protocol_cells_complete");
  assert.deepEqual(complete.missing_cells, []);
  assert.equal(complete.data_quality.browser_samples_without_server_trace, 0);
  assert.equal(complete.label, "local synthetic");
});
