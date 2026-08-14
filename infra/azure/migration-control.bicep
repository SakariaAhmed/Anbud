targetScope = 'resourceGroup'

@description('Azure region for the manual migration control job.')
param location string = resourceGroup().location

@description('Existing Container Apps managed environment name. PostgREST must be internal to this environment.')
param environmentName string = 'anbud-env'

@description('Manual Container Apps Job name.')
param jobName string = 'anbud-migration-control'

@description('Separate manual job whose immutable template can only activate the already-validated Azure target.')
param activationJobName string = 'anbud-migration-activate'

@description('Separate manual job whose immutable template freezes Azure target claims before repeat deployment control.')
param deactivationJobName string = 'anbud-migration-deactivate'

@description('Azure Container Registry resource name.')
param registryName string

@description('Existing pull-only identity created by acr-pull-bootstrap.bicep.')
param acrPullIdentityName string = 'anbud-acr-pull'

@description('Dedicated identity for Key Vault, read-only Blob evidence, and internal PostgREST cutover controls.')
param controlIdentityName string = 'anbud-migration-control'

@description('Existing Key Vault containing the independent PostgREST service JWT.')
param keyVaultName string

@description('Key Vault secret name containing the independent PostgREST service JWT.')
param dataApiServiceRoleSecretName string = 'postgrest-service-role-key'

@description('Immutable Key Vault secret version used by both control and application deployment.')
@minLength(32)
@maxLength(32)
param dataApiServiceRoleSecretVersion string

@description('Existing Storage account containing the private migration target container.')
param storageAccountName string

@description('Private target container. The control identity receives read-only data-plane access.')
param storageContainerName string = 'anbud-documents'

@description('Separate private container holding the final cutover evidence envelope. It must not contaminate the exact target document inventory.')
param migrationEvidenceContainerName string = 'anbud-migration-evidence'

@description('Relative blob path of the final cutover evidence envelope.')
param migrationEvidenceBlobName string

@description('Expected SHA-256 of the final cutover evidence envelope.')
@minLength(64)
@maxLength(64)
param migrationEvidenceSha256 string

@description('Internal PostgREST root URL. The runtime rejects hosts outside the Container Apps internal suffix.')
param dataApiUrl string

@description('Azure Blob account URL accessed only with the dedicated managed identity.')
param azureStorageAccountUrl string

@description('Candidate app image pinned by immutable digest.')
param image string

@description('Read-only pre-cutover validation is explicit; routine/final deployments use verify.')
@allowed([
  'verify'
  'validate-target'
])
param controlMode string = 'verify'

@description('One-time privileged bootstrap for the narrow Key Vault and container-scoped Blob roles. Routine Contributor CI leaves this false.')
param bootstrapRoleAssignments bool = false

@description('Maximum execution time for each bounded control execution.')
@minValue(60)
@maxValue(900)
param replicaTimeout int = 300

var imageParts = split(image, '@sha256:')
// An invalid mutable image produces no executable job. The workflow also
// validates the exact sha256 grammar before deployment and before execution.
var imageDigestPinned = length(imageParts) == 2 && length(last(imageParts)) == 64

var tags = {
  workload: 'anbud'
  environment: 'prod'
  migrationStage: 'internal-precutover-control'
  costProfile: 'manual-no-idle-replicas'
}

var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var storageBlobDataReaderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
)

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: acrPullIdentityName
}

resource controlIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: controlIdentityName
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource storageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: storageContainerName
}

resource migrationEvidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: migrationEvidenceContainerName
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapRoleAssignments) {
  name: guid(keyVault.id, controlIdentity.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource storageBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapRoleAssignments) {
  name: guid(storageContainer.id, controlIdentity.id, 'Storage Blob Data Reader')
  scope: storageContainer
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataReaderRoleDefinitionId
  }
}

resource migrationEvidenceBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (bootstrapRoleAssignments) {
  name: guid(migrationEvidenceContainer.id, controlIdentity.id, 'Storage Blob Data Reader')
  scope: migrationEvidenceContainer
  properties: {
    principalId: controlIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataReaderRoleDefinitionId
  }
}

