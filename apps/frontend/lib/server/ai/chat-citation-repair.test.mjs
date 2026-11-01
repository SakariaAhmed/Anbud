import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const frontend = new URL("../../..", import.meta.url).pathname;
test("citation repair rejects source-absent numbers and obeys cancellation after EOF", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-citation-repair-"));
  const state = { text: "K-1.3 krever eksport innen 30 dager. [Kilde 1]", calls: 0 };
  globalThis.__chatCitationRepair = state;
  try {
    const completion = path.join(directory, "completion.cjs");
    fs.writeFileSync(completion, `exports.createTextCompletionStream = async input => { const state=globalThis.__chatCitationRepair; state.calls++; state.input=input; return (async function*(){ yield state.text; state.abort?.(); })(); };`);
    const { repairChatCitationParagraph } = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { "@/lib/server/ai/completion": completion, "@": frontend, "server-only": "/dev/null" } })("./chat-citation-repair.ts");
    const sources = [{ document_title: "Krav", evidence_id: "one", original_quote: "K-1.3 krever eksport innen 30 dager." }];
    const paragraph = "K-1.3 krever eksport innen 30 dager.";
    assert.equal(await repairChatCitationParagraph({ paragraph, sources }), state.text);
    state.text = "K-1.3 krever eksport innen 60 dager. [Kilde 1]";
    assert.equal(await repairChatCitationParagraph({ paragraph, sources }), null, "A model cannot introduce a number absent from the captured evidence.");
    state.text = "K-99.9 krever eksport. [Kilde 1]";
    assert.equal(await repairChatCitationParagraph({ paragraph: "K-99.9 krever eksport.", sources }), null);
    state.text = "K-1.3 krever eksport innen 30 dager. [Kilde 1]";
    state.text = 'K-1.3 krever «eksport innen 30 dager». [Kilde 1]';
    assert.equal(await repairChatCitationParagraph({ paragraph: 'K-1.3 krever «eksport innen 60 dager». [Kilde 1]', sources }), state.text, "A failed quote can be corrected only to actual original words.");
    const controller = new AbortController(); state.abort = () => controller.abort();
    await assert.rejects(repairChatCitationParagraph({ paragraph, sources, signal: controller.signal }), error => error.name === "AbortError");
    const calls = state.calls;
    assert.equal(await repairChatCitationParagraph({ paragraph: "x".repeat(4001), sources }), null);
    assert.equal(state.calls, calls, "Oversized or unrelated paragraphs never start a repair call.");
  } finally { delete globalThis.__chatCitationRepair; fs.rmSync(directory, { recursive: true, force: true }); }
});
