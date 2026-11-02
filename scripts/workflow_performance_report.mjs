import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function summarizeWorkflowPerformance(events, label = "unspecified") {
  const classes = new Map(events.filter(row => row?.trace_id && row.document_class).map(row => [row.trace_id, row.document_class]));
  const groups = new Map();
  const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  let cacheInput = 0, cacheRead = 0, measuredCacheResponses = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "chat_completion" && Number.isSafeInteger(event.input_tokens) && event.input_tokens >= 0 && Number.isSafeInteger(event.cached_tokens) && event.cached_tokens >= 0 && event.cached_tokens <= event.input_tokens) {
      cacheInput += event.input_tokens; cacheRead += event.cached_tokens; measuredCacheResponses++;
    }
    const row = event.event === "workflow_performance" ? event
      : event.event === "chat_first_token" ? { ...event, phase: "first_token", operation: "provider_chat" } : null;
    if (!row || !finite(row.duration_ms) || typeof row.phase !== "string" || typeof row.operation !== "string") continue;
    const documentClass = row.document_class ?? classes.get(row.trace_id) ?? "unknown";
    const key = JSON.stringify([row.operation, row.phase, documentClass]);
    if (!groups.has(key)) groups.set(key, { operation: row.operation, phase: row.phase, document_class: documentClass, durations: [], failedDurations: [], failed: 0 });
    const group = groups.get(key);
    if (row.status === "failed") { group.failed++; group.failedDurations.push(row.duration_ms); }
    else group.durations.push(row.duration_ms);
  }
  const percentile = (values, p) => values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
  return { version: 2, label, phases: [...groups.values()].map(({ durations, failedDurations, ...group }) => {
    durations.sort((a, b) => a - b); failedDurations.sort((a, b) => a - b);
    const all = [...durations, ...failedDurations].sort((a, b) => a - b);
    return { ...group, samples: durations.length, p50_ms: percentile(durations, 0.5), p95_ms: percentile(durations, 0.95), failed_p50_ms: percentile(failedDurations, 0.5), failed_p95_ms: percentile(failedDurations, 0.95), all_samples: all.length, all_p50_ms: percentile(all, 0.5), all_p95_ms: percentile(all, 0.95) };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  chat_cache: { measured_responses: measuredCacheResponses, input_tokens: cacheInput, cached_tokens: cacheRead, cached_fraction: cacheInput ? cacheRead / cacheInput : null } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/workflow_performance_report.mjs <NDJSON log> [environment/corpus label]");
  const events = readFileSync(file, "utf8").split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  process.stdout.write(`${JSON.stringify(summarizeWorkflowPerformance(events, process.argv[3]), null, 2)}\n`);
}
