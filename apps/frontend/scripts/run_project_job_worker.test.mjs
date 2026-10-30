import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(frontendRoot, "../..");
const candidateScript = path.join(frontendRoot, "scripts/run_project_job_worker.mjs");
// The image a rollback restores reads only PROJECT_JOB_WORKER_LIMIT.
const releasedScript = path.join(frontendRoot, "scripts/fixtures/run_project_job_worker.9e8a422f.mjs");

const bicep = readFileSync(path.join(repositoryRoot, "infra/azure/container-app.bicep"), "utf8");
const deployWorkflow = readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-azure.yml"), "utf8");

/**
 * The worker job env as the release deploys it: workflow env values, passed as
 * Bicep parameters, rendered into the worker container. Bicep bounds are
 * checked too, since the infrastructure step deploys them before any image.
 */
function deployedWorkerEnvironment() {
  const workflowEnv = Object.fromEntries(
    [...deployWorkflow.matchAll(/^ {2}(PROJECT_JOB_WORKER_[A-Z_]+): "([^"]*)"$/gmu)]
      .map((match) => [match[1], match[2]]),
  );
  const parameterSources = Object.fromEntries(
    [...deployWorkflow.matchAll(/^ +(projectJobWorker\w+)="\$(PROJECT_JOB_WORKER_[A-Z_]+)"$/gmu)]
      .map((match) => [match[1], match[2]]),
  );
  const environment = {};
  for (const match of bicep.matchAll(
    /name: '(PROJECT_JOB_WORKER_[A-Z_]+)'\s+value: string\((projectJobWorker\w+)\)/gu,
  )) {
    const [, name, parameter] = match;
    const source = parameterSources[parameter];
    assert.ok(source, `${parameter} is not passed by the deploy workflow`);
    const value = workflowEnv[source];
    assert.ok(value !== undefined, `${source} is not set in the deploy workflow`);
    const bounds = bicep.match(new RegExp(
      `((?:@\\w+\\([^)]*\\)\\s+)*)param ${parameter} int`, "u",
    ))?.[1] ?? "";
    const minimum = Number(bounds.match(/@minValue\((\d+)\)/u)?.[1] ?? -Infinity);
    const maximum = Number(bounds.match(/@maxValue\((\d+)\)/u)?.[1] ?? Infinity);
    assert.ok(Number(value) >= minimum && Number(value) <= maximum,
      `${parameter}=${value} is outside its Bicep bounds`);
    environment[name] = value;
  }
  return environment;
}

/** A stand-in for the Next server the worker script starts as `node server.js`. */
function fakeServerDirectory({ respond = true } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "anbud-worker-"));
  writeFileSync(path.join(directory, "server.js"), `
const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync("server.pid", String(process.pid));
http.createServer((request, response) => {
  if (request.url === "/api/health/live") { response.end("ok"); return; }
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    fs.writeFileSync("request.json", JSON.stringify({
      url: request.url,
      token: request.headers["x-worker-token"],
      body: JSON.parse(body),
      workerProcess: process.env.PROJECT_JOB_WORKER_PROCESS ?? null,
    }));
    if (${respond}) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ processed: 0, results: [] }));
    }
  });
}).on("error", (error) => {
  fs.writeFileSync("server.error", String(error.code));
  process.exit(1);
}).listen(Number(process.env.PORT), "127.0.0.1", () => fs.writeFileSync("server.listening", ""));
`);
  return directory;
}

/** A port the OS reports free. A fixed range collided with ephemeral ports
 * taken by parallel test servers (`listen(0)`), so the stand-in server could
 * not start and the worker waited for its health check until the timeout. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startWorker(script, environment, options, port) {
  const directory = fakeServerDirectory(options);
  const child = spawn(process.execPath, [script], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: String(port),
      PROJECT_JOB_WORKER_TOKEN: "worker-test-token",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    directory,
    exited,
    output: () => output,
    request: () => existsSync(path.join(directory, "request.json"))
      ? JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"))
      : null,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** The bind failure the stand-in reported, once it is listening, failed, or the worker exited. */
