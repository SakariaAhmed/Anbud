# Reviewed cleanup integration – 5 September 2026

Baseline: `main` at `47a79e55b19c8fbf89e6c5cd784169cd4a9f6b86`.
Source: the 87 uncommitted paths in `Feature/modularize-analysis-ai-data-store`, based on `bcf2aa20`. The source worktree was snapshotted and left unchanged. Integration branch: `Feature/integrate-reviewed-cleanup`.

## Integrated changes

1. **Authentication:** remove email-based administrator bootstrapping; recover from failed Microsoft discovery with a bounded timeout; safe stage/reference logging; distinguish denied access from session failures; redirect signed-in non-admin users away from the admin page. The new `20260905030000_preserve_disabled_principals_on_login.sql` migration rejects disabled identities without reactivating them. Its definition also appears in the baseline schema.
2. **Caching and job events:** shared cache implementation protects saves and forced refreshes against earlier reads, preserves subscriber cancellation, and clears project-service reads with related project data. Job events reject failing callbacks and fall back on malformed payloads.
3. **AI and repository structure:** actual completion, context, chat, metadata and executive-summary implementations have their own modules. Existing model choices, prompts, source recovery and requirement coverage remain. Identity/no-op wrappers were removed. Repository callers now import the existing implementation owners directly, including main's new readiness and post-commit functions.
4. **UI:** remove the dashboard intro and decorative Lottie dependency; simplify project creation presentation; standardize primary/secondary/delete controls; close the account menu after navigation.
5. **Verification:** discover ordinary frontend and repository tests automatically, including previously omitted tests. Preserve the separate audit runner, real PostgreSQL regressions, additive-upgrade test and release gates. Dedicated audit tests are explicitly excluded from ordinary discovery because they require their own disposable database setup.

## Conflict decisions: main wins

The older analysis-tab decomposition and persistence relocation were not imported. The current editor, workspace, analysis persistence and result-history implementation remain main's versions.

A source comparison against the baseline confirmed identical non-import statements in the customer-analysis API, job API, generation workflows, job recovery and artifact workflow. Main's data-store, analyses repository, job execution, analysis editor, workspace, job panel, history panel and workflow migration remain unchanged. The cache implementation preserves main's stronger event-error fallback, transient polling retries and original-analysis-revision checks.

Consequently, this integration retains manual-edit conflict detection, no-op preservation, encrypted history, document readiness checks, serialized job claims, partial-result resumption, superseded-job rejection, post-commit recovery and monotonically versioned UI snapshots. The 43 existing workflow audit regressions passed against the combined implementation.

## Verification performed

- Authentication group: 29 focused tests and a PostgreSQL authentication regression passed.
- Cache group: 17 focused tests and all 43 workflow regressions passed.
- Final combined suite: **791 frontend tests + 106 repository tests + 43 workflow regressions = 940 tests passed, zero failures or skips**. Repository contracts were also rerun by the audit harness; duplicate runs are not included in this total.
- Parser golden cases passed: normalization, source-table repairs, acceptance/rejection and extraction.
- Production build, ESLint and TypeScript passed.
- Project-job schema, workflow-boundary and release-workflow validators passed; workflow YAML parsed successfully.
- Local browser with synthetic PostgreSQL/PostgREST data: administrator login, dashboard, account-menu navigation and project analysis/history rendering succeeded. Dashboard inspected at wide and narrow widths without horizontal overflow; browser reported no warnings or errors.
- Original worktree file hashes match the source snapshot after integration. Local browser server and disposable containers were removed after verification.

Deterministic AI tests do not establish live model answer quality. Browser checks used local synthetic data; they did not exercise Microsoft tenant authentication or production customer workflows.

## Release note

These changes are integrated into source control separately from a production release. Production remains on the previously deployed commit until an authorized deployment. Apply the new additive authentication migration before deploying this code; do not apply the destructive baseline schema to production. No production data, configuration or migration was changed during this integration.
