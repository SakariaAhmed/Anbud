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
assert.match(
  ci,
  /concurrency:[\s\S]*cancel-in-progress:\s*true/u,
  "CI must cancel obsolete runs on the same ref.",
);
for (const required of [
  "secrets:scan",
  "npm test",
  "npm run lint",
  "npm run build",
  "validate_project_jobs_schema",
  "azure_containerapp_rollout.test",
  "PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL",
  "pgvector/pgvector:pg17@sha256:",
  "az bicep build",
  "az bicep lint",
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
  "Deployment workflow default contents permission must be read-only.",
);
assert.match(
  topLevelPermissions,
  /actions:\s*read/u,
  "Deployment workflow must be able to verify the exact commit's CI run.",
);
assert.doesNotMatch(
  topLevelPermissions,
  /id-token:\s*write/u,
  "OIDC permission must not be granted at workflow scope.",
);
assert.match(
  deploy,
  /deploy:[\s\S]*permissions:[\s\S]*actions:\s*read[\s\S]*id-token:\s*write/u,
  "The production job must receive CI-read and OIDC permissions.",
);
assert.match(
  deploy,
  /actions\/workflows\/ci\.yml\/runs[\s\S]*head_sha="\$GITHUB_SHA"[\s\S]*status=success/u,
  "Deployment must require successful CI for the exact production commit.",
);
assert.doesNotMatch(
  deploy,
  /npm ci|npm test|npm run lint|npm run build|docker:smoke|fallow@/u,
  "Deployment must reuse CI results instead of repeating CI work.",
);
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
for (const required of [
  "Validate production database contract from the Azure network",
  "REMOTE_SCHEMA_PREFLIGHT=1",
  "docker/build-push-action",
  "trivy-action",
  "azure_containerapp_rollout.mjs",
  "Roll back to the previous Azure revision",
]) {
  assert.ok(deploy.includes(required), `Production deploy is missing: ${required}`);
}

console.log(JSON.stringify({ workflows: "release-boundaries-valid" }));
