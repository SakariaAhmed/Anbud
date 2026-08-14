targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Container app name.')
param appName string = 'anbud'

@description('Container Apps managed environment name.')
param environmentName string = '${appName}-env'

@description('Environment label used for tags and application health metadata.')
param environmentLabel string = 'prod'

@description('Log Analytics workspace name.')
param logAnalyticsWorkspaceName string = '${appName}-logs'

@description('Criticality label used for Azure resource tags.')
param workloadCriticality string = 'mission-critical'

@description('Fully qualified container image, for example myregistry.azurecr.io/anbud:2026-05-21.')
param image string

@description('Worker image kept on the last healthy release until web promotion succeeds.')
param workerImage string

@description('Azure Container Registry resource name in this resource group.')
param registryName string

@secure()
@description('Current Supabase project URL. Kept for phase 1 Azure hosting migration.')
param supabaseUrl string = ''

@secure()
@description('Current Supabase service role key. Kept server-side only.')
param supabaseServiceRoleKey string = ''

@description('Optional full PostgREST root URL for the Azure data API. Leave empty until cutover.')
param dataApiUrl string = ''

@secure()
@description('Optional service JWT for the internal Azure PostgREST API. Never reuse the Supabase key.')
param dataApiServiceRoleKey string = ''

@description('File storage implementation. Keep supabase until the verified blob cutover.')
@allowed([
  'supabase'
  'azure'
])
param fileStorageBackend string = 'supabase'

@description('Azure Blob service URL used with managed identity after storage cutover.')
param azureStorageAccountUrl string = ''

@description('Private Azure Blob container that preserves the existing bucket contract.')
param azureStorageContainer string = 'anbud-documents'

@description('Public origin used for OAuth callbacks, for example https://bidsite.example.com.')
param appPublicOrigin string

@description('Application client ID for the Microsoft Entra External ID app registration.')
param microsoftEntraClientId string

@secure()
@description('Client secret for the Microsoft Entra External ID app registration.')
param microsoftEntraClientSecret string

@description('External ID tenant subdomain, without .ciamlogin.com.')
param microsoftEntraTenantSubdomain string

@secure()
@description('Stable app encryption key. Do not rotate during migration unless document data is re-encrypted.')
param appEncryptionKey string

@secure()
@description('Encoded scrypt hash for the dedicated administrator password.')
param appAdminAccessPasswordHash string

@secure()
@description('Stable session signing secret.')
param appSessionSecret string

@secure()
@description('Dedicated HMAC pepper for guest access codes. Generate independently from the session secret.')
param appGuestCodePepper string = ''

@secure()
@description('Dedicated HMAC secret used for deterministic email identity lookup.')
param appIdentityLookupSecret string = ''

@secure()
@description('Dedicated HMAC secret used for privacy-preserving request context logging.')
param appActivityHashSecret string = ''

@description('Comma-separated internal emails bootstrapped with the administrator role.')
param appAdminEmails string = ''

@description('Optional Azure Communication Services endpoint used with the Container App managed identity.')
param azureCommunicationEmailEndpoint string = ''

@description('Verified MailFrom sender address in Azure Communication Services Email.')
param azureCommunicationEmailSender string = ''

@description('Stable pseudonymous ID for the dedicated administrator identity.')
param adminPrincipalId string

@description('Display name for the dedicated administrator identity.')
param adminDisplayName string = 'Administrator'

@secure()
@description('OpenAI API key.')
param openAiApiKey string

@description('Optional OpenAI model override.')
param openAiModel string = 'gpt-5.4'

@description('OpenAI model used only by the v3 customer-document analysis path.')
param openAiDocumentAnalysisModel string = 'gpt-5.6-terra'

@description('Selects the versioned document parsing and analysis pipeline.')
@allowed([
  'off'
  'v3'
])
param documentAnalysisVersion string = 'off'

@description('Optional Azure AI Document Intelligence endpoint. Leave empty to use the local layout parser with Docling fallback.')
param azureDocumentIntelligenceEndpoint string = ''

@secure()
@description('Optional Azure AI Document Intelligence API key.')
param azureDocumentIntelligenceKey string = ''

