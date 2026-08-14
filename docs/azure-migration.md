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
schedule only if up to 15 minutes of job latency is acceptable. A five-minute
worker that calls PostgREST can also wake a bridge configured with
`minReplicas=0` at every poll, so scale-to-zero is a floor, not a guarantee of
zero bridge execution charges.

## Phase 0: subscription and identity bootstrap

Run with Owner, or with Contributor plus User Access Administrator, for this
one-time step; do not grant the routine deployment principal permanent Owner.

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
  --parameters \
    @/secure/outside-git/storage.bicepparam \
    migrationEvidenceContainerName=anbud-migration-evidence

az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/budget.bicep \
  --parameters monthlyAmount=<verified-billing-currency-limit>
```

Before previewing PostgREST, set its digest reference in `POSTGREST_IMAGE` and
run `node scripts/azure_migration_guardrails.mjs postgrest`. These supported,
unit-tested guards reject `0.0.0.0`, CIDRs, malformed IPs, missing collation and
mutable PostgREST tags before the Azure CLI call.

The PostgreSQL template creates only the server. ARM's database child resource
creates a libc-locale database and cannot preserve this source's ICU contract.
After the server reports `Ready`, verify that its `en-US-x-icu` catalog entry
has actual version `153.120`, then create both databases explicitly:

```sql
CREATE DATABASE anbud_validation
  TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER icu ICU_LOCALE 'en-US';
CREATE DATABASE anbud
  TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER icu ICU_LOCALE 'en-US';
```

The source reports ICU provider `i`, locale `en-US`, no ICU rules and version
`153.120`. Azure stores the equivalent display aliases
`en_US.utf8`/`en_US.utf8` for these ICU databases, while Supabase reports
`en_US.UTF-8`/`en_US.UTF-8`; provider, locale, rules and version must still
match exactly. The database comparator accepts only this exact display-name
alias pair and rejects every other locale difference.

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
architecture decision. `storage.bicep` also creates the separate private
`anbud-migration-evidence` container. Its `accountUrl` output is the canonical
Blob origin without a trailing slash; use that exact value for
`AZURE_STORAGE_ACCOUNT_URL` and `azureStorageAccountUrl`.

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
: "${PGHOST:?load the direct source host from the protected secret store}"
: "${PGPORT:?load the direct source port}"
: "${PGUSER:?load the temporary read-only export role}"
: "${PGPASSWORD:?load its short-lived password without printing it}"
: "${PGDATABASE:?load the source database name}"
: "${PGSSLROOTCERT:?load the pinned source CA path}"
test "${PGSSLMODE:?}" = verify-full

pg_dump \
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
`SECURITY DEFINER` functions. Remove the TOC entries for the already-existing
`public` schema and Supabase's exact platform-only `rls_auto_enable()` function;
the preflight and database comparator pin that function's full catalog
fingerprint before allowing the exclusion. Dump with
`--no-owner --no-privileges` so Supabase platform ownership/ACLs cannot enter
Azure. Bootstrap default privileges grant only `service_role`. Restore to `anbud_validation` with
`--single-transaction --exit-on-error --role=anbud_owner`, re-run
`bootstrap.sql` to apply deterministic existing-object ACLs, then run
`verify.sql` with `expected_collation=en_US.utf8`,
`expected_ctype=en_US.utf8`, `expected_locale_provider=i`,
`expected_locale=en-US` and `expected_collation_version=153.120`, followed by
`ANALYZE`. The verifier exits nonzero if encoding, provider, locale, ICU rules,
stored ICU version or actual ICU version differs.

Copy every Storage object, including orphans, byte-for-byte. Do not decrypt or
re-encrypt. Keep the container name and paths unchanged. Compare source and
target manifests by path, size and downloaded SHA-256; provider ETags are not a
cross-provider content hash. Azure may contain a superseded pre-copy, but the
final source manifest must never be missing at the target.

For a small linked project, prefer `SOURCE_STORAGE_MODE=supabase-linked-cli` so
no long-lived S3 key is created. Pin Supabase CLI 2.105 or newer, bind the local
link to the expected project ref, and in final mode download every source object
a second time before accepting its size/SHA-256. For larger buckets, use the
short-lived `supabase-s3` fallback and rotate its S3 credentials immediately.
The linked CLI cannot expose original provider HTTP/user metadata. That is an
accepted application-level contract here: documents are encrypted UTF-8
payloads, MIME/download behavior comes from the database, and the Azure adapter
always writes `application/octet-stream` with the same long-lived cache policy.
The final manifest must record the unavailable-metadata marker and those exact
defaults; any other metadata shape stops evidence-v2 validation.
Provide the byte-identical `APP_ENCRYPTION_KEY` only to the dedicated
copy/verification process. Before copying, query every distinct
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

The GitHub-hosted runner never receives the PostgREST credential and cannot
reach internal PostgREST. It starts a zero-idle Container Apps control job over
the Azure management plane. That job reads the version-pinned credential from
Key Vault, validates the internal API/RPC contract, proves target claims are
closed with zero running jobs, probes Blob with its read-only managed identity,
and verifies a private, digest-pinned final evidence envelope. The production
workflow refuses Azure configuration unless this control succeeds. Never make
PostgREST public to bypass the gate.

### One-time migration-control bootstrap — hard gate before freeze

This bootstrap requires Owner, or Contributor plus User Access Administrator,
for the scoped role assignments. Routine deployment remains Resource Group
Contributor and always passes `bootstrapRoleAssignments=false`. Run every
verification below before starting the production write freeze.

Create the Key Vault once, or reconcile an existing vault. Purge protection is
irreversible. `enabledForTemplateDeployment=true` is required by the current
version-pinned ARM secret-reference flow; RBAC still controls data-plane access.
Do not grant the routine deployment identity Key Vault data roles.

```bash
MIGRATION_KEY_VAULT=anbud-prod-kv-9841703
MIGRATION_OPERATOR_OBJECT_ID="$(az ad signed-in-user show --query id --output tsv)"
test -n "$MIGRATION_OPERATOR_OBJECT_ID"

