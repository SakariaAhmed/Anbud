# Azure mission-critical review

Date: 2026-06-09

This review maps the Azure Well-Architected mission-critical workload guidance to the current Anbud web app. The app is a Next.js container deployed to Azure Container Apps with Supabase retained as the current database and storage backend.

## Reviewed Microsoft guidance

- Mission-critical workload index: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/
- Overview: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-overview
- Design methodology: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-design-methodology
- Architecture pattern: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-architecture-pattern
- Design principles: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-design-principles
- Application design: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-application-design
- Application platform: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-application-platform
- Data platform: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-data-platform
- Networking and connectivity: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-networking-connectivity
- Health modeling guide: https://learn.microsoft.com/en-us/azure/well-architected/design-guides/health-modeling
- Monitoring guide: https://learn.microsoft.com/en-us/azure/well-architected/design-guides/monitoring
- Deployment and testing: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-deployment-testing
- Security: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-security
- Operational procedures: https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-operational-procedures
- Training: https://learn.microsoft.com/en-us/training/modules/azure-mission-critical/
- Training: https://learn.microsoft.com/en-us/training/modules/design-health-model-mission-critical-workload/
- Training: https://learn.microsoft.com/en-us/training/modules/continuous-validate-test-mission-critical-workloads/

## Implemented now

| Guidance area | Applied change |
| --- | --- |
| Health Endpoint Monitoring and health modeling | Added distinct `/api/health/live`, `/api/health/ready`, and detailed `/api/health` responses with `healthy`, `degraded`, and `unhealthy` states. |
| Fast failure detection | Readiness now validates required runtime configuration and performs a bounded Supabase dependency query. |
| Avoid cascading dependency failure | Liveness no longer depends on Supabase or OpenAI, so the platform does not restart healthy containers during a dependency outage. |
| Structured correlation | Middleware now propagates and returns `x-correlation-id` for all app and API responses. |
| Protect endpoints | Middleware now applies baseline security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and production HSTS. |
| Infrastructure as code and tagging | Azure Bicep resources now receive mission-critical workload, environment, criticality, and deployment-stamp tags. |
| Deployment validation | The Azure deployment workflow runs frontend validation before deployment and a deployed health smoke test afterward. |
| Supply-chain monitoring | Added Dependabot updates for npm dependencies and GitHub Actions. |

## Current health model

Components:

- `runtime`: Next.js runtime responsiveness and process uptime.
- `configuration`: required production runtime configuration.
- `supabase`: live database dependency for project workspace flows.
- `openai`: AI generation configuration.
- `project_job_worker`: scheduled project job worker authentication.

Flows:

- `interactive_project_workspace`: runtime, configuration, and Supabase.
- `ai_generation`: workspace flow plus OpenAI.
- `async_project_jobs`: AI generation flow plus worker authentication.

Operational convention:

- `healthy`: route traffic normally.
- `degraded`: keep serving traffic, alert or investigate based on trend and user impact.
- `unhealthy`: fail readiness and block new traffic.

## Deliberate deferrals

These recommendations are important, but they require Azure subscription, networking, cost, data-residency, and operational decisions that should not be guessed in code.

- Define target SLO, SLIs, RTO, and RPO for each critical user flow.
- Add Azure Front Door with WAF before production DNS cutover.
- Decide whether the target is single-region zone-redundant, active/passive, or active/active multi-region. The current Supabase dependency constrains true Azure active/active.
- Move secrets to Azure Key Vault or managed identity-backed service connections where supported.
- Add Private Link or other private data-plane connectivity for Azure-native dependencies after the data plane migration.
- Add Azure Monitor dashboards and alerts from the health model, including alert ownership and severity.
- Add load, stress, and chaos tests around project creation, document upload, AI generation, and worker execution.
- Practice restore/failover using non-production data and record recovery runbooks.
- Move from shared Supabase service role usage toward least-privilege service/data-plane authorization as the repository adapters are replaced.

## Next architecture decisions

1. Pick reliability targets first. Do not default to active/active multi-region unless the required SLO/RTO/RPO justify its cost and complexity.
2. Use the current Azure Container Apps stamp as the phase-1 regional stamp.
3. Treat Supabase as a global external dependency during phase 1 and reflect its health in readiness.
4. During phase 3, reassess Azure Database for PostgreSQL Flexible Server versus Azure SQL or Cosmos DB per workload scenario, not as one monolithic data choice.
5. Promote the new health model into Azure Monitor Health Models or equivalent dashboards once production telemetry is available.
