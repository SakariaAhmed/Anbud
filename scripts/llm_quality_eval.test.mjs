import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./llm_quality_eval.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

/** A stand-in for the app API holding projects and services in memory.
 * `onUpload` and `onProjectDelete` may return a promise to hold the response;
 * `onProjectDelete` resolving to headers answers 429 with them. */
async function startFakeApi({ onUpload = () => undefined, onProjectDelete = () => undefined, onServiceCreate, onServiceResponse } = {}) {
  const projects = new Map();
  const services = new Map();
  const requests = [];
  let nextId = 1;
  let uploads = 0;
  const listeners = { serviceListing: () => {}, serviceCreated: () => {} };

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const route = new URL(request.url, "http://localhost").pathname;
    requests.push(`${request.method} ${route}`);
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(payload));
    };

    if (request.method === "GET" && route === "/api/health/live") return send(200, { ok: true });
    if (request.method === "POST" && route === "/api/auth/login") {
      return send(200, { ok: true }, { "set-cookie": "session=test; Path=/" });
    }
    if (request.method === "POST" && route === "/api/projects") {
      const id = `project-${nextId++}`;
      projects.set(id, { id, name: JSON.parse(body.toString("utf8")).name });
      return send(201, { id });
    }
    if (request.method === "GET" && route === "/api/projects") {
      return send(200, { projects: [...projects.values()] });
    }
    if (request.method === "GET" && route === "/api/service-descriptions") {
      listeners.serviceListing();
      return send(200, { services: [...services.values()] });
    }
    if (request.method === "POST" && route === "/api/service-descriptions") {
      const form = await new Response(body, {
        headers: { "content-type": request.headers["content-type"] },
      }).formData();
      if (onServiceCreate) await onServiceCreate();
      const id = `service-${nextId++}`;
      services.set(id, { id, name: form.get("name") });
      listeners.serviceCreated();
      if (onServiceResponse) await onServiceResponse();
      if (onServiceCreate || onServiceResponse) return send(201, { service: { id } });
      // Never answers: a service that exists on the server before the
      // script has seen its ID.
      return;
    }
    const upload = route.match(/^\/api\/projects\/([^/]+)\/documents$/);
    if (request.method === "POST" && upload) {
      uploads += 1;
      const count = uploads;
      await onUpload(count, listeners);
      return send(201, {
        document: { id: `document-${count}` },
        job: { id: `job-${count}`, status: "queued" },
      });
    }
    const job = route.match(/^\/api\/projects\/([^/]+)\/jobs\/([^/]+)$/);
    if (request.method === "GET" && job) {
      return send(200, {
        job: { id: job[2], status: "completed", result: { document: { id: `final-${job[2]}` } } },
      });
    }
    const project = route.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === "DELETE" && project) {
      const limited = await onProjectDelete(project[1], listeners);
      if (limited) return send(429, { error: "For mange sletteoperasjoner på kort tid." }, limited);
      return send(projects.delete(project[1]) ? 200 : 404, {});
    }
    const service = route.match(/^\/api\/service-descriptions\/([^/]+)$/);
    if (request.method === "DELETE" && service) {
      return send(services.delete(service[1]) ? 200 : 404, {});
    }
    send(404, { error: `unexpected ${request.method} ${route}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projects,
    services,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Runs the evaluation against `baseUrl` and sends SIGINT once
 * `interruptWhen` resolves. The judge is never reached. */
async function runInterrupted(t, baseUrl, interruptWhen) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-quality-eval-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, "test.env");
  const bilag1Path = path.join(directory, "bilag1.pdf");
  await writeFile(envPath, "APP_ACCESS_PASSWORD=test-password\nOPENAI_API_KEY=test-not-a-key\n");
  await writeFile(bilag1Path, "%PDF-1.4\n");

  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--current-base", baseUrl,
      "--main-base", baseUrl,
      "--env", envPath,
      "--repo", repoRoot,
      "--bilag1", bilag1Path,
      "--out", path.join(directory, "report.json"),
      "--rounds", "1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const early = await Promise.race([interruptWhen, exited.then((code) => ({ code }))]);
    assert.equal(early?.code, undefined, `exited ${early?.code} before the interrupt point: ${stderr}`);
    child.kill("SIGINT");
    return { code: await exited, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}

test("an interrupted run polls upload jobs and creates nothing after cleanup starts", async (t) => {
  let thirdUploadReceived;
  const interruptWhen = new Promise((resolve) => {
    thirdUploadReceived = resolve;
  });
  const api = await startFakeApi({
    onUpload: (count, listeners) => {
      if (count < 3) return undefined;
      thirdUploadReceived();
      // Answer the upload only once the shutdown sweep has listed services,
      // so the scenario moves on to create its service during cleanup.
      return new Promise((resolve) => {
        listeners.serviceListing = () => setTimeout(resolve, 10);
      });
    },
    // Keep the shutdown cleanup running until the scenario creates a
    // service, or long enough that it would have.
    onProjectDelete: (id, listeners) =>
      new Promise((resolve) => {
        listeners.serviceCreated = resolve;
        setTimeout(resolve, 2_000);
      }),
  });
  t.after(() => api.close());

  const { code, stderr } = await runInterrupted(t, api.baseUrl, interruptWhen);

  assert.equal(code, 130, stderr);
  assert.ok(api.requests.includes("GET /api/projects/project-1/jobs/job-1"), api.requests.join("\n"));
  assert.ok(api.requests.includes("GET /api/projects/project-1/jobs/job-2"), api.requests.join("\n"));
  assert.ok(!api.requests.includes("POST /api/service-descriptions"), api.requests.join("\n"));
  assert.deepEqual([...api.services.keys()], []);
  assert.deepEqual([...api.projects.keys()], []);
});

test("shutdown waits for a creation committing after the old 30-second sweep deadline", async (t) => {
  let creationStarted;
  const interruptWhen = new Promise((resolve) => { creationStarted = resolve; });
  const api = await startFakeApi({
    onServiceCreate: async () => {
      creationStarted();
      await new Promise((resolve) => setTimeout(resolve, 31_000));
    },
  });
  t.after(() => api.close());
  const { code, stderr } = await runInterrupted(t, api.baseUrl, interruptWhen);
  assert.equal(code, 130, stderr);
  assert.deepEqual([...api.services.keys()], []);
  assert.deepEqual([...api.projects.keys()], []);
  assert.ok(api.requests.some((request) => request.startsWith("DELETE /api/service-descriptions/")));
  assert.ok(!api.requests.some((request) => /^POST .*\/jobs$/u.test(request)), api.requests.join("\n"));
});

test("shutdown removes committed resources while a creation response is still stalled", async (t) => {
  let creationStarted;
  let finishResponse;
  let cleanupBeforeResponse = false;
  const interruptWhen = new Promise((resolve) => { creationStarted = resolve; });
  const api = await startFakeApi({
    onServiceResponse: () => new Promise((resolve) => {
      finishResponse = resolve;
      creationStarted();
    }),
    onProjectDelete: () => {
      cleanupBeforeResponse = true;
      assert.equal(api.services.size, 0, "the service is swept before its response finishes");
      finishResponse();
    },
  });
  t.after(() => api.close());
  const { code, stderr } = await runInterrupted(t, api.baseUrl, interruptWhen);
  assert.equal(code, 130, stderr);
  assert.equal(cleanupBeforeResponse, true);
  assert.equal(api.services.size, 0);
  assert.equal(api.projects.size, 0);
});

test("cleanup waits for the DELETE limiter's Retry-After before retrying", async (t) => {
  let firstUploadReceived;
  const interruptWhen = new Promise((resolve) => {
    firstUploadReceived = resolve;
  });
  const deleteTimes = [];
  const api = await startFakeApi({
    onUpload: () => {
      firstUploadReceived();
      return new Promise(() => {});
    },
    // Limited for 4 s, longer than the 1 s + 2 s fallback backoff.
    onProjectDelete: () => {
      deleteTimes.push(Date.now());
      return Date.now() - deleteTimes[0] < 4_000 ? { "retry-after": "4" } : null;
    },
  });
  t.after(() => api.close());

  const { code, stderr } = await runInterrupted(t, api.baseUrl, interruptWhen);

  assert.equal(code, 130, stderr);
  assert.equal(deleteTimes.length, 2, `DELETE times: ${deleteTimes.map((at) => at - deleteTimes[0])}`);
  assert.ok(deleteTimes[1] - deleteTimes[0] >= 3_900);
  assert.deepEqual([...api.projects.keys()], []);
});