if ! az keyvault show \
  --resource-group anbud-prod \
  --name "$MIGRATION_KEY_VAULT" \
  --output none 2>/dev/null
then
  az keyvault create \
    --resource-group anbud-prod \
    --name "$MIGRATION_KEY_VAULT" \
    --location norwayeast \
    --enable-rbac-authorization true \
    --enable-purge-protection true \
    --retention-days 90 \
    --enabled-for-template-deployment true \
    --public-network-access Enabled \
    --output none
fi

az keyvault update \
  --resource-group anbud-prod \
  --name "$MIGRATION_KEY_VAULT" \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --enabled-for-template-deployment true \
  --output none

az keyvault show \
  --resource-group anbud-prod \
  --name "$MIGRATION_KEY_VAULT" \
  --query '{rbac:properties.enableRbacAuthorization,templateDeployment:properties.enabledForTemplateDeployment,purgeProtection:properties.enablePurgeProtection,softDeleteDays:properties.softDeleteRetentionInDays}'
test "$(az keyvault show --resource-group anbud-prod --name "$MIGRATION_KEY_VAULT" --query properties.enableRbacAuthorization --output tsv)" = true
test "$(az keyvault show --resource-group anbud-prod --name "$MIGRATION_KEY_VAULT" --query properties.enabledForTemplateDeployment --output tsv)" = true
test "$(az keyvault show --resource-group anbud-prod --name "$MIGRATION_KEY_VAULT" --query properties.enablePurgeProtection --output tsv)" = true

KEY_VAULT_ID="$(az keyvault show --resource-group anbud-prod --name "$MIGRATION_KEY_VAULT" --query id --output tsv)"
az role assignment create \
  --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" \
  --assignee-principal-type User \
  --role 'Key Vault Secrets Officer' \
  --scope "$KEY_VAULT_ID" \
  --output none
test "$(az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$KEY_VAULT_ID" --query "[?roleDefinitionName=='Key Vault Secrets Officer'] | length(@)" --output tsv)" = 1
```

Seed the independent PostgREST service JWT from a mode-`0600` file outside the
repository. Never put its value in a shell argument, command history or
deployment parameter file. Record only the returned 32-character version in
the protected GitHub production variable
`MIGRATION_CONTROL_DATA_API_SECRET_VERSION`. If the first write is denied while
the new role propagates, re-check the same exact assignment and retry; never
widen the scope or role.

```bash
POSTGREST_SECRET_FILE=/secure/outside-git/postgrest-service-role-key.txt
node -e 'const fs=require("node:fs"); const p=process.argv[1]; const b=fs.readFileSync(p); if ((fs.statSync(p).mode & 0o777) !== 0o600 || b.length < 32 || b.includes(10) || b.includes(13)) process.exit(1)' "$POSTGREST_SECRET_FILE"

