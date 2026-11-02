import assert from "node:assert/strict";

/** Preserve the model judge's verdict while allowing an independently verified
 * false positive to fail the release gate. Independent review cannot upgrade it. */
export function summarizeModelReleaseResults(results, thresholds, { policy = "legacy" } = {}) {
  if (!results.length) throw new Error("Release metrics require completed cases.");
  if (!["legacy", "distinct-factual"].includes(policy)) throw new Error("Unknown release metric policy.");
  if (policy === "distinct-factual") {
    const ids = new Set();
    const questions = new Set();
    for (const item of results) {
      if (!item.id || ids.has(item.id)) throw new Error("Release cases require unique IDs.");
      ids.add(item.id);
      if (!["factual", "negative", "conversation", "repeat"].includes(item.kind)) throw new Error("Every release case needs a metric kind.");
      if ((item.kind === "negative") !== (item.abstention_required === true)) throw new Error("Negative-case classification must match the abstention contract.");
      if (item.kind === "factual") {
        const key = item.question?.normalize("NFKC").trim().toLowerCase();
        if (!key || questions.has(key)) throw new Error("Duplicate factual questions cannot increase the denominator.");
        questions.add(key);
      }
      if (item.kind === "repeat" && !results.some(original => original.id === item.repeat_of && original.kind === "factual" && original.question === item.question)) throw new Error("Repeated cases must identify the original factual question.");
    }
  }
  const passes = (item, key) => item.output_complete && item.verdict[key] === true && item.independent_review?.[key] !== false;
  const factual = policy === "legacy" ? results : results.filter(item => item.kind === "factual");
  const rate = predicate => factual.length ? factual.filter(predicate).length / factual.length : 0;
  const negatives = results.filter(item => item.abstention_required);
  const metrics = {
    groundedness: rate(item => passes(item, "grounded")),
    citation_correctness: rate(item => item.citation_integrity && passes(item, "citations_correct")),
    correct_abstention: negatives.length ? negatives.filter(item => passes(item, "abstention_correct")).length / negatives.length : 0,
  };
  const failures = Object.entries(thresholds).filter(([key, floor]) => !Number.isFinite(metrics[key]) || metrics[key] < floor).map(([key, floor]) => `${key}: ${metrics[key]} < ${floor}`);
  // Repeats and conversation cannot inflate factual quality, but a failed
  // repeated factual answer must still fail the release.
  if (policy !== "legacy") for (const item of results.filter(item => item.kind === "repeat")) {
    if (!passes(item, "grounded") || !item.citation_integrity || !passes(item, "citations_correct")) failures.push(`Repeated factual answer failed: ${item.id}`);
  }
  return { metrics, failures, negative_cases: negatives.length, factual_cases: factual.length, metric_policy: policy };
}

/** Interpret only newly issued judge results; historical metric records stay intact. */
export function interpretModelReleaseVerdict(raw, caseOrKind) {
  assert.ok(typeof caseOrKind === "string" || (caseOrKind && typeof caseOrKind === "object"), "Judge interpretation requires a case contract.");
  // Earlier frozen smoke suites encode these categories with flags. Apply
  // new verdict vetoes without rewriting their historical labels or metrics.
  const kind = typeof caseOrKind === "string" ? caseOrKind : caseOrKind.kind
    ?? (caseOrKind.abstention_required ? "negative" : caseOrKind.citations_required ? "factual" : "conversation");
  assert.ok(["factual", "repeat", "negative", "conversation"].includes(kind), "Unknown judge case classification.");
  assert.ok(raw && ["grounded", "citations_correct", "abstention_correct", "core_answer_correct"].every(key => typeof raw[key] === "boolean"), "Judge must provide all boolean verdicts.");
  const verdict = { ...raw };
  const factual = ["factual", "repeat"].includes(kind);
  if (factual || kind === "negative") {
    assert.ok(Array.isArray(raw.claims) && (!factual || raw.claims.length > 0), "Factual judgments require enumerated claims; negative judgments must enumerate any factual claims.");
    assert.ok(raw.claims.every(claim => typeof claim.text === "string" && claim.text.trim() && typeof claim.supported === "boolean" && typeof claim.citation_correct === "boolean"));
    const supported = raw.claims.every(claim => claim.supported);
    if (factual) {
      verdict.grounded &&= raw.core_answer_correct && supported;
      verdict.citations_correct &&= raw.core_answer_correct && supported && raw.claims.every(claim => claim.citation_correct);
    } else verdict.abstention_correct &&= supported;
  }
  return verdict;
}
