targetScope = 'resourceGroup'

@description('Azure region for the container registry.')
param location string = resourceGroup().location

@description('Globally unique Azure Container Registry name.')
@minLength(5)
@maxLength(50)
param registryName string

@description('Workload label used for resource tags.')
param workloadName string = 'anbud'

@description('Environment label used for resource tags.')
param environmentLabel string = 'prod'

@description('Criticality label used for resource tags.')
param workloadCriticality string = 'mission-critical'

@description('Registry SKU. Basic is sufficient for the current single-region workload.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string = 'Basic'

var tags = {
  workload: workloadName
  environment: environmentLabel
  criticality: workloadCriticality
  deploymentStamp: workloadName
  dataClassification: 'internal'
  component: 'container-registry'
  managedBy: 'bicep'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output loginServer string = registry.properties.loginServer
output registryResourceId string = registry.id
