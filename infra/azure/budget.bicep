targetScope = 'resourceGroup'

@description('Monthly cost-notification threshold in the subscription billing currency. Budgets notify; they do not stop resources.')
@minValue(1)
param monthlyAmount int

@description('Verified operations recipients for budget notifications.')
param contactEmails array = []

@description('Azure RBAC roles notified at this scope. Owner provides a verified fallback when no email is stored on the Entra user.')
@minLength(1)
param contactRoles array = [
  'Owner'
]

@description('Budget start on the first day of a month.')
param startDate string = utcNow('yyyy-MM-01')

@description('Budget end date.')
param endDate string = '2036-01-01'

resource migrationBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'anbud-monthly-cost'
  properties: {
    amount: monthlyAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: endDate
    }
    notifications: {
      actual50: {
        contactEmails: contactEmails
        contactRoles: contactRoles
        enabled: true
        locale: 'en-us'
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
      }
      actual80: {
        contactEmails: contactEmails
        contactRoles: contactRoles
        enabled: true
        locale: 'en-us'
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
      }
      actual100: {
        contactEmails: contactEmails
        contactRoles: contactRoles
        enabled: true
        locale: 'en-us'
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
      }
      forecast100: {
        contactEmails: contactEmails
        contactRoles: contactRoles
        enabled: true
        locale: 'en-us'
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
      }
    }
  }
}

output monthlyBudget int = monthlyAmount
