targetScope = 'resourceGroup'

@description('Azure region for PostgreSQL. Keep it colocated with Container Apps.')
param location string = resourceGroup().location

@description('Globally unique PostgreSQL Flexible Server name.')
param serverName string

@description('Workload label used for resource tags.')
param workloadName string = 'anbud'

@description('Environment label used for resource tags.')
param environmentLabel string = 'prod'

@description('Criticality label used for resource tags.')
param workloadCriticality string = 'mission-critical'

@description('Bootstrap administrator. Runtime workloads must never use this role.')
param administratorLogin string

@secure()
@description('Bootstrap administrator password supplied from a protected secret store.')
param administratorLoginPassword string

@description('Exact IPv4 addresses allowed to administer the server. Never use 0.0.0.0/0 or Allow Azure services.')
@minLength(1)
param allowedIpv4Addresses array

@description('Lowest-cost initial SKU. Scale up if the representative load test misses its SLO.')
param skuName string = 'Standard_B1ms'

@description('SKU tier paired with skuName. Burstable is the cost-first default; use GeneralPurpose when scaling up.')
@allowed([
  'Burstable'
  'GeneralPurpose'
])
param skuTier string = 'Burstable'

@description('Provisioned storage cannot be scaled down, so preflight must prove 32 GiB is sufficient first.')
@allowed([
  32
  64
  128
])
param storageSizeGiB int = 32

@description('Point-in-time restore retention for the production PostgreSQL database.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

var tags = {
  workload: workloadName
  environment: environmentLabel
  criticality: workloadCriticality
  deploymentStamp: workloadName
  dataClassification: 'confidential'
  component: 'database'
  managedBy: 'bicep'
}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    createMode: 'Create'
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    storage: {
      autoGrow: 'Disabled'
      storageSizeGB: storageSizeGiB
    }
    version: '17'
  }
}

@batchSize(1)
resource firewallRules 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = [for address in allowedIpv4Addresses: {
  parent: server
  name: 'allow-${uniqueString(address)}'
  properties: {
    endIpAddress: address
    startIpAddress: address
  }
}]

resource allowedExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    source: 'user-override'
    value: 'pgcrypto,vector'
  }
  dependsOn: [
    firewallRules
  ]
}

resource idleTransactionTimeout 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'idle_in_transaction_session_timeout'
  properties: {
    source: 'user-override'
    value: '30000'
  }
  dependsOn: [
    allowedExtensions
  ]
}

output fqdn string = server.properties.fullyQualifiedDomainName
// ARM's database child resource creates a libc-locale database and cannot
// preserve the source's ICU provider/locale contract. The runbook therefore
// creates these two databases explicitly with PostgreSQL CREATE DATABASE after
// verifying the server's ICU version.
output validationDatabaseName string = 'anbud_validation'
output productionDatabaseName string = 'anbud'
