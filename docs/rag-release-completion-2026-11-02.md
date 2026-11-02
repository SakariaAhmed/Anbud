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

Opus's round-2 review scored `1ef9af3d` 6/10 and rejected proceeding to paid
evaluation. Sol's focused round-3 check scored `ce9050f6` 8/10, accepted the
criterion/diagram fixes and identified a coalescing interval where a failing
running job could falsely acknowledge a restart. The subsequent corrections:

- Criterion uncertainty alone no longer claims a requirement downgrade or
  withholds independently verified requirement narratives.
- Typed preview validation failures withhold that field and emit a safe code;
  later valid fields continue. Cancellation, lease, CAS and unexpected
  persistence failures remain fatal.
- Enhancement messages use a source/lease-fenced update that cannot change
  document readiness or parser identity. A failed publication that already
  changed the source retains its own failed/unindexed state.
- Retry jobs carry the captured source revision before any document read.
  Read failures and pre-read deadlines can record recovery through the terminal
  owner; changed configuration fails explicitly instead of leaving a queued
  message. Cancellation and lease loss do not record an enhancement failure.
- A retry cannot coalesce into a running attempt that has already recorded its
  failure. A queued retry clears its failure atomically. A new attempt can be
  accepted after the failed job is terminal.
- The post-settlement deadline test triggers the deadline explicitly after
  settlement, without racing subprocess startup. An older chunk-concurrency
  test exposed its own 80-ms startup assumption under load; the two parent-delete
  cases now wait for an insert-trigger notice before starting the deletion.

Four real PostgreSQL regressions passed without skips after these changes,
including the failed-but-not-terminal interval and publication state fences.
The enhancement workflow tests passed 15/15. The holdout/schema tests passed
31/31. An intermediate full run passed 1,503/1,505: one old test double lacked
the new state owner, and the timing assumption above failed. Both were corrected
and their focused tests passed; a new full green run is still required.

The holdout now saves a rolling cost projection before each answer dispatch:
the highest observed whole-route cost or an initial price-scaled estimate,
remaining judge reservations without assumed cache discounts, plus 20% margin.
This is a planning estimate, not a guaranteed total; the unchanged hard proxy
still enforces the actual authorization. The offline 80-case plan using
`gpt-5.4-mini` answers and distinct `gpt-5.6-luna` judging projects $3.972449,
above the $3.668136 remaining, before retrieval/feature runs. No provider call
or ledger mutation was made. The original $1.60 semantic and $0.40 retrieval
allocations must not be presented as sufficient. Budget revision, if needed,
requires a separate explicit authorization; frozen labels/thresholds stay fixed.

## Verification after the round-2/3 corrections

The complete rerun passed 1,505 frontend tests and 195 root script tests with
zero failures or skips, followed by the parser goldens. The production build
passed, including lint/type validation; the owned AI-disabled development app
was stopped for the build and restarted afterward. Streaming analysis retains
configured SDK retries before a stream is established; tests verify that an
interrupted stream is not restarted or published twice.

The corrected HTTP enhancement scenario passed all 10 checks against the owned
local PostgREST/PostgreSQL/Docling stack. It exercised persisted failure across
a new session, unchanged basic text/register/chunks/original bytes/manual work,
no automatic retry, denied and stale requests, repeated failure, queued retry
coalescing, and successful recovery with a new source revision. Manual work
survived byte-for-byte and became stale against that revision. The harness now
arms its failure marker before upload can dispatch enhancement and removes it
in a finally block. This passing run supersedes the timed-out recovery attempt
above; it still uses Docling 2.99.0 rather than the pinned 2.142.1 image.

Fresh browser proof for partial previews and criterion coverage remains blocked.
Two T3 preview snapshots failed with "Preview automation snapshot timed out
after 15000ms." The permitted fallback reported "The browser access host is
unavailable"; selecting Chrome and Brave then failed with "cgWindowNotFound".
Owned preview tabs were closed. No screenshot or successful visual check is
claimed from these attempts.

No new paid evaluation ran. Conceptual retrieval, stress, semantic quality,
latency sampling, current-image HTTP proof, production and human acceptance
remain open. These verification results establish the local code corrections,
not release approval or completion of all 18 recommendations.

## Council round 4: unversioned queued jobs

Sol scored `d9596103` 8/10 and found that an original ingestion job, requeued
after recording a parser failure, could lack `sourceRevision`. Coalescing a
retry into it cleared the error even though a later pre-read failure could not
restore the document failure through the terminal RPC.

The retry transaction now rejects active jobs without a captured revision and
preserves the document error. Once the old job is terminal, a fresh retry gets
the current captured revision. Real PostgreSQL coverage exercises the original
job's running-to-queued transition, rejected retry with unchanged document and
job count, terminal failure, and subsequent revision-tagged retry. The focused
run passed 16 tests with no skips; an additional real-worker/read-failure test
passed and confirms the retained error is not erased. Affected-test lint,
schema validation and whitespace checks passed. The full 1,700-test/build result
above belongs to `d9596103`, before this narrow SQL correction; it was not rerun
for this correction. Opus's round-4 review of that pin remains pending.

Opus subsequently scored `d9596103` 7.5/10, not satisfied. The next corrections
retain the raw model criterion ratings through normalization and compare them
by criterion index and wording. A model-assigned `Godt` that loses that rating
withholds the global narrative; an already-uncertain unlinked criterion and a
`Mangler`-to-`Uklart` identity correction do not. The overall notice now refers
to both requirement and criterion review. Regressions cover source changes,
invented evidence/rationale, and a downgrade that occurs during normalization.

The forecast now uses the greater of the initial estimate and observed mean
whole-route cost, plus the largest observed route once as an allowance while
answers remain. It no longer assumes every future answer repeats a single
repair spike. Outstanding judge reservations, the 20% margin, durable preflight
stop and hard proxy limit remain. The initial $0.03 assumption still contributes
$2.88 including margin to the unrun 80-answer forecast. The runner's fixed
$10 authorization and $3.668136 maximum phase cap remain unchanged; a future
budget increase would require explicit authorization, a code change and a new
frozen pin before any evaluation, not just resuming an old checkpoint.

