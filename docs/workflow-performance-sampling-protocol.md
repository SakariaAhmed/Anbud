# Workflow performance sampling protocol

Protocol id: `workflow-performance-baseline-v1` (frozen 2026-11-02). Cells and
sample minimum live in `scripts/fixtures/workflow_performance_protocol.json`;
the report prints that file's SHA-256. Two baselines are only comparable when
the hash matches. Change the id instead of editing a frozen protocol in place.

No baseline exists yet. Nothing in this repository establishes a production
p50/p95, a human review time or a cost figure.

## What one sample means

| Phase | Starts | Ends | Correlation |
| --- | --- | --- | --- |
| `browser/upload_to_ready` | Submit in the workspace | Ready document painted | Document, revision, class; one per upload and revision; failures counted separately |
| `browser/requirement_register_render` | Register view opened | Stored rows painted, first read only | Document, revision, class, cold/warm; one per requirement document in each view episode |
| `browser/chat_first_render` | Message submitted | First answer text painted | Trace, corpus class, cold/warm, project revision via the trace |
| `provider_chat/first_token` | Provider request | First provider token | Same trace as the browser sample |
| `document/total` by `job_kind` | Job running | Terminal state | Ingestion and enhancement stay apart |

Cold means nothing in that page load has read the same key. A provider prompt
cache is measured separately as a token-weighted fraction.

Abandoned views, hidden tabs and superseded revisions report nothing. Failed and
completed samples never share a percentile. Separate navigations are separate
samples and are never added together.

## Running a baseline

1. Pin one commit, image digest, environment and corpus, and write them in the
   label. Keep one environment and one corpus per report.
2. Clean the log window. Record only the deployment under test.
3. Use a fresh browser profile. Cold: load the page and take the first sample.
   Warm: repeat in the same page load without a reload.
4. Upload each document class at least 20 times, as separate new documents. Take
   register samples from projects with one requirement document, so one view is
   one sample. Ask the same chat question set for each cell. Do not retry a failed
   sample; let it count as a failure.
5. Export the structured log lines to NDJSON and run
   `node scripts/workflow_performance_report.mjs <log> "<label>"`.
6. Publish `baseline_status`, `missing_cells` and `data_quality` with the numbers.
   `insufficient_samples` means no percentile from that run may be quoted as a
   baseline.

Percentiles are nearest-rank over completed samples.

## Limits

A local stack uses a development server and synthetic documents. Its report is
evidence that the measurement works, not a latency claim. A production baseline
needs production approval, authorized documents and the budget for model calls.
