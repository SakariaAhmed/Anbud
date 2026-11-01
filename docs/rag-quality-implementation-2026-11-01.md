# RAG quality and working experience: implementation record

Work starts from `49a79d33` on `Feature/rag-quality-experience`. Nothing in this record establishes a production improvement or an applied production migration.

## Council audit

The configured two-member council reviewed current main read-only at high effort: GPT-6.1 Sol and Claude Opus 5.5. Both scored code health 7/10; recommendation coverage was 5/10 and 4/10 respectively. They confirmed that OR keyword terms, executable evaluation, scoped dashboard aggregates, shared document failure tracking, artifact authority checks and the requirement-response owner already exist. Their main remaining concerns were production-path evaluation, citation persistence, exact lookup, estimated progress and the review workspace.

## Foundation implemented locally

- Real recorded embeddings replay against a disposable pgvector database using the current hybrid RPC, with explicit network recording, input/model hashing and completeness checks. CI runs the SQL gate as well as the existing fallback gate. Missing embeddings cannot silently pass via lexical fallback.
- Exact-ID lookup resolves deterministic requirement-ledger rows from the supplied persisted document snapshot, caches by source fingerprint/revision, retains repeated occurrences and pins authoritative requirements ahead of model reranking. Legacy sources without a persisted register still rebuild the ledger; a dedicated persisted-register read surface remains work below.
- Independent subqueries run concurrently and fuse with reciprocal rank fusion. A migration derives Norwegian stems from the existing plaintext FTS lexemes, backfills them and maintains them with a trigger. The simple index and encrypted originals remain intact. This adds no plaintext document representation; the existing lexeme-at-rest policy also applies to the derived index.
- Chat uses Responses streaming with nonpersistent requests, a stable project/model/system cache key, first-token and verified usage events, cancellation and explicit terminal-event checks. Deterministic retrieval overlaps query rewriting. Stable whole documents, analysis and evaluation precede volatile retrieval/history/question context. All supporting sources can be included whole when the entire collection fits.
- Incomplete-context chat drops duplicated raw prefixes. After bounded retrieval, weak evidence produces a deterministic Norwegian abstention. Generated artifacts are labeled interpretation.
- Chat evidence carries stable evidence identity, chunk identity where available, source revision/fingerprint and an original quotation. Pre-save validation persists only actually cited sources and rejects unknown citation numbers, absent quotations and requirement IDs absent from their cited passage. This is membership validation, not proof of semantic entailment.
- A shared chat/analysis source drawer displays quotation, locator, role and verification status. Original-document links require the server-derived download grant. Legacy analysis excerpts are labeled for verification.
- Document tracking publishes the basic persisted result before waiting for enhancement. Enhancement errors preserve basic state and give a distinct recovery action. Worker defaults use a one-minute cron, preserving existing claims and lease fences.
- UI completion percentages derive only from completed requirement counts. Other phases remain indeterminate and show persisted labels/elapsed time. Elapsed time no longer manufactures completion progress.
- Correlated, content-free upload/job/chat/validation/persistence events and a percentile/cache report script provide measurement boundaries. Browser render and document-class coverage still need the end-to-end baseline.
- Reproduced amendment additions no longer inherit the insertion anchor's pages. Explicit page markers can locate the addition; otherwise its page remains unknown. Inferred IDs retain their original local ID and inferred provenance.

## Measured retrieval baseline

All runs below used the 116-case frozen corpus and real SQL. The recorded replay is free of provider calls; timings include local process/SQL transport and are not production latency.

| Group | Main rank 1 | Foundation rank 1 | Main recall@10 | Foundation recall@10 |
| --- | ---: | ---: | ---: | ---: |
| Exact IDs (60) | 93.3% | 100% | 100% | 100% |
| Development paraphrases (36) | 44.4% | 41.7% | 83.3% | 83.3% |
| Frozen held-out paraphrases (20) | 85% | 85% | 100% | 100% |

The 95% conceptual release target is **unmet**. A trial that prioritized the SQL fusion score reduced development recall and was removed. No model default was changed and no holdout cases were adjusted. Membership-validation tests do not establish 98% citation correctness or groundedness.

## Remaining deliverables by recommendation

| # | Remaining work |
| --- | --- |
| 1 | Extend labelled cases across stress and answer-key corpora, including pages/headings, amendments, follow-ups and unanswerable questions; budgeted groundedness/citation release tier. |
| 2 | Evaluate subquery fusion and Norwegian indexing on the expanded versioned corpus, then measure reranker value. |
| 3 | Use the persisted requirement register directly where available; handle legacy fallback and ambiguous source occurrences explicitly. |
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
| 16 | Extend the shared evidence drawer to requirement/evaluation/Bilag sources; desktop/mobile and claim-verification timing. |
| 17 | Search/filters, next unresolved, keyboard review, selected-row regeneration with edit/source concurrency protection and a 390px synchronized view. |
| 18 | A derived “Hva mangler?” view joining coverage, unanswered requirements and open clarifications. |

No new search service, orchestration framework or model/provider migration is planned. Keep v3's complete evidence context intact. Greptile remains the accepted authentication/review gap from the preceding task; final review uses CodeRabbit and the configured council.
