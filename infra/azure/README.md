# Azure phase 1 hosting

This deploys the existing Next.js container to Azure Container Apps. Supabase
remains the live database and storage backend until the separately gated data
cutover in [the migration runbook](../../docs/azure-migration.md).

The web app defaults to `minReplicas=0` to minimize idle cost. Expect a cold
first request, especially with the large Docling image. This is not a maintenance
or write-freeze mechanism.

## Build and push an image

```bash
az login
az group create --name anbud-prod --location norwayeast
az acr create --resource-group anbud-prod --name <acr-name> --sku Basic
az acr login --name <acr-name>

docker build --target runner-docling -f apps/frontend/Dockerfile -t <acr-name>.azurecr.io/anbud:phase1 .
docker push <acr-name>.azurecr.io/anbud:phase1
```

Production builds use the `runner-docling` target so bundled Docling ingestion
keeps the same document parsing behavior as the app had before the image split.
The default target is a slim web runtime with `DOCLING_INGESTION=off`; use it
only for deployments where Docling is run out-of-process or fallback parsing is
acceptable:

```bash
docker build -f apps/frontend/Dockerfile -t <acr-name>.azurecr.io/anbud:phase1-slim .
docker push <acr-name>.azurecr.io/anbud:phase1-slim
```

## Local Docker verification

Run the same lightweight image build, size budget, container healthcheck, and
liveness smoke that CI runs:

```bash
npm --prefix apps/frontend run docker:smoke
```

Run the heavier production Docling target when changing parsing/runtime
dependencies. This is also the target used by the Azure deployment workflow:

```bash
npm --prefix apps/frontend run docker:smoke:docling
```

Production CI also scans the `runner-docling` image for critical and high CVEs
with Docker Scout before deployment. Base images are pinned by digest in the
Dockerfile and refreshed through Dependabot Docker updates.

## Deploy Container Apps

Create a local parameters file outside git, for example `infra/azure/prod.bicepparam`, or pass the secure values from your CI/CD secret store.

```bash
az deployment group create \
  --resource-group anbud-prod \
  --template-file infra/azure/container-app.bicep \
  --parameters \
    appName=anbud \
    image=<acr-name>.azurecr.io/anbud@sha256:<digest> \
    workerImage=<acr-name>.azurecr.io/anbud@sha256:<digest> \
    registryName=<acr-name> \
    supabaseUrl="$SUPABASE_URL" \
    supabaseServiceRoleKey="$SUPABASE_SERVICE_ROLE_KEY" \
    appPublicOrigin="$APP_PUBLIC_ORIGIN" \
    microsoftEntraClientId="$MICROSOFT_ENTRA_CLIENT_ID" \
    microsoftEntraClientSecret="$MICROSOFT_ENTRA_CLIENT_SECRET" \
    microsoftEntraTenantSubdomain="$MICROSOFT_ENTRA_TENANT_SUBDOMAIN" \
    appEncryptionKey="$APP_ENCRYPTION_KEY" \
    appAdminAccessPasswordHash="$APP_ADMIN_ACCESS_PASSWORD_HASH" \
    appSessionSecret="$APP_SESSION_SECRET" \
    appGuestCodePepper="$APP_GUEST_CODE_PEPPER" \
    appIdentityLookupSecret="$APP_IDENTITY_LOOKUP_SECRET" \
    appActivityHashSecret="$APP_ACTIVITY_HASH_SECRET" \
    appAdminEmails="$APP_ADMIN_EMAILS" \
    azureCommunicationEmailEndpoint="$AZURE_COMMUNICATION_EMAIL_ENDPOINT" \
    azureCommunicationEmailSender="$AZURE_COMMUNICATION_EMAIL_SENDER" \
    adminPrincipalId="$APP_ADMIN_PRINCIPAL_ID" \
    adminDisplayName="${APP_ADMIN_DISPLAY_NAME:-Administrator}" \
    openAiApiKey="$OPENAI_API_KEY" \
    openAiModel="${OPENAI_MODEL:-gpt-5.4}" \
    openAiDocumentAnalysisModel="${OPENAI_DOCUMENT_ANALYSIS_MODEL:-gpt-5.6-terra}" \
    documentAnalysisVersion="${DOCUMENT_ANALYSIS_VERSION:-off}" \
    azureDocumentIntelligenceHighResolution=auto \
    azureDocumentIntelligenceEndpoint="$AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT" \
    azureDocumentIntelligenceKey="$AZURE_DOCUMENT_INTELLIGENCE_KEY" \
    projectJobWorkerToken="$PROJECT_JOB_WORKER_TOKEN"
```

