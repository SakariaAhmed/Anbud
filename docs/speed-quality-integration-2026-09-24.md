# Speed/quality integration — 24 September 2026

Integrated `origin/main` at `74de89311ace741fc17733c3924ad16574315813`
with `Feature/speed-quality` at `7ba30ca4448e5bc336a49bdc9dda44a1a10f6d66`
on `Feature/integrate-speed-quality`. The original branches and the uncommitted
work in the main checkout were left intact.

## Integration decisions

The application code merged without conflicts. All 31 feature commits and all
five subsequent main commits are retained. Main's complete global administrator
permissions, read-only analysis history, dependency patches, and minimum replica
setting remain in place alongside the feature branch's implementation.

Only two test files needed additional edits:

- `authorization.test.mjs`: use the actual `resolve_project_role` RPC instead of
  the superseded membership/group/owner reads. Keep the database-backed admin,
  expired/revoked session, disabled principal, forged admin hint, and restricted
  viewer checks. Assert the RPC method and project/principal arguments.
- `project-route-authorization.test.mjs`: apply the accepted administrator policy
  to artifact deletion. Administrators can delete without a project grant and
  with a restricted grant; non-admin restricted viewers remain denied.

The focused tests failed on the automatic merge before these adjustments and
passed afterward. No new application behavior, model tuning, dependency upgrade,
or infrastructure change was introduced beyond merging the existing commits.
Historical reports retain their original context; their older administrator
restrictions do not override the current policy in `AGENTS.md`.

## Verification

Used Node 22.14.0 and the merged npm lockfile.

- Full suite: 925 frontend tests and 129 repository tests passed, with no failures
  or skips; parser golden checks passed. All four SQL test variables targeted a
  new disposable local PostgreSQL 17/pgvector container.
- Workflow regression harness: 44 tests passed, including historical read-only
  controls and its existing populated-schema upgrade check.
- Lint with zero warnings, production build/type validation, secret scan,
  project-job schema checks, workflow boundaries, release checks, and workflow
  YAML parsing passed. The affected Container App Bicep template built and linted.
- Applied the three added migrations in order, twice, to a populated copy of
  main's schema. Existing analysis content was preserved. The definitions and
  execution privileges of all seven affected functions matched the new baseline;
  public API roles remained denied and `service_role` retained execution.
- Authenticated local browser checks at 1440 and 390 pixels used fictional,
  encrypted current/history fixtures. All eight historical analysis tabs had no
  write controls. Keyboard opening and return focus worked; an unsaved current
  draft survived visiting history. No horizontal page overflow or JavaScript
  errors occurred. Desktop/mobile screenshots were visually inspected.

## Initial integration boundaries

The checks above established integration behavior, not renewed AI quality or
performance approval. At the integration commit, all limitations in
`speed-quality-2026-09-08.md` remained open; no paid model calls were made. Browser testing used a local development server and password login,
not production, Microsoft Entra, or Azure document ingestion/storage.

Deployment still requires the guest credential authority, job result cleanup,
and snapshot dependency migrations. Follow `security-job-result-cleanup.md` for
stored historical job-result cleanup. No production code, configuration,
migration, or cleanup was deployed by this integration task.


## Focused AI follow-up

The follow-up against integration commit `3a285d6427155cf992bc180af9c8109996ce609c`
addresses three confirmed paths without changing models, reasoning levels,
retrieval budgets, database contracts, or provider configuration:

- Critical-fact enrichment previously prepended numeric facts as `Viktig` before
  truncating the five-item priority list. That could remove a model-selected
  `Kritisk` requirement. Critical items now retain precedence; additional facts
  remain represented in the solution-direction field. Both analysis prompts also
  call out absolute requirements and concrete log-retention, training, operations
  documentation, and acceptance conditions. The v3 prompt stays below its existing
  5,000-character limit.
- Deterministic coverage advice for a rejected or unconfirmed requirement could
  tell the improvement step to replace the reservation with a commitment. That
  advice now requires an explicit supplier decision and confirmation, including
  scope and price. Coverage and holistic evaluation instructions preserve real
  reservations. The improvement workflow prioritizes supported delivery over
  reaching 100/100 and labels unconfirmed changes as proposals. Existing scores,
  original evidence, partial-result recovery, and re-evaluation stay intact.
- Identical quotes and local requirement IDs in two documents previously defeated
  finding normalization even when the model supplied the correct full reference.
  An exact qualified reference now constrains evidence matching. Ambiguous bare
  references remain unmatched; a conflicting quote cannot switch to another
  document's coverage row. The canonical row still owns the displayed assessment,
  evidence, explanation, and recommendation.

### Follow-up verification

Four selected regressions fail on the integration commit for the expected
behavioral reasons and pass with the changes: critical-priority loss, duplicate
source identity, rejection advice, and unconfirmed-delivery advice. Additional
checks capture the actual coverage/holistic model boundary and improvement
workflow instructions, including a prior evaluation that recommends removing an
unconfirmed reservation. These checks validate the delivered instructions, not
model compliance.

Node 22.14.0 validation: 928 frontend tests, 129 repository tests, and 45 workflow
regressions passed with no failures or skips. The full run used disposable local
PostgreSQL/pgvector and included parser golden checks and the existing additive
upgrade regression. Lint, production build/type validation, secret scan, project
job schema, workflow boundaries, release contracts, and whitespace checks passed.
The prior authenticated desktop/mobile integration checks were not repeated for
these server-only changes and progress-message wording.

## Live AI verification within the additional $2 cap

