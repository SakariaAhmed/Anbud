# RAG release completion — work in progress

Base: `bdce7f1c36becc8a6d78d7114849a67cc97be744` (merged PR #89).
Branch: `Feature/rag-release-completion`. User requests all remaining work,
with council and full-send. Merge is authorized after proof/review/CI;
production deployment is a separate approval step.

## Council scope audit

Sol: 6/10. Opus: 5.5/10. Both ran read-only at high effort. Both are
available for this task; the earlier Sol routing gap is historical.
Neither audit reran tests or approved the unimplemented scope.

## Acceptance ledger

- [ ] Original unchanged retrieval release gate: at least 35/36 conceptual,
  MRR >= .7; exact IDs rank one; frozen holdout/supplement preserved.
- [ ] Frozen broader factual/negative model gate, including >90k-character
  retrieval with analysis present; distinct judge, per-claim outcomes,
  separate factual/negative/conversation/repeat denominators. Saved v2/v3
  evidence remains historical and cannot become a passing v4 run.
- [ ] Narrative reconciliation after row/criterion downgrades, ambiguous
  finding guidance, proof cleanup, visible notice, safe summary input.
- [ ] Explicit page/heading claim validation; normalized repeated passages;
  replay saved outputs to measure false rejections.
- [ ] Requirement wording provenance alongside ID provenance; observed failure
  extraction fixtures. Legacy origin stays unknown, never inferred observed.
- [ ] Per-answer source confidence with reasons, immutable identity,
  manual-edit invalidation and selected-regeneration preservation.
- [ ] Stored per-criterion assessment, original criterion identity, evidence,
  row caps and follow-up UI; proposed criteria remain labelled as proposals.
- [ ] Validated partial analysis sections: streamed complete fields,
  encrypted lease/source/manual-fenced persistence, incomplete UI, final
  replacement; never consumed as complete analysis by downstream workflows.
- [ ] Broader ID ambiguity/occurrence/artifact fixtures and negative-answer
  checks that preserve complete-document and interpretation questions.
- [ ] Operation/revision render correlation, upload-to-ready metrics,
  protocol-frozen p50/p95/TTFT/cache baseline by document class.
- [ ] Actual PDF and OCR multipart upload through local stack; index/readiness,
  register, page provenance and authorized source opening.
- [ ] Enhancement failure/reload/explicit recovery and all progress surfaces,
  desktop/mobile/keyboard evidence.
- [ ] Full unit/SQL/integration/E2E/build/secret/workflow checks at final pin;
  council final review and CodeRabbit findings; CI before merge.
- [ ] External prerequisites: live Entra/MFA, protected production migrations
  and aligned immutable web/worker rollout, real dependency/latency checks,
  human claim/review timing and confidence calibration, authorized real-tender
  evaluation. Local synthetic tests cannot satisfy these claims.

## Work and evidence so far

Implemented locally (not yet final verified): strict extended release policy,
all-occurrences retrieval scoring, factual metric separation and frozen-code
checkpoints; narrative reconciliation; explicit locator validation; requirement
wording provenance; per-row source confidence; per-criterion coverage contracts;
reranker omission semantics and large-document abstention with analysis present.

Foundation implementation is committed locally at `a03b7a8a`: 124 focused app
tests, 13 metric/gate tests and the frozen-fixture check passed. Partial-analysis
integration now has 29 focused tests observed by the parent, including rejection
of invented quotations/IDs before preview persistence. TypeScript and targeted
partial-analysis lint pass. The preview uses the shared quotation, ID and locator
validator after normalization; these membership checks do not prove semantic
entailment. Real SQL, browser and provider proof remain pending.

No new paid model/embedding calls, PR, production access or deployment yet.
The prior cumulative AI budget is still
$10, with $6.331864 previously accounted and $3.668136 remaining. Do not reset
or refill its ledger. Suggested bounded allocation: development .50, feature
runs .60, retrieval .40, final semantic 1.60, reserve .568136; these are caps,
not a new authorization or evidence of actual spending.

The initial disposable SQL replay did not run: the owned Docker container
remained in `created`, with no PostgreSQL process, and the loopback connection
was refused. A network-free container also remained `created`. Existing
unrelated containers are untouched; SQL/HTTP proof is still pending.

Subsequent local verification (2026-11-02): the owned stack now runs with AI
disabled. The partial-analysis migration and actual PostgreSQL regression pass
(2 tests, no skips), including lease/source/manual fences, failure reload and
service-only access. This does not yet establish full-schema upgrade or browser
behavior. The free recorded conceptual replay also ran: 30/36 recall@10 (83.3%),
MRR .565, 36 hybrid calls, zero memory fallbacks, zero missing vectors and zero
provider requests. MAL-DRI-09 is present at heuristic rank 44 but excluded from
the 32-candidate reranker pool. Five other misses are inside that pool. No new
quality improvement is claimed.

The independent holdout runner is implemented but unrun. Its execution protocol
`single-primary-with-requirement-attachments.v1` uses the existing application's
one-primary contract: the first customer document in frozen order stays primary;
additional customer requirement documents are uploaded as supporting
`kravdokument`. This mapping is registered before any holdout model execution,
included in the checkpoint identity and judge input, and checked against persisted
roles. Fixture bytes, source identities, questions, labels and thresholds are
unchanged. Both declared fixture and actual application roles are reported.
The parent observed 22 runner/fixture tests passing and targeted root-script lint
passing after this integration. This is harness proof, not a passing live suite.

The baseline-reset failure is fixed by including the new partial-preview table
in the explicitly destructive reset. All three real-SQL checks pass, including
preservation of both ownership foreign keys after the second reset.

The reranker pool now preserves SQL-fusion and semantic candidates (maximum 48,
700 characters per passage), and source version numbers survive excerpting.
The parent reran 39 focused tests successfully. Development pool coverage is
36/36 and expected evidence survives all 36 excerpts; mean passage content grew
16%. This is not measured model improvement. The full free recorded runs still
fail release: original 116-case suite has 60/60 exact IDs at rank one and 20/20
holdout hits, but conceptual recall is 30/36 with MRR .565. The separate 55-case
extended suite has stress 18/20, below its unchanged .95 release floor; follow-up,
tender IDs, amendments and missing-ID checks pass. Both runs used zero provider
calls, zero missing vectors and zero memory fallbacks. No holdout labels changed.

Shared generation rules now preserve the actor/action/object/condition/deadline
relationship and require checking generated interpretations against primary
evidence. This addresses the observed plan-versus-execution deadline failure
class; live effectiveness remains unproven pending versioned evaluation.
An unverified criterion identity can no longer be stored as a definite missing
coverage judgement. The parent observed 30 criterion/evaluation/chat tests pass.

## Integrated local verification

The combined `npm test` run completed successfully: 1,497 frontend tests and
194 root-script tests, zero failures or skips, followed by parser goldens.
The SQL test variables pointed only at the owned disposable local PostgreSQL
server. Full ESLint and TypeScript checks also passed. These results cover the
working tree, not a deployed revision or a passing model release gate.
The production build and secret scan also passed. The owned development app was
stopped for the build and restarted afterward with AI still disabled.

The new frozen deterministic contract exercises all repeated source/locator
occurrences (`all_evidence_cases=1`), result-budget ambiguity, competing artifact
sections and stale/foreign denial. Real encrypted artifact persistence tests
cover answer-confidence history/reload, selected-only updates, immutable row
identity, manual-edit invalidation, legacy unknowns and stale/foreign sources.
This supplements unit contracts; it does not change the original pgvector
release-suite labels or establish semantic confidence calibration.

Criterion coverage now carries original wording, evidence, analysis identity,
source revisions and fingerprints. Observed, suggested and unknown origins
remain distinct. Its real SQL regression exercises encrypted publication,
history/reload and invalidation. Partial analyses remain separate encrypted,
lease/source/manual-fenced previews; failed previews survive reload and cannot
be read as complete analyses. Provider-stream and browser proof for those
features is still pending.

The parent inspected the saved 24-check multipart PDF/OCR system report. It
records the formerly missing K-42/K-43 rows, exact basic-register wording,
original-byte preservation, restricted-download denial, persisted enhancement
failure and explicit recovery. A real 60-second deadline with a parser returning
at 75 seconds left revision/chunks/manual work unchanged until explicit recovery.
The delegate also verified retry focus at 390 and 1440 pixels. This ran with
Docling 2.99.0, not the Dockerfile's pinned 2.142.1; it is local synthetic proof.
The new deadline migration must precede application rollout. Existing stuck
documents are not backfilled, and the parser process itself still runs to exit.
An enhancement deadline before the source is read records only the job failure.

Observed wording means the stored source's own characters with whitespace
collapsed, with an original span. Ambiguous character variants are reconstructed.
The basic PDF has 24 observed rows with no answer-key wording differences. The
enhanced version has 21 observed and three reconstructed rows; stored Docling
hyphens differ from the original PDF in two rows. Observed does not promise OCR
fidelity to the binary original. The new failure fixtures record actual outputs
from synthetic PDFs, parser versions, hashes and source maps.

The holdout proxy now records a fixed request-purpose label, keeping reranking
separate from chat generation even when they share a model. Internal bounded
transport/repair calls remain charged and retained; one issued answer means one
HTTP dispatch. No accounting limits changed. Judge inputs place stable source
context first. The chat stream now matches persisted outer-whitespace trimming.
These changes passed 33 harness/budget tests and 22 chat tests before the full run.

The latency protocol still has insufficient samples. No p50/p95, cache-hit or
human timing target is claimed. No new paid evaluation has run at this point;
the original conceptual and extended stress release failures remain open.

## Council round 2 follow-up

Sol scored candidate `1ef9af3d` 7/10 and withheld approval to spend on final proof.
Three reproduced defects were fixed: the evaluation view now receives complete
source documents separately from solution-selection candidates; enhancement
retry rechecks revision and eligibility, coalesces/enqueues and clears the error
in one project-locked transaction; diagram previews are withheld on publication
and reload until a diagram-label validator exists. Withholding a diagram does
not interrupt validated prose previews or final analysis generation.

Eleven focused regressions passed with zero skips, including actual evaluation
component rendering, preview publication/reload, real concurrent PostgreSQL
publication versus retry, failed-enqueue rollback and baseline reset. TypeScript
and affected-file lint passed. The additive retry migration must precede code
rollout. This is a correction to the reviewed candidate, not council approval or
a new semantic quality result.
The new atomic-retry migration was applied only to the owned local application
database. Its HTTP enhancement rerun exceeded the harness's 240-second parent
timeout while the offline Docling child was still running; no passing result
was produced. The harness failure marker was removed afterward. The earlier
24-check result predates this atomic-retry change and is not its HTTP proof.
