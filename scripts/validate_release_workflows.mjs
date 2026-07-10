#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-azure.yml", "utf8");

assert.match(ci, /pull_request:/u, "PR CI must run for pull requests.");
assert.match(
  ci,
  /push:\s*\n\s+branches:\s*\n\s+- main/u,
  "CI must validate commits pushed to main.",
);
assert.doesNotMatch(
  ci,
  /pull_request_target:/u,
  "PR CI must not expose privileged pull_request_target context.",
);
for (const required of [
  "secrets:scan",
  "npm test",
  "npm run lint",
  "npm run build",
  "validate_project_jobs_schema",
  "azure_containerapp_rollout.test",
  "az bicep build",
  "az bicep lint",
  "docker:smoke",
]) {
  assert.ok(ci.includes(required), `PR CI is missing: ${required}`);
}

assert.match(deploy, /workflow_dispatch:/u, "Production deploy must be manual.");
assert.match(
  deploy,
  /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/u,
  "Production deploy must enforce the main branch in workflow code.",
);
const topLevelPermissions = deploy.slice(
  deploy.indexOf("permissions:"),
  deploy.indexOf("env:"),
);
assert.match(
  topLevelPermissions,
  /contents:\s*read/u,
  "Deployment workflow default permissions must be read-only.",
);
assert.doesNotMatch(
  topLevelPermissions,
  /id-token:\s*write/u,
  "OIDC permission must not be granted at workflow scope.",
);
assert.match(
  deploy,
  /deploy:[\s\S]*permissions:[\s\S]*id-token:\s*write/u,
  "Only the final production job should receive OIDC permission.",
);
assert.match(
  deploy,
  /needs:[\s\S]*- validation[\s\S]*- infrastructure-validation[\s\S]*- container-validation/u,
  "Production deployment must depend on every exact-commit validation job.",
);
for (const required of [
  "secrets:scan",
  "project-jobs-lifecycle.system.test",
  "lease-fenced-persistence.system.test",
  "validate_project_jobs_schema",
  "azure_containerapp_rollout.test",
  "npm test",
  "npm run lint",
  "npm run build",
  "verify_workflow_boundaries",
  "validate_release_workflows",
  "YAML.parse_file",
  "fallow@$FALLOW_VERSION",
  "az bicep build",
  "az bicep lint",
  "docker:smoke",
  "trivy-action",
]) {
  assert.ok(
    deploy.includes(required),
    `Production deploy validation is missing: ${required}`,
  );
}
assert.doesNotMatch(
  deploy,
  /push:\s*[\s\S]*branches:\s*[\s\S]*- main/u,
  "A merge to main must not immediately deploy production.",
);
assert.match(
  deploy,
  /environment:\s*production/u,
  "Deploy must use the protected production environment.",
);
assert.match(
  deploy,
  /validate_project_jobs_schema\.mjs --remote/u,
  "Schema preflight must run before release.",
);
assert.match(
  deploy,
  /Fallback rollback/u,
  "Deploy must retain an always-available fallback rollback step.",
);

console.log(JSON.stringify({ workflows: "release-boundaries-valid" }));
