# Production findings remediation — 2026-09-05

The signed-in synthetic production test found nine defects. This change fixes the confirmed causes while preserving the current main branch workflows and permissions.

- Project deletion removes evaluation dependencies and artifact versions from leaves upward in one database transaction. Direct parent-artifact deletion remains guarded.
- PDF fallback explicitly loads native canvas primitives; standalone tracing includes PDFjs and native bindings. Invalid/password-protected PDFs receive actionable safe errors.
- Line-anchored requirement IDs take precedence over a conflicting flattened heuristic row. Explicit, unique trailing IDs in supplier prose bind answer evidence to the source ledger, retaining reservations.
- Generated requirement answers label unresolved supplier reservations as unconfirmed and require manual review.
- Evaluation actions no longer pair unrelated arrays by position.
- Mermaid arrows are accepted while active HTML, links and directives remain blocked.
- Project access display includes actual grants alongside global read/share privileges; global admin alone still cannot write project content.
- Mobile navigation closes the drawer. History selections display friendly labels. Upload captions reflect actual uploads.

## Validation before release

904 automated tests passed with zero skips, including disposable PostgreSQL regressions; 22 parser golden cases passed. Lint, production build, secret scan, repository contracts, workflow-consistency regressions and additive-upgrade checks passed. The standalone Linux container passed health/size checks and parsed the original valid PDF with the packaged native canvas and modern PDFjs fallback.

The deletion regression covers three linked artifact versions and an evaluation, and verifies that individual parent deletion remains blocked. Requirement fixtures reproduce the six known source IDs, supplier narrative matching and the explicit unpriced 24/7 gap. Diagram tests include ordinary arrows and blocked active content.

Production retest and generated export verification are tracked separately in the local test report; pre-release checks do not constitute a production sign-off. Apply `database/migrations/20260905100000_project_artifact_tree_deletion.sql` before the production retest.
