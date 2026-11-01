# Recommendation follow-ups and verification — 2026-11-01

This work follows the technical-debt review of 2026-10-31 and the RAG discussion. It changes application code and tests; it does not deploy a production release or apply production migrations.

## Implemented changes

1. Dashboard counts now use a database aggregate restricted to the authorized project page. The service-role-only RPC reports all matching documents and artifact versions without global child-row limits. Query and malformed-count failures propagate instead of becoming cached zeroes. Baseline and additive migration are consistent.
2. A document-job coordinator follows ingestion and optional enhancement using the same terminal-failure handling. It refreshes persisted document state after failures and preserves abort/unmount semantics.
3. Cross-document corrections insert hierarchical IDs near their numeric predecessor without reordering existing rows. Explicit destination names take priority over numeric-parent inference; ambiguous destinations stop the workflow. Added requirements carry the correction document, excerpt and actual pages separately from logical register ownership; they do not borrow another requirement's source page.
4. The PostgREST adapter rejects malformed successful JSON and invalid table representations. Empty mutation/204 responses, HEAD requests and scalar RPC responses retain their intended contracts. Dashboard and artifact-currentness boundaries parse unknown values explicitly; broader repository typing remains debt.
5. Short numbered headings no longer become continuations of preceding customer facts merely because they contain digits. Wrapped amounts, dates and standard identifiers retain their regression coverage.
6. Requirement-response orchestration now lives in a substantive implementation owner with its batching, repairs, deadlines, progress and coverage logic. Shared runtime/context helpers own their dependencies. Other substantial coupling in `ai.ts`, the repository and workspace remains.
7. Authorization tests exercise denied routes with no downstream I/O, expired/disabled sessions, restricted-viewer download/generation/chat denial, grant filtering and administrator access without a project grant.
8. Chat fetches authoritative current IDs before loading artifact bodies, avoiding the UI history's 250-version cap, and rechecks authority after loading to exclude racing publication/deletion/invalidation. It selects relevant artifacts across that current, source-current, project-scoped set before applying its context cap. UUID scope comparisons tolerate uppercase route IDs.
9. The RAG evaluation command now executes retrieval and enforces a CI gate. Twenty held-out questions complement 60 ID lookups and 36 conceptual questions. Scoring requires the labeled evidence text when supplied and reports citation accuracy as unavailable when no citations exist.
10. System testing found that short hierarchical registers fell through to parsers that truncated their IDs. A regression now follows actual TXT ingestion through ledger extraction and completeness validation. Small normative registers preserve full IDs while incomplete coverage still stops publication.

## Retrieval evidence

The live run used disposable PostgreSQL/pgvector, stored hybrid retrieval, actual embeddings and bounded model reranking. All 116 cases passed the gate; 114 used model reranking and nine broadened retrieval.

| Group | Cases | Recall at 5 | Recall at 10 | MRR |
| --- | ---: | ---: | ---: | ---: |
| Explicit IDs | 60 | 100% | 100% | 1.000 |
| Conceptual | 36 | 94.4% | 94.4% | 0.880 |
| Held-out | 20 | 100% | 100% | 0.975 |
| All | 116 | 98.3% | 98.3% | 0.958 |

Median retrieval latency was 1,897 ms and p95 was 2,645 ms in this local run. These results measure labeled retrieval, not overall answer quality. Held-out questions use the same fictional corpus; they are a regression set, not evidence of generalization to unseen tenders. The deterministic offline fallback also passes its separate regression policy but remains weaker on the conceptual set (58.3% recall at 10); that limitation is explicit in the gate.

## Reproducing checks

Run application commands from `apps/frontend` with the Node version pinned by CI. Configure all four disposable SQL database variables from `.github/workflows/ci.yml` before `npm test`. Never use a production database.

```sh
npm test
npm run lint
npm run build
npm run secrets:scan
npm run rag:eval
```

From the repository root, the isolated system harness starts its own loopback PostgreSQL, PostgREST, Azurite and Next.js processes. It generates temporary credentials and stores them in a private temporary directory. Docker and installed frontend dependencies are required.

```sh
node scripts/system-test-environment.mjs start
node scripts/system-test-http.mjs
node scripts/system-test-environment.mjs stop
```

The default harness disables model calls, Document Intelligence and email delivery. Its app inherits only essential OS environment variables and explicit scenario configuration, and refuses frontend dotenv files; run it from a clean checkout. AI testing is explicit: start with `--live-ai` and an explicitly supplied `OPENAI_API_KEY`/`OPENAI_BASE_URL`, then run the HTTP script with `--ai`. Direct `--live-ai` has no built-in spending cap; use a budget-enforcing proxy when a cap is required. The `restart-ai` command targets the local budget proxy at port 4340; it does not load an upstream key. Use an absolute `ANBUD_SYSTEM_TEST_STATUS` to override the shared status path, otherwise it lives under the operating system's temporary directory. The browser-login controller signs in through the real local authentication endpoint and is stopped with the harness.

## Dependency decisions

PRs #79, #83, #84 and #85 were merged after applicable reviews and verification. #86 was superseded by #79; Dependabot closed #82 and its Tailwind update is included through #85. #81 remains open: Python 3.15 requires a source build of `pyclipper==1.4.0` in the proposed runtime image, where that build fails because `g++` is absent. A dependency-resolution dry run alone does not detect this failure.

The production Docling image with the retained Python 3.14 base built successfully and passed its container health smoke test. Authenticated browser checks exercised the updated UI at desktop and 390-pixel mobile widths, including input errors, tabs, dialogs and sidebar behavior. Live Entra sign-in, production data and production rollout were not exercised.

The live local HTTP scenario passed actual admin/guest sessions, role checks, project creation, three document-role uploads, encrypted blob round-trips, worker publication, parsing/indexing, dashboard RPC counts, customer analysis, improved requirement responses, solution evaluation and streamed project chat. Output assertions checked the customer size (120), all three explicit requirement IDs, artifact currentness, selected solution provenance and the sourced 30-day exit deadline. These synthetic examples do not establish quality across every tender format.

Separate OCR verification ran the built image offline as a non-root user through the application parser adapter. Both Norwegian scan fixtures retained exact text, original PDF bytes and page locators; the narrative fixture recovered all four expected requirements with marked source boundaries. The HTTP scenario used text uploads, not those OCR PDFs.

## Remaining debt

The repository and other AI workflows still contain coupled logic and broadly typed result boundaries. The generic fallback parser can miss an independent unnumbered obligation after a new section heading in a mixed short narrative; this pre-existing limitation is outside the bounded hierarchical-register repair. The new fast path rejects mixed narratives with unassigned obligations rather than taking over their extraction. Further parser work needs its own corpus fixtures and completeness policy.

Correction destinations deliberately reject an ambiguous unquoted plain title followed by a space and a numbered location. For example, an unselected `Sikkerhet del 3` must not silently bind to a selected `Sikkerhet`. A quoted name, filename, canonical attachment reference or explicit comma/`i` separator supplies a clear boundary; explicit requirement anchors also work without a comma. Document titles remain literal, including conjunctions and location-shaped words. This conservative limit avoids guessing an unknown source from a shorter selected title; it does not require changing original source bytes.