Enhancement publication now supplies the revision captured before parsing to
the existing persistence owner. That owner rejects a changed revision before
any write, then retains its existing compare-and-swap fence for changes after
the read. A real-owner regression covers a role/subtype revision change during
parsing; the workflow test checks the captured revision reaches publication.
The previously plausible stale progress message after a concurrent role change
remains debt: publication is rejected safely, but that newer document can retain
old progress text. No recovery action or cleanup for that case is claimed.

Before the complete rerun, 38 focused application tests and 23 holdout-runner
tests passed; TypeScript and full lint passed. No provider call, budget change,
production action or frozen-fixture change was made.

The full rerun then passed 1,508 frontend tests and 196 root script tests with
zero failures or skips, followed by parser goldens. The preceding full attempt
had one failure in an existing SQL role-change race whose 80-ms delay sometimes
started replacement before demotion. That test now holds the demotion
transaction open, signals that its lock is acquired, and releases it after the
competing replacement completes; its focused real-SQL check passed before the
full rerun. Production build, lint/types, workflow/schema/release validation and
tracked-secret scan passed. The build preceded only this test-ordering repair
and report edits, with no subsequent application change. The owned AI-disabled
app was restarted after the build. Latest full log:
`/private/tmp/anbud-round4-final-tests.log`; build log:
`/private/tmp/anbud-round4-build.log`.

## Council round 5 result

Both configured members reviewed code pin `43e9acd8` read-only at high effort:
Sol 9/10, satisfied, with 53 independently passing deterministic tests; Opus
9/10, satisfied, with 61 independently passing deterministic tests. Both found
the prior blocking corrections resolved. Neither result approves production,
all 18 recommendations, or the still-unrun final quality evaluations.

Opus recorded three non-blocking follow-ups for a subsequent implementation pin:
criterion label/index contract violations can evade the lost-positive-rating
comparison; two reconciliation strings still say requirements when only a
criterion changed; and active unversioned retry rejection could explain that
the existing job must finish. Final feature evaluation should also record how
often narrative withholding occurs. These are not claimed fixed at this pin.
Before relying on the owned application database again, reapply/check the latest
branch version of migration 20261102150000: earlier local application runs used
an older version. Disposable SQL tests used the current migration and baseline.

The current code is accepted for final evaluation conditional on authorization
and runtime proof. Greptile remains an accepted signed-out review gap. The
original release gates and all external acceptance limits remain unchanged.

## PR #90 CI audit-harness correction

Validation at `78e152a4` passed its main test/build stage but failed the separate
workflow audit. Local reproduction found missing injected dependencies in the
AST-based audit harness: the persisted analysis-revision reader, partial preview
publisher, fenced enhancement-state writer and enhancement notice constant.
The adapters now call the current owners with real disposable SQL where needed.
The parser-failure control additionally asserts the persisted error, usable
basic status and preserved manual analysis. No application behavior was changed.

All 46 audit regressions passed with zero skips against a newly created local
audit database, which was removed afterward. The same historical populated
baseline and additive migration used by CI were also exercised: applying the
migration twice preserved the existing analysis. Affected-file lint and
whitespace checks passed. Log: `/private/tmp/anbud-pr90-audit-fixed.log`.
CI must still verify the pushed correction in its own environment.

## PR #90 CodeRabbit corrections

CI Validation, Infrastructure and Production Docling passed at `77b62f76`,
confirming the audit-harness correction above. The next correction addresses
all nine current CodeRabbit inline findings:

- Queued/running customer-analysis jobs keep partial previews polling even
  without a manual button's busy state; terminal jobs fetch their final snapshot.
- Only an artifact explicitly named in the current question can relax the weak
  evidence gate. A name inherited through rewriting/history cannot. Drafting and
  explicit attachment questions are no longer blocked by project ID truncation;
  unrelated attachments still cannot bypass that ambiguity check.
- Exact-ID questions can narrow the authorized source collection by document
  title/filename/Bilag alias and the authoritative register by an explicit chapter
  number or quoted heading before budgeting occurrences. Unscoped questions keep
  all occurrences, and the large-project context threshold is unchanged.
- Completed holdout answers and judge verdicts are saved before the separate
  accounting observation. Exhaustion/read failure cannot overwrite that evidence
  as an uncertain paid attempt. An unfinished accounting observation prevents a
  release pass, including a crash between the two saves; resume never redispatches.
- The smoke judge must explicitly assess the core answer. Supported off-topic
  claims fail factual metrics; unsupported claims veto negative-case abstention.
  Historical judge results, frozen cases and thresholds remain unchanged.
- The deadline scenario arms its parser-failure injection before upload can
  dispatch the worker, removes it in `finally`, and starts the child with the
  existing isolated environment builder rather than inherited provider settings.

Focused tests exercise actual workspace-to-preview props, polling and cleanup,
current/history intent, scoped repeated IDs, completed accounting outcomes and
negative/off-topic verdicts. These are deterministic component/owner tests, not
browser or live-provider proof. The real local HTTP deadline scenario passed all
three checks: a 60-second deadline persisted a recoverable error; the parser's
75-second late return changed no bytes/register/chunks/manual work; explicit
retry recovered revision 1 to 2. This used offline `docling-slim` 2.99.0 in image
`sha256:f168a8e0229f22ef2127275dd068500e4520a3401985cd8eddcfd4e201eee137`,
not the Dockerfile's pinned 2.142.1. The earlier local stack disappeared before
its in-progress test completed, so that run was not counted; a new isolated
stack supplied this proof.

Both recorded SQL regression gates passed again (116 original and 55
extended cases), without model calls or memory fallback. Conceptual retrieval remains
30/36, MRR 0.565; stress remains 18/20. These are regression passes, not the
unchanged release-quality thresholds. No paid evaluation, budget increase,
production action or new semantic-quality claim accompanies these corrections.