An Owner/User Access Administrator first deploys `acr-pull-bootstrap.bicep`.
That one-time template creates a user-assigned identity and its ACR-scoped
`AcrPull` role. The routine `container-app.bicep` deployment only references
the existing identity, so CI keeps Contributor and stores no ACR password.
It also enables a system-assigned managed identity on the web Container App.
To send guest invitations, assign that identity email-send access on the
Azure Communication Services resource after the first deployment. The exact
steps and the least-privilege/connection-string alternatives are documented in
[Guest access, RBAC and insights](../../docs/guest-access-rbac-and-insights.md).

Azure Document Intelligence is optional. When endpoint/key are omitted, the
quality router keeps the fast local layout parser and can use the existing local
Docling fallback. Add the two values as protected production secrets/variables
before enabling the managed last-resort path. `auto` enables high-resolution OCR
only when the local quality score indicates weak OCR; use `off` to disable that
paid Azure feature entirely.

`DOCUMENT_ANALYSIS_VERSION` defaults to `off` so a deploy preserves the legacy
PDF and Docling paths until canary activation. Set it to `v3` together with
`OPENAI_DOCUMENT_ANALYSIS_MODEL=gpt-5.6-terra` for the versioned pipeline. Keep
`APP_ADMIN_PRINCIPAL_ID` stable across password and session-secret rotations;
it is a pseudonymous identifier, not a secret.

The deployment output includes the Container App FQDN and creates a scheduled Container Apps job named `<appName>-project-job-worker`. In GitHub Actions, configure `PROJECT_JOB_WORKER_TOKEN`, `MICROSOFT_ENTRA_CLIENT_SECRET`, `APP_ADMIN_ACCESS_PASSWORD_HASH`, and optionally `AZURE_DOCUMENT_INTELLIGENCE_KEY` as production secrets. Configure `APP_PUBLIC_ORIGIN`, `MICROSOFT_ENTRA_CLIENT_ID`, `MICROSOFT_ENTRA_TENANT_SUBDOMAIN`, `APP_ADMIN_PRINCIPAL_ID`, and optionally `APP_ADMIN_DISPLAY_NAME`, `DOCUMENT_ANALYSIS_VERSION`, `OPENAI_DOCUMENT_ANALYSIS_MODEL`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, and `AZURE_DOCUMENT_INTELLIGENCE_HIGH_RESOLUTION` as production variables. See [Microsoft Entra External ID login](../../docs/microsoft-entra-login.md) for the app registration and callback setup.

## Controlled production rollout

Production releases are manual and use the protected GitHub `production`
environment. The workflow first verifies the durable Supabase job schema, then
reconciles Bicep while keeping both workloads on their current healthy images.
`scripts/azure_containerapp_rollout.mjs` pins the last healthy revision at
100% traffic, creates a uniquely suffixed candidate, and smokes the candidate's
revision-specific FQDN before promotion. The scheduled worker is updated only
after web promotion. A failed candidate smoke keeps production traffic
unchanged; a failed post-promotion smoke restores both traffic and the previous
worker image. The workflow retains an idempotent fallback rollback step using a
secret-free state file.

Verify:

