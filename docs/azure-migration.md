# Azure data-plane migration

This runbook deliberately separates reversible preparation from the production
cutover. A merge or ordinary application deployment must not move data.

## Current decision

- Keep the PostgREST query/RPC contract for the first database cutover. The app
  has many chained PostgREST queries and 34 PostgreSQL RPCs; rewriting these to
  direct `pg` calls during the data move would combine two high-risk changes.
- Use Azure Database for PostgreSQL Flexible Server 17, Azure Blob Storage and a
  temporary internal PostgREST Container App.
- Start with B1ms, 32 GiB, no HA and seven-day PITR only after a representative
  restore proves the capacity margin. B1ms is a cost-first choice, not a
  mission-critical availability tier.
- Keep PostgREST at `maxReplicas=1` and `PGRST_DB_POOL=5`. B1ms has very limited
  connection headroom.
- Keep Supabase authoritative until the validation restore, counts, hashes,
  RBAC, app smoke and cold-start tests all pass.
- Never apply `supabase/schema.sql` to Azure. It is destructive, includes
  Supabase platform objects and is not the complete live schema.

## Cost guardrails

The current Norway East retail estimate is approximately USD 20.81/month for
B1ms plus 32 GiB PostgreSQL storage, before Blob operations and backup growth.
Hot LRS Blob storage is small by comparison for the current workload. During
the 14-day rollback window, both Supabase and Azure are billed.

Additional controls:

- `minReplicas=0` for the web app and bridge; expect a cold first request.
- no PostgreSQL HA or geo-redundant backup during the initial migration
- storage auto-grow disabled; scale only after an explicit capacity review
- 7-day PostgreSQL PITR and 14-day Blob/container soft delete
- no Blob versioning initially, because frequent upserts can grow storage cost
- no Shared Key access, public blob access or broad `Allow Azure services`
- budget notifications at 50%, 80% and 100% actual plus 100% forecast;
  notifications do not stop resources automatically
- deploy the budget before the first paid data resource, after converting the
  cost ceiling to the subscription's verified billing currency
- scale PostgreSQL storage only after preflight: Azure storage cannot be scaled
  back down

The five-minute worker poll is a separate recurring cost. Consider a 15-minute
schedule only if up to 15 minutes of job latency is acceptable.

## Phase 0: subscription and identity bootstrap

Run with an Owner/User Access Administrator for this one-time step; do not grant
the routine deployment principal permanent Owner.

```bash
for namespace in Microsoft.DBforPostgreSQL Microsoft.Storage Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network
do
  az provider register --namespace "$namespace"
done

az provider list \
  --query "[?namespace=='Microsoft.DBforPostgreSQL' || namespace=='Microsoft.Storage' || namespace=='Microsoft.KeyVault' || namespace=='Microsoft.ManagedIdentity' || namespace=='Microsoft.Network'].{namespace:namespace,state:registrationState}" \
  --output table
```

Deploy the separate RBAC bootstrap once. Routine CI must not manage role
assignments and keeps only Contributor:

```bash
az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/acr-pull-bootstrap.bicep \
  --parameters registryName=<acr-name>

az deployment group create \
  --resource-group anbud-prod \
  --template-file infra/azure/acr-pull-bootstrap.bicep \
  --parameters registryName=<acr-name>
```

Assign the resulting identity to web and worker and configure both registry
entries to use it. Confirm a web cold start and a no-op worker execution pull an
immutable digest successfully. Only then disable the ACR admin user and rotate
its password. Ordinary `container-app.bicep` deployments only reference this
existing identity.

## Phase 1: backend-compatible application deploy

The database adapter accepts either:

- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; or
- full `DATA_API_URL` + `DATA_API_SERVICE_ROLE_KEY`.

The explicit pair wins, but an incomplete explicit pair fails closed. Storage
uses `FILE_STORAGE_BACKEND=supabase` by default. The Azure alternative requires
`AZURE_STORAGE_ACCOUNT_URL`, uses `DefaultAzureCredential`, permits only the
configured private container and preserves encrypted UTF-8 bytes and object
paths exactly.

Deploy this phase while both feature flags still select Supabase. Verify login,
RBAC, worker claims, audit writes, document upload/download/delete and RAG.

## Phase 2: source preflight — hard gate

Production data access must be passed as protected environment variables, never
as CLI arguments or committed parameter files:

```bash
export SOURCE_DATABASE_URL='postgresql://...:5432/postgres?sslmode=verify-full'
```

