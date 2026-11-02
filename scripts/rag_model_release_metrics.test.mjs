import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { summarizeModelReleaseResults } from "./rag_model_release_metrics.mjs";

test("conversation, abstention and warm repeats cannot inflate factual quality", () => {
  const pass = { output_complete: true, citation_integrity: true, verdict: { grounded: true, citations_correct: true, abstention_correct: true } };
  const cases = [
    { ...pass, id: "fact", question: "What does the source say?", kind: "factual", independent_review: { grounded: false, citations_correct: false } },
    { ...pass, id: "negative", kind: "negative", abstention_required: true },
    { ...pass, id: "format", kind: "conversation" },
    { ...pass, id: "warm", kind: "repeat", repeat_of: "fact", question: "What does the source say?" },
  ];
  const summary = summarizeModelReleaseResults(cases, { groundedness: 0.98, citation_correctness: 0.98, correct_abstention: 0.95 }, { policy: "distinct-factual" });
  assert.equal(summary.factual_cases, 1);
  assert.equal(summary.metrics.groundedness, 0);
  assert.equal(summary.metrics.citation_correctness, 0);
  assert.equal(summary.metrics.correct_abstention, 1);
  assert.throws(() => summarizeModelReleaseResults([...cases, { ...cases[0], id: "duplicate" }], {}, { policy: "distinct-factual" }), /Duplicate factual/u);
  cases[3].independent_review = { grounded: false };
  assert.ok(summarizeModelReleaseResults(cases, {}, { policy: "distinct-factual" }).failures.some(f => f.includes("warm")));
});

test("an empty factual tier fails closed and unknown classifications cannot hide cases", () => {
  const item = { id: "hello", kind: "conversation", output_complete: true, verdict: { grounded: true } };
  assert.equal(summarizeModelReleaseResults([item], { groundedness: 0.98 }, { policy: "distinct-factual" }).failures.length, 1);
  assert.throws(() => summarizeModelReleaseResults([{ ...item, kind: "unknown" }], {}, { policy: "distinct-factual" }), /metric kind/u);
});

test("the recorded exit-plan conflation fails the gate while preserving the original judge verdict", () => {
  const report = JSON.parse(fs.readFileSync(new URL("../docs/rag-quality-model-smoke-2026-11-02.json", import.meta.url)));
  const run = report.runs.find(run => run.version === "rag-model-release.v2"
    && run.recorded_at === "2026-11-02T03:13:17.750Z"
    && run.cases.some(item => item.id === "generated-bilag" && item.independent_review?.grounded === false));
  assert.ok(run, "The independently audited v2 run must remain in the historical report.");
  const result = run.cases.find(item => item.id === "generated-bilag");
  assert.equal(result.verdict.grounded, true);
  assert.equal(result.independent_review.grounded, false);
  const summary = summarizeModelReleaseResults(run.cases, run.thresholds);
  assert.equal(summary.metrics.groundedness, 0.9);
  assert.equal(summary.metrics.citation_correctness, 0.9);
  assert.equal(summary.metrics.correct_abstention, 1);
  assert.equal(summary.failures.length, 2);
  assert.deepEqual(summary.metrics, run.independent_review.metrics);
});

test("independent review cannot upgrade a failed judge or an incomplete answer", () => {
  const base = { output_complete: true, citation_integrity: true, abstention_required: true, verdict: { grounded: false, citations_correct: false, abstention_correct: false }, independent_review: { grounded: true, citations_correct: true, abstention_correct: true } };
  const summary = summarizeModelReleaseResults([base, { ...base, output_complete: false, verdict: { grounded: true, citations_correct: true, abstention_correct: true } }], { groundedness: 0.98, citation_correctness: 0.98, correct_abstention: 0.95 });
  assert.deepEqual(summary.metrics, { groundedness: 0, citation_correctness: 0, correct_abstention: 0 });
  assert.equal(summary.failures.length, 3);
});
