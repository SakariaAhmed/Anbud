# RAG quality and working experience: implementation record

Work starts from `49a79d33` on `Feature/rag-quality-experience`. Nothing in this record establishes a production improvement or an applied production migration.

## Council audit

The configured two-member council reviewed current main read-only at high effort: GPT-6.1 Sol and Claude Opus 5.5. Both scored code health 7/10; recommendation coverage was 5/10 and 4/10 respectively. They confirmed that OR keyword terms, executable evaluation, scoped dashboard aggregates, shared document failure tracking, artifact authority checks and the requirement-response owner already exist. Their main remaining concerns were production-path evaluation, citation persistence, exact lookup, estimated progress and the review workspace.

## Foundation implemented locally

- Real recorded embeddings replay against a disposable pgvector database using the current hybrid RPC, with explicit network recording, input/model hashing and completeness checks. CI runs the SQL gate as well as the existing fallback gate. Missing embeddings cannot silently pass via lexical fallback.
- Exact-ID lookup resolves deterministic requirement-ledger rows from the supplied persisted document snapshot, caches by source fingerprint/revision, retains repeated occurrences and pins authoritative requirements ahead of model reranking. The encrypted document-intelligence artifact now persists the register during ingestion, including when v3 analysis is off; legacy sources fall back to rebuilding it. Failed or ambiguous documents are isolated and never become authoritative lookup rows.
- Independent subqueries run concurrently and fuse with reciprocal rank fusion. A migration derives Norwegian stems from the existing plaintext FTS lexemes, backfills them and maintains them with a trigger. The simple index and encrypted originals remain intact. This adds no plaintext document representation; the existing lexeme-at-rest policy also applies to the derived index.
- Chat uses Responses streaming with nonpersistent requests, a stable project/model/system cache key, first-token and verified usage events, cancellation and explicit terminal-event checks. Deterministic retrieval overlaps query rewriting. Stable whole documents, analysis and evaluation precede volatile retrieval/history/question context. All supporting sources can be included whole when the entire collection fits.
- Incomplete-context chat drops duplicated raw prefixes. After bounded retrieval, weak evidence produces a deterministic Norwegian abstention. Generated artifacts are labeled interpretation.
- Chat evidence carries stable evidence identity, chunk identity where available, source revision/fingerprint and an original quotation. Pre-save validation persists only actually cited sources and rejects unknown citation numbers, absent quotations and requirement IDs absent from their cited passage. This is membership validation, not proof of semantic entailment.
- A shared chat/analysis/requirement-review/evaluation source drawer displays quotation, locator, role and verification status. Original-document links require the server-derived download grant. Legacy analysis excerpts are labeled for verification.
- Document tracking publishes the basic persisted result before waiting for enhancement. Enhancement errors preserve basic state and give a distinct recovery action. Worker defaults use a one-minute cron, preserving existing claims and lease fences.
- UI completion percentages derive only from completed requirement counts. Other phases remain indeterminate and show persisted labels/elapsed time. Elapsed time no longer manufactures completion progress.
- Correlated, content-free upload/job/chat/validation/persistence events and a percentile/cache report script provide measurement boundaries. Browser render and document-class coverage still need the end-to-end baseline.
- Reproduced amendment additions no longer inherit the insertion anchor's pages. Explicit page markers can locate the addition; otherwise its page remains unknown. Inferred IDs retain their original local ID and inferred provenance.

## Review fixes and review workflow

The second council round reviewed foundation commit `b4e305e8`: Sol scored 7/10 and Opus 6/10. Their findings led to paragraph validation **before publication**, preserved sparse citation numbers and evidence fields on reload, whole-document and attachment binding, safe history/session-memory markers, technical-ID exclusions, per-document lookup failure isolation, cancellation checks and reuse of an unchanged retrieval candidate pool. CodeRabbit completed with 16 findings and one unreviewed file; the findings were assessed and addressed in this milestone. A fresh review is still required.

Norwegian stemming now retains original positions and weights, rather than creating alphabetically ordered artificial positions. A populated 1,001-row HNSW/FTS regression exercises the real additive migration and its idempotent backfill. The migration has a short DDL transaction, resumable 500-row commits and a concurrent GIN build. Scheduled claims now allow only one running scheduled worker job across projects while preserving web per-project concurrency.

