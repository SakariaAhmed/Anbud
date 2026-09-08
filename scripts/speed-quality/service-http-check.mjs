import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openSync, closeSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function checkServiceHttp({ root, env, projectId, services }) {
  const children = [];
  const logFile = `verification/populated-service-http-server-${Date.now()}.log`;
  const log = openSync(path.join(root, "output/speed-quality-2026-09-08", logFile), "wx");
  const runtime = mkdtempSync(path.join(tmpdir(), "anbud-service-http-runtime-"));
  const origin = "http://localhost:4320";
  const run = (args, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd: path.join(root, "apps/frontend"), env: { ...process.env, ...env, ...extra }, stdio: ["ignore", log, log] });
    children.push(child);
  };
  try {
    // A separate process alone still shares Next's disk cache with the original
    // standalone tree. Isolate that cache as well as the test database.
    cpSync(path.join(root, "apps/frontend/.next/standalone"), runtime, { recursive: true, verbatimSymlinks: true, filter: (source) => !source.endsWith("/.next/cache") });
    run([path.join(root, "scripts/speed-quality/local-production-proxy.mjs"), "--service-check"]);
    run([path.join(runtime, "apps/frontend/server.js")], {
      NODE_ENV: "production", PORT: "4320", HOSTNAME: "127.0.0.1", APP_PUBLIC_ORIGIN: origin,
      DATA_API_URL: "https://db.internal.speed-quality.test:55446", DATA_API_ALLOWED_HOST_SUFFIX: ".internal.speed-quality.test",
      NODE_EXTRA_CA_CERTS: "/tmp/anbud-speed-quality-tls/cert.pem", NODE_OPTIONS: "--require=/tmp/anbud-speed-quality-tls/dns.cjs",
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { const r = await fetch(`${origin}/api/health/live`); if (r.ok) { ready = true; break; } } catch { /* Local app startup. */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(ready, true);
    const route = `${origin}/api/projects/${projectId}/service-descriptions`;
    assert.equal((await fetch(route)).status, 401);
    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "speed-quality-local-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
    async function read() {
      const r = await fetch(route, { headers: { cookie } }); assert.equal(r.status, 200); return (await r.json()).services;
    }
    const patch = (body, authenticated = true) => fetch(route, { method: "PATCH", headers: { ...(authenticated ? { cookie } : {}), "content-type": "application/json", origin }, body: JSON.stringify(body) });
    for (let i = 0; i < 2; i++) assert.equal((await read()).length, 3);
    assert.equal((await patch({ selected_service_ids: [services[0].id] }, false)).status, 401);
    assert.equal((await patch({ selected_service_ids: [17] })).status, 400);
    const transitions = [];
    for (const selected of [[services[0].id], [services[1].id, services[1].id], []]) {
      const r = await patch({ selected_service_ids: selected }); assert.equal(r.status, 200);
      const expected = [...new Set(selected)];
      assert.deepEqual((await r.json()).selected_service_ids, expected);
      const actual = (await read()).filter((s) => s.selected).map((s) => s.id);
      assert.deepEqual(actual, expected);
      transitions.push({ submittedCount: selected.length, persistedSelectedCount: actual.length });
    }
    return { scope: "Actual isolated standalone HTTP GET/PATCH, local password auth and real Next invalidation execution; isolated runtime/disk cache, no browser cache or AI generation, no latency gain claim.", logFile, anonymousReadDenied: true, anonymousWriteDenied: true, invalidPayloadRejected: true, warmedCatalogRead: true, selectionTransitionsReadBack: transitions };
  } finally {
    for (const child of children) if (child.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited; clearTimeout(timer);
    }
    closeSync(log);
    rmSync(runtime, { recursive: true, force: true });
  }
}
