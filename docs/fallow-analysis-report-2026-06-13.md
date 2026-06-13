# Fallow Remediation Report

Generated: 2026-06-13, Europe/Oslo
Repository: `/Users/sakariaahmed/Code/anbud`
Fallow version: 2.95.0
Review lens: code-quality-auditor + security-checklist

## Executive Summary

The original Fallow baseline scored **68.8 / C**. After remediation, the final Fallow health score is **78.1 / B**.

The highest-confidence cleanup work is complete:

- Dead-code findings are now **0**, down from 100.
- Unused files are now **0**, down from 16.
- Unused exports/types and duplicate exports are now **0**.
- Fallow fix dry-run now proposes **0** fixes, down from 49.
- Duplication is reduced from 91 clone groups / 3,453 duplicated lines / 6.26% to **72 clone groups / 2,772 duplicated lines / 5.15%**.
- The largest original AI artifact-generation function is no longer in Fallow's top large-function list after extraction.

The remaining risk is concentrated in large UI/workflow modules and static security candidates that need deeper, targeted verification rather than blind automated edits.

## Severity Model

- P1: High-risk code health item that blocks confident expansion or frequent changes.
- P2: Material maintenance, correctness, or security-verification risk; schedule soon.
- P3: Cleanup, configuration, or consistency item.
- Info: Analyzer signal with no direct remediation required.

## Before And After

| Metric | Original | Final |
| --- | ---: | ---: |
| Health score | 68.8 / C | 78.1 / B |
| Files analyzed | 140 | 133 |
| Functions analyzed | 3,094 | 3,028 |
| Average maintainability | 88.6 | 92.1 |
| Dead-code issues | 100 | 0 |
| Unused files | 16 | 0 |
| Unused exports | 75 | 0 |
| Duplicate exports | 2 | 0 |
| Clone groups | 91 | 72 |
| Clone instances | 200 | 154 |
| Duplicated lines | 3,453 | 2,772 |
| Duplication percentage | 6.26% | 5.15% |
| Security candidates | 113 | 113 |
| Feature flags | 0 | 0 |
| Fallow fix dry-run proposed fixes | 49 | 0 |

## Remediation Applied

P1/P2 work completed:

- Added `.fallowrc.json` to mark intentional operational entry points and intentional UI primitive exports.
- Removed verified-unused runtime files and stale public exports.
- Narrowed internal-only type/function exports to private declarations.
- Deleted stale document repository helpers and legacy AI/model helpers with no call sites.
- Extracted shared project API rate-limit response helpers.
- Extracted shared service-description write rate-limit handling.
- Extracted shared health response handling.
- Extracted job queue/audit response helpers for project jobs.
- Split the original `generateProjectArtifact` orchestration into smaller artifact-context and generation helpers.
- Hardened middleware redirect construction to local paths.
- Hardened Docling temp-file extension handling so validated upload format controls the suffix.
- Added a defensive dynamic-regex length fallback for signal word counting.
- Extracted shared browser download helpers for blob download and filename normalization.

## Analyzer: Combined

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow --root . --format json --score --performance
```

Final result:

- Score: **78.1 / B**
- Files analyzed: 133
- Functions analyzed: 3,028
- Functions over threshold: 569
- Critical complexity findings: 180
- High complexity findings: 158
- Moderate complexity findings: 231
- Average maintainability: 92.1
- Dead-code issues: 0
- Duplication: 2,772 duplicated lines, 72 clone groups, 5.15%

Severity:

- P1: `apps/frontend/lib/server/ai.ts` and `apps/frontend/components/projects/project-workspace-page.tsx` remain the top churn/complexity hotspots.
- P2: The combined score is now mainly capped by unit size and hotspots, not dead code.
- P3: Keep `.fallowrc.json` current when adding scripts or intentional exported component inventory.

## Analyzer: Health

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow health --root . --format json --score --file-scores --hotspots --ownership --targets --coverage-gaps --performance
```

Final result:

- Score: **78.1 / B**
- Average maintainability: 92.1
- Penalties: hotspots 10.0, unit size 10.0, coupling 1.3, duplication 0.2, complexity 0.4
- Dead-file and dead-export penalties: 0.0

### P1 Findings

