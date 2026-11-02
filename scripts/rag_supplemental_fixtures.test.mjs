import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { supplementalRetrievalFixtures } from "./rag_supplemental_fixtures.mjs";
const root = path.resolve(import.meta.dirname, "..");
test("mixed source labels resolve original blocks, actual page metadata, follow-up history and frozen PDF sources", () => {
  const uuid = index => `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
  const fixture = supplementalRetrievalFixtures(root, uuid, 10);
  assert.equal(fixture.documents.length, 9); assert.equal(fixture.cases.length, 55);
  assert.equal(new Set(fixture.documents.map(document => document.id)).size, 9);
  assert.equal(new Set(fixture.cases.map(item => `${item.kind}:${item.question}`)).size, 55);
  for (const item of fixture.cases.filter(item => item.kind === "stress" || item.kind === "follow_up")) {
    const document = fixture.documents.find(document => item.expected_source_ids.includes(document.id));
    const section = document.structure_map.find(section => section.page === item.expected_page && section.heading_path.includes(item.expected_heading));
    assert.ok(section && item.expected_texts.every(text => section.text.includes(text)));
    if (item.kind === "follow_up") assert.ok(item.previous_question.length > 15);
  }
  assert.equal(fixture.cases.filter(item => item.expected_abstention).length, 5);
  assert.ok(fixture.documents.filter(document => document.key.startsWith("halandsvik-")).every(document => document.source_sha256 && document.parser && document.raw_text));
});