Final correction-tree verification passed 1,514 frontend tests and 201 root
script tests (1,715 total), with zero failures/skips and parser goldens. Final
production build, full lint, TypeScript, workflow/schema/release checks and
tracked-secret scan passed. The final build temporarily stopped only the owned
idle development process and restarted it with AI still disabled. Logs:
`/private/tmp/anbud-pr90-final-tests.log`,
`/private/tmp/anbud-pr90-final-build.log`, and
`/private/tmp/anbud-pr90-deadline-http.log`. Fresh council/CodeRabbit review and
CI on the correction commit are still required; earlier council approval is
not approval of this subsequent diff.

## Council round 6 and follow-up corrections

Both members reviewed `b7b87c05`: Sol scored 8/10 and Opus 7/10, neither
satisfied. They independently reproduced invalid `[Kilde 0]` labels when scoped
references were paired with unscoped small-project text. Opus also reproduced
source mentions and coordinated names silently narrowing retrieval, and both
found quoted chapter titles failing against numbered headings.

The correction uses the same scoped document collection for whole-document
blocks and citation references, while preserving the project-wide size threshold.
Source restriction now requires an immediately preceding `i`, `fra`, `ifølge`
or `under`; ambiguous coordinated forms such as “Bilag 1 og 2” remain unscoped.
Comparisons, cross-references and generic topical mentions preserve all ID
occurrences. Numeric chapter scopes accept punctuation and descendants; quoted
titles match numbered heading titles without losing repeated matches. The
clarification explicitly asks users to repeat the requirement ID. Filename
underscores are normalized before alias recognition. A current explicitly named
artifact is selected into the prompt even if rewriting loses its name.

CodeRabbit's separate minor context finding is also fixed: criterion summaries
preserve identity, origin, assessment, review status and linked requirements,
compact rationale/evidence, and omit repeated persistence snapshots. No criterion
is silently dropped. Newly judged legacy v3 smoke cases use their existing
citation/abstention flags to enforce the same core-answer and unsupported-claim
vetoes as the default suite; frozen fixtures and historical results are unchanged.

The accounting follow-ups remain disclosed: a failed/pending observation blocks
release but does not itself prohibit later paid work on resume, and provisional
case metrics can remain optimistic inside that failed report. This pass makes
no accounting, budget or provider change. Chapter restriction applies to the
authoritative register; broader contextual hybrid snippets can still include
other chapters. Neither limitation is claimed fixed.

Verification of this correction tree: 1,517 frontend and 202 root tests passed
(1,719 total), zero failures/skips, followed by parser goldens. Production build,
full lint, TypeScript, workflow boundaries, secret scan and whitespace checks
passed. Both recorded SQL regression gates passed again, with unchanged
conceptual 30/36 (MRR .565) and stress 18/20, no paid model replay and no memory
fallback. Tests include the actual retrieval owner on coordinated/comparative
source questions, small-project prompt/reference consistency, numbered/quoted
headings, explicit-artifact rewrite loss, criterion payload bounds and the
unchanged legacy v3 fixture. The local app was restarted with AI disabled after
the build. Logs: `/private/tmp/anbud-round6-full-tests.log`,
`/private/tmp/anbud-round6-build.log`, `/private/tmp/anbud-round6-retrieval.log`,
`/private/tmp/anbud-round6-extended.log`. No additional HTTP/OCR, browser or
provider run was needed or claimed for these prompt/lookup corrections. Fresh
council and CI review of the resulting commit remains pending.

## Council round 7 and source-intent corrections

Both members rejected `129b31a2` (Sol 8/10, Opus 7/10). The round-6 comparison
claim above was too broad: the tested questions lacked a leading scoped source.
Adding one could still discard a second source while reporting sufficient
evidence. Negated and indirect cross-references, solution-only scope, and a
parenthesized chapter exposed further gaps. Opus also found that an explicit
artifact follow-up lost the rewritten topic when ranking its sections.

The correction preserves the complete source set for recognized comparisons,
exclusions and cross-references, or whenever another mentioned document lacks
the scoping preposition. Non-requirement document requests retain the
requirement sources. One-word alphabetic titles require their original casing
to avoid interpreting a generic topic as a source restriction. The chapter
parser accepts closing parentheses, curly/single quotes, and `kap` with or
without a period. The clarification includes a literal syntax example.
Relevant amendment sections recognized by the existing correction parser stay
in the source set; whole-document prompt retention was tested. The persisted-row
proof claimed for this pin was invalid; see the round-8 correction below. This does not claim recognition
of arbitrary unstructured amendment language.

Artifact selection uses the current question to identify an explicit artifact
and the standalone query to rank its sections. A shared title such as “Bilag 1”
alone no longer exempts a factual question from the weak-evidence gate; the
question must also request generated interpretation. Mixed project/attachment
questions retain project failed-register, truncation, missing-ID and weak-source
gates. A matching ID in the attachment cannot supply missing project authority.
The tested attachment-only forms still worked, but round 8 found other common
forms falsely refused. These changes addressed CodeRabbit's two additional
major findings; its minor report wording correction is included.

Verification: 30 focused tests pass, including the real retrieval owner and
small-project prompt assembly with stubbed completions. Four test groups fail
against the previous owner and pass with the correction. Full tests pass 1,519
frontend plus 202 root cases (1,721 total), zero failures/skips, and parser
goldens. Production build, full lint/type validation, workflow boundaries,
tracked-secret scan and whitespace checks pass. Both recorded SQL regression
gates pass (116 original and 55 extended), with no provider calls or memory
fallback. Conceptual recall remains 30/36, MRR .565, and stress remains 18/20.
Logs: `/private/tmp/anbud-r8-before.log`, `/private/tmp/anbud-r8-focused.log`,
`/private/tmp/anbud-r8-full-tests.log`, `/private/tmp/anbud-r8-build.log`,
`/private/tmp/anbud-r8-retrieval.log` and `/private/tmp/anbud-r8-extended.log`.
The owned app restarted with AI disabled and liveness returned 200.

