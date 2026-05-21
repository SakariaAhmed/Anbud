targetScope = 'resourceGroup'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Container app name.')
param appName string = 'anbud'

@description('Container Apps managed environment name.')
param environmentName string = '${appName}-env'

@description('Log Analytics workspace name.')
param logAnalyticsWorkspaceName string = '${appName}-logs'

@description('Fully qualified container image, for example myregistry.azurecr.io/anbud:2026-05-21.')
param image string

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

@description('Minimum active replicas.')
@minValue(0)
param minReplicas int = 1

@description('Maximum active replicas.')
@minValue(1)
param maxReplicas int = 3

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
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
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
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
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 15
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
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

output fqdn string = app.properties.configuration.ingress.fqdn
