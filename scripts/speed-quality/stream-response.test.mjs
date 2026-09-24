import test from "node:test";
import assert from "node:assert/strict";
import { forwardStream } from "./stream-response.mjs";

test("streams immediately, preserves split UTF-8 bytes and records completion/usage", async () => {
  const text = 'data: {"choices":[{"delta":{"content":"Ærlig"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(text);
  const output = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function* body() { yield bytes.subarray(0, 47); await gate; for (let i = 47; i < bytes.length; i++) yield bytes.subarray(i, i + 1); }
  const requestStart = performance.now() - 75; // Includes time before upstream headers.
  const result = forwardStream(body(), (chunk) => { output.push(chunk); }, requestStart);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.length, 1, "first bytes must arrive before provider finishes");
  release();
  const metadata = await result;
  assert.equal(Buffer.concat(output).toString(), text);
  assert.deepEqual(metadata.usage, { prompt_tokens: 4, completion_tokens: 2 });
  assert.deepEqual(metadata.completion, { finishReasons: ["stop"] });
  assert.ok(metadata.firstContentMs >= 75);
});

test("provider tier is observed for Chat and Responses streams, including explicit downgrade", async () => {
  for (const [payload, expected] of [[{ choices: [], service_tier: "priority" }, "priority"], [{ type: "response.completed", response: { status: "completed", service_tier: "default" } }, "default"]]) {
    const bytes = Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
    async function* body() { yield bytes; }
    const result = await forwardStream(body(), () => {});
    assert.equal(result.returnedServiceTier, expected);
  }
});