No new HTTP/OCR, browser, provider-stream or semantic evaluation is claimed.
These checks establish deterministic evidence selection and refusal behavior,
not live model answer quality. The recorded budget, unresolved quality/runtime
and external release gates, and accepted Greptile gap remain unchanged. Fresh
council, CodeRabbit and CI review of this correction is required.

## Council round 8 and conservative intent handling

Both members rejected `10bedd64` (Sol 7/10, Opus 6/10). Sol reproduced negated
interpretation bypass, missing supported artifact aliases, and attachment-only
customer questions being refused. Opus reproduced additional attachment forms,
occurrence questions, and chapter filtering that silently removed a source even
when document narrowing had been rejected. The earlier source-preservation and
attachment claims were therefore limited to their specific tested forms.

Document narrowing now accepts complete source-only request forms, including
the clarification example. An additional clause, comparison, occurrence or
exclusion question keeps all sources. A trailing chapter restriction is applied
only to that accepted scope or a plain ID/chapter request; rejected source scope
cannot silently apply one document's chapter across all documents. This trades
some natural-language narrowing for conservative ambiguity handling, without
changing the repeated-occurrence gate or the project-wide whole-document limit.

Attachment source intent is separated from its subject matter. A present
attachment can answer implicit file/document questions and questions about its
customer or project, provided the question does not also request project
sources and the attachment contains any requested IDs. Explicit mixed-source
questions retain all four project evidence gates. Draft questions use the
selector's supported interpretation aliases, including risikoplan/systemløsning;
negated requests do not enable interpretation. A shared project-document name
requires an affirmative draft request. Merely discussing proposals, kravsvar or
value arguments inside the source does not make it a request for a draft.

CodeRabbit's two remaining minor findings are corrected: artifact names use
Unicode letter/number boundaries, with supported definite forms, so Bilag 1
does not match Bilag 12. Artifact retrieval uses a bounded evaluation projection
(two short summaries and at most eight criterion label/assessment pairs), while
the generation prompt retains every criterion and its meaning. Search terms
precede the evaluation projection. No frozen cases or historical metrics change.

The earlier persisted-amendment proof was invalid: it put another document's
correction authority inside the original document's register, which the current
persistence validator correctly rejects. Its passing assertion merely found
separately extracted evidence after a lookup failure. The replacement fixture
stores correction rows in the amendment's own register and preserves the
original register. It explicitly requires no lookup failure, no truncation, no
missing IDs, sufficient retrieval, and chat completion using that real retrieval
result with a stubbed provider. The application persistence contract is unchanged.

Verification of the correction tree: 1,522 frontend and 202 root tests passed
(1,724 total), zero failures/skips, plus parser goldens. Four new regression
groups fail against the previous chat owner; 36 focused tests pass with the
correction. The final production build, lint/type validation, workflow
boundaries, tracked-secret scan and whitespace checks passed. Both recorded
SQL regression gates passed (116 original and 55 extended), no provider calls
or memory fallback, with conceptual 30/36 (MRR .565) and stress 18/20 unchanged.
Logs: `/private/tmp/anbud-r9-before.log`, `/private/tmp/anbud-r9-focused.log`,
`/private/tmp/anbud-r9-final-tests.log`, `/private/tmp/anbud-r9-final-build.log`,
`/private/tmp/anbud-r9-retrieval.log` and `/private/tmp/anbud-r9-extended.log`.
The owned app restarted with AI disabled and returned liveness 200. This is
local deterministic/build proof; no new browser, HTTP/OCR, provider-stream or
semantic model result is claimed. Fresh council/CI/CodeRabbit review remains
required, and the previously recorded budget and release gates are unchanged.

## Council round 9 and explicit source requests

Both members rejected `3097bc50` (Sol 7/10, Opus 6/10). The previous attachment
fallback was too permissive: an attached draft containing an ID could replace
missing project evidence when the user never selected the attachment as the
source. Draft topic words still enabled interpretation, while a global negation
check rejected valid requests about missing coverage. The prior broad claims
about mixed-source gates and negation therefore exceeded the examples tested.

Attachment exemptions now require a positive file/attachment reference or its
title, requested-ID membership, and no source comparison or explicit project
source. Tests cover possessive project-source phrases, generic requirement and
solution document names, unscoped factual questions, and comparisons under all
four failure/weakness telemetry states. Ordinary attachment subjects such as
customer responsibility, the project period and collaboration with a project
manager remain available; those nouns alone do not select project evidence.

Interpretation requires the named source to be an action's direct target or a
citation source (for example “hva sier risikoplanen”, “oppsummer risikoplanen”,
“ifølge vurderingen”). Merely asking about a deadline or requirement concerning
utkast/tolkning/gjennomføring/kravsvar does not meet that pattern. Negation is
checked where it rejects use of the source or a draft, rather than anywhere in
the question. Tests preserve questions about risks not handled and instructions
not to change a draft, while refusing the reported factual topic-word and
explicit no-interpretation examples. These are deterministic recognized forms,
not a claim to classify every natural-language intent correctly.

The clarification example can be pasted with its guillemets or a trailing
colon. The amendment regression now builds the amendment row with
`buildIngestionRequirementRegister`, persists that actual output under the
amendment document, and checks lookup and chat completion. A requested original
chapter cannot remove rows for IDs in a recognized correction section. The
original register remains the frozen synthetic fixture. This proves the
parsed-text ingestion/serialization/lookup path for that amendment, not another
PDF/HTTP upload or general amendment-language recognition.