Use PostgreSQL 17 client tools. Local PostgreSQL 14 tools are not safe for a
PostgreSQL 17 source.

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
node scripts/azure_migration_preflight.mjs
```

This command is intentionally database-only. It stops on the wrong client or
server major, any difference in the complete migration history or exact
31-table inventory, missing RLS, locale/encoding surprises, unexpected
`SECURITY DEFINER` signatures/settings/ACLs, running jobs or a database above
70% of planned target storage. Bring the source to the canonical migration set
through the normal reviewed Supabase migration process, then run preflight
again; never patch only the target.

Before continuing, also inventory:

- exact PostgreSQL/extension versions and every table/function/index/trigger
- distinct `file_storage_bucket` values
- referenced blobs, unreferenced/orphan blobs and database-only legacy files
- object count, byte count and SHA-256 manifest
- queued/running jobs and every active writer

## Phase 3: provision locked-down validation targets

Always preview first:

```bash
export POSTGRES_ALLOWED_IPV4_ADDRESSES='["<every-aca-outbound-ip>","<migration-host-ip>"]'
export POSTGRES_DATABASE_COLLATION='<value-from-database-preflight>'
node scripts/azure_migration_guardrails.mjs postgres

az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/postgres.bicep \
  --parameters @/secure/outside-git/postgres.bicepparam

az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/storage.bicep \
  --parameters @/secure/outside-git/storage.bicepparam

az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/budget.bicep \
  --parameters monthlyAmount=<verified-billing-currency-limit>
```

Before previewing PostgREST, set its digest reference in `POSTGREST_IMAGE` and
run `node scripts/azure_migration_guardrails.mjs postgrest`. These supported,
unit-tested guards reject `0.0.0.0`, CIDRs, malformed IPs, missing collation and
mutable PostgREST tags before the Azure CLI call.

The PostgreSQL template creates production and validation databases on one
server; the second database adds no compute instance. It allowlists only exact
IP addresses, enables only `pgcrypto,vector`, disables HA and starts with the
smallest allowed storage. Pass the source collation reported by preflight as
`databaseCollation`; provisioning or verification must stop if Azure cannot
preserve it.

Inventory every value in the Container Apps environment's advertised outbound
IP list and the controlled migration host IP, and pass the full set to the
PostgreSQL firewall. The template rejects CIDRs, `0.0.0.0`, and the cross-tenant
"Allow Azure services" rule. Re-check the advertised list before cutover and
after any Container Apps environment infrastructure change.

The cheapest reliable same-region Blob design uses a public Storage endpoint
with network default Allow because Azure Storage IP rules do not support
same-region Azure workload traffic. Data access is still identity-only: Shared
Key and public blobs are disabled, and web/worker get only container-scoped
roles. A private data endpoint requires a new VNet-integrated Container Apps
environment plus service/private endpoints and is a separate, more expensive
architecture decision.

Deploy and verify `budget.bicep` before creating PostgreSQL or Storage. A budget
is a notification control, not a hard spending cap. Run
`infra/azure/postgres/bootstrap.sql` as the Azure bootstrap administrator in
both `anbud_validation` and `anbud`.
Set the `anbud_authenticator` password interactively with `\password`; never put
the password in shell history. Runtime connects only as `anbud_authenticator`,
which may `SET ROLE service_role`. The data owner and privileged service role
are `NOLOGIN`.

## Phase 4: validation restore and blob pre-copy

Take a PostgreSQL 17 custom dump of only the live `public` schema:

```bash
PGDATABASE="$SOURCE_DATABASE_URL" pg_dump \
  --format=custom \
  --compress=zstd:6 \
  --serializable-deferrable \
  --strict-names \
  --quote-all-identifiers \
  --no-owner \
  --no-privileges \
  --schema=public \
  --file="$DUMP_PATH"