POSTGREST_SECRET_ID="$(az keyvault secret set \
  --vault-name "$MIGRATION_KEY_VAULT" \
  --name postgrest-service-role-key \
  --file "$POSTGREST_SECRET_FILE" \
  --query id \
  --output tsv)"
POSTGREST_SECRET_VERSION="${POSTGREST_SECRET_ID##*/}"
test "${#POSTGREST_SECRET_VERSION}" -eq 32
unset POSTGREST_SECRET_ID
```

The Storage deployment must already have created two distinct private
containers. Its canonical account URL deliberately has no trailing slash:

```bash
STORAGE_ACCOUNT=anbudprod9841703data
STORAGE_ID="$(az storage account show \
  --resource-group anbud-prod \
  --name "$STORAGE_ACCOUNT" \
  --query id \
  --output tsv)"
AZURE_STORAGE_ACCOUNT_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net"
test "${AZURE_STORAGE_ACCOUNT_URL%/}" = "$AZURE_STORAGE_ACCOUNT_URL"
DOCUMENTS_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-documents"
EVIDENCE_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-migration-evidence"

az storage container-rm show \
  --resource-group anbud-prod \
  --storage-account "$STORAGE_ACCOUNT" \
  --name anbud-documents \
  --query '{name:name,publicAccess:properties.publicAccess}'
az storage container-rm show \
  --resource-group anbud-prod \
  --storage-account "$STORAGE_ACCOUNT" \
  --name anbud-migration-evidence \
  --query '{name:name,publicAccess:properties.publicAccess}'
test -z "$(az storage container-rm show --resource-group anbud-prod --storage-account "$STORAGE_ACCOUNT" --name anbud-documents --query properties.publicAccess --output tsv)"
test -z "$(az storage container-rm show --resource-group anbud-prod --storage-account "$STORAGE_ACCOUNT" --name anbud-migration-evidence --query properties.publicAccess --output tsv)"

az role assignment create \
  --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" \
  --assignee-principal-type User \
  --role 'Storage Blob Data Contributor' \
  --scope "$DOCUMENTS_SCOPE" \
  --output none
az role assignment create \
  --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" \
  --assignee-principal-type User \
  --role 'Storage Blob Data Contributor' \
  --scope "$EVIDENCE_SCOPE" \
  --output none
```

Deploy `migration-control.bicep` once with role bootstrap enabled. The reserved
bootstrap evidence path must not exist and the all-zero digest makes an
accidental job start fail closed. The final workflow replaces both with the
fresh, verified final evidence path and digest before it starts the job.

```bash
CONTROL_IMAGE="${CONTROL_IMAGE:?Export the verified digest-pinned image containing the migration-control script}"
[[ "$CONTROL_IMAGE" =~ ^anbudprod9841703\.azurecr\.io/anbud@sha256:[0-9a-f]{64}$ ]]
POSTGREST_FQDN="$(az containerapp show --resource-group anbud-prod --name anbud-postgrest --query properties.configuration.ingress.fqdn --output tsv)"
test "$(az containerapp show --resource-group anbud-prod --name anbud-postgrest --query properties.configuration.ingress.external --output tsv)" = false
DATA_API_URL="https://${POSTGREST_FQDN}"

az deployment group what-if \
  --resource-group anbud-prod \
  --template-file infra/azure/migration-control.bicep \
  --parameters \
    environmentName=anbud-env \
    jobName=anbud-migration-control \
    registryName=anbudprod9841703 \
    acrPullIdentityName=anbud-acr-pull \
    controlIdentityName=anbud-migration-control \
    keyVaultName="$MIGRATION_KEY_VAULT" \
    dataApiServiceRoleSecretName=postgrest-service-role-key \
    dataApiServiceRoleSecretVersion="$POSTGREST_SECRET_VERSION" \
    storageAccountName="$STORAGE_ACCOUNT" \
    storageContainerName=anbud-documents \
    migrationEvidenceContainerName=anbud-migration-evidence \
    migrationEvidenceBlobName=bootstrap/never-run.json \
    migrationEvidenceSha256=0000000000000000000000000000000000000000000000000000000000000000 \
    dataApiUrl="$DATA_API_URL" \
    azureStorageAccountUrl="$AZURE_STORAGE_ACCOUNT_URL" \
    image="$CONTROL_IMAGE" \
    bootstrapRoleAssignments=true

