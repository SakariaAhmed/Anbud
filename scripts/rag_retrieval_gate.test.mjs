import assert from "node:assert/strict";
import test from "node:test";
import { scoreRetrievalCases } from "./rag_eval.mjs";
import { evaluateRetrievalGate, retrievalGateMode } from "./rag_retrieval_gate.mjs";

function cases() {
  return [["id_lookup", 60], ["conceptual", 36], ["held_out", 20]].flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, index) => ({ kind, question: `${kind} question ${index}`, expected_requirement_id: `R-${index}`, expected_texts: [`Required evidence ${kind} ${index}`], retrieved: [{ source_id: "source", reference: "Side 1", text: `Required evidence ${kind} ${index}` }] })),
  );
}

test("release mode cannot silently select regression floors for the extended suite", () => {
  const mode = retrievalGateMode({ extendedSuite: true, releaseGate: true, recorded: true });
  assert.equal(mode, "extended_release");
  const rows = Array.from({ length: 20 }, (_, i) => ({ kind: "stress", question: String(i), expected_requirement_id: `K-${i}`, expected_texts: [`Evidence ${i}`], retrieved: i < 18 ? [{ text: `Evidence ${i}` }] : [] }));
  assert.ok(!evaluateRetrievalGate(rows, "extended").failures.some(f => f.startsWith("stress:")));
  assert.ok(evaluateRetrievalGate(rows, mode).failures.some(f => f.startsWith("stress: recall@10")));
});

test("repeated-ID proof requires every labelled source occurrence", () => {
  const rows = cases();
  rows[0].required_evidence = [
    { expected_texts: ["Shared requirement"], expected_source_ids: ["source-a"], expected_page: 1 },
    { expected_texts: ["Shared requirement"], expected_source_ids: ["source-b"], expected_page: 2 },
  ];
  rows[0].retrieved.push({ text: "Shared requirement", source_id: "source-a", page_start: 1, page_end: 1 });
  assert.equal(evaluateRetrievalGate(rows).passed, false);
  rows[0].retrieved.push({ text: "Shared requirement", source_id: "source-b", page_start: 2, page_end: 2 });
  assert.equal(evaluateRetrievalGate(rows).passed, true);
  rows[0].required_evidence = [];
  assert.equal(evaluateRetrievalGate(rows).passed, false);
});

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

test("mixed-source gate checks original pages/headings, exact-ID rank and missing-ID evidence separately", () => {
  const rows = [["stress", 20], ["follow_up", 5], ["tender_ids", 23], ["amendment", 2]].flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => ({ kind, question: `${kind}:${index}`, expected_requirement_id: `K-${index}`, expected_texts: [`literal ${kind} ${index}`], expected_source_ids: ["source"], expected_page: 2, expected_heading: "Original heading", retrieved: [{ source_id: "source", page_start: 2, page_end: 2, heading_path: ["Original heading"], text: `literal ${kind} ${index}` }] })));
  rows.push(...Array.from({ length: 5 }, (_, index) => ({ kind: "missing_id", question: `missing:${index}`, expected_requirement_id: `MISSING-${index}`, expected_texts: [], expected_abstention: true, retrieved: [], retrieval_sufficient: false, missing_requirement_ids: [`MISSING-${index}`] })));
  assert.equal(evaluateRetrievalGate(rows, "extended").passed, true);
  const id = rows.find(row => row.kind === "tender_ids");
  id.retrieved[0].page_start = 3; id.retrieved[0].page_end = 3;
  assert.equal(evaluateRetrievalGate(rows, "extended").passed, false, "correct text at an invented page must fail");
  id.retrieved[0].page_start = 2; id.retrieved[0].page_end = 2;
  id.retrieved[0].heading_path = ["Wrong heading"];
  assert.equal(evaluateRetrievalGate(rows, "extended").passed, false);
  id.retrieved[0].heading_path = ["Original heading"];
  rows.at(-1).retrieval_sufficient = true;
  assert.equal(evaluateRetrievalGate(rows, "extended").passed, false, "a confident answer path for a missing ID must fail");
});
