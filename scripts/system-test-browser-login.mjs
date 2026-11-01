#!/usr/bin/env node
// Temporary loopback test controller, outside application auth. It signs in
// through the actual handler so preview tools never need to expose a password
// or session token. Stop it with the owned system-test stack.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { systemTestStatusPath } from "./system-test-runtime.mjs";

const statusPath = systemTestStatusPath();
const status = JSON.parse(readFileSync(statusPath, "utf8"));
const runtime = JSON.parse(readFileSync(path.join(status.directory, "environment.json"), "utf8"));
const endpoint = new URL(status.baseUrl);
if (!status.running || endpoint.hostname !== "127.0.0.1" || endpoint.port !== "4338") throw new Error("Only the isolated loopback system test is allowed.");
const server = http.createServer(async (request, response) => {
  if (request.socket.remoteAddress !== "127.0.0.1" || request.headers.host !== "127.0.0.1:4339" || request.method !== "GET" || request.url !== "/browser-login") {
    response.writeHead(404); response.end(); return;
  }
  try {
    const login = await fetch(`${status.baseUrl}/api/auth/login`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", origin: status.baseUrl },
      body: JSON.stringify({ password: runtime.adminPassword }),
    });
    const cookie = login.headers.get("set-cookie");
    if (!login.ok || !cookie) throw new Error("Local test authentication failed.");
    response.writeHead(303, { "Set-Cookie": cookie, Location: status.projectId ? `${status.baseUrl}/projects/${status.projectId}` : status.baseUrl, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
    response.end();
  } catch {
    response.writeHead(503, { "Cache-Control": "no-store" }); response.end("Local test login unavailable.");
  }
});
server.listen(4339, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => process.exit(0)));