@description('Azure OCR high-resolution feature. auto enables it only for PDFs with weak OCR; on forces it and off disables it.')
@allowed([
  'auto'
  'on'
  'off'
])
param azureDocumentIntelligenceHighResolution string = 'auto'

@secure()
@description('Shared token required by the project job worker endpoint.')
param projectJobWorkerToken string

@description('Docling enhancement mode. async keeps uploads RAG-ready quickly and queues enhancement.')
@allowed([
  'async'
  'inline'
  'off'
])
param doclingEnhancementMode string = 'async'

@description('Whether app processes should immediately run queued async Docling jobs. Keep off when a scheduled worker job is deployed.')
@allowed([
  'on'
  'off'
])
param doclingAsyncAutoRun string = 'off'

@description('Cron schedule for the same-image project job worker. Evaluated in UTC.')
param projectJobWorkerCron string = '*/5 * * * *'

@description('Maximum project jobs processed by one scheduled worker execution.')
@minValue(1)
@maxValue(1)
param projectJobWorkerLimit int = 1

@description('CPU cores for the web container.')
param webCpu string = '1.0'

@description('Memory for the web container.')
param webMemory string = '2Gi'

@description('CPU cores for the scheduled project job worker. Docling benefits from more CPU than the web path.')
param projectJobWorkerCpu string = '2.0'

@description('Memory for the scheduled project job worker.')
param projectJobWorkerMemory string = '4Gi'

@description('Maximum seconds a scheduled worker replica can run. Covers one 30-minute job plus five minutes of startup and shutdown allowance.')
@minValue(2100)
param projectJobWorkerReplicaTimeout int = 2100

@description('Minimum active replicas.')
@minValue(0)
param minReplicas int = 0

@description('Maximum active replicas.')
@minValue(1)
param maxReplicas int = 3