1. `apps/frontend/lib/server/ai.ts`
   - Hotspot score: 75.9.
   - Risk: The file still combines parsing, retrieval, prompt construction, generation, evaluation, and correction logic.
   - Status: The original `generateProjectArtifact` issue was reduced by extraction, but the file remains a hotspot due to size and churn.
   - Next step: Continue extracting pure requirement-ledger and evaluation helpers into testable modules.

2. `apps/frontend/components/projects/project-workspace-page.tsx:783` - `ProjectWorkspacePage`
   - Size: 1,806 lines.
   - Hotspot score: 70.8.
   - Risk: Workspace state, job watching, upload actions, prefetching, and rendering remain coupled.
   - Next step: Extract job-progress and document-upload hooks first because those are workflow-critical and testable.

### P2 Findings

1. `apps/frontend/components/projects/project-analysis-tab.tsx:2410` - `ProjectAnalysisTab`
   - Size: 1,779 lines.
   - Next step: Extract repeated section/list editors and chart/render helpers.

2. `apps/frontend/components/projects/project-dashboard.tsx`
   - `HomepageRefreshAnimation`: 1,006 lines.
   - `ProjectDashboard`: 615 lines.
   - Next step: Split visual animation state from dashboard data/actions.

3. Static coverage gaps
   - Runtime files: 123
   - Covered files discovered by Fallow: 0
   - Untested exports: 409
   - Next step: Add focused unit tests around AI parsing/generation, artifact validation, document parsing, and workflow boundary input parsing.

## Analyzer: Dead Code

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow dead-code --root . --format json --performance
```

Final result:

- Total issues: **0**
- Unused files: 0
- Unused exports: 0
- Unused types: 0
- Duplicate exports: 0
- Circular dependencies: 0
- Unresolved imports: 0
- Unlisted dependencies: 0

Severity:

- Info: No remaining dead-code remediation is required from Fallow.

## Analyzer: Duplication

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow dupes --root . --format json --performance
```

Final result:

- Files scanned: 113
- Files with clones: 30
- Clone groups: 72
- Clone instances: 154
- Duplicated lines: 2,772
- Duplication: 5.15%

### P2 Findings

1. AI/project route boilerplate
   - Remaining examples:
     - `apps/frontend/app/api/projects/[id]/customer-analysis/route.ts:296`
     - `apps/frontend/app/api/projects/[id]/solution-evaluation/route.ts:38`
     - `apps/frontend/app/api/projects/[id]/executive-summary/route.ts:33`
     - `apps/frontend/app/api/projects/[id]/generate/route.ts:29`
   - Status: Rate-limit response handling is shared, but request-body/model/error wrappers still have similar structure.
   - Next step: Extract a typed `runProjectAiRoute` wrapper only if it does not obscure endpoint-specific validation.

2. Service-description UI duplication
   - Remaining examples:
     - `apps/frontend/components/projects/global-service-descriptions-panel.tsx:79`
     - `apps/frontend/components/projects/project-service-description-tab.tsx:163`
   - Next step: Extract shared service document cards/list controls.

3. Project analysis tab duplication
   - Remaining examples:
     - `apps/frontend/components/projects/project-analysis-tab.tsx:1455`
     - `apps/frontend/components/projects/project-analysis-tab.tsx:2809`
   - Next step: Extract repeated section renderers after adding snapshot or component tests.

### P3 Findings

- Script harness duplication remains in smoke/quality scripts, but those scripts are intentional operational tooling. Extract a shared script harness when those scripts are next changed.

## Analyzer: Audit

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow audit --root . --format json
```

Final result:

- Verdict: **fail**
- Dead-code issues in audit scope: 0
- Dead-code errors: false
- Complexity findings: 465
- Max cyclomatic complexity: 73
- Duplication clone groups in audit scope: 61

Severity:

- P1: Audit still fails because complexity and duplication thresholds remain above gate, not because of dead code.
- P2: Treat this as the next refactor queue: workspace page, analysis tab, dashboard, AI/evaluation helpers, then repeated project route wrappers.

## Analyzer: Flags

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow flags --root . --format json
```

Final result:

- Feature flags found: 0

Severity:

- Info: No feature-flag cleanup required.

