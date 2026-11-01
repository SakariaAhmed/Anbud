import assert from "node:assert/strict";
import test from "node:test";
import { scoreRetrievalCases } from "./rag_eval.mjs";
import { evaluateRetrievalGate } from "./rag_retrieval_gate.mjs";

function cases() {
  return [["id_lookup", 60], ["conceptual", 36], ["held_out", 20]].flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, index) => ({ kind, question: `${kind} question ${index}`, expected_requirement_id: `R-${index}`, expected_texts: [`Required evidence ${kind} ${index}`], retrieved: [{ source_id: "source", reference: "Side 1", text: `Required evidence ${kind} ${index}` }] })),
  );
}

test("retrieval gate rejects a lost ID lookup even when aggregate recall remains high", () => {
  const rows = cases();
  assert.equal(evaluateRetrievalGate(rows).passed, true);
  rows[0].retrieved = [...Array(5).fill({ text: "Irrelevant" }), rows[0].retrieved[0]];
  const result = evaluateRetrievalGate(rows);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.includes("id_lookup: recall@5")));
});

test("offline fallback and live semantic quality have separate enforced floors", () => {
  const rows = cases();
  rows.filter(row => row.kind === "conceptual").slice(20).forEach(row => { row.retrieved = []; });
  assert.equal(evaluateRetrievalGate(rows, "offline").passed, true);
  assert.equal(evaluateRetrievalGate(rows, "live").passed, false);
  assert.equal(evaluateRetrievalGate([]).passed, false);
});

test("duplicate or unlabeled cases cannot satisfy the evaluation gate", () => {
  const rows = cases();
  rows[1] = structuredClone(rows[0]);
  assert.equal(evaluateRetrievalGate(rows).passed, false);
  delete rows[2].expected_texts;
  assert.ok(evaluateRetrievalGate(rows).failures.some(failure => failure.includes("Missing evidence label")));
});

test("a source ID match cannot substitute for the required evidence passage", () => {
  const score = scoreRetrievalCases([{ expected_source_ids: ["source"], expected_texts: ["required statement"], retrieved: [{ source_id: "source", text: "unrelated paragraph" }] }]);
  assert.equal(score.recall_at_5, 0);
  assert.equal(score.citation_accuracy, null);
});

test("citation scoring never awards absent or malformed citations a perfect score", () => {
  const row = { expected_texts: ["evidence"], retrieved: [{ source_id: "source", reference: "Side 1", text: "evidence" }] };
  assert.equal(scoreRetrievalCases([row]).citation_accuracy, null);
  const score = scoreRetrievalCases([{ ...row, citations: [{ source_id: "source", reference: "Side 1" }, {}, null, 1, "invalid"] }]);
  assert.equal(score.citation_accuracy, 0.2);
  assert.equal(score.citation_count, 5);
});


test("empty and non-string evidence labels cannot satisfy the gate", () => {
  for (const label of ["", " \n\t", "\u0301", null, 1, {}]) {
    const rows = cases();
    rows[0].expected_texts = [label];
    assert.ok(evaluateRetrievalGate(rows).failures.some(failure => failure.includes("Missing evidence label")));
  }
});
