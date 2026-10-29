# Merge verification — 24 September 2026

The integration contains current main `74de8931` and has no merge conflict.
This pass found and fixed one worker-reporting defect in `56e62ccc`.
No other application changes were made. The complete local suite and the
additional checks below pass. This is evidence of reduced regression risk,
not proof that every possible workflow or deployment is defect-free.

The [evidence register](merge-readiness-evidence-2026-09-24.json) records the
tested source, container identity, results, limitations and local log hashes.
The unrelated edits in the user's main checkout were preserved.

## Confirmed finding

When two workers selected the same queued job, the database correctly allowed
only one to acquire it. Only one model request ran and one result was published,
but both worker HTTP responses reported `processed: 1`.

The internal runner now returns whether it acquired the job. The queue runner
reports a lost claim as `skipped`. Claiming, leases, workflow execution, retries,
result publication and error handling are unchanged. `processed` continues to
mean that a worker acquired and handled the job; the persisted job can still
have a failed outcome. The defect also exists on main; it was not introduced
by merging the feature branch.

The concurrency regression failed before the fix and passed afterward.
Additional controls cover missing input and safe handling of claim failures.
Two rebuilt application containers reproduced the corrected response: the
same job was reported once as processed and once as skipped, with one model
request and one persisted result. A separate repeat also passed.

## Fresh verification

| Area | Result and scope |
| --- | --- |
| Complete test suite | 939 frontend, 129 repository and 46 workflow tests: **1,114 passed, zero failures or skips**. Real disposable PostgreSQL 17/pgvector. Another 36 contract checks were repeated by the harness and are excluded from this total. |
| Application checks | Lint with zero warnings, production build/type checking, secret scan, repository contracts, workflow YAML, Bicep build/lint and whitespace checks passed. Bicep emitted update notices only. |
| Parser golden checks | 8 normalization, 5 table-repair, 2 accepted-quality, 5 rejected-quality and 2 ledger-extraction cases passed. |
| Upgrade compatibility | All four branch migrations applied twice to populated current-main schema. Existing analysis preserved. Upgraded and fresh schemas agree on all 87 public functions and their grants, columns/defaults, constraints, indexes, triggers, RLS policies and table grants. The extensions schema grants also match; only service-role USAGE is added. |
| Extraction comparison | Current main and candidate independently scored the same 100-document dataset, with 7,038 reference requirements. Every document's scores and recorded mismatches match, excluding execution time. No measured regression. |
| OCR | Both frozen fixtures, three scanned pages, passed exact text through the application parser and final rebuilt image's CLI. Norwegian letters, identifiers, page references and original PDF bytes are preserved. Offline, UID 1001. |
| Authentication/access | Actual password login works across two replicas. Anonymous, restricted-viewer, revoked-session and disabled-principal denials pass. A global admin can read a project without ownership or a membership grant. Missing generation prerequisites return 422 without enqueueing. |
| Concurrent jobs | Eight identical enqueues coalesce. Two replicas publish only one result for that job and report it correctly. Separate projects can execute concurrently. Changing evaluation input during execution rejects stale output. Lease takeover closes the active provider connection in about 30 seconds and prevents stale publication. |
| Worker packaging | The actual `scripts/run_project_job_worker.mjs` entrypoint starts its server, claims and completes a durable job, then exits successfully. |
| Browser | Authenticated production-container checks at 1440×1000 and 390×844 pass: all eight history tabs remain read-only, keyboard focus returns correctly, unsaved drafts survive history navigation, current analysis is preserved and there is no page overflow or browser exception. Screenshots inspected. |

The extraction comparison is not a perfect-accuracy claim: strict row-text
recall is 99.9%, identifier accuracy 92.3%, heading accuracy 97.4%, and exact
requirement counts match in 74 of 100 documents on **both** branches. These
existing shortcomings were not changed to manufacture a clean comparison.

The new container workflow checks used real PostgreSQL/PostgREST and TLS with
a disposable trusted certificate matching the production hostname policy.
They used controlled local model HTTP responses and fictional data. They prove
orchestration, access and persistence behavior, not live model answer quality.
Initial harness failures from HTTP database configuration, a too-short fixture
principal ID and a retained creator membership were corrected in test setup;
production security controls were not relaxed.

## Independent review and release limits

The [ChatGPT review](https://chatgpt.com/c/6ab586c9-9190-83eb-af9b-fdeaa6930cce)
was explicitly told it was speaking with Codex, given the actual defect, patch,
test evidence and limitations, and asked to challenge them. It found no
additional demonstrated flaw and requested the rebuilt two-worker race,
which passed. This was a review of supplied excerpts/evidence, not independent
repository access or independent execution of the tests.

The tested final container is `anbud-merge-verification:worker-fix`, image
`sha256:e4b322ccd175940a96ff4171f0558a85b3b115003b55838b795d7afc7dfd4a26`,
1,665,172,656 bytes, **linux/arm64**, Python 3.14.6, Node 22.23.1 and Docling
2.99.0. It uses the existing immutable model-cache prefill described in the
[OCR report](norwegian-ocr-verification-2026-09-24.md), followed by the normal
download/cleanup step. This is not the exact Azure release artifact:
production builds **linux/amd64**. The normal Dockerfile's unseeded model
download was attempted again and cancelled after about 20 minutes in that step;
it did not produce a verified image. No fatal application incompatibility was
demonstrated by this incomplete build attempt.

Before production promotion, the protected release must build and smoke-test
the exact amd64 image, keep web/worker digests aligned, apply the four documented
migrations and complete the documented historical job-result cleanup. The
candidate needs deployed login, ingestion and worker smoke checks. The bounded
two-worker tests are not a sustained-load or capacity test.

Earlier live Entra, managed-identity, private Azure Blob ingestion and bounded
AI checks remain recorded in the [cloud report](azure-entra-ingestion-verification-2026-09-24.md)
and [AI evidence](speed-quality-integration-ai-evidence-2026-09-24.json). They
were not rerun against a deployed candidate in this pass. No additional paid
AI calls were made: the prior $1.562117 of the authorized $2 remains unchanged.
No merge or deployment was performed. All six containers and the network created
for these checks were removed, along with their disposable credentials and TLS
private key. Unrelated containers and files were preserved.
