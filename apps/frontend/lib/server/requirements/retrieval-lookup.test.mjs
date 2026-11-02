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

test("explicit chapters narrow repeated authoritative IDs before the caller budgets occurrences", async () => {
  const source = document("chapter-source", "[[SIDE:1]]\nK-42 Leverandøren skal holde fire kurs.\n[[SIDE:2]]\nK-42 Leverandøren skal levere driftsrapport.");
  globalThis.__literalRegisterTest = { rows: { [source.id]: [
    { id: "K-42", text: "Leverandøren skal holde fire kurs.", heading: "2 Opplæring", pages: [1], idOrigin: "source" },
    { id: "K-42", text: "Leverandøren skal levere driftsrapport.", heading: "3.2 Drift", pages: [2], idOrigin: "source" },
  ] } };
  const input = { ids: ["K-42"], documents: [source], fingerprints: new Map([[`project_document:${source.id}`, "chapter-v1"]]) };
  assert.equal((await lookupRequirementSnippets(input)).length, 2);
  for (const heading of ["3", "3.2", "3.2 Drift"]) {
    const selected = await lookupRequirementSnippets({ ...input, heading });
    assert.equal(selected.length, 1); assert.equal(selected[0].pageStart, 2);
    assert.match(selected[0].text, /driftsrapport/u);
  }
  assert.deepEqual(await lookupRequirementSnippets({ ...input, heading: "30" }), []);
  assert.deepEqual(await lookupRequirementSnippets({ ...input, heading: "ukjent" }), []);
  assert.equal((await lookupRequirementSnippets(input)).length, 2, "Scoped lookups never poison the full ledger cache.");
});


test("quoted chapter titles match numbered headings and numeric scopes accept punctuation boundaries", async () => {
  for (const [index, heading] of ["3.2 Drift og sikkerhet", "Kapittel 3: Drift og sikkerhet", "3) Drift og sikkerhet", "## Kapittel 3.2: Drift og sikkerhet"].entries()) {
    const source = document(`numbered-heading-${index}`, "K-42 Leverandøren skal levere driftsrapport.");
    globalThis.__literalRegisterTest = { rows: { [source.id]: [{ id: "K-42", text: "Leverandøren skal levere driftsrapport.", heading, pages: [], idOrigin: "source" }] } };
    const input = { ids: ["K-42"], documents: [source], fingerprints: new Map([[`project_document:${source.id}`, source.id]]) };
    for (const requested of ["Drift og sikkerhet", "3"]) assert.equal((await lookupRequirementSnippets({ ...input, heading: requested })).length, 1, `${requested}: ${heading}`);
    for (const requested of ["30", "3.20", "Drift"]) assert.equal((await lookupRequirementSnippets({ ...input, heading: requested })).length, 0, `${requested}: ${heading}`);
  }
});


test("a correction cross-reference does not exempt unrelated occurrences from chapter scope", async () => {
  const source = document("correction-cross-reference", "# 3 Kurs\nK-7 Leverandøren skal holde fire kurs.\n# 5 Drift\nK-7 Leverandøren skal levere driftsrapport.\n# Rettelser\nSe også jf. K-7 for bakgrunn.");
  globalThis.__literalRegisterTest = { rows: { [source.id]: [
    { id: "K-7", text: "Leverandøren skal holde fire kurs.", heading: "3 Kurs", pages: [], idOrigin: "source" },
    { id: "K-7", text: "Leverandøren skal levere driftsrapport.", heading: "5 Drift", pages: [], idOrigin: "source" },
  ] } };
  const selected = await lookupRequirementSnippets({ ids: ["K-7"], heading: "3", documents: [source], fingerprints: new Map([[`project_document:${source.id}`, "cross-reference-v1"]]) });
  assert.equal(selected.length, 1);
  assert.match(selected[0].text, /fire kurs/u);
});

test("partial corrections remain discoverable by their persisted correction chapter without quoting reconstructed wording", async () => {
  const { applyRequirementCorrections } = app("./corrections.ts");
  const { parsePersistedRequirementRegister } = app("../document-intelligence/repository.ts");
  const source = document("partial-correction-chapter", "[[SIDE:2]]\n## 4 Krav\nK-3 Leverandøren skal svare innen fem virkedager.\n[[SIDE:9]]\n## 9 Rettelser\nI K-3 endres «fem virkedager» til «tre virkedager».");
  const original = { id: "K-3", text: "Leverandøren skal svare innen fem virkedager.", heading: "4 Krav", pages: [2], idOrigin: "source", documentId: source.id };
  const corrected = applyRequirementCorrections([original], source.raw_text, { documentId: source.id, documentTitle: source.title }).ledger;
  assert.equal(corrected[0].text, "Leverandøren skal svare innen tre virkedager.");
  assert.equal(corrected[0].correctionSource.heading, "9 Rettelser");
  assert.ok(!source.raw_text.includes(corrected[0].text));
  const expected = { documentId: source.id, projectId: source.project_id, sourceRevision: source.chunk_source_revision };
  const persisted = parsePersistedRequirementRegister(JSON.parse(JSON.stringify({ ...expected, requirementRegister: { version: 2, rows: corrected } })), expected);
  globalThis.__literalRegisterTest = { rows: { [source.id]: persisted } };
  const input = { ids: ["K-3"], documents: [source], fingerprints: new Map([[`project_document:${source.id}`, "partial-v1"]]) };
  for (const heading of ["4", "9", "9 Rettelser", "Rettelser"]) {
    const selected = await lookupRequirementSnippets({ ...input, heading });
    assert.equal(selected.length, 1, heading);
    assert.equal(selected[0].pageStart, 9);
    assert.deepEqual(selected[0].headingPath, ["9 Rettelser"]);
    assert.match(selected[0].text, /endres «fem virkedager» til «tre virkedager»/u);
    assert.ok(source.raw_text.includes(selected[0].text), "Only original amendment wording is quoted.");
  }
  assert.deepEqual(await lookupRequirementSnippets({ ...input, heading: "7" }), []);
  for (const [index, correctionSource] of [
    { ...persisted[0].correctionSource, documentId: "foreign-document" },
    { ...persisted[0].correctionSource, excerpt: "K-3 endres til noe som ikke finnes i kilden." },
    { ...persisted[0].correctionSource, heading: undefined },
  ].entries()) {
    globalThis.__literalRegisterTest.rows[source.id] = [{ ...persisted[0], correctionSource }];
    assert.deepEqual(await lookupRequirementSnippets({ ...input, heading: "9", fingerprints: new Map([[`project_document:${source.id}`, `partial-invalid-${index}`]]) }), []);
  }
});
