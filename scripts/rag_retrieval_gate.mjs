import { scoreRetrievalCases } from "./rag_eval.mjs";

// Offline checks exercise the lexical fallback without paid model calls.
// Their floors preserve the measured baseline; live semantic quality has a
// separate, stronger gate. Passing offline does not establish answer quality.
const policies = {
  offline: {
    id_lookup: { cases: 60, recall5: 1, mrr: 0.9, requiredRank: 5 },
    conceptual: { cases: 36, recall10: 0.55, mrr: 0.27 },
    held_out: { cases: 20, recall10: 1, mrr: 0.7, requiredRank: 10 },
  },
  live: {
    id_lookup: { cases: 60, recall5: 1, mrr: 0.9, requiredRank: 5 },
    conceptual: { cases: 36, recall10: 0.9, mrr: 0.7 },
    held_out: { cases: 20, recall10: 0.8, mrr: 0.6 },
  },
};

export function evaluateRetrievalGate(cases, mode = "offline") {
  const policy = policies[mode];
  if (!policy) throw new Error("Unknown retrieval gate mode.");
  const failures = [];
  const unique = new Set();
  for (const item of cases) {
    const key = `${item.kind}:${item.question}`;
    if (unique.has(key)) failures.push(`Duplicate case: ${key}`);
    unique.add(key);
    if (!item.expected_requirement_id || (!Array.isArray(item.expected_texts) || !item.expected_texts.length || item.expected_texts.some(label => typeof label !== "string" || !label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim())) || !Array.isArray(item.retrieved)) {
      failures.push(`Missing evidence label or retrieval result: ${key}`);
    }
  }
  const groups = {};
  for (const [kind, floor] of Object.entries(policy)) {
    const rows = cases.filter(item => item.kind === kind);
    const score = scoreRetrievalCases(rows);
    groups[kind] = score;
    if (rows.length < floor.cases) failures.push(`${kind}: needs at least ${floor.cases} distinct cases; got ${rows.length}`);
    if (floor.recall5 !== undefined && score.recall_at_5 < floor.recall5) failures.push(`${kind}: recall@5 ${score.recall_at_5} < ${floor.recall5}`);
    if (floor.recall10 !== undefined && score.recall_at_10 < floor.recall10) failures.push(`${kind}: recall@10 ${score.recall_at_10} < ${floor.recall10}`);
    if (floor.mrr !== undefined && score.mrr < floor.mrr) failures.push(`${kind}: MRR ${score.mrr} < ${floor.mrr}`);
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
