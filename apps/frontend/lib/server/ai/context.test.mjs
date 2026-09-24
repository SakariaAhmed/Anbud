import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" }, fsCache: false });
const { compactText, documentContext } = jiti("./context.ts");
function original(value, limit = 16000) {
  const normalized = (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

test("bounded normalization preserves exact excerpts, whitespace and truncation semantics", () => {
  const sources = [undefined, null, 42, "", "  ", " ÆØÅ\t ansvar\r\n og\u00a0kontroll ", "x".repeat(50000), " ".repeat(50000), `A${" \n".repeat(30000)}B`, `${" ".repeat(50000)}Kontroll`, `😀${"kilde\n".repeat(12000)}`];
  for (const source of sources) {
    for (const limit of [-3, 0, 1, 2, 2.8, 220, 4000, 16000, Infinity, NaN]) {
      assert.equal(compactText(source, limit), original(source, limit));
    }
  }
  // Seeded fuzz checks mixed whitespace around exactly truncated boundaries.
  let seed = 20260908;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const alphabet = ["a", "ø", "🙂", "\t", "\n", " ", "\r\n", "\u2028", "\ufeff"];
  for (let iteration = 0; iteration < 600; iteration++) {
    const source = Array.from({ length: Math.floor(random() * 4000) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const limit = Math.floor(random() * 1000);
    assert.equal(compactText(source, limit), original(source, limit));
  }
});

test("document prompt preserves metadata, exact source references and original text", () => {
  const document = { title: "Kundekrav", file_name: "krav.txt", file_format: "txt", role: "primary_customer_document", raw_text: " \nK-17 Leverandøren dokumenterer kontroll.\n".repeat(10000), structure_map: [{ reference: "Side 12 / K-17", text: "Verifisert kilde" }] };
  const source = document.raw_text;
  const result = documentContext("Kilde", document, { textLimit: 220 });
  assert.ok(result.includes(original(source, 220)));
  assert.ok(result.includes("Side 12 / K-17"));
  assert.ok(result.includes("primary_customer_document"));
  assert.equal(document.raw_text, source);
});
