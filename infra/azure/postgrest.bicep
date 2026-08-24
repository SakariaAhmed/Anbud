targetScope = 'resourceGroup'

@description('Azure region for the internal PostgREST bridge.')
param location string = resourceGroup().location

@description('Existing Container Apps managed environment name.')
param environmentName string = 'anbud-env'

@description('Internal bridge name.')
param appName string = 'anbud-postgrest'

@description('Existing Azure Container Registry containing the pinned PostgREST image.')
param registryName string

@description('Existing pull-only identity with AcrPull on the registry.')
param acrPullIdentityName string = 'anbud-acr-pull'

@description('PostgREST image pinned by immutable digest; mutable tags are not accepted operationally.')
param image string

@secure()
@description('TLS-verified PostgreSQL URI for the NOINHERIT authenticator login.')
param databaseUri string

@secure()
@description('Independent high-entropy HMAC secret used only by PostgREST JWT validation.')
param jwtSecret string

@description('Keep one small pool and one replica on B1ms to preserve connection headroom.')
@minValue(1)
@maxValue(5)
param databasePoolSize int = 5

@description('Minimum active replicas. Zero minimizes idle cost but causes cold starts.')
@minValue(0)
@maxValue(1)
param minReplicas int = 0

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: acrPullIdentityName
}

resource bridge 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: {
    workload: 'anbud'
    environment: 'prod'
    component: 'data-api'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: false
        targetPort: 3000
        transport: 'http'
      }
      secrets: [
        {
          name: 'database-uri'
          value: databaseUri
        }
        {
          name: 'jwt-secret'
          value: jwtSecret
        }
      ]
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
          name: 'postgrest'
          image: image
          env: [
            {
              name: 'PGRST_DB_URI'
              secretRef: 'database-uri'
            }
            {
              name: 'PGRST_JWT_SECRET'
              secretRef: 'jwt-secret'
            }
            {
              name: 'PGRST_DB_SCHEMAS'
              value: 'public'
            }
            {
              name: 'PGRST_DB_POOL'
              value: string(databasePoolSize)
            }
            {
              name: 'PGRST_DB_MAX_ROWS'
              value: '1000'
            }
            {
              name: 'PGRST_DB_PLAN_ENABLED'
              value: 'false'
            }
            {
              name: 'PGRST_OPENAPI_MODE'
              value: 'disabled'
            }
            {
              name: 'PGRST_SERVER_PORT'
              value: '3000'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              tcpSocket: {
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 30
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

output internalFqdn string = bridge.properties.configuration.ingress.fqdn
output internalDataApiUrl string = 'https://${bridge.properties.configuration.ingress.fqdn}'
