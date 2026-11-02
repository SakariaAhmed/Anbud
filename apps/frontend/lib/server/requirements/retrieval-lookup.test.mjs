import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const directory = mkdtempSync(path.join(tmpdir(), "anbud-register-lookup-"));
const repository = path.join(directory, "register.cjs");
writeFileSync(repository, `exports.readDocumentRequirementRegister = async input => { const state=globalThis.__literalRegisterTest; if(state.fail?.includes(input.documentId))throw new Error("Ambiguous synthetic register"); return state.rows[input.documentId] ?? []; };`);
const app = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "../../.."), "@/lib/server/document-intelligence/repository": repository, "server-only": "/dev/null" } });
const { lookupRequirementSnippets } = app("./retrieval-lookup.ts");
const document = (id, raw_text) => ({ id, project_id: "fictional", role: "supporting_document", supporting_subtype: "kravdokument", title: "Kravspesifikasjon", file_name: "krav.pdf", file_format: "pdf", raw_text, structure_map: [], chunk_source_revision: 1 });
const entry = { id: "K-3.3.1", text: "Minstekrav leverandørens driftssenter skal være bemannet hele døgnet. Etterfølgende generert overskrift", heading: "Driftssenter", pages: [1, 2], idOrigin: "source" };
test.after(() => { delete globalThis.__literalRegisterTest; rmSync(directory, { recursive: true, force: true }); });
test("normalized ledger wording resolves an original ID row and its actual explicit page without quoting a reconstruction", async () => {
  const source = document("literal-source", "[[SIDE:1]]\nK-3.3.1 Minstekrav Leverandørens driftssenter skal være bemannet hele døgnet.\nK-3.3.2 Personell skal dokumentere tilgang.\n[[SIDE:2]]\n4 Neste kapittel");
  globalThis.__literalRegisterTest = { rows: { [source.id]: [{ ...entry, documentId: source.id }] } };
  const snippets = await lookupRequirementSnippets({ ids: [entry.id], documents: [source], fingerprints: new Map([[`project_document:${source.id}`, "literal-v1"]]) });
  assert.equal(snippets.length, 1); assert.equal(snippets[0].pageStart, 1); assert.equal(snippets[0].pageEnd, 1);
  assert.ok(source.raw_text.includes(snippets[0].text)); assert.match(snippets[0].text, /Minstekrav Leverandørens/u);
  assert.doesNotMatch(snippets[0].text, /generert overskrift|K-3.3.2/u);
});
test("a failed register is isolated and an inline cross-reference does not become an authoritative row", async () => {
  const broken = document("broken-source", "K-3.3.1 Leverandøren skal ha drift.");
  const inline = document("inline-source", "Spørsmål: Kan driftssenteret i K-3.3.1 ligge utenfor Norden? Kravet står uendret.");
  const good = document("good-source", "K-3.3.1 Minstekrav Leverandørens driftssenter skal være bemannet hele døgnet.");
  globalThis.__literalRegisterTest = { fail: [broken.id], rows: { [inline.id]: [{ ...entry, documentId: inline.id }], [good.id]: [{ ...entry, documentId: good.id }] } };
  const failures = [];
  const snippets = await lookupRequirementSnippets({ ids: [entry.id], documents: [broken, inline, good], fingerprints: new Map([broken, inline, good].map(source => [`project_document:${source.id}`, source.id])), onSourceFailure: id => failures.push(id) });
  assert.deepEqual(failures, [broken.id]); assert.deepEqual(snippets.map(snippet => snippet.sourceId), [good.id]);
});

test("register rows in source wording and in normalized wording resolve the same original passage", async () => {
  const source = document("dash-source", "[[SIDE:1]]\nK-6.2 Tjenesten skal bemannes mellom 06:00–22:00 alle dager.\nK-6.3 Rapporter skal leveres ukentlig.");
  for (const [index, text] of ["Tjenesten skal bemannes mellom 06:00–22:00 alle dager.", "Tjenesten skal bemannes mellom 06:00-22:00 alle dager."].entries()) {
    globalThis.__literalRegisterTest = { rows: { [source.id]: [{ id: "K-6.2", text, heading: "Drift", pages: [1], idOrigin: "source", documentId: source.id }] } };
    const snippets = await lookupRequirementSnippets({ ids: ["K-6.2"], documents: [source], fingerprints: new Map([[`project_document:${source.id}`, `dash-${index}`]]) });
    assert.equal(snippets.length, 1);
    assert.ok(source.raw_text.includes(snippets[0].text));
    assert.match(snippets[0].text, /06:00–22:00/u, "A quotation carries the original dash.");
  }
});
