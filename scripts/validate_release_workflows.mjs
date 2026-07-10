#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy-azure.yml", "utf8");

assert.match(ci, /pull_request:/u, "PR CI must run for pull requests.");
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
