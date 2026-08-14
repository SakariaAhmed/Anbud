targetScope = 'resourceGroup'

@description('Azure region for the user-assigned image-pull identity.')
param location string = resourceGroup().location

@description('Existing Azure Container Registry name.')
param registryName string

@description('Container App workload name. The routine deployment references the resulting identity.')
param appName string = 'anbud'

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-acr-pull'
  location: location
  tags: {
    workload: appName
    environment: 'prod'
    purpose: 'acr-pull'
  }
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, acrPullIdentity.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: acrPullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output identityResourceId string = acrPullIdentity.id
output identityPrincipalId string = acrPullIdentity.properties.principalId
