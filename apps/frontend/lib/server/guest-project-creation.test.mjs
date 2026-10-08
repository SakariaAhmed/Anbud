import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
    "next/cache": path.join(frontendRoot, "lib/server/repositories/data-store.persistence.test-support.ts"),
  },
});
const { workUnitAsyncStorage } = jiti("next/dist/server/app-render/work-unit-async-storage.external.js");
const { workAsyncStorage } = jiti("next/dist/server/app-render/work-async-storage.external.js");
const { NextRequest } = jiti("next/server");
const { GET, POST } = jiti(path.join(frontendRoot, "app/api/projects/route.ts"));
const { middleware } = jiti(path.join(frontendRoot, "middleware.ts"));
const { requireProjectPermission } = jiti("./authorization.ts");
const { PROJECT_PERMISSIONS } = jiti("../access-control.ts");
const { AUTH_COOKIE_NAME, AUTH_PRINCIPAL_HEADER, AUTH_SESSION_HEADER, encodeDatabaseSessionToken } = jiti("../password-auth.ts");

const guestId = "g_project_creator_000000000000001";
const adminId = "u_project_admin_0000000000000001";
const otherGuestId = "g_other_guest_000000000000000001";
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "223e4567-e89b-42d3-a456-426614174001";

function backend(t, options = {}) {
  const environment = {
    DATA_API_URL: "https://guest-project.test.invalid",
    DATA_API_SERVICE_ROLE_KEY: "test-service-key",
    APP_SESSION_SECRET: "guest-project-test-session-secret",
    APP_ACTIVITY_HASH_SECRET: "guest-project-test-activity-secret",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = { actor: guestId, project: null, activities: [], projectQueries: [], inserts: 0 };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, environment.DATA_API_URL);
    const body = init.body ? JSON.parse(init.body) : null;
    switch (url.pathname) {
      case "/rpc/check_app_rate_limit":
        return Response.json([{ allowed: !options.rateLimited, retry_after_seconds: 10 }]);
      case "/rpc/resolve_app_session":
        return Response.json(options.invalidSession ? [] : [{
          session_id: sessionId,
          principal_id: state.actor,
          identity_type: state.actor === adminId ? "internal" : "guest",
          display_name: "Test user",
          global_roles: state.actor === adminId ? ["admin"] : [],
        }]);
      case "/app_sessions":
        return Response.json({
          id: sessionId, principal_id: state.actor,
          expires_at: new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(),
          revoked_at: options.revoked ? new Date().toISOString() : null,
        });
      case "/app_principals":
        return Response.json({
          id: state.actor,
          identity_type: state.actor === adminId ? "internal" : "guest",
          disabled_at: options.disabled ? new Date().toISOString() : null,
        });
      case "/app_principal_roles":
        return Response.json(state.actor === adminId ? [{ role: "admin" }] : []);
      case "/project_memberships":
      case "/app_group_members":
      case "/documents":
      case "/generated_artifacts":
        return Response.json([]);
      case "/projects": {
        if (init.method === "POST") {
          state.inserts += 1;
          state.project = { id: projectId, ...body };
          return Response.json(state.project, { status: 201 });
        }
        state.projectQueries.push(url.search);
        const ownerFilter = url.searchParams.get("owner_id");
        const visible = state.project && (!ownerFilter || ownerFilter === `eq.${state.project.owner_id}`);
        const single = new Headers(init.headers).get("Accept")?.includes("vnd.pgrst.object");
        return Response.json(single ? state.project : visible ? [state.project] : []);
      }
      case "/rpc/get_solution_evaluation_currentness":
        return Response.json({ [projectId]: false });
      case "/rpc/resolve_project_role":
        return Response.json(state.project?.owner_id === body.p_principal_id ? "owner" : null);
      case "/activity_events":
        state.activities.push(body);
        return new Response(null, { status: 201 });
      case "/audit_events":
        return new Response(null, { status: 201 });
      default:
        assert.fail(`Unexpected backend request: ${init.method} ${url.pathname}`);
    }
  });
  state.request = (callback) => {
    const headers = new Headers({
      [AUTH_PRINCIPAL_HEADER]: state.actor,
      [AUTH_SESSION_HEADER]: sessionId,
    });
    if (options.anonymous) headers.delete(AUTH_PRINCIPAL_HEADER);
    return workAsyncStorage.run({ route: "/api/projects" }, () =>
      workUnitAsyncStorage.run({ type: "request", phase: "render", headers }, callback),
    );
  };
  return state;
}