az deployment group create \
  --resource-group anbud-prod \
  --name anbud-migration-control-bootstrap \
  --template-file infra/azure/migration-control.bicep \
  --parameters \
    environmentName=anbud-env \
    jobName=anbud-migration-control \
    registryName=anbudprod9841703 \
    acrPullIdentityName=anbud-acr-pull \
    controlIdentityName=anbud-migration-control \
    keyVaultName="$MIGRATION_KEY_VAULT" \
    dataApiServiceRoleSecretName=postgrest-service-role-key \
    dataApiServiceRoleSecretVersion="$POSTGREST_SECRET_VERSION" \
    storageAccountName="$STORAGE_ACCOUNT" \
    storageContainerName=anbud-documents \
    migrationEvidenceContainerName=anbud-migration-evidence \
    migrationEvidenceBlobName=bootstrap/never-run.json \
    migrationEvidenceSha256=0000000000000000000000000000000000000000000000000000000000000000 \
    dataApiUrl="$DATA_API_URL" \
    azureStorageAccountUrl="$AZURE_STORAGE_ACCOUNT_URL" \
    image="$CONTROL_IMAGE" \
    bootstrapRoleAssignments=true \
  --output none
```

Role assignment propagation can lag behind the ARM deployment. If provisioning
fails only because the new identity cannot yet resolve the Key Vault reference,
keep every scope and immutable parameter unchanged, wait for the three role
queries below to return exactly one result, and rerun the same deployment.

Verify exactly one scoped role at each boundary and confirm the bootstrap
evidence blob is absent. Any extra role is a stop condition.

```bash
CONTROL_PRINCIPAL_ID="$(az identity show \
  --resource-group anbud-prod \
  --name anbud-migration-control \
  --query principalId \
  --output tsv)"
az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$KEY_VAULT_ID" --output table
az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$DOCUMENTS_SCOPE" --output table
az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$EVIDENCE_SCOPE" --output table