Verification: two regression groups fail against the prior owners; 43 focused
tests pass with these changes. The first full run caught a definite-ending
regression for “kundeanalysen”; the shared name rule was corrected, with an
additional kravbesvarelsen control. The final complete run passed 1,522 frontend
and 202 root tests (1,724 total), zero failures/skips, plus parser goldens.
Production build, lint/type validation, workflow boundaries, secret scan and
whitespace checks passed. Both recorded SQL suites passed (116 original and 55
extended), no provider calls or memory fallback, with conceptual 30/36 (MRR .565)
and stress 18/20 unchanged. Logs: `/private/tmp/anbud-r10-before.log`,
`/private/tmp/anbud-r10-focused.log`, `/private/tmp/anbud-r10-final-tests.log`,
`/private/tmp/anbud-r10-final-build.log`, `/private/tmp/anbud-r10-retrieval.log`
and `/private/tmp/anbud-r10-extended.log`. The owned app restarted with AI
disabled and liveness returned 200. No new browser, PDF/HTTP, live-provider or
semantic-quality result is claimed. Fresh council, CI and CodeRabbit review
remain required; the budget and external/runtime/release gates are unchanged.


## Council round 10 and affirmative source selection

Both members rejected `856d05f6` (Sol 7/10, Opus 6/10). The prior paragraph's
positive-selection and scoped-negation claims were broader than its tests:
a rejected attachment, a rejected interpretation source, and additional mixed
questions still enabled completion. Generic draft noun phrases also matched
contractual subject matter. The repeated corrections demonstrate that these
language heuristics are not a general intent classifier.

The shared source-request owner now checks affirmative request frames for each
sentence, rather than attachment keyword presence. Rejected source instructions
cannot qualify through an `i`/`fra` phrase inside that instruction in the tested
forms. Generic draft/assessment terms require an action or citation frame and
reject noun complements such as `utkast til kontrakt` and `vurderingen av pris`.
Locative interpretation requests are limited to distinct application names.
The explicit `som et forslag` path uses the same request check. An empty title
cannot grant a source exemption.

The regression matrix preserves all four project gates for the reported rejected
attachments, mixed project-source subjects and coordinated names, comparisons,
and topic-word/title coincidences. It also preserves the reported valid file,
analysis and evaluation summaries, including `fila`, `basert på`, `hva viser`,
`den siste`, and negated subject matter. A correction-section chapter exemption
now requires both the ID and the row wording within that section: a bare `jf.`
cross-reference no longer exempts unrelated occurrences. The existing regression
still exercises actual amendment ingestion, persisted ownership and chat lookup.

Scope limitation: recognized request frames are conservative Norwegian syntax,
not semantic intent proof. Complex coordination, unsupported paraphrases and
indirect source requests can still be misclassified. No claim is made that every
mixed or negated natural-language question is handled. Explicit source selection
in the product would provide a stronger contract; that UI change is not part of
this correction. Generated content remains interpretation, never primary evidence.
The frozen holdout, labels, thresholds, generation prompt wording and model settings are unchanged.

Verification: the new request-gate and correction-cross-reference groups fail
against `856d05f6`. All 44 focused tests pass on the final code. The final full
run passes 1,523 frontend and 202 root tests (1,725 total), zero failures/skips,
plus parser goldens. Production build/types, lint, workflow boundaries and secret
scan pass. Both recorded SQL regression gates pass (116 original + 55 extended),
with zero provider calls, missing recorded inputs or memory fallback. Conceptual
recall remains 30/36 (MRR .565), and stress remains 18/20; these are regression
passes, not release-quality passes. The owned AI-disabled app restarted and its
liveness endpoint returned 200.

Logs: `/private/tmp/anbud-r11-before.log`, `/private/tmp/anbud-r11-focused.log`,
`/private/tmp/anbud-r11-final-tests.log`, `/private/tmp/anbud-r11-final-build.log`,
`/private/tmp/anbud-r11-final-lint.log`, `/private/tmp/anbud-r11-retrieval.log`,
`/private/tmp/anbud-r11-extended.log`. No new browser, HTTP/OCR, provider-stream
or semantic model proof is claimed. No paid provider calls, budget changes or
production operations ran. Fresh council, CI and CodeRabbit review of the new
commit remain required; all previously recorded release gaps remain open.


## Council round 11 and ordinary attachment questions

Both members rejected `cbab8df8` (Sol 8/10, Opus 6/10). Its request frames
incorrectly refused ordinary attachment questions and beneficiary suffixes such
as “for meg”, and anchoring comparison verbs introduced a mid-sentence bypass.
These were regressions, not cases justified by the documented unsupported-language
caveat. The prior statement about preserving known valid requests was incomplete.

Comparison verbs such as `sammenlign` and `oppfyller` again keep the project gates
anywhere in a question. `avvik` and `samsvar` remain anchored so summaries about
those topics still work. Attachment reading now recognizes locative questions,
content questions and ordinary summary/read requests, including “Hva er fristen
i vedlegget?”, “Kan du oppsummere vedlegget?” and “Se på vedlegget …”. The
rejection and mixed-project checks still apply. Tests exercise the reported
comparison/attachment cases under all four telemetry states, and attachment-only
IDs on the small-project whole-document path.

The noun-complement restriction applies to generic draft/assessment nouns, not
attachment or distinct application-source names. Generic requests also allow
beneficiary “for meg/oss”; `utkast til kontrakt` and `vurderingen av pris` stay
blocked. Generic `analyse` and `vurdering` cannot grant an interpretation exemption
when a primary project source is named. Additional reported coordinated sources,
`i forhold til`, `kontra`, `i lys av` and attachment exclusion are covered.

CodeRabbit's Major finding “Use correction provenance for reconstructed wording”
was independently reproduced. A partial replacement can leave the full corrected
sentence absent from the original text. Lookup now also matches the persisted
correction heading when its document identity, requirement ID and original
correction excerpt are backed by that document's recognized correction section.
The test applies the real correction parser, round-trips the register through
its persistence parser, and checks both original/correction chapter lookups,
actual page/heading/quote, and absent/foreign/stale provenance. A bare correction
cross-reference still cannot exempt an unrelated row.

