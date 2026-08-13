# Azure phase 1 hosting

This deploys the existing Next.js container to Azure Container Apps while keeping Supabase as the live database and storage backend.

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
    image=<acr-name>.azurecr.io/anbud:phase1 \
    workerImage=<acr-name>.azurecr.io/anbud:phase1 \
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

The template creates a user-assigned identity with `AcrPull` and uses it for
both web and worker image pulls; no ACR username or password is stored. The
deployment principal must be allowed to create role assignments on the ACR.
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
