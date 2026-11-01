import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const load = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const { parseWorkflowRenderMetric } = load("./workflow-render-metric.ts");
const { recordWorkflowRenderAfterPaint } = load("./client/workflow-render-metric.ts");
const id = "123e4567-e89b-12d3-a456-426614174000";
test("render metric boundary rejects unbounded, foreign-shaped and content-bearing fields", () => {
  const metric = { traceId: id, phase: "requirement_register_render", documentId: id, durationMs: 125 };
  assert.deepEqual(parseWorkflowRenderMetric({ ...metric, documentText: "never persist" }), metric);
  for (const value of [{ ...metric, durationMs: Infinity }, { ...metric, durationMs: -1 }, { ...metric, durationMs: 600001 }, { ...metric, phase: "made_up" }, { ...metric, traceId: "prompt text" }, { ...metric, documentId: "another" }, { ...metric, phase: "chat_first_render" }]) assert.equal(parseWorkflowRenderMetric(value), null);
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
    recordWorkflowRenderAfterPaint(id, { phase: "chat_first_render", traceId: id }, performance.now(), first.signal);
    flush(); assert.equal(calls.length, 0); flush(); assert.equal(calls.length, 1);
    const second = new AbortController();
    recordWorkflowRenderAfterPaint(id, { phase: "chat_first_render", traceId: id }, performance.now(), second.signal);
    flush(); second.abort(); flush(); assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0][1].body).traceId, id);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});