async function standInBindError(worker) {
  let done = false;
  worker.exited.then(() => { done = true; });
  const file = (name) => path.join(worker.directory, name);
  while (!done && !existsSync(file("server.listening")) && !existsSync(file("server.error"))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return existsSync(file("server.error")) ? readFileSync(file("server.error"), "utf8") : null;
}

/** Another test can still take the free port before the stand-in binds it, so
 * that collision gets a fresh port, up to three attempts. */
async function runWorker(script, environment, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const worker = startWorker(script, environment, options, await freePort());
    if (await standInBindError(worker) !== "EADDRINUSE") return worker;
    worker.child.kill("SIGTERM");
    await worker.exited;
    worker.cleanup();
    if (attempt === 3) assert.fail("the stand-in server could not bind a free port in three attempts");
  }
}

async function waitFor(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition was not reached in time");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the deployed worker env keeps the legacy limit at 1 and sets the new budget variables", () => {
  const environment = deployedWorkerEnvironment();
  assert.equal(environment.PROJECT_JOB_WORKER_LIMIT, "1");
  assert.equal(environment.PROJECT_JOB_WORKER_MAX_JOBS, "10");
  assert.equal(environment.PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS, "2100");
});

for (const [label, script, expectedLimit] of [
  ["the released worker image restored by a rollback", releasedScript, 1],
  ["the candidate worker image", candidateScript, 10],
]) {
  test(`${label} runs with the deployed worker env`, { timeout: 30_000 }, async () => {
    const worker = await runWorker(script, deployedWorkerEnvironment());
    try {
      const { code } = await worker.exited;
      assert.equal(code, 0, worker.output());
      const request = worker.request();
      assert.equal(request.url, "/api/project-jobs/worker");
      assert.equal(request.token, "worker-test-token");
      assert.equal(request.body.limit, expectedLimit);
    } finally {
      worker.cleanup();
    }
  });
}

test("the candidate plans against the replica timeout it is given", { timeout: 30_000 }, async () => {
  const startedAt = Date.now();
  const worker = await runWorker(candidateScript, {
    ...deployedWorkerEnvironment(),
    PROJECT_JOB_WORKER_REPLICA_TIMEOUT_SECONDS: "3600",
  });
  try {
    assert.equal((await worker.exited).code, 0, worker.output());
    const { body, workerProcess } = worker.request();
    const expected = startedAt + 3600_000 - 60_000;
    assert.ok(Math.abs(body.deadline_at - expected) < 5_000, `deadline ${body.deadline_at} vs ${expected}`);
    assert.equal(workerProcess, "1", "the server knows it must not drain into its own queue");
  } finally {
    worker.cleanup();
  }
});

test("both images refuse a legacy limit other than 1", { timeout: 30_000 }, async () => {
  for (const script of [releasedScript, candidateScript]) {
    const worker = await runWorker(script, { ...deployedWorkerEnvironment(), PROJECT_JOB_WORKER_LIMIT: "10" });
    try {
      assert.equal((await worker.exited).code, 1);
      assert.match(worker.output(), /PROJECT_JOB_WORKER_LIMIT must be 1\./u);
      assert.equal(worker.request(), null);
    } finally {
      worker.cleanup();
    }
  }
});

test("the candidate rejects an out-of-range job count before starting the server", { timeout: 30_000 }, async () => {
  const worker = await runWorker(candidateScript, { ...deployedWorkerEnvironment(), PROJECT_JOB_WORKER_MAX_JOBS: "11" });
  try {
    assert.equal((await worker.exited).code, 1);
    assert.match(worker.output(), /PROJECT_JOB_WORKER_MAX_JOBS must be an integer from 1 to 10\./u);
    assert.equal(existsSync(path.join(worker.directory, "server.pid")), false);
  } finally {
    worker.cleanup();
  }
});

test("stopping the worker replica also stops its server", { timeout: 30_000 }, async () => {
  const worker = await runWorker(candidateScript, deployedWorkerEnvironment(), { respond: false });
  try {
    await waitFor(() => worker.request() !== null);
    const serverPid = Number(readFileSync(path.join(worker.directory, "server.pid"), "utf8"));
    assert.ok(processAlive(serverPid));
    worker.child.kill("SIGTERM");
    const { code } = await worker.exited;
    assert.equal(code, 143);
    await waitFor(() => !processAlive(serverPid));
  } finally {
    worker.cleanup();
  }
});
