# Azure hosting

The production application runs in Azure Container Apps. Its data plane is an
internal PostgREST Container App backed by Azure Database for PostgreSQL, while
encrypted document objects are stored in private Azure Blob Storage.

## Build and verify the image

Production uses the `runner-docling` target so document parsing behavior is
included in the deployed image.

```bash
az login
az acr login --name <acr-name>
docker build --target runner-docling -f apps/frontend/Dockerfile -t <acr-name>.azurecr.io/anbud:<tag> .
docker push <acr-name>.azurecr.io/anbud:<tag>
```

Run the same image checks as CI:

```bash
npm --prefix apps/frontend run docker:smoke
npm --prefix apps/frontend run docker:smoke:docling
```

CI scans the production image before deployment. Base images are pinned by
digest and refreshed through Dependabot.

## Deploy Container Apps

Create parameter files outside git, or pass secure values from the CI/CD secret
store. The core data-plane parameters are required:

```bash
az deployment group create \
  --resource-group anbud-prod \
  --template-file infra/azure/container-app.bicep \
  --parameters \
    appName=anbud \
    image=<acr-name>.azurecr.io/anbud@sha256:<digest> \
    workerImage=<acr-name>.azurecr.io/anbud@sha256:<digest> \
    registryName=<acr-name> \
    dataApiUrl="$DATA_API_URL" \
    dataApiServiceRoleKey="$DATA_API_SERVICE_ROLE_KEY" \
    azureStorageAccountUrl="$AZURE_STORAGE_ACCOUNT_URL" \
    azureStorageContainer="${AZURE_STORAGE_CONTAINER:-anbud-documents}" \
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
    adminPrincipalId="$APP_ADMIN_PRINCIPAL_ID" \
    openAiApiKey="$OPENAI_API_KEY" \
    projectJobWorkerToken="$PROJECT_JOB_WORKER_TOKEN"
```

An Owner or User Access Administrator first deploys
`acr-pull-bootstrap.bicep`. It creates the ACR pull identity and scoped role.
Routine deployment then needs no registry password. Web and worker use managed
identity for Blob Storage.

The registry itself is declared in `registry.bicep`. Its public endpoint stays
enabled for GitHub-hosted builders, while anonymous access and the registry
administrator account stay disabled. Image pulls by Azure workloads use only
the scoped managed identity.

Azure Document Intelligence and Azure Communication Services Email are
optional. Leave their parameters empty to retain local parsing and out-of-band
guest-code delivery.

## Production rollout

Production releases are manual and use the protected GitHub `production`
environment. The workflow validates the PostgreSQL job schema and internal
PostgREST endpoint, builds and scans the image, reconciles Bicep, then creates a
candidate web revision. The candidate is smoke-tested before traffic moves, and
the scheduled worker is updated only after promotion. A failed rollout restores
the last healthy web revision and worker image.

Verify after deployment:

```bash
curl "https://<fqdn>/api/health/live"
node apps/frontend/scripts/smoke_health.mjs "https://<fqdn>"
az containerapp job show \
  --resource-group anbud-prod \
  --name anbud-project-job-worker \
  --query "properties.configuration.triggerType"
```

Also confirm administrator and Microsoft Entra login, open an existing project,
upload and delete a test document, run a short AI workflow, and inspect recent
worker executions.

## Data-plane templates

- `resource-group.bicep`: production resource-group location and ownership tags.
- `registry.bicep`: ACR configuration, immutable deployment target, and tags.
- `postgres.bicep`: PostgreSQL 17 with `pgcrypto` and `vector` support.
- `postgrest.bicep`: internal PostgREST data API.
- `storage.bicep`: private document storage and managed-identity roles.
- `budget.bicep`: subscription cost notifications.

Steady-state resources use the same `workload`, `environment`, `criticality`,
`deploymentStamp`, `component`, and `managedBy` tag vocabulary. Confidential
data resources additionally carry `dataClassification=confidential`. Migration
evidence may remain in its private Blob container as an audit record, but
migration jobs, identities, secrets, and lifecycle tags are not steady-state
infrastructure.

Run `az deployment group what-if` before provisioning data-plane resources.
Schema changes live in `database/migrations` and should be validated against a
disposable PostgreSQL database before production deployment.
