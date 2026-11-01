#!/usr/bin/env node
// Temporary loopback test controller, outside application auth. It signs in
// through the actual handler so preview tools never need to expose a password
// or session token. Stop it with the owned system-test stack.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { systemTestStatusPath } from "./system-test-runtime.mjs";

export function createBrowserLoginHandler({ baseUrl, adminPassword, projectId, token, host = "127.0.0.1:4339", loginFetch = fetch }) {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("A private per-run browser token is required.");
  let used = false;
  return async (request, response) => {
    let target;
    try { target = new URL(request.url, "http://127.0.0.1"); } catch { response.writeHead(404); response.end(); return; }
    const supplied = target.searchParams.get("token") ?? "";
    const authenticated = /^[a-f0-9]{64}$/u.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (used || !authenticated || request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== host || request.method !== "GET" || target.pathname !== "/browser-login") {
      response.writeHead(404); response.end(); return;
    }
    used = true;
    try {
      const login = await loginFetch(`${baseUrl}/api/auth/login`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ password: adminPassword }),
      });
      const cookie = login.headers.get("set-cookie");
      if (!login.ok || !cookie) throw new Error("Local test authentication failed.");
      response.writeHead(303, { "Set-Cookie": cookie, Location: projectId ? `${baseUrl}/projects/${projectId}` : baseUrl, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
      response.end();
    } catch {
      response.writeHead(503, { "Cache-Control": "no-store" }); response.end("Local test login unavailable.");
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const status = JSON.parse(readFileSync(systemTestStatusPath(), "utf8"));
  const runtime = JSON.parse(readFileSync(path.join(status.directory, "environment.json"), "utf8"));
  const endpoint = new URL(status.baseUrl);
  if (!status.running || endpoint.hostname !== "127.0.0.1" || endpoint.port !== "4338") throw new Error("Only the isolated loopback system test is allowed.");
  const server = http.createServer(createBrowserLoginHandler({ baseUrl: status.baseUrl, adminPassword: runtime.adminPassword, token: runtime.browserLoginToken, projectId: status.projectId }));
  server.listen(4339, "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
}
