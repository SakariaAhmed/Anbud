# Code quality audit — 2026-09-04

Historical review of the modularization worktree. Its test totals and file sizes describe that earlier checkout. For the integration onto current main and retained workflow safeguards, see `reviewed-cleanup-integration-2026-09-05.md`.

Repository-wide static analysis and targeted source review covered application/API boundaries, client caching, AI generation and requirement processing, persistence and background jobs, tests, SQL contracts, and Azure/CI configuration. Findings were checked against callers and existing behavior before editing. The starting working-copy changes in the login form and app shell were preserved. The subsequent requested button design also touches the login button.

## Findings cleaned up

| Priority | Finding | Change |
| --- | --- | --- |
| P2 | Client reads had three implementations with different invalidation semantics. Project service reads ignored `forceRefresh`; global service reads could let an old response overwrite refreshed or saved data. Project cache bookkeeping also retained revision/sequence maps indefinitely. | Centralized request sharing and freshness in `apps/frontend/lib/client-cache.ts:47`. A pending request's identity controls whether it may cache a result. Saves and invalidations detach old reads; subscriber cancellation leaves shared prefetches intact. Service and artifact reads now use the same implementation. |
| P2 | The job event watcher opened connections for already-aborted signals. Invalid event JSON and exceptions in status callbacks could leave its promise unresolved. | `apps/frontend/lib/client/project-api.ts:223` checks cancellation before connecting, falls back to polling for malformed events, rejects callback failures, and closes the event connection when polling takes over. |
| P2 | AI and repository façade files implied separation while forwarding everything into the same large modules. Chat depended on the entire AI engine just for completion and context helpers. | Moved shared completion/context implementations into `ai/completion.ts` and `ai/context.ts`. Document analysis and executive summary modules now contain their implementations. Removed the three remaining empty AI façades and three empty repository façades; callers import implementation owners directly. |
| P2 | `enrichSolutionEvaluationWithFoundationFacts` and `enrichExecutiveSummaryWithProjectSignals` discarded their additional inputs and returned the original result unchanged. Their names implied grounding that did not occur. | Removed both no-op functions and their calls. Existing normalization, source evidence, and coverage validation remain. No replacement grounding behavior was invented. |
| P2 | A 964-line dashboard animation used timers, viewport measurements, session storage, and a full-screen scene before revealing the working surface. Separate decorative animations loaded third-party assets. | Removed the intro, animation coordination/CSS, decorative Lottie component, and `lottie-web` dependency. Simplified the upload area and removed the static promotional workflow panel. Kept the original logo artwork and sizing; used a shared strong blue for primary actions, quiet outlined secondary actions, and restrained delete controls. Projects, search, status filters, uploads, and navigation remain. |
| P2 | Architecture tests checked historical line limits, import spelling, and component placement. A CI test only checked whether the workflow mentioned that test's filename. The default test command was a hand-maintained list that omitted an artifact-input test and excluded PDF parser tests from normal CI. | Removed four superficial tests. Default `npm test` discovers frontend tests and runs all root script tests plus the parser golden cases. Removed duplicate CI execution of script tests. Retained checks for concrete ingestion order, access restrictions, source integrity, and transactional behavior. |
| P3 | `promptCacheFamily` was an identity function and `promptJson` only called `JSON.stringify`. Two obsolete database helpers and unused exports remained. Dashboard uploads duplicated the client API request/response handling. | Removed the wrappers, unused `addPrincipalToGroups` and `isSolutionEvaluationCurrent` helpers, and unused public exports. Dashboard uploads use the existing client API. |

Approximately 1,700 net lines were removed, counting the new implementation modules and regression tests, excluding this note and pre-existing user edits. The AI file decreased from 23,710 to 23,073 lines; most of that reduction moves responsibilities to their actual owners rather than deleting behavior.

## Validation

- Production `npm run build`: passed.
- `npm run lint`: passed with zero warnings.
- Strict TypeScript checks, including unused locals/parameters: passed during the cleanup; final build also checked types.
- Final `npm test`: **889 passed, zero failed, zero skipped** (783 frontend tests and 106 root script tests).
- Eight PostgreSQL integration tests ran against an isolated local pgvector/PostgreSQL 17 container. They cover rollback, chunk completeness, lease fencing/deadlocks, terminal audit atomicity, service writes/selections, source invalidation, and legacy SQL compatibility.
- Parser golden cases: passed (normalization, source-bound table repairs, quality acceptance/rejection, and extraction).
- New cache regression tests cover invalidation during reads, forced refresh, a save racing a read, cancellation of a shared subscriber, cached nulls, retry after failure, and expiry. Job-watcher regressions exercise cancellation, malformed events, and failing callbacks.
- Project-job schema, workflow-boundary, release-workflow, and tracked-secret checks: passed. Workflow YAML parsed successfully; all Azure Bicep templates compiled locally.
- Desktop and 390px mobile browser inspection used server-rendered dashboard components with synthetic projects and built CSS. The mobile content width equaled the viewport width. This was a layout check, not an authenticated end-to-end upload test.
- Final dead-code analysis found no unused files/types/dependencies, unresolved imports, or import cycles. Its one remaining unused-export candidate, `isProjectSourceRevisionChangedError`, is imported by the existing Jiti-based behavior test and was retained.

Button follow-up (2026-09-05): the final palette uses blue primary actions with a darker hover, matching outlined project links on desktop/mobile, and neutral delete triggers that turn red on hover. The original logo artwork and sizing remain unchanged. The production build, lint, and refreshed dashboard visual check passed after this styling follow-up.

## Remaining engineering debt

1. **Requirement engine size.** `apps/frontend/lib/server/ai.ts` still combines source recovery, requirement coverage, response repair, customer analysis, and artifact orchestration. Further decomposition should separate actual dependency clusters. The source-bound PDF repairs and requirement regression cases are intentional behavior; deleting them based on unusual names or size would lose supported inputs.
2. **Persistence and workspace ownership.** `repositories/data-store.ts` remains 3,526 lines, while `components/projects/project-workspace-page.tsx` remains 2,049 lines. Removing forwarding files makes this coupling visible but does not resolve it. Future changes should move coherent implementations, with their state and contracts, rather than add more forwarding layers.
3. **Source-text tests.** Several tests still inspect source strings. Some provide useful checks for security and migration wiring, but cannot establish runtime behavior by themselves. Replace them incrementally with focused behavior tests when changing those paths; the database integration tests were retained and exercised here.
4. **Live AI and deployment behavior.** No production data or deployed services were modified. Paid model evaluations, live answer quality, authenticated browser workflows, and full Docker image builds were not exercised. Deterministic grounding tests do not establish that every live generated answer is factual.
