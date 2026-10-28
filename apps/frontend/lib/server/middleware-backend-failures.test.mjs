import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": frontendRoot, "server-only": "/dev/null" },
});
const { NextRequest } = jiti("next/server");
const { middleware } = jiti(path.join(frontendRoot, "middleware.ts"));
const { AUTH_COOKIE_NAME, encodeDatabaseSessionToken } = jiti("../password-auth.ts");

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "223e4567-e89b-42d3-a456-426614174001";
const principalId = "u_middleware_failure_000000000001";

function backend(t, { session = "ok", role = "ok" } = {}) {
  const environment = {
    DATA_API_URL: "https://middleware-failure.test.invalid",
    DATA_API_SERVICE_ROLE_KEY: "test-service-key",
    APP_SESSION_SECRET: "middleware-failure-test-session-secret",
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const logs = [];
  t.mock.method(console, "error", (line) => logs.push(line));
  const failure = (mode, init) => {
    if (mode === "network") return Promise.reject(new TypeError("fetch failed"));
    if (mode === "timeout") {
      assert.ok(init.signal, "data API calls must carry a timeout signal");
      return Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    }
    if (mode === "html") return Promise.resolve(new Response("<html>proxy</html>", { status: 200 }));
    if (mode === "status") return Promise.resolve(new Response("{}", { status: 503 }));
    return null;
  };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/rpc/resolve_app_session") {
      return failure(session, init) ?? Response.json(session === "missing" ? [] : [{
        session_id: sessionId, principal_id: principalId, identity_type: "internal",
        display_name: "Test", global_roles: [],
      }]);
    }
    if (url.pathname === "/rpc/resolve_project_role") {
      return failure(role, init) ?? Response.json(role === "none" ? null : "editor");
    }
    if (url.pathname === "/activity_events") return new Response(null, { status: 201 });
    assert.fail(`Unexpected backend request ${url.pathname}`);
  });
  return logs;
}

async function request(pathname) {
  const token = encodeDatabaseSessionToken(sessionId, "s".repeat(48));
  const pending = [];
  const response = await middleware(new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` },
  }), { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return response;
}

for (const mode of ["network", "timeout", "html", "status"]) {
  test(`a ${mode} session lookup failure reports an outage, not a missing login`, async (t) => {
    const logs = backend(t, { session: mode });
    const api = await request("/api/projects");
    assert.equal(api.status, 503);
    const body = await api.json();
    assert.equal(body.reference, api.headers.get("x-correlation-id"));
    const page = await request("/projects");
    assert.equal(page.status, 503);
    assert.equal(page.headers.get("location"), null);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.event, "middleware_backend_failure");
    assert.equal(entry.stage, "session");
    assert.ok(entry.correlation_id);
  });
}

test("login and liveness stay reachable while session lookup fails", async (t) => {
  backend(t, { session: "network" });
  for (const pathname of ["/login", "/api/health/live"]) {
    const response = await request(pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }
});

test("a project role lookup failure is not reported as a missing project", async (t) => {
  const logs = backend(t, { role: "html" });
  const response = await request(`/api/projects/${projectId}`);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(logs[0]).stage, "project_role");
});

test("a missing session or project role keeps the existing denial responses", async (t) => {
  backend(t, { session: "missing" });
  assert.equal((await request("/api/projects")).status, 401);
  t.mock.restoreAll();
  backend(t, { role: "none" });
  assert.equal((await request(`/api/projects/${projectId}`)).status, 404);
});
