import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { assertOwnedSystemTestStack, dockerEngineSocketPath, isolatedApplicationEnvironment, ownedContainerCreateArguments, startContainerThroughEngine, systemTestPorts, systemTestStatusPath } from "./system-test-runtime.mjs";

test("local app inherits only OS essentials and explicitly supplied scenario settings", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-harness-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = isolatedApplicationEnvironment(directory, {
    DATA_API_URL: "http://127.0.0.1:55449", OPENAI_API_KEY: "", NODE_ENV: "development",
  }, {
    PATH: "/usr/bin", HOME: directory, OPENAI_API_KEY: "synthetic-parent-credential",
    OPENAI_MAIN_MODEL: "unrequested-model", AZURE_DOCUMENT_INTELLIGENCE_KEY: "synthetic-parent-credential",
    DATA_API_ALLOWED_HOST_SUFFIX: "external.invalid", NODE_OPTIONS: "--require unwanted.cjs",
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, directory);
  assert.equal(environment.DATA_API_URL, "http://127.0.0.1:55449");
  assert.equal(environment.OPENAI_API_KEY, "");
  assert.equal(environment.AZURE_DOCUMENT_INTELLIGENCE_KEY, "");
  assert.equal(environment.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, "");
  for (const key of ["OPENAI_MAIN_MODEL", "DATA_API_ALLOWED_HOST_SUFFIX", "NODE_OPTIONS"]) assert.equal(environment[key], undefined);
});

test("Next dotenv files cannot introduce external credentials into an isolated scenario", t => {
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const directory = mkdtempSync(path.join(tmpdir(), "anbud-harness-dotenv-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, file), "EXTERNAL_SERVICE_KEY=synthetic-credential");
    assert.throws(() => isolatedApplicationEnvironment(directory, {}, {}), /clean checkout/u);
  }
});

test("status paths use the OS temporary directory or an explicit absolute override", () => {
  assert.equal(systemTestStatusPath({}), path.join(tmpdir(), "anbud-system-test-status.json"));
  const override = path.join(tmpdir(), "owned-other-status.json");
  assert.equal(systemTestStatusPath({ ANBUD_SYSTEM_TEST_STATUS: override }), override);
  assert.throws(() => systemTestStatusPath({ ANBUD_SYSTEM_TEST_STATUS: "relative.json" }), /absolute/u);
});

test("data ports move together while the app stays at its guarded loopback origin", () => {
  assert.deepEqual(systemTestPorts({}), { postgres: 55448, postgrest: 55449, blob: 55450, app: 4338, browserLogin: 4339 });
  assert.deepEqual(systemTestPorts({ ANBUD_SYSTEM_TEST_DATA_PORT_BASE: "55470" }), { postgres: 55470, postgrest: 55471, blob: 55472, app: 4338, browserLogin: 4339 });
  for (const invalid of ["80", "65534", "abc", "55470.5"]) assert.throws(() => systemTestPorts({ ANBUD_SYSTEM_TEST_DATA_PORT_BASE: invalid }), /unprivileged/u);
});

test("fixture and worker calls refuse anything but the recorded owned loopback stack", () => {
  const status = { running: true, baseUrl: "http://127.0.0.1:4338", ports: { postgrest: 55471 } };
  assert.doesNotThrow(() => assertOwnedSystemTestStack(status, { env: { DATA_API_URL: "http://127.0.0.1:55471" } }));
  for (const [nextStatus, url] of [
    [status, "https://example.invalid"], [status, "http://127.0.0.1:55449"],
    [{ ...status, running: false }, "http://127.0.0.1:55471"],
    [{ ...status, baseUrl: "https://example.invalid" }, "http://127.0.0.1:55471"],
    [{ ...status, ports: {} }, "http://127.0.0.1:55471"],
  ]) assert.throws(() => assertOwnedSystemTestStack(nextStatus, { env: { DATA_API_URL: url } }), /owned|Start/u);
});

test("owned containers are labelled, attached only as requested and name their image last", () => {
  const created = ownedContainerCreateArguments({ name: "anbud-system-test-x-pg", network: "n", envFile: "/private/e", publish: ["127.0.0.1:1:2"], user: "1001:1001", entrypoint: "sleep", label: "anbud.system-test=x", image: "img", args: ["a"] });
  assert.equal(created[0], "create");
  for (const value of ["--rm", "anbud.system-test=x", "127.0.0.1:1:2", "1001:1001", "sleep", "--no-healthcheck"]) assert.ok(created.includes(value), value);
  assert.deepEqual(created.slice(-2), ["img", "a"]);
  assert.ok(!ownedContainerCreateArguments({ name: "n", label: "l", image: "i" }).includes("--network"));
});

test("engine start accepts started containers and reports refusal or a stalled engine", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-engine-"));
  const socketPath = path.join(directory, "engine.sock");
  const paths = [], seen = new Set();
  const server = http.createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    if (request.url.includes("stall")) return;
    if (request.url.includes("first-hangs") && !seen.has(request.url)) { seen.add(request.url); return; }
    response.writeHead(request.url.includes("running") ? 304 : request.url.includes("missing") ? 404 : 204); response.end();
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  await startContainerThroughEngine(socketPath, "owned");
  await startContainerThroughEngine(socketPath, "running");
  await assert.rejects(startContainerThroughEngine(socketPath, "missing"), /HTTP 404/u);
  await startContainerThroughEngine(socketPath, "first-hangs", { timeoutMs: 30 });
  await assert.rejects(startContainerThroughEngine(socketPath, "stall", { attempts: 2, timeoutMs: 30 }), /did not start stall in 2 attempts/u);
  assert.equal(paths[0], "POST /containers/owned/start");
  assert.equal(dockerEngineSocketPath("unix:///tmp/docker.sock"), "/tmp/docker.sock");
  for (const host of ["tcp://127.0.0.1:2375", "", undefined]) assert.throws(() => dockerEngineSocketPath(host), /local Docker Engine/u);
});
