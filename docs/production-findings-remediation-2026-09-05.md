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

## Follow-up from the live retest

The first release exposed a second Mermaid issue: its temporary render container must be attached to the DOM for measurement. A browser reproduction fails when detached and passes when mounted offscreen. The follow-up also keeps already persisted submissions queued during the deployment claim pause, while unrelated claim errors still reject.

Downloaded PDFs were present in Downloads even though the embedded browser emitted no download event. Visual review found row splitting at adjacent-cell paragraph boundaries; pagination now uses whole-row boundaries and preserves full headings. Invalid PDF signatures now use the actionable PDF domain error and HTTP 400. Evaluation actions now include deficient rows from the complete coverage result instead of relying only on sampled findings.

The combined local suite passes 909 tests with zero skips and 22 parser golden cases, plus lint/build. Production results and cleanup are recorded in the separate retest report.

General artifact export now reuses the existing safe GFM Markdown renderer for Word and PDF, preserving headings, emphasis and tables while excluding raw HTML and executable links. PDF clones restore normal document flow so offscreen fixed-position source content cannot overlap the title or be clipped. A locally downloaded PDF was rendered and visually checked for complete, formatted content. The final suite passed 911 tests with zero skips, plus 22 parser golden cases; lint and production build passed.

The next live pass exposed two further causes: the fallback architecture reused `Identity` as both a subgraph and its child node (a Mermaid cycle), and background refresh recomputed artifact totals from partially loaded tab data, making saved outputs appear missing. Future fallback groups now use distinct IDs; known saved fallback diagrams are repaired at render time without rewriting source history. Project refresh merges retain authoritative counts, loaded artifact bodies and revision fencing. The exact production diagram was reproduced locally and the corrected graph rendered successfully. Production requirement PDF (both pages) and Word/proposal exports now preserve complete content and formatting. Final follow-up validation: 913 tests, zero skips, 22 parser golden cases, lint and build passed.
