import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createBrowserLoginHandler } from "./system-test-browser-login.mjs";

test("browser bridge requires a private one-time token before forwarding real login", async t => {
  const token = "a".repeat(64);
  let calls = 0;
  let handler;
  const server = http.createServer((request, response) => handler(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const host = `127.0.0.1:${server.address().port}`;
  handler = createBrowserLoginHandler({
    baseUrl: "http://127.0.0.1:4338", adminPassword: "synthetic-password", token, host,
    loginFetch: async (url, options) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:4338/api/auth/login");
      assert.equal(JSON.parse(options.body).password, "synthetic-password");
      return new Response(null, { headers: { "set-cookie": "session=synthetic; HttpOnly" } });
    },
  });
  for (const suffix of ["", `?token=${"b".repeat(64)}`, `?token=${"ø".repeat(64)}`]) {
    const denied = await fetch(`http://${host}/browser-login${suffix}`, { redirect: "manual" });
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get("set-cookie"), null);
  }
  assert.equal(calls, 0);
  const url = `http://${host}/browser-login?token=${token}`;
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
  assert.equal(calls, 0);
  const allowed = await fetch(url, { redirect: "manual" });
  assert.equal(allowed.status, 303);
  assert.match(allowed.headers.get("set-cookie"), /session=synthetic/u);
  assert.equal(allowed.headers.get("referrer-policy"), "no-referrer");
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
  assert.equal((await fetch(url, { redirect: "manual" })).status, 404);
  assert.equal(calls, 1);
});