resource migrationControl 'Microsoft.App/jobs@2024-03-01' = if (imageDigestPinned) {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
      '${controlIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaRetryLimit: 0
      replicaTimeout: replicaTimeout
      secrets: [
        {
          name: 'data-api-service-role-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${dataApiServiceRoleSecretName}/${dataApiServiceRoleSecretVersion}'
          identity: controlIdentity.id
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
          name: 'migration-control'
          image: image
          command: [
            'node'
          ]
          args: [
            'scripts/run_azure_migration_control.mjs'
            controlMode
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
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
              name: 'DATA_API_SERVICE_ROLE_KEY'
              secretRef: 'data-api-service-role-key'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: azureStorageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: storageContainerName
            }
            {
              name: 'AZURE_MIGRATION_EVIDENCE_CONTAINER'
              value: migrationEvidenceContainerName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_BLOB'
              value: migrationEvidenceBlobName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_SHA256'
              value: migrationEvidenceSha256
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS'
              value: '7200'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: controlIdentity.properties.clientId
            }
            {
              name: 'MIGRATION_CONTROL_IMAGE'
              value: image
            }
            {
              name: 'MIGRATION_CONTROL_TIMEOUT_MS'
              value: '90000'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    keyVaultSecretsUser
    storageBlobReader
    migrationEvidenceBlobReader
  ]
}

// Do not pass container overrides to `az containerapp job start`: Azure treats
// an overridden container as a replacement and drops the template environment,
// including the Key Vault-backed service-role secret. A separate immutable
// manual job keeps activation fail-closed without exposing secrets to the CLI.
resource migrationActivation 'Microsoft.App/jobs@2024-03-01' = if (imageDigestPinned) {
  name: activationJobName
  location: location
  tags: union(tags, {
    migrationStage: 'internal-target-activation'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
      '${controlIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaRetryLimit: 0
      replicaTimeout: replicaTimeout
      secrets: [
        {
          name: 'data-api-service-role-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${dataApiServiceRoleSecretName}/${dataApiServiceRoleSecretVersion}'
          identity: controlIdentity.id
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
          name: 'migration-activation'
          image: image
          command: [
            'node'
          ]
          args: [
            'scripts/run_azure_migration_control.mjs'
            'activate-target'
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
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
              name: 'DATA_API_SERVICE_ROLE_KEY'
              secretRef: 'data-api-service-role-key'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: azureStorageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: storageContainerName
            }
            {
              name: 'AZURE_MIGRATION_EVIDENCE_CONTAINER'
              value: migrationEvidenceContainerName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_BLOB'
              value: migrationEvidenceBlobName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_SHA256'
              value: migrationEvidenceSha256
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS'
              value: '7200'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: controlIdentity.properties.clientId
            }
            {
              name: 'MIGRATION_CONTROL_IMAGE'
              value: image
            }
            {
              name: 'MIGRATION_CONTROL_TIMEOUT_MS'
              value: '90000'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    keyVaultSecretsUser
    storageBlobReader
    migrationEvidenceBlobReader
  ]
}

// Repeat deployments begin with an already-active Azure target. Keep the
// service-role secret inside the private Container Apps environment and use a
// separate immutable job to close claims and requeue any interrupted work
// before the read-only migration control runs.
resource migrationDeactivation 'Microsoft.App/jobs@2024-03-01' = if (imageDigestPinned) {
  name: deactivationJobName
  location: location
  tags: union(tags, {
    migrationStage: 'internal-target-deactivation'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${acrPullIdentity.id}': {}
      '${controlIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaRetryLimit: 0
      replicaTimeout: replicaTimeout
      secrets: [
        {
          name: 'data-api-service-role-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${dataApiServiceRoleSecretName}/${dataApiServiceRoleSecretVersion}'
          identity: controlIdentity.id
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
          name: 'migration-deactivation'
          image: image
          command: [
            'node'
          ]
          args: [
            'scripts/run_azure_migration_control.mjs'
            'deactivate-target'
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
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
              name: 'DATA_API_SERVICE_ROLE_KEY'
              secretRef: 'data-api-service-role-key'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: azureStorageAccountUrl
            }
            {
              name: 'AZURE_STORAGE_CONTAINER'
              value: storageContainerName
            }
            {
              name: 'AZURE_MIGRATION_EVIDENCE_CONTAINER'
              value: migrationEvidenceContainerName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_BLOB'
              value: migrationEvidenceBlobName
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_SHA256'
              value: migrationEvidenceSha256
            }
            {
              name: 'MIGRATION_CONTROL_EVIDENCE_MAX_AGE_SECONDS'
              value: '7200'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: controlIdentity.properties.clientId
            }
            {
              name: 'MIGRATION_CONTROL_IMAGE'
              value: image
            }
            {
              name: 'MIGRATION_CONTROL_TIMEOUT_MS'
              value: '90000'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    keyVaultSecretsUser
    storageBlobReader
    migrationEvidenceBlobReader
  ]
}

output migrationControlJobName string = migrationControl.name
output migrationActivationJobName string = migrationActivation.name
output migrationDeactivationJobName string = migrationDeactivation.name
output dedicatedControlIdentityResourceId string = controlIdentity.id
output idleReplicaCount int = 0
