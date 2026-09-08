import test from "node:test";
import assert from "node:assert/strict";
import { assertComparableInputs, frozenInvocation, hashInput } from "./generation-input.mjs";

test("v1 baseline hashing never permits changed candidate evidence or operation", () => {
  const fixture = { input: { customerDocument: { raw_text: "Frozen" }, solutionEvaluation: null } };
  const kind = "losningsutkast";
  const before = { fullInputSha256: hashInput(fixture.input) };
  const expected = frozenInvocation(fixture, kind);
  const after = { evidenceInputSha256: hashInput(expected) };
  assert.deepEqual(assertComparableInputs({ fixture, kind, before, after }), expected);
  for (const changed of [{ ...expected, instructions: "Different" }, { ...expected, artifactType: "tilbudsstrategi" }, { ...expected, solutionEvaluation: { injected: true } }]) assert.throws(() => assertComparableInputs({ fixture, kind, before, after: { evidenceInputSha256: hashInput(changed) } }), /differ/);
  assert.throws(() => assertComparableInputs({ fixture, kind: "chat", before, after }), /differ/);
});

test("executive comparisons freeze the exact evaluation and model trials retain evidence", () => {
  const fixture = { input: { projectName: "Frozen", solutionEvaluation: null } };
  const evaluation = { fit: "Frozen evaluation" };
  const invocation = frozenInvocation(fixture, "executive_summary", { evaluation, model: "gpt-5.6-luna" });
  const evidence = { ...invocation }; delete evidence.model;
  const run = { evidenceInputSha256: hashInput(evidence) };
  assertComparableInputs({ fixture, kind: "executive_summary", before: run, after: run, evaluation });
  assert.throws(() => assertComparableInputs({ fixture, kind: "executive_summary", before: run, after: run, evaluation: { fit: "Changed" } }), /differ/);
  assert.equal(fixture.input.solutionEvaluation, null);
});

test("analysis sections remain distinct frozen operations", () => {
  const fixture = { input: { customerAnalysis: { customer_profile_summary: "Bevar denne teksten" } } };
  const expected = frozenInvocation(fixture, "section_risks");
  assert.equal(expected.section, "risks");
  assert.equal(expected.artifactType, undefined);
  const run = { evidenceInputSha256: hashInput(expected) };
  assertComparableInputs({ fixture, kind: "section_risks", before: run, after: run });
  assert.throws(() => assertComparableInputs({ fixture, kind: "section_design", before: run, after: run }), /differ/);
  assert.equal(fixture.input.section, undefined);
});