```bash
curl "https://<fqdn>/api/health/live"
node apps/frontend/scripts/smoke_health.mjs "https://<fqdn>"
az containerapp job show \
  --resource-group anbud-prod \
  --name anbud-project-job-worker \
  --query "properties.configuration.triggerType"
```

## Cutover checklist

- Confirm `/api/health/live` returns `status: healthy`.
- With an authenticated administrator session, confirm `/api/health/ready` and `/api/health` do not return `status: unhealthy` (anonymous requests should return `401`).
- Confirm the health response contains the expected `runtime.region`, `runtime.stamp`, and image-backed `runtime.version`.
- Log in with Microsoft Entra ID and confirm the callback returns to the app.
- Confirm the dedicated administrator password still works as the fallback login.
- Open an existing project from Supabase.
- Upload and delete a test document.
- Run one short OpenAI-backed workflow.
- Confirm the scheduled project job worker exists and has recent executions.
- Only then move DNS from the current host to Azure.

## Data-plane templates

These templates are intentionally separate so an ordinary app deployment cannot
create paid data resources or trigger a cutover:

- `postgres.bicep`: PostgreSQL 17, B1ms/32 GiB by default, no HA, exact IP
  firewall rules, 7-day PITR and allowlisted `pgcrypto`/`vector`. ICU production
  and validation databases are created explicitly by the migration runbook.
- `storage.bicep`: separate private document and migration-evidence containers,
  Shared Key/public access disabled, identity-only access on a public
  same-region endpoint, 14-day soft delete and document-container-scoped runtime
  roles. Its `accountUrl` output is canonicalized without a trailing slash.
- `postgrest.bicep`: temporary internal compatibility bridge, pool size 5,
  `maxReplicas=1` and scale-to-zero by default.
- `budget.bicep`: 50/80/100% actual and 100% forecast notifications in the
  subscription billing currency. A budget
  warns but never stops or deletes resources.

Never deploy these from an unreviewed parameter file. Store parameter files
outside git, run `az deployment group what-if` first, and follow the stop gates
in the migration runbook. `storage.bicep` creates role assignments, so its
one-time bootstrap requires Owner, or Contributor plus User Access
Administrator; routine CI should retain Contributor only.

## Migration-control bootstrap and retirement

Before the production write freeze, follow the exact
[one-time migration-control bootstrap](../../docs/azure-migration.md#one-time-migration-control-bootstrap--hard-gate-before-freeze).
It creates or reconciles an RBAC/purge-protected Key Vault with the current
ARM secret-reference flag enabled, verifies the distinct private evidence
container created by `storage.bicep`, and deploys
`migration-control.bicep` once with `bootstrapRoleAssignments=true`. That
privileged deployment grants only:

- `Key Vault Secrets User` on the migration Key Vault;
- `Storage Blob Data Reader` on `anbud-documents`; and
- `Storage Blob Data Reader` on `anbud-migration-evidence`.

The initial job configuration uses an intentionally absent bootstrap evidence
path and all-zero digest, so it must never be started. The final protected
workflow replaces those inputs with fresh digest-pinned evidence and always
uses `bootstrapRoleAssignments=false`.

After Azure acceptance, return PostgREST to `minReplicas=0`, remove only the
migration-host PostgreSQL firewall rule, and revoke temporary human Blob/Key
Vault roles after their last required operation. Keep the Container Apps
outbound rule, web/worker Blob roles and ACR pull identity while production
still needs them.

Supabase URL/service-role credentials are allowed only during the explicit
14-day rollback window. After restore tests and formal rollback closure, first
change Azure-mode deployment so it no longer requires or passes the Supabase
pair, deploy revisions with no Supabase references, remove the Container Apps
secrets, then revoke the upstream Supabase credentials. Do not delete secrets
that a live revision still references. The full ordered commands,
migration-control role cleanup and Key Vault flag rollback are in
[Rollback and cleanup](../../docs/azure-migration.md#rollback-and-cleanup).