## Analyzer: Security

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow security --root . --format json --surface
```

Final result:

- Security candidates: 113
- Medium: 88
- Low: 25
- Reachable from entry: 103
- Reachable from untrusted source: 88

Categories:

- `path-traversal`: 63
- `ssrf`: 24
- `dynamic-regex`: 16
- `dynamic-module-load`: 5
- `open-redirect`: 4
- `dangerous-html`: 1

### P2 Verification Targets

1. Dynamic regex candidates in `apps/frontend/lib/server/ai.ts`
   - Status: A high-risk signal-word path now falls back to plain substring counting for very long dynamic keywords.
   - Residual: Fallow still reports non-literal `RegExp` construction where customer document text can influence matching logic.
   - Next step: Continue converting dynamic patterns to escaped literals or bounded token matching.

2. Path traversal candidates in `apps/frontend/lib/server/documents.ts`
   - Status: Docling temp-file suffix now comes from validated file format instead of uploaded filename extension.
   - Residual: Fallow still flags temp-dir `path.join` sinks and script path construction.
   - Next step: Add small path guard helpers around temp-dir joins and suppress only after tests prove containment.

3. Open redirect candidates
   - `apps/frontend/middleware.ts:215`
   - `apps/frontend/middleware.ts:232`
   - Status: Middleware now builds redirects with explicit local path helpers and a safe `next` path.
   - Residual: Fallow still flags non-literal redirect targets.
   - Next step: Add middleware tests for external `next` URLs and malformed paths, then baseline/suppress if accepted.

4. Dangerous HTML candidate
   - `apps/frontend/components/projects/mermaid-diagram.tsx:898`
   - Residual: Requires explicit sanitization or proof that Mermaid output is sanitized before `dangerouslySetInnerHTML`.
   - Next step: Prefer DOMPurify or a narrow sanitizer before suppressing.

### P3 Verification Targets

- SSRF candidates in client API helpers and local scripts are mostly dynamic same-origin fetches or operational script targets. Keep host allowlisting for worker/script URLs on the hardening backlog.

## Analyzer: Project Introspection

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow list --root . --format json --entry-points --plugins --boundaries --workspaces
```

Final result:

- Workspaces: 1
- Listed entry points: 9
- Active plugins: `nextjs`, `eslint`, `typescript`, `tailwind`, `postcss`
- Workspace diagnostics: none
- Architecture boundaries configured: false

Severity:

- P3: The new `.fallowrc.json` handles intentional entry points and ignored UI primitive exports. Architecture boundaries are still not configured.

## Analyzer: Fix Preview

Command:

```bash
FALLOW_UPDATE_CHECK=off npx --yes fallow fix --root . --dry-run --yes --no-create-config --format json
```

Final result:

- Dry run: true
- Proposed fixes: 0
- Total fixed: 0
- Skipped: 0

Severity:

- Info: Fallow has no remaining automatic export removals to suggest.

## Non-Fallow Checks

Commands:

```bash
npm run lint
npx tsc --noEmit
node scripts/verify_workflow_boundaries.mjs
node scripts/scan_tracked_secrets.mjs
```

Result:

- ESLint: passed.
- TypeScript: passed.
- Workflow boundary checks: passed.
- Tracked secret scan: passed.

## Raw Analyzer Outputs

- `/tmp/anbud-fallow-2026-06-13-final-combined.json`
- `/tmp/anbud-fallow-2026-06-13-final-health.json`
- `/tmp/anbud-fallow-2026-06-13-final-dead-code.json`
- `/tmp/anbud-fallow-2026-06-13-final-dupes.json`
- `/tmp/anbud-fallow-2026-06-13-final-audit.json`
- `/tmp/anbud-fallow-2026-06-13-final-flags.json`
- `/tmp/anbud-fallow-2026-06-13-final-security.json`
- `/tmp/anbud-fallow-2026-06-13-final-list.json`
- `/tmp/anbud-fallow-2026-06-13-final-fix-preview.json`

## Caveats

- Fallow still warns that some `apps/frontend/package.json` scripts reference `../../scripts/...` paths outside the package root. The root-level config marks the important scripts as entry points, but package-script discovery still warns about parent-directory traversal.
- Security findings are static candidates, not confirmed vulnerabilities. Representative findings were hardened, but the full 113-candidate list should be triaged before suppression.
- Runtime coverage was not available because no Istanbul/V8 coverage artifact exists in the workspace.
