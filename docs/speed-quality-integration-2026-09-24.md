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

### Still unverified

No paid model calls were made in this follow-up. New paired live evaluations need
an authorized task spending cap; historical evaluation-ledger headroom is not a
new authorization. Prompt changes still need fresh source-grounded output review
for omitted operational details and unsupported commitments. They do not provide
a deterministic guarantee that every future answer preserves every reservation.

Generation speed remains unresolved. Earlier attempts to reduce holistic output
or change its model did not establish a speed/quality improvement. This follow-up
introduces no extra model calls and makes no latency claim. Fresh paired runs must
measure full completion time, usage, and answer quality on identical inputs,
including the actual improvement-and-re-evaluation workflow, before changing
model or context settings. Production deployment and the original migration and
cleanup requirements remain as described above.
