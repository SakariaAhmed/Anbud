# Cleanup audit

## Code cleanup done

- Removed unused imports and props from the customer analysis tab.
- Removed two unused workspace handlers that no longer had callers.
- Removed unused AI helper functions and an unused type.
- Removed an unused file-storage import from the project database module.

## API route audit

No API routes were removed. Each current route is referenced by the UI or by server workflow polling:

- `/api/projects`
- `/api/projects/[id]`
- `/api/projects/[id]/documents`
- `/api/projects/[id]/documents/[documentId]`
- `/api/projects/[id]/customer-analysis`
- `/api/projects/[id]/solution-evaluation`
- `/api/projects/[id]/executive-summary`
- `/api/projects/[id]/generate`
- `/api/projects/[id]/jobs`
- `/api/projects/[id]/jobs/[jobId]`
- `/api/projects/[id]/chat`
- `/api/projects/[id]/service-descriptions`
- `/api/service-descriptions`
- `/api/service-descriptions/[serviceId]`
- `/api/service-descriptions/[serviceId]/documents/[documentId]`
- `/api/openai-models`

`/api/health/live` and `/api/health/ready` are used for Azure liveness and readiness probes. `/api/health` exposes the detailed health model.

## Index cleanup candidates

Do not drop these from production until `supabase/index_usage_audit.sql` has been run after representative traffic.

Source-level candidates to inspect first:

- `project_jobs_status_idx`: current app reads jobs by `id` and `project_id`, not by status.
- `project_jobs_project_status_idx`: current app does not query project jobs by `project_id + status`.
- `service_descriptions_keywords_idx`: keywords are currently used in application-side matching, not SQL search.
- `generated_artifacts_project_type_idx`: artifacts are currently loaded by project and filtered in application code.
- `audit_events_project_idx` and `audit_events_action_idx`: the app currently writes audit events but has no audit-event read UI.

Keep foreign-key and common listing indexes unless production stats prove they are unused; they help deletes, cascades, and common project-detail reads.