The register appears before generated analysis and can be searched. The primary requirement review view synchronizes the requirement, answer and evidence at mobile widths, supports search, follow-up/unanswered/missing-source filters, next-unresolved navigation and j/k/e/a shortcuts. Single-row editing preserves immutable cells and creates a manual version. Selected regeneration uses the existing ledger generation owner for only the selected rows, preserves all other answer lines, remaps review flags and checks the parent again inside the lease-fenced SQL publication. A manual version created during generation prevents publication; successful retries remain idempotent.

The derived “Hva mangler?” panel lists unresolved current requirement answers, weak/missing/unclear coverage, missing solution elements and open customer-analysis ambiguities. It reports unknown coverage when no evaluation has been loaded. Source drawers can verify legacy excerpts against the current authorized document; page/heading data comes from the original source structure or explicit page markers. Repeated passages have no manufactured locator. Restricted viewers may read excerpts but still cannot download originals.

## Round-three fixes and live verification

Sol reviewed `e15aa97e` at 7/10 and withheld approval: preserved answers could be promoted from stale solution/service inputs; mixed legacy and indexed warnings could hide legacy rows; clarification sections could retain an old answer. The fixes capture revisions before the parent read, compare parent authority before generation, recheck its source/service/knowledge/evaluation dependencies under the publication lock, retain unmatched legacy warnings and replace selected clarification duplicates with references to their authoritative table row. New clarification outputs reference the table instead of duplicating answer text. Real SQL regressions reproduce both a new manual version and new source/service revisions while retaining the same parent ID.

Opus's round-three run returned no score because its provider failed with `ENOTFOUND`. The fresh CodeRabbit run also failed with `Connection failed: WebSocket closed`; this is a review gap, not a clean review. The previous CodeRabbit run completed with 16 findings and one unreviewed file. Greptile remains the accepted authentication gap.

The 116-case recorded SQL gate now stores encrypted requirement registers in PostgreSQL and reads five source registers through the real repository parser; all 60 ID cases remain rank one and conceptual recall remains 30/36. No paid calls occur during replay.

Actual model-backed HTTP testing completed customer analysis, requirement responses and evaluation. Chat exposed a false quotation rejection caused by balanced Markdown bold markers inside an exact quote; quotation comparison now ignores balanced emphasis while tests continue to reject changed words or unbalanced markup. A subsequent telemetry-header edit exposed a 500 during dev-server reloading; the variable and header construction order were fixed and the route regression also covers cancellation after provider EOF. The complete system test is being rerun and is not yet claimed green.

Browser DOM checks exercised the actual requirement workspace at 390px with no document-level horizontal overflow. Opening an uncached requirement source reached a verified original quotation in 1,056 ms and the drawer measured 390px wide. This is an automated display timing, not a human claim-verification study. Screenshot/interaction automation has connection failures, so visual and keyboard verification are incomplete.

Browser render metrics now correlate the first visible chat output to the server request trace, and register loading to the document trace. They are bounded, metadata-only client observations taken after paint frames, with cancellation and hidden-tab handling. Register load-to-render is not upload-to-ready and these measurements must not be added across unrelated navigation episodes.

## Mixed-corpus gate and completed system scenario

The frozen `4dc962f4` application passed the complete model-backed HTTP scenario: authentication, three document roles, encrypted storage round-trip, actual parsing/indexing/readiness, persisted register, dashboard counts, restricted excerpt reads with invented/stale/foreign evidence denied, guest-owned project/admin access, customer analysis, requirement generation, solution evaluation and streamed chat with its actual cited identity/quotation/revision fields reloaded from the database. This does not exercise live Entra or PDF/OCR through HTTP.

A separate real HTTP/job/SQL selected-generation test then created a child artifact version from one selected row while preserving the other two answer lines byte for byte and retaining the complete immutable manifest and current source authority.

The new `mixed-source-retrieval.v1` suite has 50 answerable cases and five missing IDs across the checked-in stress notes and SHA-256-bound PDF/DOCX parser snapshots of the fictional Hålandsvik tender. It measures original document/page/heading labels, follow-ups, hierarchical IDs, tables and amendments. It exposed a fixture subtype mismatch that caused memory fallback, lost explicit heading paths, and normalized PDF ledger wording that no longer matched a literal source span. The fixes preserve the source subtype, explicit heading path and actual line-start requirement spans with page-marker provenance; inline prose cross-references are not promoted to requirement rows.

