import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const directory = mkdtempSync(path.join(tmpdir(), "anbud-response-stream-"));
const sdk = path.join(directory, "sdk.cjs");
writeFileSync(sdk, `module.exports = class OpenAI {
  constructor() { this.responses = { create: async (body, options) => {
    globalThis.__anbudResponseStream.calls.push({ body, options });
    return (async function* () { for (const event of globalThis.__anbudResponseStream.events) { if (typeof event === "function") event(); else yield event; } })();
  } }; }
};`);
const root = path.resolve(import.meta.dirname, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "openai/error": path.join(root, "node_modules/openai/error.js"), openai: sdk, "@": root, "server-only": "/dev/null" } });
const { createTextCompletionStream } = jiti("./completion.ts");
const completed = { type: "response.completed", response: { usage: { input_tokens: 1200, output_tokens: 3, input_tokens_details: { cached_tokens: 1100 } } } };
const input = { system: "Stable contract", user: "Question", model: "gpt-5.4-mini", promptCacheKey: "project-1" };
const collect = async stream => { let text = ""; for await (const part of stream) text += part; return text; };
const previousKey = process.env.OPENAI_API_KEY;
test.before(() => { process.env.OPENAI_API_KEY = "local-stream-test"; });
test.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; delete globalThis.__anbudResponseStream; rmSync(directory, { recursive: true, force: true }); });
test("Responses streams text in order, uses stable project cache keys, and reports verified cache usage", async () => {
  const state = globalThis.__anbudResponseStream = { calls: [], events: [{ type: "response.output_text.delta", delta: "Hei " }, { type: "response.output_text.delta", delta: "Norge" }, completed] };
  const events = [], originalLog = console.info;
  console.info = line => events.push(JSON.parse(line));
  try {
    assert.equal(await collect(await createTextCompletionStream(input)), "Hei Norge");
    await collect(await createTextCompletionStream({ ...input, user: "Another question" }));
    await collect(await createTextCompletionStream({ ...input, promptCacheKey: "project-2" }));
  } finally { console.info = originalLog; }
  assert.equal(state.calls[0].body.store, false);
  assert.equal(state.calls[0].body.prompt_cache_key, state.calls[1].body.prompt_cache_key);
  assert.notEqual(state.calls[0].body.prompt_cache_key, state.calls[2].body.prompt_cache_key);
  assert.equal(events.filter(event => event.event === "chat_first_token").length, 3);
  assert.equal(events.find(event => event.event === "chat_completion").cached_tokens, 1100);
});
test("failed, incomplete, disconnected and cancelled streams never complete successfully", async () => {
  for (const events of [[{ type: "response.failed" }], [{ type: "response.incomplete" }], [{ type: "error", message: "private provider body" }], [{ type: "response.output_text.delta", delta: "partial" }]]) {
    globalThis.__anbudResponseStream = { calls: [], events };
    await assert.rejects(collect(await createTextCompletionStream(input)), error => !error.message.includes("private"));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createTextCompletionStream({ ...input, signal: abort.signal }), { name: "AbortError" });
  for (const atEnd of [false, true]) {
    const controller = new AbortController();
    const delta = { type: "response.output_text.delta", delta: "partial" };
    globalThis.__anbudResponseStream = { calls: [], events: atEnd ? [delta, completed, () => controller.abort()] : [delta, () => controller.abort(), completed] };
    await assert.rejects(collect(await createTextCompletionStream({ ...input, signal: controller.signal })), { name: "AbortError" });
  }
});
