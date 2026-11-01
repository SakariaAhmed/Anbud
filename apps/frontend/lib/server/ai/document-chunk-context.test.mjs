import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const frontend = path.resolve(import.meta.dirname, "../../..");
const load = createJiti(import.meta.url, { alias: { "@": frontend, "server-only": "/dev/null" } });
const { buildDocumentTextChunks } = await load.import(path.join(frontend, "lib/server/ai/document-chunk-context.ts"));

test("long source entries retain late evidence and references across bounded chunks", () => {
  const reference = "Side 7";
  const text = `${"Tidlig evidens. ".repeat(1000)}Siste forbehold må bevares.`;
  const document = { title: "Tilbud", structure_map: [{ reference, text }], raw_text: text };
  const chunks = buildDocumentTextChunks(document, { chunkLimit: 6500, maxChunks: 8 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.text.length <= 6500 && chunk.references[0] === reference));
  assert.equal(chunks.map(chunk => chunk.text.slice(reference.length + 1)).join(""), text.trim());
  assert.ok(chunks.at(-1).text.endsWith("Siste forbehold må bevares."));
  assert.equal(buildDocumentTextChunks(document, { chunkLimit: 6500, maxChunks: 1 }).length, 1);
  assert.equal(buildDocumentTextChunks(document, { chunkLimit: 2, maxChunks: 1 })[0].text.length, 2);
});