The free SQL replay now reports zero provider calls, zero missing vectors and no memory fallback. Supplement recall@10 is 48/50 (96%), MRR 0.922; stress is 18/20, follow-ups 5/5, tender IDs 23/23 rank one, amendments 2/2 rank one and missing IDs 5/5 correctly marked weak. The original 116-case gate remains green with 60/60 ID rank one, conceptual recall 30/36 and unchanged holdout recall 20/20. The conceptual release threshold remains unmet. Regression floors are frozen separately by suite; no held-out cases were edited.

At 390px, actual DOM checks exercised search (K-1.3 leaves one row), j navigation and e opening the row editor with focus in the answer. The workspace has no document-level horizontal overflow. Screenshot tooling still times out; native browser access is unavailable. These DOM checks do not replace visual inspection on real mobile hardware.

Local development-server telemetry is a small-sample baseline, including failed investigation runs: six measured first-visible chat events had p50 2,347 ms/p95 4,236 ms; four completed provider usage records had 49.2% weighted cached input tokens. The aggregate cache target above 50% is not met by that sample. TXT ingestion total had 15 observations, p50 392 ms/p95 6,571 ms. Generation is still slow: three analysis phases measured p50 82,634 ms and three evaluation phases p50 108,787 ms. No production latency improvement or representative PDF timing is established.

## Migration and rollback notes

Apply `20261101210000_norwegian_hybrid_retrieval.sql` with `psql -f` in autocommit mode: its batched backfill and concurrent index cannot run with `--single-transaction`. If a previous concurrent index build left an invalid index, follow the migration's explicit recovery instruction before rerunning. The baseline is only for disposable databases.

Apply `20261101213000_scheduled_worker_capacity.sql` and `20261101220000_selected_requirement_regeneration.sql` before releasing code that relies on them. Older worker images do not identify scheduled claims; restore the five-minute cron before rolling back to an older image. No production migration or deployment has been performed.

Queue wait means elapsed time since job creation, including reclaimed jobs. The performance report separates successful, failed and combined latency distributions; none constitutes a production latency claim.

## Measured retrieval baseline

All runs below used the 116-case frozen corpus and real SQL. The recorded replay is free of provider calls; timings include local process/SQL transport and are not production latency.

| Group | Main rank 1 | Foundation rank 1 | Main recall@10 | Foundation recall@10 |
| --- | ---: | ---: | ---: | ---: |
| Exact IDs (60) | 93.3% | 100% | 100% | 100% |
| Development paraphrases (36) | 44.4% | 41.7% | 83.3% | 83.3% |
| Frozen held-out paraphrases (20) | 85% | 85% | 100% | 100% |

The 95% conceptual release target is **unmet**. A trial that prioritized the SQL fusion score reduced development recall and was removed. No model default was changed and no holdout cases were adjusted. Membership-validation tests do not establish 98% citation correctness or groundedness.

Exact-ID rank 1 measures the complete chat retrieval path including the authoritative register pin, not SQL keyword rank alone. The conceptual group independently exercises the hybrid path.

## Remaining deliverables by recommendation

| # | Remaining work |
| --- | --- |
| 1 | Mixed stress/PDF/DOCX case gate is implemented; budgeted groundedness/citation release tier and broader conceptual/unanswerable coverage remain. |
| 2 | Evaluate subquery fusion and Norwegian indexing on the expanded versioned corpus, then measure reranker value. |
| 3 | Persisted register reads, legacy fallback/source isolation and actual encrypted-register SQL replay are implemented; broaden ambiguous/repeated-ID fixtures. |
| 4 | Measure abstention for unanswerable conceptual questions and missing exact IDs; preserve whole-document answering. |
| 5 | Explicit artifact-reference guarantees and section-level discovery over the complete current collection. |
| 6 | Extend the evidence contract/pre-save checks to requirement responses, evaluation, executive summary and Bilag 1; locator and quote integrity across all output types. |
| 7 | Held-out observed extraction failures and complete observed/inferred provenance. |
| 8 | Complete browser render correlation and publish the actual local p50/p95 baseline by document class. |
| 9 | Verify configuration/release checks; deployment remains separate. |
| 10 | Register-first publication, readiness-safe automatic analysis and validated section delivery. |
| 11 | Measure first-token time and cache fraction on budgeted repeated real chat requests. |
| 12 | Preserve the model configuration owner and requirement-response owner; use versioned A/B evaluation for future policy changes. |
| 13 | Already implemented on main; production migration application is not established by local tests. |
| 14 | Browser/system verification of enhancement-only failure and recovery. |
| 15 | Verify measured counts and indeterminate phases across all affected screens. |
| 16 | Requirement/evaluation drawers are wired; finish Bilag sources and desktop/mobile claim-verification timing. |
| 17 | Review UI, row editing, selected regeneration, transactional parent/source protection and 390px DOM/keyboard checks are implemented; confidence handling, visual checks and review timing remain. |
| 18 | Derived follow-up view implemented; browser verification and evaluated-criterion mapping remain. |

