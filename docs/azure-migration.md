# Azure migration plan

## Phase 1: Azure hosting, Supabase unchanged

Goal: move the web runtime first without changing the data plane.

- Build with `apps/frontend/Dockerfile`.
- Deploy `infra/azure/container-app.bicep`.
- Keep these runtime variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY`, `APP_ACCESS_PASSWORD`, `APP_SESSION_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
- Use `/api/health` as the Azure liveness/readiness endpoint.

## Phase 2: isolate data adapters

Goal: make the later database/storage migration mostly internal.

- Replace direct `createServiceClient()` usage with repository/storage interfaces.
- Keep current behavior and response shapes.
- Move Supabase table access behind a database adapter first.
- Move Supabase Storage access behind a file storage adapter second.

## Phase 3: Azure PostgreSQL and Blob Storage

Goal: cut over the data plane.

- Provision Azure Database for PostgreSQL Flexible Server.
- Apply `supabase/schema.sql` minus Supabase-specific `storage.*` statements.
- Migrate Postgres data with `pg_dump` and `pg_restore`.
- Provision Azure Blob Storage container `anbud-documents`.
- Copy Supabase Storage objects to Azure Blob Storage while preserving object paths.
- Replace adapter implementations with Postgres + Azure Blob SDK.

## Cleanup rules

- Do not delete an API route just because it is not obvious in the UI; first confirm there is no `fetch()` usage and no external integration.
- Do not drop an index from production based only on source search. Confirm with `pg_stat_user_indexes.idx_scan` after representative traffic.
- Remove compatibility fallbacks only after the production schema version is guaranteed.