var missionCriticalTags = {
  workload: appName
  environment: environmentLabel
  criticality: workloadCriticality
  deploymentStamp: appName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

// Created once by acr-pull-bootstrap.bicep under Owner/User Access
// Administrator. Routine CI only needs Contributor and must not manage RBAC.
resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${appName}-acr-pull'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: missionCriticalTags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: missionCriticalTags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: missionCriticalTags
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat([
        {
          name: 'microsoft-entra-client-secret'
          value: microsoftEntraClientSecret
        }
        {
          name: 'app-encryption-key'
          value: appEncryptionKey
        }
        {
          name: 'app-admin-access-password-hash'
          value: appAdminAccessPasswordHash
        }
        {
          name: 'app-session-secret'
          value: appSessionSecret
        }
        {
          name: 'openai-api-key'
          value: openAiApiKey
        }
        {
          name: 'project-job-worker-token'
          value: projectJobWorkerToken
        }
      ], !empty(supabaseUrl) && !empty(supabaseServiceRoleKey) ? [
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-role-key'
          value: supabaseServiceRoleKey
        }
      ] : [], !empty(azureDocumentIntelligenceKey) ? [
        {
          name: 'azure-document-intelligence-key'
          value: azureDocumentIntelligenceKey
        }
      ] : [], !empty(appGuestCodePepper) ? [
        {
          name: 'app-guest-code-pepper'
          value: appGuestCodePepper
        }
      ] : [], !empty(appIdentityLookupSecret) ? [
        {
          name: 'app-identity-lookup-secret'
          value: appIdentityLookupSecret
        }
      ] : [], !empty(appActivityHashSecret) ? [
        {
          name: 'app-activity-hash-secret'
          value: appActivityHashSecret
        }
      ] : [], !empty(dataApiServiceRoleKey) ? [
        {
          name: 'data-api-service-role-key'
          value: dataApiServiceRoleKey
        }
      ] : [])
      registries: [
        {
          server: registry.properties.loginServer
          identity: acrPullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          env: concat([
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'HOSTNAME'
              value: '0.0.0.0'
            }
            {
              name: 'APP_ENVIRONMENT'
              value: environmentLabel
            }
            {
              name: 'APP_REGION'
              value: location
            }
            {
              name: 'APP_STAMP'
              value: appName
            }
            {
              name: 'APP_VERSION'
              value: image
            }
            {
              name: 'TRUST_FORWARDED_RATE_LIMIT_HEADERS'
              value: 'true'
            }
            {
              name: 'DATA_API_URL'
              value: dataApiUrl
            }
            {
              name: 'DATA_API_ALLOWED_HOST_SUFFIX'
              value: '.internal.${environment.properties.defaultDomain}'
            }
            {
              name: 'FILE_STORAGE_BACKEND'
              value: fileStorageBackend
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: azureStorageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: azureStorageContainer
            }
            {
              name: 'APP_PUBLIC_ORIGIN'
              value: appPublicOrigin
            }
            {
              name: 'MICROSOFT_ENTRA_CLIENT_ID'
              value: microsoftEntraClientId
            }
            {
              name: 'MICROSOFT_ENTRA_CLIENT_SECRET'
              secretRef: 'microsoft-entra-client-secret'
            }
            {
              name: 'MICROSOFT_ENTRA_TENANT_SUBDOMAIN'
              value: microsoftEntraTenantSubdomain
            }
            {
              name: 'APP_ENCRYPTION_KEY'
              secretRef: 'app-encryption-key'
            }
            {
              name: 'APP_ADMIN_ACCESS_PASSWORD_HASH'
              secretRef: 'app-admin-access-password-hash'
            }
            {
              name: 'APP_SESSION_SECRET'
              secretRef: 'app-session-secret'
            }
            {
              name: 'APP_ADMIN_PRINCIPAL_ID'
              value: adminPrincipalId
            }
            {
              name: 'APP_ADMIN_DISPLAY_NAME'
              value: adminDisplayName
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'OPENAI_MODEL'
              value: openAiModel
            }
            {
              name: 'OPENAI_DOCUMENT_ANALYSIS_MODEL'
              value: openAiDocumentAnalysisModel
            }
            {
              name: 'PROJECT_JOB_WORKER_TOKEN'
              secretRef: 'project-job-worker-token'
            }
            {
              name: 'DOCLING_ENHANCEMENT_MODE'
              value: doclingEnhancementMode
            }
            {
              name: 'DOCLING_ASYNC_AUTO_RUN'
              value: doclingAsyncAutoRun
            }
            {
              name: 'DOCUMENT_ANALYSIS_VERSION'
              value: documentAnalysisVersion
            }
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_HIGH_RESOLUTION'
              value: azureDocumentIntelligenceHighResolution
            }
          ], !empty(supabaseUrl) && !empty(supabaseServiceRoleKey) ? [
            {
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
          ] : [], !empty(azureDocumentIntelligenceEndpoint) && !empty(azureDocumentIntelligenceKey) ? [
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'
              value: azureDocumentIntelligenceEndpoint
            }
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_KEY'
              secretRef: 'azure-document-intelligence-key'
            }
          ] : [], !empty(appGuestCodePepper) ? [
            {
              name: 'APP_GUEST_CODE_PEPPER'
              secretRef: 'app-guest-code-pepper'
            }
          ] : [], !empty(appIdentityLookupSecret) ? [
            {
              name: 'APP_IDENTITY_LOOKUP_SECRET'
              secretRef: 'app-identity-lookup-secret'
            }
          ] : [], !empty(appActivityHashSecret) ? [
            {
              name: 'APP_ACTIVITY_HASH_SECRET'
              secretRef: 'app-activity-hash-secret'
            }
          ] : [], !empty(dataApiServiceRoleKey) ? [
            {
              name: 'DATA_API_SERVICE_ROLE_KEY'
              secretRef: 'data-api-service-role-key'
            }
          ] : [], !empty(appAdminEmails) ? [
            {
              name: 'APP_ADMIN_EMAILS'
              value: appAdminEmails
            }
          ] : [], !empty(azureCommunicationEmailEndpoint) && !empty(azureCommunicationEmailSender) ? [
            {
              name: 'AZURE_COMMUNICATION_EMAIL_ENDPOINT'
              value: azureCommunicationEmailEndpoint
            }
            {
              name: 'AZURE_COMMUNICATION_EMAIL_SENDER'
              value: azureCommunicationEmailSender
            }
          ] : [])
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health/live'
                port: 3000
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json(webCpu)
            memory: webMemory
          }
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

