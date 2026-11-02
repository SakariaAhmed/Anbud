import { scoreRetrievalCases } from "./rag_eval.mjs";

// Offline checks exercise the lexical fallback without paid model calls.
// Their floors preserve the measured baseline; live semantic quality has a
// separate, stronger gate. Passing offline does not establish answer quality.
const policies = {
  extended: {
    stress: { cases: 20, recall10: 0.9, mrr: 0.85 },
    follow_up: { cases: 5, recall10: 1, mrr: 0.7 },
    tender_ids: { cases: 23, recall5: 1, mrr: 1, requiredRank: 1 },
    amendment: { cases: 2, recall5: 1, mrr: 1, requiredRank: 1 },
    missing_id: { cases: 5, lowEvidence: 1 },
  },
  // Frozen production-path baseline without the paid model reranker. Release
  // quality targets are a separate, stronger gate, never silently rounded up.
  recorded: {
    id_lookup: { cases: 60, recall5: 1, mrr: 1, requiredRank: 1 },
    conceptual: { cases: 36, recall10: 30 / 36, mrr: 0.55 },
    held_out: { cases: 20, recall10: 1, mrr: 0.85 },
  },
  release: {
    id_lookup: { cases: 60, recall5: 1, mrr: 1, requiredRank: 1 },
    conceptual: { cases: 36, recall10: 0.95, mrr: 0.7 },
    held_out: { cases: 20, recall10: 0.95, mrr: 0.7 },
  },
  offline: {
    id_lookup: { cases: 60, recall5: 1, mrr: 1, requiredRank: 1 },
    conceptual: { cases: 36, recall10: 0.55, mrr: 0.27 },
    held_out: { cases: 20, recall10: 1, mrr: 0.7, requiredRank: 10 },
  },
  live: {
    id_lookup: { cases: 60, recall5: 1, mrr: 1, requiredRank: 1 },
    conceptual: { cases: 36, recall10: 0.9, mrr: 0.7 },
    held_out: { cases: 20, recall10: 0.8, mrr: 0.6 },
  },
};

policies.extended_release = {
  ...policies.extended,
  stress: { ...policies.extended.stress, recall10: 0.95 },
};

export function retrievalGateMode({ extendedSuite, releaseGate, recorded, stored }) {
  if (releaseGate) return extendedSuite ? "extended_release" : "release";
  return extendedSuite ? "extended" : recorded ? "recorded" : stored ? "live" : "offline";
}

export function evaluateRetrievalGate(cases, mode = "offline") {
  const policy = policies[mode];
  if (!policy) throw new Error("Unknown retrieval gate mode.");
  const failures = [];
  const unique = new Set();
  for (const item of cases) {
    const key = `${item.kind}:${item.question}`;
    if (unique.has(key)) failures.push(`Duplicate case: ${key}`);
    unique.add(key);
    const labelledEvidence = Array.isArray(item.expected_texts) && item.expected_texts.length > 0 && item.expected_texts.every(label => typeof label === "string" && label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim());
    const labelledMissingId = item.kind === "missing_id" && item.expected_abstention === true;
    if (!item.expected_requirement_id || (!labelledEvidence && !labelledMissingId) || !Array.isArray(item.retrieved)) {
      failures.push(`Missing evidence label or retrieval result: ${key}`);
    }
  }
  const groups = {};
  for (const [kind, floor] of Object.entries(policy)) {
    const rows = cases.filter(item => item.kind === kind);
    const score = scoreRetrievalCases(rows);
    groups[kind] = score;
    if (score.all_evidence_cases && score.all_evidence_recall_at_10 !== 1) failures.push(`${kind}: not all labelled occurrences were retrieved in the top 10`);
    if (rows.length < floor.cases) failures.push(`${kind}: needs at least ${floor.cases} distinct cases; got ${rows.length}`);
    if (floor.recall5 !== undefined && score.recall_at_5 < floor.recall5) failures.push(`${kind}: recall@5 ${score.recall_at_5} < ${floor.recall5}`);
    if (floor.recall10 !== undefined && score.recall_at_10 < floor.recall10) failures.push(`${kind}: recall@10 ${score.recall_at_10} < ${floor.recall10}`);
    if (floor.mrr !== undefined && score.mrr < floor.mrr) failures.push(`${kind}: MRR ${score.mrr} < ${floor.mrr}`);
    if (floor.lowEvidence !== undefined) {
      const correctlyLow = rows.filter(row => row.expected_abstention === true && row.retrieval_sufficient === false && row.missing_requirement_ids?.includes(row.expected_requirement_id)).length;
      groups[kind] = { cases: rows.length, correct_low_evidence: correctlyLow, low_evidence_rate: rows.length ? correctlyLow / rows.length : 0 };
      if (!rows.length || correctlyLow / rows.length < floor.lowEvidence) failures.push(`${kind}: missing-ID low-evidence rate is below ${floor.lowEvidence}`);
    }
    if (floor.requiredRank) {
      for (const row of rows) {
        if (scoreRetrievalCases([{ ...row, retrieved: row.retrieved.slice(0, floor.requiredRank) }]).mrr === 0) {
          failures.push(`${kind}: required evidence missing from top ${floor.requiredRank}: ${row.question}`);
        }
      }
    }
  }
  return { mode, passed: !failures.length, failures, groups };
}