```

Inspect `pg_restore --list`. Reject unexpected ACL grantees, owners or
`SECURITY DEFINER` functions. Remove the dump TOC entry that creates the
already-bootstrapped `public` schema and dump with `--no-owner --no-privileges`
so Supabase platform ownership/ACLs cannot enter Azure. Bootstrap default
privileges grant only `service_role`. Restore to `anbud_validation` with
`--single-transaction --exit-on-error --role=anbud_owner`, re-run
`bootstrap.sql` to apply deterministic existing-object ACLs, then run
`verify.sql` with `--set expected_collation=<source>` and
`--set expected_ctype=<source>` from the preflight report, followed by
`ANALYZE`. The verifier exits nonzero if either locale or UTF8 differs.

Copy every Storage object, including orphans, byte-for-byte. Do not decrypt or
re-encrypt. Keep the container name and paths unchanged. Compare source and
target manifests by path, size and downloaded SHA-256; provider ETags are not a
cross-provider content hash. Azure may contain a superseded pre-copy, but the
final source manifest must never be missing at the target.

Provide the S3 credentials and byte-identical `APP_ENCRYPTION_KEY` only to the
dedicated copy/verification process. Before copying, query every distinct
`file_storage_bucket` and stop unless it matches the configured Azure container.
Grant the migration identity `Storage Blob Data Contributor` only on that
container, prove the path/size/SHA-256 manifest and decryption smoke, then revoke
the temporary role and S3 credentials. The database preflight does not claim to
validate blobs.

An anonymous request to the account/container must return 401/403, and a test
identity without the container role must be denied. The web and worker managed
identities must pass the non-mutating readiness probe before promotion.

## Phase 5: application acceptance on validation data

Deploy `infra/azure/postgrest.bicep` with an image pinned by digest. It has
internal ingress, no anonymous role, a five-connection pool and at most one
replica. Use a new JWT secret and service token; never reuse the Supabase JWT
secret/key.

Before enabling Azure in production, run the real app query/RPC suite against
standalone PostgREST on the restored PostgreSQL 17 database, including
service-role JWT, scalar/table RPC responses, schema-cache reload and
`vector(1536)`. Mocked HTTP tests are not sufficient.

The current GitHub-hosted deployment runner cannot reach internal PostgREST and
therefore explicitly refuses non-empty `DATA_API_*` or Azure file storage.
Keep the data API pair unset and both Supabase backends active until schema
checks, cutover RPCs and the paired Blob switch run from a controlled Container
Apps job or a self-hosted runner inside the Azure network. Never make PostgREST
public to bypass this gate.

The complete gate is:

- full frontend tests, lint and production build
- every SQL atomicity/fencing/audit/history test against PostgreSQL 17
- exact table counts and stable PK-ordered content hashes
- sequences, validated constraints, valid/ready indexes, triggers and ACL/RLS
- `vector(1536)`, HNSW and hybrid retrieval with representative data
- Blob overwrite/download/prefix boundary/idempotent delete/soft-delete restore
- internal, guest and administrator login; revoked and expired sessions
- project roles, admin read-only rules and required audit writes
- document upload/download/delete and legacy database-file fallback
- worker claim, heartbeat, takeover and terminal state
- a real first login and document request after scale-to-zero
- CPU credits, connection count, storage and latency below agreed thresholds

If B1ms misses the SLO, scale compute up before cutover. Do not increase storage
as a performance experiment because it cannot be reduced later.

## Phase 6: production write freeze and final cutover

`minReplicas=0` is not a write freeze; an HTTP request can wake the app.

1. Deploy a maintenance revision that blocks every mutating route.
2. Stop the scheduled worker and call `set_project_job_claims_enabled(false)`.
3. Drain running jobs or use the controlled requeue RPC; prove zero running jobs
   and no other writers.
4. Re-run `azure_migration_preflight.mjs` against the now-frozen source and stop
   on any schema, migration, function, locale, job or size drift.
5. Run the final Blob delta and freeze the source manifest.
6. Drop the stale `anbud_validation` database after retaining its acceptance
   evidence. Never keep two full restores on the 32 GiB server during cutover.
7. Take a new consistent database dump and restore it into the empty production
   target.
8. Re-run `bootstrap.sql` in production to lock down restored existing-object
   ACLs, then run `verify.sql`, database counts/hashes/sequences/triggers and all
   Blob integrity/decryption checks again.
9. Deploy `DATA_API_*` and `FILE_STORAGE_BACKEND=azure` together from the
   internal deployment control plane.
10. Keep Azure read-only until acceptance tests pass, then enable claims/writes.

Stop immediately on any restore warning/error, count/hash/sequence mismatch,
missing referenced blob, decryption failure, unexpected ACL/definer, broadly
accessible PostgreSQL or blob container, active writer or failed smoke test.

## Rollback and cleanup

Do not dual-write. Before Azure receives a production write, rollback is a
traffic switch to the still-frozen Supabase source. After the first Azure write,
rollback requires another freeze and reverse migration; a simple switch would
split or lose data.

Keep Supabase immutable for 14 days. Test PostgreSQL PITR and Blob restoration
before removing it. Then revoke temporary S3 credentials, remove Supabase keys,
rotate migration credentials and JWTs, and later replace the temporary
PostgREST bridge repository-by-repository with a direct pooled PostgreSQL
adapter.
