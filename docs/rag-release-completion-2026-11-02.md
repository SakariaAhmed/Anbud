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

Focused tests are running. No new paid model/embedding calls, commits, PR,
production access or deployment yet. The prior cumulative AI budget is still
$10, with $6.331864 previously accounted and $3.668136 remaining. Do not reset
or refill its ledger. Suggested bounded allocation: development .50, feature
runs .60, retrieval .40, final semantic 1.60, reserve .568136; these are caps,
not a new authorization or evidence of actual spending.

The initial disposable SQL replay did not run: the owned Docker container
remained in `created`, with no PostgreSQL process, and the loopback connection
was refused. A network-free container also remained `created`. Existing
unrelated containers are untouched; SQL/HTTP proof is still pending.
