import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const authorization = jiti(
  path.join(frontendRoot, "lib/middleware-project-authorization.ts"),
);

const projectId = "123e4567-e89b-12d3-a456-426614174000";
const documentId = "223e4567-e89b-12d3-a456-426614174001";
const encodedProjectId = `%31${projectId.slice(1)}`;
const encodedDocumentId = `%32${documentId.slice(1)}`;

function normalized(pathname) {
  const result = authorization.normalizeAuthorizationPathname(pathname);
  assert.notEqual(result, null);
  return result;
}

test("canonical and encoded project IDs deny no-role project requests", () => {
  for (const candidateId of [projectId, encodedProjectId]) {
    for (const method of ["GET", "DELETE", "POST"]) {
      const pathname = normalized(`/api/projects/${candidateId}`);
      assert.equal(
        authorization.projectIdFromAuthorizationPath(pathname),
        projectId,
      );
      assert.equal(
        authorization.projectRoleAllowsAuthorizationPath({
          method,
          pathname,
          role: null,
          isAdmin: false,
        }),
        false,
        `${method} must be denied for ${candidateId}`,
      );
    }
  }
});

test("canonical and encoded document IDs require download permission", () => {
  for (const candidateId of [documentId, encodedDocumentId]) {
    const pathname = normalized(
      `/api/projects/${projectId}/documents/${candidateId}`,
    );
    assert.equal(
      authorization.requiredProjectPermission("GET", pathname),
      "document.download",
    );
    assert.equal(
      authorization.projectRoleAllowsAuthorizationPath({
        method: "GET",
        pathname,
        role: "restricted_viewer",
        isAdmin: false,
      }),
      false,
    );
  }
});

test("malformed percent-encoding and decoded control characters fail closed", () => {
  assert.equal(
    authorization.normalizeAuthorizationPathname(
      `/api/projects/${projectId.slice(0, -1)}%`,
    ),
    null,
  );
  assert.equal(
    authorization.normalizeAuthorizationPathname(
      `/api/projects/${projectId}%00`,
    ),
    null,
  );
});

test("administrator can read and share globally but cannot mutate project content", () => {
  for (const [method, suffix, allowed] of [
    ["GET", "", true],
    ["POST", "/access", true],
    ["PATCH", "", false],
    ["DELETE", "", false],
  ]) {
    assert.equal(
      authorization.projectRoleAllowsAuthorizationPath({
        method,
        pathname: `/api/projects/${projectId}${suffix}`,
        role: null,
        isAdmin: true,
      }),
      allowed,
    );
  }
});

test("page-view telemetry requires project read access without granting writes", () => {
  const pathname = `/api/projects/${projectId}/page-view`;
  assert.equal(
    authorization.requiredProjectPermission("POST", pathname),
    "project.read",
  );
  assert.equal(
    authorization.projectRoleAllowsAuthorizationPath({
      method: "POST",
      pathname,
      role: "restricted_viewer",
      isAdmin: false,
    }),
    true,
  );
  assert.equal(
    authorization.projectRoleAllowsAuthorizationPath({
      method: "POST",
      pathname,
      role: null,
      isAdmin: false,
    }),
    false,
  );
});