resource projectJobWorker 'Microsoft.App/jobs@2024-03-01' = {
  name: '${appName}-project-job-worker'
  location: location
  tags: missionCriticalTags
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: projectJobWorkerCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaRetryLimit: 1
      replicaTimeout: projectJobWorkerReplicaTimeout
      secrets: concat([
        {
          name: 'app-encryption-key'
          value: appEncryptionKey
        }
        {
          name: 'app-session-secret'
          value: appSessionSecret
        }
        {
          name: 'openai-api-key'
          value: openAiApiKey
        }
        {
          name: 'project-job-worker-token'
          value: projectJobWorkerToken
        }
      ], !empty(supabaseUrl) && !empty(supabaseServiceRoleKey) ? [
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-role-key'
          value: supabaseServiceRoleKey
        }
      ] : [], !empty(azureDocumentIntelligenceKey) ? [
        {
          name: 'azure-document-intelligence-key'
          value: azureDocumentIntelligenceKey
        }
      ] : [], !empty(dataApiServiceRoleKey) ? [
        {
          name: 'data-api-service-role-key'
          value: dataApiServiceRoleKey
        }
      ] : [])
      registries: [
        {
          server: registry.properties.loginServer
          identity: acrPullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          command: [
            'node'
          ]
          args: [
            'scripts/run_project_job_worker.mjs'
          ]
          env: concat([
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'HOSTNAME'
              value: '0.0.0.0'
            }
            {
              name: 'APP_ENVIRONMENT'
              value: environmentLabel
            }
            {
              name: 'APP_REGION'
              value: location
            }
            {
              name: 'APP_STAMP'
              value: '${appName}-project-job-worker'
            }
            {
              name: 'APP_VERSION'
              value: workerImage
            }
            {
              name: 'DATA_API_URL'
              value: dataApiUrl
            }
            {
              name: 'DATA_API_ALLOWED_HOST_SUFFIX'
              value: '.internal.${environment.properties.defaultDomain}'
            }
            {
              name: 'FILE_STORAGE_BACKEND'
              value: fileStorageBackend
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: azureStorageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: azureStorageContainer
            }
            {
              name: 'APP_ENCRYPTION_KEY'
              secretRef: 'app-encryption-key'
            }
            {
              name: 'APP_SESSION_SECRET'
              secretRef: 'app-session-secret'
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
            {
              name: 'OPENAI_MODEL'
              value: openAiModel
            }
            {
              name: 'OPENAI_DOCUMENT_ANALYSIS_MODEL'
              value: openAiDocumentAnalysisModel
            }
            {
              name: 'PROJECT_JOB_WORKER_TOKEN'
              secretRef: 'project-job-worker-token'
            }
            {
              name: 'PROJECT_JOB_WORKER_LIMIT'
              value: string(projectJobWorkerLimit)
            }
            {
              name: 'DOCLING_ENHANCEMENT_MODE'
              value: doclingEnhancementMode
            }
            {
              name: 'DOCLING_ASYNC_AUTO_RUN'
              value: 'off'
            }
            {
              name: 'DOCUMENT_ANALYSIS_VERSION'
              value: documentAnalysisVersion
            }
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_HIGH_RESOLUTION'
              value: azureDocumentIntelligenceHighResolution
            }
          ], !empty(supabaseUrl) && !empty(supabaseServiceRoleKey) ? [
            {
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
          ] : [], !empty(azureDocumentIntelligenceEndpoint) && !empty(azureDocumentIntelligenceKey) ? [
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'
              value: azureDocumentIntelligenceEndpoint
            }
            {
              name: 'AZURE_DOCUMENT_INTELLIGENCE_KEY'
              secretRef: 'azure-document-intelligence-key'
            }
          ] : [], !empty(dataApiServiceRoleKey) ? [
            {
              name: 'DATA_API_SERVICE_ROLE_KEY'
              secretRef: 'data-api-service-role-key'
            }
          ] : [])
          resources: {
            cpu: json(projectJobWorkerCpu)
            memory: projectJobWorkerMemory
          }
        }
      ]
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
