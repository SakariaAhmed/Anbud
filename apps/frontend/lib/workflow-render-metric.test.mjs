import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const { parseWorkflowRenderMetric, workflowCorpusClass } = load("./workflow-render-metric.ts");
const { recordWorkflowRenderAfterPaint, workflowCacheState } = load("./client/workflow-render-metric.ts");
const id = "123e4567-e89b-12d3-a456-426614174000";
test("render metric boundary rejects unbounded, foreign-shaped and content-bearing fields", () => {
  const metric = { traceId: id, phase: "requirement_register_render", documentId: id, sourceRevision: 3, cacheState: "cold", durationMs: 125 };
  assert.deepEqual(parseWorkflowRenderMetric({ ...metric, documentText: "never persist" }), metric);
  for (const value of [{ ...metric, durationMs: Infinity }, { ...metric, durationMs: -1 }, { ...metric, durationMs: 600001 }, { ...metric, phase: "made_up" }, { ...metric, traceId: "prompt text" }, { ...metric, documentId: "another" }, { ...metric, documentId: undefined }, { ...metric, sourceRevision: undefined }, { ...metric, sourceRevision: -1 }, { ...metric, sourceRevision: 1.5 }, { ...metric, cacheState: undefined }, { ...metric, cacheState: "hot" }, { ...metric, status: "failed" }, { ...metric, status: "maybe" }]) assert.equal(parseWorkflowRenderMetric(value), null);
});
test("each phase carries only the correlation it can truthfully state", () => {
  const chat = { phase: "chat_first_render", traceId: id, cacheState: "warm", durationMs: 40 };
  assert.deepEqual(parseWorkflowRenderMetric(chat), chat);
  for (const value of [{ ...chat, documentId: id }, { ...chat, sourceRevision: 1 }, { ...chat, cacheState: undefined }, { ...chat, status: "failed" }]) assert.equal(parseWorkflowRenderMetric(value), null);
  const ready = { phase: "upload_to_ready", traceId: id, documentId: id, sourceRevision: 2, durationMs: 1_800_000 };
  assert.deepEqual(parseWorkflowRenderMetric(ready), ready);
  const failed = { phase: "upload_to_ready", traceId: id, documentId: id, status: "failed", durationMs: 20 };
  assert.deepEqual(parseWorkflowRenderMetric(failed), failed);
  for (const value of [{ ...ready, sourceRevision: undefined }, { ...ready, cacheState: "cold" }, { ...ready, documentId: undefined }, { ...failed, sourceRevision: 2 }, { ...ready, durationMs: 3_600_001 }]) assert.equal(parseWorkflowRenderMetric(value), null);
});
test("corpus class names one shared format and otherwise says mixed", () => {
  assert.equal(workflowCorpusClass(["pdf", "pdf"]), "pdf");
  assert.equal(workflowCorpusClass(["pdf", "docx"]), "mixed");
  assert.equal(workflowCorpusClass([]), undefined);
});
test("cache state is cold once per key in a page load", () => {
  assert.equal(workflowCacheState("register:a:1"), "cold");
  assert.equal(workflowCacheState("register:a:1"), "warm");
  assert.equal(workflowCacheState("register:a:2"), "cold");
});
test("render measurement waits for paint frames and abort prevents stale-view telemetry", async () => {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, document: globalThis.document, fetch: globalThis.fetch };
  const frames = new Map(), calls = []; let sequence = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.document = { visibilityState: "visible" };
  globalThis.fetch = async (...args) => { calls.push(args); return new Response(null, { status: 204 }); };
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  try {
    const first = new AbortController();
    recordWorkflowRenderAfterPaint(id, { phase: "chat_first_render", traceId: id, cacheState: "cold" }, performance.now(), first.signal);
    flush(); assert.equal(calls.length, 0); flush(); assert.equal(calls.length, 1);
    const second = new AbortController();
    recordWorkflowRenderAfterPaint(id, { phase: "chat_first_render", traceId: id, cacheState: "warm" }, performance.now(), second.signal);
    flush(); second.abort(); flush(); assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).traceId, id);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
