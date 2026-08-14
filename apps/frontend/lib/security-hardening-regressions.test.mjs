import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(frontendRoot, "../..");

function read(relativePath, root = frontendRoot) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("document downloads are attachment-only and MIME types are canonical", () => {
  const route = read("app/api/projects/[id]/documents/[documentId]/route.ts");
  const documents = read("lib/server/documents.ts");

  assert.doesNotMatch(route, /disposition\s*===\s*["']inline["']/u);
  assert.match(route, /Content-Disposition["']?:\s*contentDisposition/u);
  assert.match(route, /X-Content-Type-Options["']?:\s*["']nosniff["']/u);
  assert.doesNotMatch(documents, /clientContentType/u);
});

test("global service-description writes require an administrator", () => {
  for (const relativePath of [
    "app/api/service-descriptions/route.ts",
    "app/api/service-descriptions/[serviceId]/route.ts",
  ]) {
    const source = read(relativePath);
    assert.match(source, /requireAdmin\(\)/u, relativePath);
    assert.match(source, /authorizationErrorResponse/u, relativePath);
  }
});

test("only liveness is public and detailed health endpoints require admin", () => {
  const middleware = read("middleware.ts");
  assert.match(middleware, /pathname\s*===\s*["']\/api\/health\/live["']/u);
  assert.doesNotMatch(middleware, /startsWith\(["']\/api\/health\/["']\)/u);

  for (const route of ["app/api/health/route.ts", "app/api/health/ready/route.ts"]) {
    assert.match(read(route), /requireAdmin\(\)/u, route);
  }
});

test("Azure image pulls use managed identity and no static ACR password", () => {
  const bicep = read("infra/azure/container-app.bicep", repositoryRoot);
  const bootstrap = read("infra/azure/acr-pull-bootstrap.bicep", repositoryRoot);
  const workflow = read(".github/workflows/deploy-azure.yml", repositoryRoot);

  assert.match(bicep, /userAssignedIdentities/u);
  assert.match(bootstrap, /AcrPull/u);
  assert.match(bootstrap, /Microsoft\.Authorization\/roleAssignments/u);
  assert.doesNotMatch(bicep, /Microsoft\.Authorization\/roleAssignments/u);
  assert.doesNotMatch(bicep, /registryPassword|registryUsername/u);
  assert.doesNotMatch(workflow, /ACR_PASSWORD|ACR_USERNAME/u);
  assert.match(workflow, /az acr login/u);
});

test("production deploy requires and forwards independent identity HMAC secrets", () => {
  const workflow = read(".github/workflows/deploy-azure.yml", repositoryRoot);

  for (const [environmentName, parameterName] of [
    ["APP_GUEST_CODE_PEPPER", "appGuestCodePepper"],
    ["APP_IDENTITY_LOOKUP_SECRET", "appIdentityLookupSecret"],
    ["APP_ACTIVITY_HASH_SECRET", "appActivityHashSecret"],
  ]) {
    assert.match(
      workflow,
      new RegExp(`${environmentName}: \\\${\\{ secrets\\.${environmentName} \\}\\}`),
      environmentName,
    );
    assert.match(
      workflow,
      new RegExp(`${parameterName}=\\"\\$${environmentName}\\"`),
      parameterName,
    );
  }

  const requiredNames = workflow.match(/for name in ([^\n]+)/u)?.[1] ?? "";
  assert.match(requiredNames, /APP_GUEST_CODE_PEPPER/u);
  assert.match(requiredNames, /APP_IDENTITY_LOOKUP_SECRET/u);
  assert.match(requiredNames, /APP_ACTIVITY_HASH_SECRET/u);
});

test("production script CSP uses a nonce and never unsafe-inline", () => {
  const middleware = read("middleware.ts");
  assert.match(middleware, /nonce-/u);
  assert.match(middleware, /x-nonce/u);
  assert.doesNotMatch(
    middleware,
    /script-src[^`\n]*unsafe-inline/u,
  );
});

test("rate limits prefer authenticated principals and Azure's trusted hop", () => {
  const observability = read("lib/server/observability.ts");
  const bicep = read("infra/azure/container-app.bicep", repositoryRoot);

  assert.match(observability, /request\.headers\.get\(AUTH_PRINCIPAL_HEADER\)/u);
  assert.match(observability, /split\(["'],["']\)\.at\(-1\)/u);
  assert.match(observability, /isIP\(candidate\)/u);
  assert.match(bicep, /TRUST_FORWARDED_RATE_LIMIT_HEADERS/u);
});