Remaining named language limitations: “Oppsummer vedlegget. Bruk punktliste.”,
“Hei! Oppsummer vedlegget.”, `f.eks.`/`jf.` and a follow-up “Forklar kort.” can
still be refused because every parsed sentence must select a source. The comma
form “Oppsummer risikoplanen, uten forslag til tiltak” remains conservative.
Unstructured/unknown correction headings and unsupported coordination remain
outside the proof. An explicit source choice would provide a stronger product
contract; this patch does not introduce it. These limits do not excuse the
ordinary attachment and comparison regressions fixed above.

Verification: the new chat regression group and correction-chapter test fail
against the previous owners. All 86 focused tests pass. The final full suite
passes 1,524 frontend + 202 root tests (1,726 total), zero failures/skips, plus
parser goldens. Production build/types, lint, schema/release/workflow checks,
secret scan and whitespace checks pass. Original 116-case and extended 55-case
recorded SQL regression gates pass, with zero provider calls, missing recorded
inputs or memory fallback. Conceptual recall remains 30/36 (MRR .565) and stress
18/20, so this does not establish release quality. The owned AI-disabled app
restarted and liveness returned 200.

Logs: `/private/tmp/anbud-r12-before.log`,
`/private/tmp/anbud-r12-correction-before.log`, `/private/tmp/anbud-r12-focused.log`,
`/private/tmp/anbud-r12-final-tests.log`, `/private/tmp/anbud-r12-final-build.log`,
`/private/tmp/anbud-r12-final-lint.log`, `/private/tmp/anbud-r12-retrieval.log`,
`/private/tmp/anbud-r12-extended.log`. No new browser, HTTP/OCR, provider-stream,
semantic or production proof is claimed. No paid calls or budget changes ran;
the existing release and budget gaps remain. Fresh council/CI/CodeRabbit review
of this correction is required.


## Council round 12: topic wording, excluded sources and partial table corrections

Both members rejected `03336c97` (Sol 8/10, Opus 5/10). The prior comparison
patterns matched topic nouns/passive wording, while broad coordinated-noun
matching rejected ordinary attachment subjects. Widening attachment reading had
also admitted excluded sources and bare contractual appendix/file references.
Generic analysis/evaluation scoping confused source and subject. These concrete
regressions are addressed here rather than assigned to the syntax caveat.

Comparison matching now uses the intended active forms instead of arbitrary
suffixes, preserving `sammenligning`, `sammenligningsgrunnlaget`, `oppfyllelse`
and `oppfylles` as subject matter. Relational phrases (`i forhold til`, `kontra`,
`mot`, `i lys av`) require an actual requested ID or a recognized project-source
noun as the comparison target. Coverage comparison forms work mid-sentence and
in the reported inverted order. Coordination requires the attachment noun next
to `og`/`eller`, so “frister og krav” and “leverandøren og kunden” remain topics.

The source-request check rejects the reported `se bort fra`, `bortsett fra`,
`utenom` and `enn i/fra` exclusions. Unanchored attachment reading requires a
definite generic file noun without a contract `til` complement or appendix
number; exact attachment titles retain their own name match. The generic
`analyse`/`vurdering` guard distinguishes “analysen i Bilag 1” from “analysen om
Bilag 1”, allowing the latter as an analysis request. Tests retain the earlier
beneficiary, attachment-reading, small-project ID and project-gate cases.

The partial-table correction regression uses the real parser and register
round-trip with a supplier-question column. Parsing drops that column, making
the stored correction excerpt non-verbatim even though every quoted old and new
phrase exists in the original section. The provenance check now accepts that
case only when all quoted phrases are present, retaining document identity,
heading and section-ID checks. A missing old phrase rejects the row. The returned
snippet remains original source text, with its actual correction page/heading.

Named limits remain: format-only follow-up sentences, greetings and `f.eks.`/
`jf.` can still trigger conservative refusal, as can comma `uten forslag`.
A correction heading without page markers is not populated by the existing
correction-location parser, so a correction-chapter lookup can still be empty;
this patch does not infer that locator. Unsupported read/translation phrasing
and ambiguous subject/source wording remain outside the demonstrated cases.
No universal intent classification or release-quality improvement is claimed.

Verification: new chat and partial-table correction tests fail against the
previous owners. All 87 focused tests pass. The final full suite passes 1,525
frontend + 202 root tests (1,727 total), zero failures/skips, plus parser goldens.
Production build/types, lint, schema/release/workflow checks, secret scan and
whitespace checks pass. Original 116-case and extended 55-case recorded SQL
regression gates pass with zero provider calls, missing recorded inputs or memory
fallback. Conceptual recall remains 30/36 (MRR .565), stress 18/20; these regression
passes do not meet the release-quality thresholds.

Logs: `/private/tmp/anbud-r13-before.log`,
`/private/tmp/anbud-r13-correction-before.log`, `/private/tmp/anbud-r13-focused.log`,
`/private/tmp/anbud-r13-final-tests.log`, `/private/tmp/anbud-r13-final-build.log`,
`/private/tmp/anbud-r13-final-lint.log`, `/private/tmp/anbud-r13-retrieval.log`,
`/private/tmp/anbud-r13-extended.log`. The owned AI-disabled app restarted after
build. No new browser, HTTP/OCR, provider-stream, semantic or production proof is
claimed. No paid calls or budget changes ran. Fresh council/CI/CodeRabbit review
is required; the existing release and runtime gaps remain open.

## Council round 13: modified source targets and automatic enhancement recovery

Both members rejected `1ae95975` (Sol 7/10, Opus 5/10). Their concrete examples
showed that the preceding source heuristics still confused modified comparison
targets, document-bound analysis nouns, output formatting and definite uploaded
file references. The partial-table provenance correction was accepted by both;
that owner is unchanged in this correction.

