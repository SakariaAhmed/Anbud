targetScope = 'resourceGroup'

@description('Azure region for the migration storage account.')
param location string = resourceGroup().location

@description('Globally unique Storage account name.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Existing web Container App that receives container-scoped Blob access.')
param appName string = 'anbud'

@description('Existing scheduled worker that receives container-scoped Blob access.')
param workerName string = '${appName}-project-job-worker'

@description('Private container name. It must match existing database bucket values.')
@allowed([
  'anbud-documents'
])
param containerName string = 'anbud-documents'

@description('Separate private container for digest-pinned final cutover evidence. It must never share the application object inventory.')
@allowed([
  'anbud-migration-evidence'
])
param migrationEvidenceContainerName string = 'anbud-migration-evidence'

@description('Soft-delete retention for blobs and containers.')
@minValue(7)
@maxValue(30)
param softDeleteDays int = 14

var tags = {
  workload: appName
  environment: 'prod'
  dataClassification: 'confidential'
  migrationStage: 'precutover'
}

var blobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource web 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: appName
}

resource worker 'Microsoft.App/jobs@2024-03-01' existing = {
  name: workerName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    isHnsEnabled: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    // Same-region Storage firewall IP rules do not support Azure workload
    // traffic. The cost-first deployment therefore uses identity-only data
    // access on a public endpoint: shared keys and public blobs remain off.
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
    deleteRetentionPolicy: {
      allowPermanentDelete: false
      enabled: true
      days: softDeleteDays
    }
    isVersioningEnabled: false
  }
}

resource documentsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    defaultEncryptionScope: '$account-encryption-key'
    denyEncryptionScopeOverride: false
    publicAccess: 'None'
  }
}

resource migrationEvidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: migrationEvidenceContainerName
  properties: {
    defaultEncryptionScope: '$account-encryption-key'
    denyEncryptionScopeOverride: false
    publicAccess: 'None'
  }
}

resource webBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentsContainer.id, web.id, 'Storage Blob Data Contributor')
  scope: documentsContainer
  properties: {
    principalId: web.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleDefinitionId
  }
}

resource workerBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentsContainer.id, worker.id, 'Storage Blob Data Contributor')
  scope: documentsContainer
  properties: {
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleDefinitionId
  }
}

// Azure reports the primary endpoint with a trailing slash. Runtime and
// workflow host-binding checks use this canonical origin without one.
output accountUrl string = 'https://${storage.name}.blob.${environment().suffixes.storage}'
output privateContainer string = documentsContainer.name
output privateMigrationEvidenceContainer string = migrationEvidenceContainer.name
output sharedKeyAccessEnabled bool = storage.properties.allowSharedKeyAccess
