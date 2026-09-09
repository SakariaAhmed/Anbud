import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const jiti = createJiti(import.meta.url, {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { workUnitAsyncStorage } = jiti(
  "next/dist/server/app-render/work-unit-async-storage.external.js",
);
const { workAsyncStorage } = jiti(
  "next/dist/server/app-render/work-async-storage.external.js",
);
const { requireProjectPermission } = jiti("./authorization.ts");
const { PROJECT_PERMISSIONS } = jiti("../access-control.ts");
const { AUTH_PRINCIPAL_HEADER, AUTH_SESSION_HEADER, AUTH_IS_ADMIN_HEADER } =
  jiti("../password-auth.ts");

const principalId = "u_admin_access_test";
const projectId = "123e4567-e89b-12d3-a456-426614174000";
const sessionId = "223e4567-e89b-12d3-a456-426614174001";

async function withRequest(t, options, callback) {
  const env = {
    DATA_API_URL: "https://authorization.test.invalid",
    DATA_API_SERVICE_ROLE_KEY: "test-service-key",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, env.DATA_API_URL);
    assert.equal(init.method, "GET");
    switch (url.pathname) {
      case "/app_sessions":
        assert.equal(url.searchParams.get("principal_id"), `eq.${principalId}`);
        assert.equal(url.searchParams.get("id"), `eq.${sessionId}`);
        return Response.json({
          id: sessionId,
          principal_id: principalId,
          expires_at: new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(),
          revoked_at: options.revoked ? new Date().toISOString() : null,
        });
      case "/app_principals":
        return Response.json({
          id: principalId,
          identity_type: "internal",
          disabled_at: options.disabled ? new Date().toISOString() : null,
        });
      case "/app_principal_roles":
        return Response.json(options.admin ? [{ role: "admin" }] : []);
      case "/project_memberships":
        return Response.json(options.role
          ? [{ role: options.role, revoked_at: null, expires_at: null }]
          : []);
      case "/app_group_members":
        return Response.json([]);
      case "/projects":
        return Response.json({ owner_id: "u_other_project_owner" });
      default:
        assert.fail(`Unexpected authorization request: ${url.pathname}`);
    }
  });

  const headers = new Headers({
    [AUTH_PRINCIPAL_HEADER]: principalId,
    [AUTH_SESSION_HEADER]: sessionId,
    // A stale or forged admin hint must never override the database role.
    [AUTH_IS_ADMIN_HEADER]: "1",
  });
  if (options.anonymous) headers.delete(AUTH_PRINCIPAL_HEADER);
  return workAsyncStorage.run({ route: `/projects/${projectId}` }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", headers }, callback),
  );
}

test("server grants admin every permission on another user's project without membership", async (t) => {
  await withRequest(t, { admin: true }, async () => {
    for (const permission of PROJECT_PERMISSIONS) {
      const access = await requireProjectPermission(projectId, permission);
      assert.equal(access.principal.isAdmin, true);
      assert.equal(access.effectiveRole, "admin");
      assert.deepEqual(access.permissions, PROJECT_PERMISSIONS);
    }
  });
});

test("server exposes full admin permissions even with a restricted project grant", async (t) => {
  await withRequest(t, { admin: true, role: "restricted_viewer" }, async () => {
    const access = await requireProjectPermission(projectId, "project.read");
    // These permissions drive the workspace's read-only state and server writes.
    assert.equal(access.permissions.includes("project.update"), true);
    assert.equal(access.permissions.includes("job.run"), true);
    await requireProjectPermission(projectId, "document.download");
    await requireProjectPermission(projectId, "project.delete");
  });
});

for (const options of [{ revoked: true }, { expired: true }, { disabled: true }, { anonymous: true }]) {
  test(`server denies admin with ${Object.keys(options)[0]} identity/session`, async (t) => {
    await withRequest(t, { admin: true, ...options }, async () => {
      await assert.rejects(requireProjectPermission(projectId, "job.run"), { status: 401 });
    });
  });
}

test("server denies global access after admin removal despite an admin request header", async (t) => {
  await withRequest(t, { admin: false }, async () => {
    for (const permission of PROJECT_PERMISSIONS) {
      await assert.rejects(requireProjectPermission(projectId, permission), { status: 403 });
    }
  });
});

test("non-admin restricted viewers can read but cannot generate, delete or download", async (t) => {
  await withRequest(t, { admin: false, role: "restricted_viewer" }, async () => {
    const access = await requireProjectPermission(projectId, "project.read");
    assert.equal(access.permissions.includes("project.update"), false);
    for (const permission of ["job.run", "analysis.write", "project.delete", "document.download"]) {
      await assert.rejects(requireProjectPermission(projectId, permission), { status: 403 });
    }
  });
});
