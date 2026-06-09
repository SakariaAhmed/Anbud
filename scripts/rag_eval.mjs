import { existsSync, readFileSync } from "node:fs";

function usage() {
  console.error(
    "Usage: node scripts/rag_eval.mjs <results.json>\n\n" +
      "results.json must be an array of cases with expected_source_ids or expected_references and retrieved snippets.",
  );
}

const filePath = process.argv[2];
if (!filePath || !existsSync(filePath)) {
  usage();
  process.exit(1);
}

const cases = JSON.parse(readFileSync(filePath, "utf8"));
if (!Array.isArray(cases)) {
  throw new Error("Eval file must contain an array.");
}

function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function expectedMatch(caseItem, snippet) {
  const expectedIds = new Set((caseItem.expected_source_ids ?? []).map(String));
  if (expectedIds.has(String(snippet.source_id))) {
    return true;
  }

  const reference = norm(
    [snippet.document_title, snippet.reference, ...(snippet.heading_path ?? [])].join(" "),
  );
  return (caseItem.expected_references ?? []).some((expected) =>
    reference.includes(norm(expected)),
  );
}

let recallAt5 = 0;
let recallAt10 = 0;
let reciprocalRankSum = 0;
let citationCoverageSum = 0;
let latencySum = 0;
let latencyCount = 0;

const failures = [];

for (const [caseIndex, caseItem] of cases.entries()) {
  const retrieved = Array.isArray(caseItem.retrieved) ? caseItem.retrieved : [];
  const firstMatchIndex = retrieved.findIndex((snippet) =>
    expectedMatch(caseItem, snippet),
  );

  if (firstMatchIndex >= 0 && firstMatchIndex < 5) {
    recallAt5 += 1;
  }
  if (firstMatchIndex >= 0 && firstMatchIndex < 10) {
    recallAt10 += 1;
  }
  if (firstMatchIndex >= 0) {
    reciprocalRankSum += 1 / (firstMatchIndex + 1);
  } else {
    failures.push({
      index: caseIndex,
      question: caseItem.question,
      expected_source_ids: caseItem.expected_source_ids ?? [],
      expected_references: caseItem.expected_references ?? [],
    });
  }

  const cited = Array.isArray(caseItem.citations) ? caseItem.citations : [];
  if (cited.length) {
    const validCitations = cited.filter((citation) =>
      retrieved.some(
        (snippet) =>
          String(snippet.source_id) === String(citation.source_id) &&
          norm(snippet.reference) === norm(citation.reference),
      ),
    ).length;
    citationCoverageSum += validCitations / cited.length;
  } else {
    citationCoverageSum += firstMatchIndex >= 0 ? 1 : 0;
  }

  const latency = Number(caseItem.latency_ms ?? caseItem.retrieval_latency_ms);
  if (Number.isFinite(latency)) {
    latencySum += latency;
    latencyCount += 1;
  }
}

const total = cases.length || 1;
const report = {
  cases: cases.length,
  recall_at_5: recallAt5 / total,
  recall_at_10: recallAt10 / total,
  mrr: reciprocalRankSum / total,
  citation_accuracy: citationCoverageSum / total,
  avg_latency_ms: latencyCount ? latencySum / latencyCount : null,
  failed_cases: failures.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));

if (report.recall_at_5 < 0.75 || report.citation_accuracy < 0.8) {
  process.exitCode = 2;
}
