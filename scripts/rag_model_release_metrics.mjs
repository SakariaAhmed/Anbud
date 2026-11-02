/** Preserve the model judge's verdict while allowing an independently verified
 * false positive to fail the release gate. Independent review cannot upgrade it. */
export function summarizeModelReleaseResults(results, thresholds) {
  if (!results.length) throw new Error("Release metrics require completed cases.");
  const passes = (item, key) => item.output_complete && item.verdict[key] === true && item.independent_review?.[key] !== false;
  const rate = predicate => results.filter(predicate).length / results.length;
  const negatives = results.filter(item => item.abstention_required);
  const metrics = {
    groundedness: rate(item => passes(item, "grounded")),
    citation_correctness: rate(item => item.citation_integrity && passes(item, "citations_correct")),
    correct_abstention: negatives.length ? negatives.filter(item => passes(item, "abstention_correct")).length / negatives.length : 0,
  };
  const failures = Object.entries(thresholds).filter(([key, floor]) => !Number.isFinite(metrics[key]) || metrics[key] < floor).map(([key, floor]) => `${key}: ${metrics[key]} < ${floor}`);
  return { metrics, failures, negative_cases: negatives.length };
}