Comparison targets now recognize bounded determiners/possessives/modifiers and
the reported need, solution, contract and bid nouns. Comparison matching folds
Unicode dashes before checking requested IDs and retains the explicit anchored
assessment/comparison frame. Attachment title coordination and comma-separated
source lists preserve project gates. The reported attachment topic “leverandørens
plikter mot kunden” remains answerable. These are tested under all four telemetry
states (failed register, truncated register, missing ID and insufficient evidence),
not just the weak-evidence path.

Generic analysis/evaluation aliases are withheld when tied to a named project's
document through the tested location, coordination or comparison complements,
including page/chapter locators. Ordinary single-sentence formatting such as
“i korte trekk”, “i punktform” and “i tre punkter” remains available, as do the
existing “analysen om Bilag 1” controls. Attachment references accept explicit
“vedlagte/opplastede/denne/dette” determiners before a generic noun. All attachment
request frames now share the definite-source check, including direct questions
and `ifølge`; a bare “vedlegg 3” cannot qualify through a different frame or an
attachment title whose capitalization is “Vedlegg”.

CodeRabbit's outside-diff Minor **“Pass the ready document revision to the automatic
enhancement job.”** is corrected in the enqueue owner. A successful ingestion's
returned document revision is included in its automatic enhancement input;
without a returned document, no automatic enhancement is enqueued. The regression
stubs only successful ingestion publication and repository boundaries: the real
job runner enqueues and claims its follow-up, the real enhancement workflow fails
its initial read, and the combined terminal failure receives revision 7. Removing
the new input field makes the test fail with zero document-failure calls. This is
deterministic owner proof, not a new HTTP/provider enhancement run. Existing
unversioned jobs are not rewritten or backfilled.

CodeRabbit's new Major **“Keep the evidence gate for coordinated factual
questions.”** is also addressed for the reported `og gi` request and `og oppgi`
variant. These clauses are checked independently, so an opening interpretation
or attachment request cannot exempt the later binding-fact request. A control
with an explicit analysis request in both clauses remains answerable. The added
regression fails before the clause split is extended.

The round-13 chat cases fail against `1ae95975`; the final behavior tests retain all
earlier controls. All 49 focused tests pass. The final full suite passes 1,526
frontend + 202 root tests (1,728 total), with zero failures/skips, plus parser
goldens. Production build/types, full lint, schema/release/workflow checks, secret
scan and whitespace checks pass. The original 116-case and extended 55-case
recorded SQL regression suites pass with zero provider calls, missing recorded
inputs or memory fallback. Conceptual recall remains 30/36 (MRR .565), stress
18/20; these are regression passes, not release-quality passes.

Logs: `/private/tmp/anbud-r14-before.log`,
`/private/tmp/anbud-r14-enhancement-before.log`,
`/private/tmp/anbud-r14-coordinated-before.log`,
`/private/tmp/anbud-r14-focused.log`, `/private/tmp/anbud-r14-final-tests.log`,
`/private/tmp/anbud-r14-final-build.log`, `/private/tmp/anbud-r14-final-lint.log`,
`/private/tmp/anbud-r14-retrieval.log`, `/private/tmp/anbud-r14-extended.log`.
The owned AI-disabled app restarted after build. No new browser, HTTP/OCR,
provider-stream, semantic or production proof is claimed. Fresh council,
CodeRabbit and CI review of the new commit is required.

The heuristic contract is still limited. Sentence splitting can over-refuse
format-only follow-ups, greetings and abbreviations; some unlisted source
exclusions, reversed mixed-source orders and active verbs used as topics remain
unresolved. Correction lookup can be empty when a dropped question column mentions
another ID or exceeds the parser's excerpt bound, or when correction headings
lack page markers. These nonblocking findings were unchanged at the reviewed pin;
no universal natural-language intent guarantee is claimed. Chapter hybrid context,
accounting resume and the previously listed runtime, semantic, production and
human evidence gaps remain. No frozen cases, model settings, thresholds or budget
were changed, and no paid/provider calls were made.

## Council round 14: source-bound comparisons and automatic versus retry revisions

Sol (6/10) and Opus (5/10) rejected `5c897bbc`. The generic location guard had
been made dependent on a matching project title; the customer-topic exception
also admitted real comparisons; and the broad anchored comparison rule refused
ordinary attachment topics. The previous automatic enhancement fix additionally
used a field that activates manual retry preconditions. Those are introduced
regressions, not covered by the earlier syntax limitations.

Generic `analyse`/`vurdering` followed by `i` again retains the source-evidence
gate independently of matching document titles, with the explicit formatting
exceptions preserved. Named page/chapter and coordinated-source controls remain.
Comparison relations now bind to an attachment name or anaphoric source before
the relation. “Vurder vedlegget mot kunden” and “mot kunden sine krav” keep the
project gates; “tiltak mot datatap” and attachment topics about costs in relation
to the solution remain readable. Existing modified-target and mixed-source
regressions remain in the same real dispatch tests with stubbed retrieval/model.

Coordinated summary requests accept the reported beneficiary and `kort` forms.
Closed, complete output-shaped follow-ups may inherit the preceding source:
summaries, main points, a numbered list of recommendations/actions and `oppgi
fristene`. A follow-up asking for the customer's binding deadline still must
qualify independently. `siste` and `nyeste` explicitly select an uploaded file.
This restores the reported ordinary requests, without claiming an exhaustive
language parser.

CodeRabbit's Minor **“The `unngå` split branch never matches. Replace `\b` with a
Unicode-aware boundary.”** is corrected. A coordinated `og unngå` clause now
splits on a Unicode letter/digit boundary. A closed omission instruction such as
“unngå å nevne frister” remains an output constraint; the tested clause that adds
“svar på hva kundens bindende exit-frist er” retains the factual evidence gate.
That mixed case fails before the boundary correction.

