# Azure, Entra and document ingestion verification — 24 September 2026

This follow-up replaces the earlier untested Azure/Entra/ingestion boundary with
specific live checks. It also fixes two defects reproduced during those checks.
It does not deploy the integration branch or establish a staging environment.
The [evidence register](azure-entra-ingestion-evidence-2026-09-24.json) records
the environments, results, failed attempts, cleanup and evidence hashes.

## Confirmed defects and changes

### Standalone database indexing permission

A fresh PostgreSQL/pgvector database initialized from the baseline accepted an
Azure upload but failed the persisted ingestion job with `permission denied for
schema extensions`. The application role had table and function permissions but
lacked schema `USAGE`, which is required for the `extensions.vector` cast used
when writing embeddings.

`20260924183000_service_role_extensions_access.sql` grants only schema `USAGE`
to `service_role`; the baseline includes the same grant. It grants neither
schema `CREATE` nor access to anonymous/authenticated API roles. The SQL
regression fails against the old baseline, then passes against the fixed
baseline and a populated database upgraded twice. It exercises vector writes
under the actual application role, preservation of existing rows, denied schema
creation, and denied public-role schema/RPC access. The full HTTP ingestion
workflow also passes after applying this migration to the disposable database.

The live production retrieval RPC already accepts vector input under its service
role (HTTP 200, empty result with an empty source filter). This finding establishes
a fresh-installation defect, not a demonstrated production indexing outage.

### Automatic OCR for small scans

The fast parser returns `[[SIDE:1]]` for the 48,724-byte image-only test PDF, with
no source-map text. The OCR decision treated this marker as readable content,
requested Docling without OCR, and the ingestion job failed. The existing OCR
decision now excludes page markers from its text-quality calculation while
leaving the original source text intact. No model, OCR engine, dependency,
retrieval budget or explicit OCR setting changed.

A regression fails before the change and passes afterward. It covers single,
multiple and ranged page markers, real text, non-PDF input and explicit OCR-off
configuration. A fresh run through the actual HTTP upload and persisted job
uses Docling 2.99.0 with automatic OCR and completes indexing and metadata.
The extracted requirement IDs, 14-month retention, four courses and control code
are retained. Some Norwegian accents are lost (`måneder` becomes `maneder`);
this functional check does not establish character-perfect OCR. The original
PDF remains byte-identical on download.

## Live Azure and Microsoft sign-in

Read-only production checks used the `anbud-prod` resource group in subscription
`9841703e-4a2d-49a7-ae9f-f20af28a8fd7`. Production still serves main commit
`74de89311ace741fc17733c3924ad16574315813`, with 100% traffic on that revision.
Web and scheduled worker use the same immutable image digest, recorded in the
evidence register. The CLI subscription tenant differs from the application's
Microsoft External ID tenant; this distinction was checked explicitly.

- Live liveness returned HTTP 200. Anonymous project and readiness requests
  returned HTTP 401.
- The actual browser Microsoft sign-in flow completed and opened the protected
  project list. The account menu showed Microsoft authentication and Administrator.
  Sign-out returned to login, and reopening the protected page redirected to login.
  This exercised an existing Microsoft browser session, not a fresh MFA challenge.
- Simulated provider cancellation and invalid callback state redirected to the
  expected login error states, cleared all three flow cookies, and used no-store.
- Inside the running production web container, its managed identity obtained a
  storage token (200), read private-container properties (200), and reached the
  internal data API (200). No tokens or customer payloads were printed.
- A read-only vector retrieval RPC with an empty source filter returned 200 and
  no rows. Both web and worker have Blob Data Contributor scoped to the private
  document container. The five observed scheduled worker executions succeeded;
  this is worker health evidence, not a new production document execution.

Direct authenticated readiness JSON navigation was blocked by the browser client;
it is not counted as a successful route check. The separate production dependency
probes above passed. The actual authenticated readiness route passed in the
isolated ingestion environment. Azure CLI registration inventory required MFA
(`AADSTS50076`); no Conditional Access or complete identity-policy audit is claimed.
Microsoft authentication implementation is unchanged between main and this branch.

## Ingestion environment and results

The candidate application ran on Node 22.14.0 with a disposable PostgreSQL 17/
pgvector database and PostgREST. It used real Azure Blob Storage in a new private
container in the Learning subscription's `learningstorageee` account. No separate
Anbud staging deployment was present in either accessible subscription. This was
a local application with real cloud storage, not a deployed Azure candidate.

All fixtures were fictional. PDF, DOCX and TXT used the fast parsers; the separate
image-only PDF used the candidate's ingestion workflow with the pinned Docling
2.99.0 runtime from an existing local Docker image, with its network disabled.
Only Docling ran in that image; the current candidate owned the HTTP routes, job
execution, persistence and OCR decision. AI embeddings and metadata used actual
provider calls through the budget proxy, with no mocked database or storage.

Successful runs checked:

- Actual password login, project creation, multipart upload, durable job
  completion and preservation of all three document roles.
- Persisted `enhanced_ready`, indexing timestamps, source revisions, encrypted
  source text, nonempty chunks and non-null embeddings. Inferred customer metadata
  was present when the primary-document job completed.
- Encrypted blob round trips and byte-identical application downloads with
  `private, no-store`. Anonymous blob access returned Azure's
  `409 PublicAccessNotPermitted`.
- A disposable restricted viewer could read its project but was denied upload
  and source download by middleware (404). Revoking its persisted session made
  subsequent access return 401. This local role fixture did not perform Entra login.
- Authenticated readiness checked the local data API and live Azure container.
- Actual document and project delete routes removed blobs, chunks and rows.

The test operator initially had subscription Owner but lacked blob data access.
A temporary Blob Data Contributor assignment was added only to the newly created
test container. Its initial propagation failures, harness assumptions about Azure
denial status and middleware denial status, and the Docker path-mapping correction
are retained separately from application defects. The OCR accent discrepancy is
also retained, rather than silently counted as exact text fidelity.

## Verification, spending and cleanup

Final local checks: 930 frontend tests, 129 repository tests and 46 workflow
regressions passed without failures or skips. SQL tests used disposable real
PostgreSQL/pgvector. Parser golden checks, lint with zero warnings, production
build/type validation, secret scan, project-job schema, workflow boundaries,
release contracts and whitespace checks passed. Both new regressions were
observed failing for the relevant behavior before their fixes.

The original $2 AI cap was preserved. This follow-up made 17 additional requests
with conservative accounted cost **$0.012225**, bringing the total to **$1.562117**
and leaving **$0.437883**. The prior 20-request ledger remains unchanged; a copy
extended it under a $0.45 phase cap. No paid calls were pending when the proxy
stopped. These figures describe AI API accounting, not an Azure billing estimate.

Successful runs deleted their own fixtures through application routes. Cleanup
also deleted nine projects from failed/partial attempts through those routes.
The Azure container and its temporary role assignment were removed and verified
absent. Disposable database/API containers and their network were removed; the
local application and budget proxy stopped. Production content, configuration,
roles, code and schema were not changed. Normal sign-in/sign-out session writes
were the only production authentication actions.

## Release boundary

The two fixes are on the integration branch and require the normal main/CI/
protected-production release process. Apply the new additive migration along
with the previously identified integration migrations; historical job-result
cleanup remains a separate release operation. A deployed candidate workflow,
representative multi-worker load and a wider OCR corpus remain release/evaluation
checks. This report establishes the specific functional paths above, not those
broader guarantees.