The user authorized up to $2 for this round. All new calls went through the
existing budget proxy with a separate $2 task cap and conservative usage
accounting. The inherited ledger failed the current authorization validator; its
1,062-row snapshot was preserved unchanged, and none of its historical allowance
was reused. The validator and accounting rules were not weakened. Prices were
checked against [OpenAI's pricing documentation](https://developers.openai.com/api/docs/pricing).
All 20 paid requests completed. Conservative spending was **$1.549892**, leaving
**$0.450108** unused; the proxy was stopped with no pending calls. Usage, request
counts and hashes are recorded in the
[AI evidence register](speed-quality-integration-ai-evidence-2026-09-24.json).

### Confirmed omission and focused fix

Fresh legacy analyses on two eight-requirement cases retained the investigated
operational details: retention period, training count, operations documentation,
signed acceptance before startup, and exit deadline. The first v3 analysis also
retained them. The second v3 analysis omitted the 20-working-day exit deadline.
Its existing fallback recognized Norwegian `virkedager`, but not `arbeidsdager`,
and did not recognize month-based retention periods.

The existing duration extractor now recognizes those forms and normalizes English
months to Norwegian. A regression fails before the fix and passes afterward;
replaying the exact failed analysis restores the source deadline without changing
its five critical priorities or original source text. A separate fresh fixture,
frozen after that finding, then retained 14 months of security logs, four training
sessions, signed acceptance before launch, and exit within 12 working days. Its
separate incident-log retention period correctly remained an open clarification.
This fixes the observed omission path; it is not a promise that a five-item
priority list reproduces a full requirements register.

### Holistic evaluation speed

The three pairs below used the same GPT-5.4 model, source input, full solution
artifact, output contract and completed requirement coverage within each pair.
Captured provider payloads are identical except for `reasoning_effort`. Calls
were serial and measured without concurrent tests or builds. The second and
third pairs ran the lower reasoning level first. Cached input counts matched
within every pair: 0, 2,816 and 2,816 respectively.

| Frozen case | Medium reasoning | Low reasoning | Reduction |
| --- | ---: | ---: | ---: |
| Development, 8 requirements | 90.43 s | 55.22 s | 38.9% |
| Holdout, 8 requirements | 117.76 s | 53.85 s | 54.3% |
| Larger case, 32 requirements | 109.26 s | 56.75 s | 48.1% |

Source review and three separately blinded GPT-5.4-mini judgments found the lower
reasoning results no worse on the investigated requirements, source fidelity and
supplier reservations. All three judges returned a tie. Each result retains the
full canonical coverage; the holistic narrative can select a smaller set of
findings. Judge scores are advisory, not a guarantee of correctness. These are
three individual comparisons, not a p95 estimate or approval of every generation
feature. The larger case replays synthetic fixed coverage rows and therefore
measures holistic evaluation, not fresh 32-row coverage quality.

Only the GPT-5.4 holistic evaluation now uses low reasoning, selected in the
existing model-configuration owner. Coverage, requirement responses, other
models, source selection and output limits retain their existing policies.
Tests capture the actual evaluation boundary, verify unchanged coverage reasoning,
and check that another model override still uses medium reasoning. Their new
expectations fail on the old policy. No provider or model migration was added.

### Improvement and re-evaluation

The actual improvement workflow supplied its revised instructions to actual
artifact generation. The new draft retained Norwegian backup, external MFA,
RTO, log retention, training and round-the-clock service changes as unresolved
supplier decisions, subject to confirmation and price. The exact generated
artifact then reached actual evaluation. The evaluation still identified the
unconfirmed commitments; its improved score of 72 did not imply that those
requirements had become confirmed. Existing supplier coverage remained unchanged.
A final live re-evaluation on Node 22 used the newly configured policy without
a test override; its submitted payload matched the experimental low-reasoning
payload exactly. Supplier coverage stayed unchanged and the result still
identified the open confirmations and prices (score 74). Some rewrite advice is terse and relies on the surrounding confirmation
instructions; no deterministic guarantee of model compliance is claimed.

The experiment uses in-memory retrieval and context persistence and captures the
workflow handoff before publication. It is not a newly persisted queue/workflow
run. Existing database/workflow regressions separately cover publication, partial
failure and lease behavior. Setup failures are preserved and cost $0: the initial
context stub, initial SDK fetch setup, and the larger-case replay accidentally
including an example row from the system prompt. The first successful v3 run has
ledger usage but lacks SDK payload capture; later runs record the full payload.

### Final validation

Node 22.14.0: 929 frontend tests, 129 repository tests and 45 workflow
regressions passed with zero failures or skips, including parser golden cases,
disposable PostgreSQL/pgvector checks and the existing populated-schema upgrade
regression. Lint had zero warnings; production build/type validation, secret
scan, project-job schema, workflow boundaries, release contracts and whitespace
checks passed. The two reasoning-policy regressions failed before implementation
and pass in the full suite. Authenticated desktop/mobile checks from integration
were not repeated for these server-only changes.

### Release boundaries

No production code, configuration, migration or cleanup was deployed. Azure/Entra
and real ingestion were outside this local AI verification; the subsequent
[Azure/Entra/ingestion follow-up](azure-entra-ingestion-verification-2026-09-24.md)
records live checks, two confirmed fixes and its exact remaining boundaries.
Representative multi-worker load is still unmeasured. The earlier
migration/cleanup requirements still apply. Historical
failed experiments and broader per-feature speed/quality goals remain in the
original report; these focused results do not retroactively approve them.

## Norwegian OCR follow-up

The later [Norwegian OCR follow-up](norwegian-ocr-verification-2026-09-24.md)
addresses the accent loss found during ingestion verification, using bundled
Norwegian/English recognition and exact-text scan fixtures. It makes no paid AI
calls and does not deploy the integration branch.
