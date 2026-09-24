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

## Remaining boundaries

This is integration verification, not renewed AI quality or performance approval.
The limitations in `speed-quality-2026-09-08.md` remain open; no paid model calls
were made. Browser testing used a local development server and password login,
not production, Microsoft Entra, or Azure document ingestion/storage.

Deployment still requires the guest credential authority, job result cleanup,
and snapshot dependency migrations. Follow `security-job-result-cleanup.md` for
stored historical job-result cleanup. No production code, configuration,
migration, or cleanup was deployed by this integration task.