Automatic jobs now carry `failureSourceRevision` for failure recording before
the first read. Explicit retries continue to carry `sourceRevision` as a strict
precondition. The input parser validates both and refuses an input supplying both.
After a successful read, an automatic attempt adopts the actual read revision for
failure/publication fencing. A role change from revision 7 to 8 before claim is
therefore processed using revision 8 and its current role. The real job/workflow
regression verifies this; the previous pin failed without attempting enhancement.
An automatic job whose configuration no longer permits enhancement completes as
a skip, with a revision-fenced queue-message update and no invented failure.
Manual retries still reject stale revisions and disabled configuration. Their
existing lease, cancellation and publication fences are unchanged.

The earlier round-13 statement that the revision input only repaired early
failure recording was incomplete: it also activated strict retry behavior. This
section supersedes that statement. Existing queued inputs are not rewritten;
old `sourceRevision` inputs keep strict behavior and unversioned inputs remain
unversioned. If an initial document read fails after its revision has changed,
the old failure seed cannot alter the newer document; no unfenced compensation
is added. Skip-message updates also leave a concurrently changed document alone.

All 53 focused tests pass. New chat, changed-revision and changed-configuration
regressions fail against the previous owners; input-boundary and explicit-retry
controls pass. The final full suite passes 1,530 frontend + 202 root tests (1,732
total), zero failures/skips, plus parser goldens. Production build/types, full
lint, schema/release/workflow checks, secret scan and whitespace checks pass.
Original 116-case and extended 55-case recorded SQL regression suites pass with
zero provider calls, missing recorded inputs or memory fallback. Conceptual
recall is still 30/36 (MRR .565), stress 18/20; these do not pass release gates.

Logs: `/private/tmp/anbud-r15-before.log`, `/private/tmp/anbud-r15-unicode-before.log`,
`/private/tmp/anbud-r15-focused.log`, `/private/tmp/anbud-r15-final-tests.log`,
`/private/tmp/anbud-r15-final-build.log`, `/private/tmp/anbud-r15-final-lint.log`,
`/private/tmp/anbud-r15-retrieval.log`, `/private/tmp/anbud-r15-extended.log`.
The owned AI-disabled app restarted after build. Fresh council/CI/CodeRabbit
review is required.
No schema, frozen fixture, model, threshold or budget change is included. Existing
sentence-splitting, unsupported language, correction-parser and broader release
limits remain; no paid/provider, production or new browser/HTTP proof ran.

## Round 15 corrections: comparison modifiers and style-only follow-ups

Round 15 rejected `7107f9bc` (Sol 7/10, Opus 6/10). Requiring the attachment
immediately before a comparison relation lost ordinary modified comparisons.
The Unicode clause fix also exposed refusals for complete style instructions.
Those were introduced regressions; the preceding section's reported controls
were too narrow to establish the broader behavior.

Comparison detection now allows up to three of the bounded manner/source
modifiers `samlet`, `grundig`, `nøye`, `sett` and `fra leverandøren` between an
attachment and the relation. `mot`/`kontra` followed by a recognized requirement
or project target also retains the project gates when the attachment occurs
elsewhere. The source-bound rule still handles `mot kunden`; the independent
target rule excludes bare `kunden` so the existing “plikter mot kunden” topic
control remains readable. Attachment titles receive the same dash folding as
the question and the existing definite-ending convention. Tests cover both
“Leverandørnotat”/“leverandørnotatet” and “Tilbud – Bilag 3”.

Complete `unngå fagspråk`, `unngå gjentakelser`, `unngå lange setninger` and
`unngå å nevne leverandøren` instructions can inherit a previously selected
source. These remain whole-clause matches: an added binding-fact request or
rejection of the source cannot inherit the exemption. The nonblocking
`oppgi fristene` concern is also addressed: that inherited follow-up is limited
to attachment reading, not a stored analysis, evaluation or artifact.

The expanded real-dispatch regression fails on the preceding owner. All four
project-evidence failure states are exercised separately for the reported
comparisons and title cases, with prior topic-reading controls retained. The
four focused chat/evidence/lookup files pass 46/46 tests. These tests stub
retrieval and completion: they prove dispatch decisions, not semantic quality.

The grammar remains bounded, not a universal Norwegian intent classifier.
Unlisted modifiers/paraphrases and existing mixed-source, generic-location,
format-follow-up, chapter-context and accounting-resume limitations remain.
CodeRabbit then reported a new Minor at `7107f9bc`: an automatic job reading an
already `enhanced_ready` non-Docling revision would try to start enhancement,
although the state RPC accepts only `basic_ready`. Automatic jobs now skip that
revision without changing its message, error, content or revision. The focused
real job/workflow regression fails before the fix and passes afterward; its
repository stub now enforces the existing status/parser/revision predicate.
Manual retry preconditions and the SQL lease/revision fences are unchanged.
All five focused files pass 68/68 tests. No schema, model, frozen fixture,
threshold or budget changes are included.

Final verification: 1,531 frontend + 202 root tests pass (1,733 total), zero
failures/skips, plus parser goldens. Production build/types, full lint,
schema/workflow/release checks, secret scan and whitespace pass. Original
116-case and extended 55-case recorded SQL regression gates pass with zero
provider requests, missing recorded inputs or memory fallback. Conceptual
30/36 (MRR .565) and stress 18/20 remain below the release targets.

Logs: `/private/tmp/anbud-r16-before.log`,
`/private/tmp/anbud-r16-enhanced-before.log`, `/private/tmp/anbud-r16-focused.log`,
`/private/tmp/anbud-r16-final-tests.log`, `/private/tmp/anbud-r16-final-build.log`,
`/private/tmp/anbud-r16-final-lint.log`, `/private/tmp/anbud-r16-retrieval.log`,
`/private/tmp/anbud-r16-extended.log`. The owned AI-disabled app restarted after
build. No paid/provider, production or new browser/HTTP proof ran. All four PR
checks passed on preceding `7107f9bc`; the new correction requires fresh
council, CI and CodeRabbit review. The semantic/holdout, budget, runtime and
external acceptance gaps remain open; all 18 recommendations are not complete.
