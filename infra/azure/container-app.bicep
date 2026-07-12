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

@description('Container registry server, for example myregistry.azurecr.io.')
param registryServer string

@description('Container registry username.')
param registryUsername string

@secure()
@description('Container registry password.')
param registryPassword string

@secure()
@description('Current Supabase project URL. Kept for phase 1 Azure hosting migration.')
param supabaseUrl string

@secure()
@description('Current Supabase service role key. Kept server-side only.')
param supabaseServiceRoleKey string

@secure()
@description('Stable app encryption key. Do not rotate during migration unless document data is re-encrypted.')
param appEncryptionKey string

@secure()
@description('Shared password for the current app-level login.')
param appAccessPassword string

@secure()
@description('Stable session signing secret.')
param appSessionSecret string

@secure()
@description('OpenAI API key.')
param openAiApiKey string

@description('Optional OpenAI model override.')
param openAiModel string = 'gpt-5.4'

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
param minReplicas int = 1

@description('Maximum active replicas.')
@minValue(1)
param maxReplicas int = 3

var missionCriticalTags = {
  workload: appName
  environment: environmentLabel
  criticality: workloadCriticality
  deploymentStamp: appName
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
      secrets: [
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-role-key'
          value: supabaseServiceRoleKey
        }
        {
          name: 'app-encryption-key'
          value: appEncryptionKey
        }
        {
          name: 'app-access-password'
          value: appAccessPassword
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
        {
          name: 'registry-password'
          value: registryPassword
        }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          env: [
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
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
            {
              name: 'APP_ENCRYPTION_KEY'
              secretRef: 'app-encryption-key'
            }
            {
              name: 'APP_ACCESS_PASSWORD'
              secretRef: 'app-access-password'
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
          ]
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
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health/ready'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
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
      secrets: [
        {
          name: 'supabase-url'
          value: supabaseUrl
        }
        {
          name: 'supabase-service-role-key'
          value: supabaseServiceRoleKey
        }
        {
          name: 'app-encryption-key'
          value: appEncryptionKey
        }
        {
          name: 'app-access-password'
          value: appAccessPassword
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
        {
          name: 'registry-password'
          value: registryPassword
        }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'registry-password'
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
          env: [
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
              name: 'SUPABASE_URL'
              secretRef: 'supabase-url'
            }
            {
              name: 'SUPABASE_SERVICE_ROLE_KEY'
              secretRef: 'supabase-service-role-key'
            }
            {
              name: 'APP_ENCRYPTION_KEY'
              secretRef: 'app-encryption-key'
            }
            {
              name: 'APP_ACCESS_PASSWORD'
              secretRef: 'app-access-password'
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
          ]
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