No new search service, orchestration framework or model/provider migration is planned. Keep v3's complete evidence context intact. Greptile remains the accepted authentication/review gap from the preceding task; final review uses CodeRabbit and the configured council.

## Round four and output evidence

The two configured members reviewed `4dc962f4`: Sol scored 8/10, Opus 7.5/10; neither approved. They confirmed the round-three fixes. The new fixes bind an editor draft to its original row and block all navigation while editing/saving, reuse the existing standards exclusion predicate for protocol names, and try both literal and balanced-emphasis quotation forms while returning original source characters. Regression tests cover these failures. The actual reloaded browser at 390px confirms a/j/k/e cannot change the draft row or filter while editing. Desktop 1440px and mobile screenshots now work and show no horizontal overflow.

Output evidence v1 now binds original quotations and requirement IDs before requirement-response/Bilag artifact publication, evaluation publication and executive-summary generation. Evidence is persisted with source revision, fingerprint and identity. Generated-artifact excerpts are explicitly interpretation, including when carried into a summary. Manual changes discard the changed cell's inherited proof without discarding unchanged cells. This is deterministic membership, not semantic entailment; free-form locator validation is still incomplete.

Chat ranks sections across the entire authorized current artifact collection before budgeting its context, recognizes explicit artifact-type aliases and can cite selected original draft passages as interpretation. Stale, historical and foreign-project artifacts remain excluded.

The complete local suite passed 1,349 frontend tests and 152 root tests with zero failures/skips, plus parser goldens. Three subsequently added evidence-boundary cases passed in a focused six-test run; lint/type checks passed. The expanded live run completed customer analysis, requirement responses, Bilag 1, evaluation and executive summary. Its older final assertion wrongly expected the previous requirement artifact to remain source-fresh after Bilag changed cross-type knowledge; the harness now checks freshness at publication and keeps subsequent freshness explicit. Resuming the completed project verified all four persisted evidence contracts, authorization and actual streamed-chat citation persistence. No paid generation jobs were repeated for that assertion correction.

The new explicitly budgeted `rag-model-release.v1` smoke has eight synthetic cases and a separate fast-model judge. Its first run passed deterministic citation integrity 8/8, judged citation correctness 8/8 and negative-answer abstention 3/3, but groundedness was 7/8: a correct first paragraph was followed by the source-validator recovery message after a later paragraph failed its ID check. The release gate correctly failed. The source contract now explicitly includes headings and closing questions; this prompt adjustment requires another versioned run. The small smoke is not a statistical production-quality estimate or a replacement for the recorded SQL suite.

The stricter completed smoke passed 8/8 grounded answers and citations and 3/3 negative answers. A draft judge result had accepted truncated answers; the evaluator now rejects every source-validation recovery message deterministically and requires an actual generated-artifact citation for the draft-summary case. Earlier draft runs are not passing release evidence. One bounded paragraph repair handles recognized citation failures against the captured sources and is itself validated before display. It can correct a reconstructed quote or remove quotation marks from a proposed follow-up; it cannot introduce source-absent numeric facts or unknown requirement IDs. Failed repair retains the honest failure state. Regression tests cover the one-attempt bound, invalid numbers/IDs, corrected literal quotations and cancellation after provider EOF. This is a correction of unpublished generated text, never manual text.