test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$KEY_VAULT_ID" --query "[?ends_with(roleDefinitionId, '4633458b-17de-408a-b874-0445c86b69e6')] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$DOCUMENTS_SCOPE" --query "[?ends_with(roleDefinitionId, '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$EVIDENCE_SCOPE" --query "[?ends_with(roleDefinitionId, '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$KEY_VAULT_ID" --query 'length(@)' --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$DOCUMENTS_SCOPE" --query 'length(@)' --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$EVIDENCE_SCOPE" --query 'length(@)' --output tsv)" = 1
if az storage blob show --account-name "$STORAGE_ACCOUNT" --container-name anbud-migration-evidence --name bootstrap/never-run.json --auth-mode login --output none 2>/dev/null
then
  echo 'Reserved bootstrap evidence path unexpectedly exists.' >&2
  exit 1
fi
```

Do not start the bootstrap-configured job. Routine and final deployments must
pass `bootstrapRoleAssignments=false`; only the protected final cutover inputs
may start it.

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

1. Convert the live web ingress to internal-only, then prove the public origin
   cannot reach `/api/health/live`. Do not use `ingress disable`: the deployment
   gate requires the explicit `external=false` state and keeps that state
   through reconcile, candidate readiness and target activation.

   ```bash
   az containerapp ingress enable \
     --resource-group anbud-prod \
     --name anbud \
     --type internal \
     --target-port 3000 \
     --transport auto \
     --allow-insecure false \
     --output none \
     --only-show-errors
   test "$(az containerapp show --resource-group anbud-prod --name anbud --query properties.configuration.ingress.external --output tsv)" = false
   ```

   A public request must fail or return the Container Apps gateway's `404`,
   never an application response. This is the technical HTTP write freeze.
2. Stop the scheduled worker and call `set_project_job_claims_enabled(false)`.
3. Drain running jobs or use the controlled requeue RPC; prove zero running jobs
   and no other writers.
4. Re-run `azure_migration_preflight.mjs` against the now-frozen source and stop
   on any schema, migration, function, locale, job or size drift.
5. Generate the reference inventory from the already-frozen linked database,
   then run the final Blob delta with the same exact freeze timestamp. Never
   hand-edit or reuse this file: the Blob manifest pins its bytes, mtime,
   project ref, unique reference count and deterministic reference SHA-256.
   During activation the internal control job queries `documents` and
   `service_documents` from the restored Azure database and requires the same
   count/SHA-256, so an omitted database reference fails closed.

   ```bash
   umask 077
   test -n "$AZURE_CUTOVER_SOURCE_FROZEN_AT"
   supabase db query \
     --linked \
     --output json \
     --log-level error \
     --workdir "$MIGRATION_SUPABASE_WORKDIR" \
     "SELECT file_storage_bucket AS bucket, file_storage_path AS path
        FROM public.documents
       WHERE file_storage_path IS NOT NULL
       UNION ALL
      SELECT file_storage_bucket AS bucket, file_storage_path AS path
        FROM public.service_documents
       WHERE file_storage_path IS NOT NULL
       ORDER BY 1, 2" \
     > "$MIGRATION_DB_REFERENCES_FILE"
   test -s "$MIGRATION_DB_REFERENCES_FILE"

   export MIGRATION_SOURCE_FROZEN=1
   export MIGRATION_SOURCE_FROZEN_AT="$AZURE_CUTOVER_SOURCE_FROZEN_AT"
   npm --prefix apps/frontend run storage:migrate:azure -- --mode=final
   ```

   Keep the reference file on mode-`0600` temporary storage, and delete it with
   the other local evidence only after the private evidence upload has been
   downloaded and re-hashed successfully.
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

Keep Supabase immutable and keep its service-role fallback only for the explicit
14-day rollback window. It must not be a permanent second backend. Test
PostgreSQL PITR and Blob soft-delete restoration before the window closes.

Immediately after Azure acceptance:

1. Return the temporary PostgREST bridge to scale-to-zero.
2. Remove only the migration-host PostgreSQL firewall rule. Keep the exact
   Container Apps outbound IP rule while PostgREST still uses the public
   PostgreSQL endpoint.
3. Remove temporary human Blob roles after the final evidence upload and remove
   the human Key Vault role after the coordinated credential rotation. Keep the
   web/worker container-scoped Blob Contributor roles and the shared
   `anbud-acr-pull` ACR role.

Resolve and inspect every target before deletion:

```bash
az containerapp update \
  --resource-group anbud-prod \
  --name anbud-postgrest \
  --min-replicas 0 \
  --output none

az postgres flexible-server firewall-rule list \
  --resource-group anbud-prod \
  --name anbud-prod-pg-9841703 \
  --query '[].{name:name,start:startIpAddress,end:endIpAddress}' \
  --output table

# Set this only after matching it to the controlled migration-host IP. Never
# remove the rule matching the advertised Container Apps outbound IP here.
MIGRATION_HOST_FIREWALL_RULE="${MIGRATION_HOST_FIREWALL_RULE:?Export the exact reviewed migration-host rule name}"
az postgres flexible-server firewall-rule delete \
  --resource-group anbud-prod \
  --name anbud-prod-pg-9841703 \
  --rule-name "$MIGRATION_HOST_FIREWALL_RULE" \
  --yes
```

For each temporary operator role, first list with the same assignee and exact
scope, require one intended match, then delete that role at that scope. Never
delete the runtime managed-identity assignments.

```bash
MIGRATION_OPERATOR_OBJECT_ID="${MIGRATION_OPERATOR_OBJECT_ID:?Export the object ID recorded at bootstrap}"
KEY_VAULT_ID="$(az keyvault show --resource-group anbud-prod --name anbud-prod-kv-9841703 --query id --output tsv)"
STORAGE_ID="$(az storage account show --resource-group anbud-prod --name anbudprod9841703data --query id --output tsv)"
DOCUMENTS_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-documents"
EVIDENCE_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-migration-evidence"

az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$DOCUMENTS_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Contributor']" --output table
az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$EVIDENCE_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Contributor']" --output table
az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$KEY_VAULT_ID" --query "[?roleDefinitionName=='Key Vault Secrets Officer']" --output table
test "$(az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$DOCUMENTS_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Contributor'] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$EVIDENCE_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Contributor'] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --scope "$KEY_VAULT_ID" --query "[?roleDefinitionName=='Key Vault Secrets Officer'] | length(@)" --output tsv)" = 1

az role assignment delete --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --role 'Storage Blob Data Contributor' --scope "$DOCUMENTS_SCOPE"
az role assignment delete --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --role 'Storage Blob Data Contributor' --scope "$EVIDENCE_SCOPE"
az role assignment delete --assignee-object-id "$MIGRATION_OPERATOR_OBJECT_ID" --role 'Key Vault Secrets Officer' --scope "$KEY_VAULT_ID"
```

At day 14, freeze any remaining Azure writes long enough to decide rollback or
final retirement. After restore tests pass and rollback is formally closed:

- revoke every Supabase S3 credential, PAT and service-role credential used by
  migration;
- first change the deployment workflow so Azure mode no longer requires or
  passes Supabase credentials, then deploy web and worker revisions that no
  longer reference `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`, remove the
  obsolete Container Apps secrets and verify they are absent;
- rotate the PostgREST service JWT and database bootstrap/runtime passwords;
- remove the migration-control job/identity and its three read roles only after
  the release workflow no longer recreates or invokes it; and
- turn off Key Vault template deployment only after no deployment uses an ARM
  Key Vault parameter reference.

```bash
az containerapp secret remove \
  --resource-group anbud-prod \
  --name anbud \
  --secret-names supabase-url supabase-service-role-key
az containerapp job secret remove \
  --resource-group anbud-prod \
  --name anbud-project-job-worker \
  --secret-names supabase-url supabase-service-role-key \
  --yes

az containerapp secret list --resource-group anbud-prod --name anbud --query "[?starts_with(name, 'supabase')].name" --output table
az containerapp job secret list --resource-group anbud-prod --name anbud-project-job-worker --query "[?starts_with(name, 'supabase')].name" --output table
```

To retire the migration-control identity, delete its exact scoped assignments
before deleting the identity so Azure does not leave unresolved principals:

```bash
CONTROL_PRINCIPAL_ID="$(az identity show --resource-group anbud-prod --name anbud-migration-control --query principalId --output tsv)"
KEY_VAULT_ID="$(az keyvault show --resource-group anbud-prod --name anbud-prod-kv-9841703 --query id --output tsv)"
STORAGE_ID="$(az storage account show --resource-group anbud-prod --name anbudprod9841703data --query id --output tsv)"
DOCUMENTS_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-documents"
EVIDENCE_SCOPE="$STORAGE_ID/blobServices/default/containers/anbud-migration-evidence"

test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$KEY_VAULT_ID" --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$DOCUMENTS_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Reader'] | length(@)" --output tsv)" = 1
test "$(az role assignment list --assignee-object-id "$CONTROL_PRINCIPAL_ID" --scope "$EVIDENCE_SCOPE" --query "[?roleDefinitionName=='Storage Blob Data Reader'] | length(@)" --output tsv)" = 1

az role assignment delete --assignee-object-id "$CONTROL_PRINCIPAL_ID" --role 'Key Vault Secrets User' --scope "$KEY_VAULT_ID"
az role assignment delete --assignee-object-id "$CONTROL_PRINCIPAL_ID" --role 'Storage Blob Data Reader' --scope "$DOCUMENTS_SCOPE"
az role assignment delete --assignee-object-id "$CONTROL_PRINCIPAL_ID" --role 'Storage Blob Data Reader' --scope "$EVIDENCE_SCOPE"
az containerapp job delete --resource-group anbud-prod --name anbud-migration-control --yes
az identity delete --resource-group anbud-prod --name anbud-migration-control

az keyvault update \
  --resource-group anbud-prod \
  --name anbud-prod-kv-9841703 \
  --enabled-for-template-deployment false \
  --output none
```

Finally, replace the temporary PostgREST bridge repository-by-repository with a
direct pooled PostgreSQL adapter. Only after the bridge is gone or PostgreSQL
has private connectivity may the remaining Container Apps outbound firewall
rule be removed and PostgreSQL public access disabled.
