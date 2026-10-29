#!/usr/bin/env node
import { createServer } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const baseline = process.argv.includes("--baseline");
const serviceCheck = process.argv.includes("--service-check");
if (baseline && serviceCheck) throw new Error("Select one isolated gateway.");
const listenPort = serviceCheck ? 55446 : baseline ? 55442 : 55441;
const targetOrigin = `http://127.0.0.1:${serviceCheck ? 55444 : baseline ? 55443 : 55440}`;

const directory = "/tmp/anbud-speed-quality-tls";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const key = `${directory}/key.pem`, cert = `${directory}/cert.pem`;
if (!existsSync(key) || !existsSync(cert)) execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=db.internal.speed-quality.test", "-addext", "subjectAltName=DNS:db.internal.speed-quality.test"], { stdio: "ignore" });
// Scoped to test Node processes. No system DNS, trust store or app security rule
// is changed. All other hostnames retain their normal resolution.
writeFileSync(`${directory}/dns.cjs`, `const dns = require("node:dns");
const lookup = dns.lookup;
dns.lookup = function(hostname, ...args) { return lookup.call(this, hostname === "db.internal.speed-quality.test" ? "127.0.0.1" : hostname, ...args); };
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = function(hostname, ...args) { return promisesLookup.call(this, hostname === "db.internal.speed-quality.test" ? "127.0.0.1" : hostname, ...args); };
`, { mode: 0o600 });
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
  try {
    const target = new URL(request.url, targetOrigin);
    if (target.origin !== targetOrigin) throw new Error("Only local PostgREST is allowed.");
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 10e6) throw new Error("Local request too large."); chunks.push(chunk); }
    const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers["content-length"];
    const upstream = await fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks) });
    response.statusCode = upstream.status;
    for (const name of ["content-type", "content-range", "preference-applied", "range-unit"]) if (upstream.headers.has(name)) response.setHeader(name, upstream.headers.get(name));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { response.writeHead(502, { "content-type": "application/json" }); response.end('{"message":"Local TLS test gateway failed."}'); }
});
server.listen(listenPort, "127.0.0.1", () => console.log("Local TLS test gateway ready; trust and DNS are scoped to test Node processes."));
