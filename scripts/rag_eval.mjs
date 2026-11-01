import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function expectedMatch(caseItem, snippet) {
  const expectedTexts = caseItem.expected_texts ?? [];
  if (expectedTexts.length) {
    const text = norm(snippet.text);
    return Boolean(text) && expectedTexts.some(expected => text.includes(norm(expected)));
  }
  const expectedIds = new Set((caseItem.expected_source_ids ?? []).map(String));
  if (expectedIds.has(String(snippet.source_id))) {
    return true;
  }

  const reference = norm(
    [snippet.document_title, snippet.reference, ...(snippet.heading_path ?? [])].join(" "),
  );
  if ((caseItem.expected_references ?? []).some((expected) =>
    reference.includes(norm(expected)),
  )) {
    return true;
  }
  // Optional: the snippet text must contain one of these passages.
  const text = norm(snippet.text);
  return Boolean(text) && (caseItem.expected_texts ?? []).some((expected) =>
    text.includes(norm(expected)),
  );
}

export function scoreRetrievalCases(cases) {
  let recallAt5 = 0;
  let recallAt10 = 0;
  let reciprocalRankSum = 0;
  let validCitations = 0;
  let citationCount = 0;
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
      validCitations += cited.filter((citation) =>
        typeof citation.source_id === "string" && citation.source_id.trim() && norm(citation.reference) &&
        retrieved.some(
          (snippet) =>
            String(snippet.source_id) === String(citation.source_id) &&
            norm(snippet.reference) === norm(citation.reference),
        ),
      ).length;
      citationCount += cited.length;
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
    citation_accuracy: citationCount ? validCitations / citationCount : null,
    citation_count: citationCount,
    avg_latency_ms: latencyCount ? latencySum / latencyCount : null,
    failed_cases: failures.slice(0, 20),
  };
  return report;
}

function usage() {
  console.error(
    "Usage: node scripts/rag_eval.mjs <results.json>\n\n" +
      "results.json must be an array of cases with expected_source_ids, expected_references or expected_texts and retrieved snippets.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const filePath = process.argv[2];
  if (!filePath || !existsSync(filePath)) {
    usage();
    process.exit(1);
  }

  const cases = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(cases)) {
    throw new Error("Eval file must contain an array.");
  }

  const report = scoreRetrievalCases(cases);
  console.log(JSON.stringify(report, null, 2));

  if (!cases.length || report.recall_at_5 < 0.75 || (report.citation_accuracy !== null && report.citation_accuracy < 0.8)) {
    process.exitCode = 2;
  }
}
