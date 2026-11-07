import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const root = path.resolve(import.meta.dirname, "../..");
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": "/dev/null" } });
const { POST } = jiti("../../app/api/auth/logout/route.ts");
const { AUTH_COOKIE_NAME, AUTH_PRINCIPAL_HEADER, AUTH_SESSION_HEADER } = jiti("../password-auth.ts");
const { workUnitAsyncStorage } = jiti("next/dist/server/app-render/work-unit-async-storage.external.js");
const { workAsyncStorage } = jiti("next/dist/server/app-render/work-async-storage.external.js");
const sessionId = "223e4567-e89b-12d3-a456-426614174001", principalId = "synthetic-logout-principal";
function setup(t, options = {}) {
  const environment = { DATA_API_URL: "https://logout.test.invalid", DATA_API_SERVICE_ROLE_KEY: "synthetic-test-key" };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const state = { revoked: options.revoked ?? false, failWrite: options.failWrite ?? false, writes: 0, events: 0 }, logs = [];
  t.mock.method(console, "error", (line) => logs.push(JSON.parse(line)));
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, environment.DATA_API_URL);
    if (url.pathname === "/app_sessions" && init.method === "PATCH") {
      state.writes++;
      assert.equal(url.searchParams.get("id"), `eq.${sessionId}`);
      assert.equal(url.searchParams.get("revoked_at"), "is.null");
      assert.ok(Date.parse(JSON.parse(init.body).revoked_at));
      if (state.failWrite) return Response.json({ code: "TEST503", message: "private revocation failure" }, { status: 503 });
      state.revoked = true; return new Response(null, { status: 204 });
    }
    if (url.pathname === "/app_sessions") {
      if (options.lookupFailure) return Response.json({ code: "TEST503", message: "private lookup failure" }, { status: 503 });
      if (options.missing) return Response.json(null);
      return Response.json({ id: sessionId, principal_id: principalId, expires_at: new Date(Date.now() + (options.expired ? -60_000 : 60_000)).toISOString(), revoked_at: state.revoked ? new Date().toISOString() : null });
    }
    if (url.pathname === "/app_principals") return Response.json({ id: principalId, identity_type: "internal", disabled_at: null });
    if (url.pathname === "/app_principal_roles") return Response.json([]);
    if (url.pathname === "/activity_events") { state.events++; return new Response(null, { status: 201 }); }
    assert.fail(`Unexpected fetch ${url.pathname}`);
  });
  const headers = new Headers(options.anonymous ? {} : { [AUTH_PRINCIPAL_HEADER]: principalId, [AUTH_SESSION_HEADER]: sessionId });
  const run = () => workAsyncStorage.run({ route: "/api/auth/logout" }, () => workUnitAsyncStorage.run({ type: "request", phase: "render", headers }, POST));
  return { run, state, logs };
}
test("failed revocation retains cookie and reports503; retry revokes before success", async (t) => {
  const { run, state, logs } = setup(t, { failWrite: true });
  const failed = await run();
  assert.equal(failed.status, 503); assert.equal(failed.headers.get("set-cookie"), null);
  const body = await failed.json(); assert.match(body.reference, /^[a-f0-9-]{36}$/u);
  assert.equal(logs[0].stage, "session_revocation"); assert.equal(logs[0].reference, body.reference);
  assert.doesNotMatch(JSON.stringify([body, logs]), /private revocation/u);
  assert.equal(state.revoked, false); assert.equal(state.events, 0);
  state.failWrite = false;
  const success = await run();
  assert.deepEqual(await success.json(), { ok: true }); assert.equal(success.status, 200); assert.equal(state.revoked, true);
  assert.match(success.headers.get("set-cookie"), new RegExp(`${AUTH_COOKIE_NAME}=;`));
  assert.match(success.headers.get("set-cookie"), /Max-Age=0/u); assert.equal(state.events, 1);
  await run(); assert.equal(state.writes, 2, "already revoked session needs no extra write");
});
for (const options of [{ anonymous: true }, { missing: true }, { expired: true }, { revoked: true }]) {
  test(`logout remains idempotent for ${Object.keys(options)[0]} sessions`, async (t) => {
    const { run, state } = setup(t, options); const response = await run();
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/u); assert.equal(state.writes, 0); assert.equal(state.events, 0);
  });
}
test("identity lookup outage cannot be swallowed as already logged out", async (t) => {
  const { run, state } = setup(t, { lookupFailure: true }); const response = await run();
  assert.equal(response.status, 503); assert.equal(response.headers.get("set-cookie"), null); assert.equal(state.writes, 0);
});
