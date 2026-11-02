import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PROTOCOL = path.join(import.meta.dirname, "fixtures/workflow_performance_protocol.json");
// One user action yields one of these per trace. A later reload or duplicate
// report must not add a second sample for the same action. Register renders are
// per view episode, so each remains its own sample and none are ever summed.
const ONE_SAMPLE_PER_ACTION = new Set(["upload_to_ready", "chat_first_render"]);

const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const percentile = (values, p) => values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : null;
const ascending = values => [...values].sort((a, b) => a - b);

function correlations(events) {
  const classes = new Map(), revisions = new Map(), serverTraces = new Set();
  for (const row of events) {
    if (!row?.trace_id) continue;
    if (row.document_class && !classes.has(row.trace_id)) classes.set(row.trace_id, row.document_class);
    if (Number.isSafeInteger(row.source_revision)) revisions.set(row.trace_id, row.source_revision);
    if (row.operation !== "browser") serverTraces.add(row.trace_id);
  }
  return { classes, revisions, serverTraces };
}

function cacheSummary(events, classes) {
  const empty = () => ({ measured_responses: 0, input_tokens: 0, cached_tokens: 0, cached_fraction: null });
  const total = empty(), byClass = new Map();
  const add = (summary, input, cached) => {
    summary.measured_responses++; summary.input_tokens += input; summary.cached_tokens += cached;
    summary.cached_fraction = summary.input_tokens ? summary.cached_tokens / summary.input_tokens : null;
  };
  for (const event of events) {
    if (event?.event !== "chat_completion") continue;
    const { input_tokens: input, cached_tokens: cached } = event;
    if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(cached) || cached < 0 || cached > input) continue;
    add(total, input, cached);
    const documentClass = classes.get(event.trace_id) ?? "unknown";
    if (!byClass.has(documentClass)) byClass.set(documentClass, empty());
    add(byClass.get(documentClass), input, cached);
  }
  return { ...total, by_document_class: Object.fromEntries([...byClass].sort(([a], [b]) => a.localeCompare(b))) };
}

function protocolCoverage(phases, protocol) {
  const missing = [];
  for (const cell of protocol.cells) for (const documentClass of cell.document_classes) for (const cacheState of cell.cache_states) {
    const observed = phases.find(row => row.operation === cell.operation && row.phase === cell.phase && row.document_class === documentClass && row.cache_state === cacheState && (cell.job_kind ?? null) === row.job_kind);
    const samples = observed?.samples ?? 0;
    if (samples < protocol.minimum_samples_per_cell) missing.push({ operation: cell.operation, ...(cell.job_kind ? { job_kind: cell.job_kind } : {}), phase: cell.phase, document_class: documentClass, cache_state: cacheState, samples, required: protocol.minimum_samples_per_cell });
  }
  return missing;
}

export function summarizeWorkflowPerformance(events, { label = "unspecified", protocol = JSON.parse(readFileSync(DEFAULT_PROTOCOL, "utf8")), protocolSha256 = null } = {}) {
  const usable = events.filter(event => event && typeof event === "object");
  const { classes, revisions, serverTraces } = correlations(usable);
  const groups = new Map(), actionSamples = new Set();
  let duplicateActionSamples = 0, browserSamplesWithoutServerTrace = 0;
  for (const event of usable) {
    const row = event.event === "workflow_performance" ? event
      : event.event === "chat_first_token" ? { ...event, phase: "first_token", operation: "provider_chat" } : null;
    if (!row || !finite(row.duration_ms) || typeof row.phase !== "string" || typeof row.operation !== "string") continue;
    if (row.operation === "browser" && ONE_SAMPLE_PER_ACTION.has(row.phase)) {
      const action = JSON.stringify([row.phase, row.trace_id, row.source_revision ?? null]);
      if (actionSamples.has(action)) { duplicateActionSamples++; continue; }
      actionSamples.add(action);
    }
    if (row.operation === "browser" && !serverTraces.has(row.trace_id)) browserSamplesWithoutServerTrace++;
    const documentClass = row.document_class ?? classes.get(row.trace_id) ?? "unknown";
    const cacheState = row.cache_state ?? "n/a";
    const jobKind = row.job_kind ?? null;
    const key = JSON.stringify([row.operation, jobKind, row.phase, documentClass, cacheState]);
    if (!groups.has(key)) groups.set(key, { operation: row.operation, job_kind: jobKind, phase: row.phase, document_class: documentClass, cache_state: cacheState, durations: [], failedDurations: [], traces: new Set(), revisions: new Set() });
    const group = groups.get(key);
    (row.status === "failed" ? group.failedDurations : group.durations).push(row.duration_ms);
    if (row.trace_id) group.traces.add(row.trace_id);
    const revision = row.source_revision ?? revisions.get(row.trace_id);
    if (Number.isSafeInteger(revision)) group.revisions.add(revision);
  }
  const phases = [...groups.values()].map(({ durations, failedDurations, traces, revisions: seenRevisions, ...group }) => {
    const completed = ascending(durations), failed = ascending(failedDurations), all = ascending([...durations, ...failedDurations]);
    const samples = completed.length;
    return { ...group, samples, failed: failed.length, attempts: all.length, failure_rate: all.length ? failed.length / all.length : null,
      p50_ms: percentile(completed, 0.5), p95_ms: percentile(completed, 0.95), failed_p50_ms: percentile(failed, 0.5), failed_p95_ms: percentile(failed, 0.95),
      all_p50_ms: percentile(all, 0.5), all_p95_ms: percentile(all, 0.95), distinct_traces: traces.size, distinct_source_revisions: seenRevisions.size,
      meets_protocol_minimum: samples >= protocol.minimum_samples_per_cell };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const missing = protocolCoverage(phases, protocol);
  return {
    version: 3, label,
    protocol: { id: protocol.id, sha256: protocolSha256, minimum_samples_per_cell: protocol.minimum_samples_per_cell, percentile_method: protocol.percentile_method },
    baseline_status: missing.length ? "insufficient_samples" : "protocol_cells_complete",
    missing_cells: missing,
    data_quality: { duplicate_action_samples_dropped: duplicateActionSamples, browser_samples_without_server_trace: browserSamplesWithoutServerTrace },
    phases,
    chat_cache: cacheSummary(usable, classes),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, label, protocolPath = DEFAULT_PROTOCOL] = process.argv.slice(2);
  if (!file || !label) throw new Error("Usage: node scripts/workflow_performance_report.mjs <NDJSON log> <environment and corpus label> [protocol.json]");
  const events = readFileSync(file, "utf8").split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const protocolText = readFileSync(protocolPath, "utf8");
  const report = summarizeWorkflowPerformance(events, { label, protocol: JSON.parse(protocolText), protocolSha256: createHash("sha256").update(protocolText).digest("hex") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
