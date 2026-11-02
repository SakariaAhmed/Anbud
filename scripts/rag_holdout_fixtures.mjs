import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function loadFrozenRagHoldout(directory = new URL("../test-data/rag-release-holdout/", import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", directory)));
  const ids = new Set(), questions = new Set();
  const fixtures = manifest.fixtures.map(entry => {
    assert.match(entry.file, /^[a-z]+\.v\d+\.json$/u);
    const bytes = readFileSync(new URL(entry.file, directory));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, "Frozen holdout bytes changed.");
    const fixture = JSON.parse(bytes);
    const documents = new Map(fixture.documents.map(doc => [doc.id, doc]));
    assert.equal(documents.size, fixture.documents.length);
    assert.ok(fixture.documents.some(doc => doc.role === "primary_customer_document"));
    assert.ok(fixture.documents.every(doc => ["primary_customer_document", "primary_solution_document", "supporting_document"].includes(doc.role)));
    assert.equal(fixture.documents.filter(doc => doc.role === "primary_solution_document").length, 1);
    const chars = fixture.documents.reduce((sum, doc) => sum + doc.raw_text.length, 0);
    assert.ok(chars >= manifest.protocol.minimum_project_characters && chars <= 130_000);
    for (const item of fixture.cases) {
      assert.ok(item.id && !ids.has(item.id)); ids.add(item.id);
      assert.ok(item.question && !questions.has(item.question)); questions.add(item.question);
      assert.ok(["factual", "negative"].includes(item.kind));
      assert.equal(item.abstention_required === true, item.kind === "negative");
      assert.equal(typeof item.citations_required, "boolean");
      assert.ok(item.expected.trim());
      if (item.kind === "factual") assert.ok(item.evidence.length > 0 && item.citations_required);
      for (const evidence of item.evidence) {
        const text = documents.get(evidence.document_id)?.raw_text;
        assert.ok(text && evidence.quote.trim());
        const marker = `[[SIDE:${evidence.page}]]`;
        const from = text.indexOf(marker);
        const to = text.indexOf("[[SIDE:", from + marker.length);
        assert.ok(from >= 0 && text.slice(from + marker.length, to < 0 ? text.length : to).includes(evidence.quote), `${item.id}: original quote/page mismatch`);
      }
    }
    assert.equal(fixture.cases.filter(item => item.kind === "factual").length, 30);
    assert.equal(fixture.cases.filter(item => item.kind === "negative").length, 10);
    return { ...fixture, sha256: entry.sha256, characters: chars };
  });
  assert.equal(fixtures.flatMap(f => f.cases).filter(c => c.kind === "factual").length, manifest.factual_cases);
  assert.equal(fixtures.flatMap(f => f.cases).filter(c => c.kind === "negative").length, manifest.negative_cases);
  return { manifest, fixtures };
}