function createRequest(body = {}) {
  return new Request("http://localhost/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("guest creates a project as owner; admin sees it and has every permission without a grant", async (t) => {
  const state = backend(t);
  const response = await state.request(() => POST(createRequest({ name: " Guest tender ", owner_id: adminId })));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).name, "Guest tender");
  assert.equal(state.project.owner_id, guestId, "ownership comes from the session, never request input");
  assert.equal(state.activities[0].actor_principal_id, guestId);
  assert.equal(state.activities[0].action, "project.create");
  assert.equal(state.activities[0].project_id, projectId);

  await state.request(async () => {
    assert.equal((await (await GET()).json())[0].id, projectId);
    for (const permission of PROJECT_PERMISSIONS) {
      const access = await requireProjectPermission(projectId, permission);
      assert.equal(access.effectiveRole, "owner");
      assert.equal(access.principal.isAdmin, false);
    }
  });

  state.actor = adminId;
  state.projectQueries = [];
  await state.request(async () => {
    assert.equal((await (await GET()).json())[0].id, projectId);
    assert.equal(new URLSearchParams(state.projectQueries[0]).has("id"), false);
    for (const permission of PROJECT_PERMISSIONS) {
      const access = await requireProjectPermission(projectId, permission);
      assert.equal(access.effectiveRole, "admin");
    }
  });

  state.actor = otherGuestId;
  await state.request(async () => {
    assert.deepEqual(await (await GET()).json(), []);
    for (const permission of PROJECT_PERMISSIONS) {
      await assert.rejects(requireProjectPermission(projectId, permission), { status: 403 });
    }
  });
});

test("dashboard's unnamed creation gives the guest ownership and the default project name", async (t) => {
  const state = backend(t);
  const response = await state.request(() => POST(createRequest()));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).name, "Ny analyse");
  assert.equal(state.project.owner_id, guestId);
});

for (const reason of ["anonymous", "expired", "revoked", "disabled"]) {
  test(`project creation denies guests with ${reason} identity/session without inserting a project`, async (t) => {
    const state = backend(t, { [reason]: true });
    assert.equal((await state.request(() => POST(createRequest()))).status, 401);
    assert.equal(state.inserts, 0);
  });
}

test("guest project creation keeps the distributed rate limit", async (t) => {
  const state = backend(t, { rateLimited: true });
  const response = await state.request(() => POST(createRequest()));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "10");
  assert.equal(state.inserts, 0);
});

async function pageRequest(pathname, method = "GET") {
  const token = encodeDatabaseSessionToken(sessionId, "s".repeat(48));
  const pending = [];
  const response = await middleware(new NextRequest(`http://localhost${pathname}`, {
    method, headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
  }), { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return response;
}

test("guest can open the new-project form and creation endpoint while the service library stays restricted", async (t) => {
  backend(t);
  for (const [pathname, method] of [["/projects/new", "GET"], ["/projects/new/", "GET"], ["/api/projects", "POST"]]) {
    const response = await pageRequest(pathname, method);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal((await pageRequest("/service-descriptions")).headers.get("location"), "http://localhost/");
  assert.equal((await pageRequest("/api/service-descriptions")).status, 404);
});

test("a revoked session cannot enter project creation through middleware", async (t) => {
  backend(t, { invalidSession: true });
  const response = await pageRequest("/projects/new");
  assert.equal(new URL(response.headers.get("location")).pathname, "/login");
  assert.equal((await pageRequest("/api/projects", "POST")).status, 401);
});
