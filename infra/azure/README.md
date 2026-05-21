# Azure phase 1 hosting

This deploys the existing Next.js container to Azure Container Apps while keeping Supabase as the live database and storage backend.

## Build and push an image

```bash
az login
az group create --name anbud-prod --location norwayeast
az acr create --resource-group anbud-prod --name <acr-name> --sku Basic
az acr login --name <acr-name>

docker build -f apps/frontend/Dockerfile -t <acr-name>.azurecr.io/anbud:phase1 .
docker push <acr-name>.azurecr.io/anbud:phase1
```

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
    openAiModel="${OPENAI_MODEL:-gpt-5.4}"
```

The deployment output includes the Container App FQDN. Verify:

```bash
curl "https://<fqdn>/api/health"
```

## Cutover checklist

- Confirm `/api/health` returns `status: ok`.
- Log in with the existing app password.
- Open an existing project from Supabase.
- Upload and delete a test document.
- Run one short OpenAI-backed workflow.
- Only then move DNS from Netlify to Azure.