An explicit paid reranker comparison replays the same recorded embeddings and current SQL, forwarding only model completions through the finite local budget proxy. It reports model calls separately and is disabled in CI. Development conceptual recall@10 rose from 30/36 to 34/36 (94.4%), MRR from 0.565 to 0.917; latency was p50 1,710 ms/p95 2,459 ms including the local retrieval path. The unchanged held-out set retained 20/20 recall@10, with 18/20 rank one and MRR 0.950. The 95% conceptual target remains unmet; no model default, label or holdout case changed. Case subsets cannot pass the complete regression gate.


## Round five: field-level source checks and preserved manual work

The fifth council pass reviewed `8625060f`: Sol scored 8/10 and Opus 6.5/10; neither approved. The fixes preserve untouched manual answer cells during selected regeneration, including their own quoted proposal wording, and reuse the same table parser for UI editing and retained evidence identity. Only generated selected cells are reviewed. Provenance fields such as document titles are not treated as generated claims. Legacy executive summaries now verify against the actual stable document snapshot rather than an empty document collection.

Unsupported generated fields are replaced with an explicit Norwegian clarification message and a persisted path-specific issue; their unsupported wording and inherited proof are withheld while valid fields remain usable. Authoring drafts may contain their own proposed wording without acquiring primary-source proof. Public source-validation errors now follow the existing workflow error contract. Formal IDs remain checked against authoritative requirement references; product, severity and planning labels do not acquire requirement authority merely by appearing in a generated draft.

Evaluation links now sit beside the corresponding requirement or finding. Bilag has inline paragraph sources and a collapsed catalogue; large catalogues mount their buttons only when opened. Summary links follow the field they support. The final static UI scan found only two pre-existing accent borders outside the changed sections. An observed mobile finding-header overflow and duplicate requirement-source link were corrected. Historical source IDs no longer bypass verification when the drawer opens: all displayed project-document quotations are checked against a consistent current revision, and original-document downloads reject a mismatched source revision with 409. Restricted download access is unchanged. Actual HTTP checks passed current/stale/invalid revision cases (200/409/400).

The complete local suite passed 1,370 frontend tests and 154 root tests, zero failures or skips, plus parser goldens. Subsequent focused tests cover the two observed chat-boundary failures below. Type validation, lint and the tracked secret scan passed; the large recorded-vector fixture is excluded by that scanner and was structurally checked separately. The fresh all-generator HTTP scenario passed customer analysis, requirement responses, solution proposal, risk plan, Bilag 1, evaluation and executive summary, with all four strict output evidence manifests containing zero issues for this known synthetic fixture. A separate real selected-regeneration scenario preserved an untouched manual quoted proposal and two unselected rows. These are local checks, not deployed changes.

The frozen ten-case `rag-model-release.v2` smoke includes normal conversation formatting and P1/L2/Q3/M365 planning, in addition to factual, generated-draft and three negative cases. Its failures exposed: generated terms being mistaken for registered IDs; a repair that omitted previously published solution evidence and contradicted it; a prose line joined to the next Markdown bullet as an invented compound ID; and user-supplied quoted wording being mistaken for a document quotation. Regression fixes retain line boundaries, preserve primary/prior repair context, and permit uncited repetition of exact user wording without creating document evidence. Cited quotes still require the actual cited source, and user wording cannot exempt an unknown requirement ID.

The configured model's completed smoke passed 10/10 grounded answers and citations and 3/3 negative answers. GPT-5.4 passed the same ten cases before the final two deterministic boundary fixes. Earlier failed runs are preserved in `docs/rag-quality-model-smoke-2026-11-02.json`; no model default changed. These small sequential development-server runs do not establish population quality, production latency or a randomized A/B speed improvement. The evaluator now checkpoints every persisted answer before judging and supports judge-only resumption, so malformed judge output cannot force repeated paid answer calls. The original cumulative local AI budget remains $10, with interrupted streams charged conservatively.

The recorded SQL suites last passed 116 original cases and 55 supplement cases with no provider calls or memory fallback. Conceptual recall remains 30/36 without model reranking and 34/36 in the explicit paid reranker comparison, below the 95% release target. The remaining-work table above records the wider plan; this milestone does not complete automatic analysis/validated section delivery, universal free-form locator validation, production measurements, or all 18 recommendations. CodeRabbit's completed first review and failed second connection remain explicit; Greptile remains the accepted authentication gap.
