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
    registryServer=<acr-name>.azurecr.io \
    registryUsername=<acr-name> \
    registryPassword="$ACR_PASSWORD" \
    supabaseUrl="$SUPABASE_URL" \
    supabaseServiceRoleKey="$SUPABASE_SERVICE_ROLE_KEY" \
    appEncryptionKey="$APP_ENCRYPTION_KEY" \
    appAccessPassword="$APP_ACCESS_PASSWORD" \
    appSessionSecret="$APP_SESSION_SECRET" \
    openAiApiKey="$OPENAI_API_KEY" \
    openAiModel="${OPENAI_MODEL:-gpt-5.4}" \
    projectJobWorkerToken="$PROJECT_JOB_WORKER_TOKEN"
```

The deployment output includes the Container App FQDN and creates a scheduled Container Apps job named `<appName>-project-job-worker`. In GitHub Actions, configure `PROJECT_JOB_WORKER_TOKEN` as a repository secret before deploying.

Verify:

```bash
curl "https://<fqdn>/api/health/live"
curl "https://<fqdn>/api/health/ready"
node apps/frontend/scripts/smoke_health.mjs "https://<fqdn>"
az containerapp job show \
  --resource-group anbud-prod \
  --name anbud-project-job-worker \
  --query "properties.configuration.triggerType"
```

## Cutover checklist

- Confirm `/api/health/live` returns `status: healthy`.
- Confirm `/api/health/ready` and `/api/health` do not return `status: unhealthy`.
- Confirm the health response contains the expected `runtime.region`, `runtime.stamp`, and image-backed `runtime.version`.
- Log in with the existing app password.
- Open an existing project from Supabase.
- Upload and delete a test document.
- Run one short OpenAI-backed workflow.
- Confirm the scheduled project job worker exists and has recent executions.
- Only then move DNS from the current host to Azure.
