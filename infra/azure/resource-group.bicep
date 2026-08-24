targetScope = 'subscription'

@description('Production resource group name.')
param resourceGroupName string = 'anbud-prod'

@description('Azure region for the resource group.')
param location string = 'norwayeast'

@description('Workload label used for resource tags.')
param workloadName string = 'anbud'

@description('Environment label used for resource tags.')
param environmentLabel string = 'prod'

@description('Criticality label used for resource tags.')
param workloadCriticality string = 'mission-critical'

resource workloadResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    workload: workloadName
    environment: environmentLabel
    criticality: workloadCriticality
    deploymentStamp: workloadName
    dataClassification: 'confidential'
    component: 'resource-group'
    managedBy: 'bicep'
  }
}

output resourceGroupResourceId string = workloadResourceGroup.id
