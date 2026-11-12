import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectJobWorkerHasPendingWork } from "./project_job_worker_pending_work.mjs";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "project-job-worker-pending-work-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const { dataApiConfiguration } = jiti(path.join(frontendRoot, "lib/data-api-config.ts"));

const internalEnv = {
  DATA_API_URL: "https://anbud-postgrest.internal.example.norwayeast.azurecontainerapps.io",
  DATA_API_SERVICE_ROLE_KEY: "service-role-key-for-tests",
  DATA_API_ALLOWED_HOST_SUFFIX: ".internal.example.norwayeast.azurecontainerapps.io",
};

/** Answers each table from `tables`; records every request. */
function fakeDataApi(tables) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, signal: init.signal });
    const table = new URL(url).pathname.split("/").pop();
    const answer = tables[table];
    if (typeof answer === "function") return answer(init);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetchImpl, requests };
}

async function check(tables, env = internalEnv, options = {}) {
  const api = fakeDataApi(tables);
  const reasons = [];
  const result = await projectJobWorkerHasPendingWork({
    env,
    fetchImpl: api.fetchImpl,
    onUnknown: (reason) => reasons.push(reason),
    ...options,
  });
  return { result, reasons, requests: api.requests };
}

const empty = { body: [] };

test("no running/queued job and no pending analysis means no work", async () => {
  const { result, reasons, requests } = await check({ project_jobs: empty, project_analysis_requests: empty });
  assert.equal(result, false);
  assert.deepEqual(reasons, []);
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    `${internalEnv.DATA_API_URL}/project_analysis_requests?select=project_id&status=eq.pending&limit=1`,
    `${internalEnv.DATA_API_URL}/project_jobs?select=id&status=in.(queued,running)&limit=1`,
  ]);
  for (const request of requests) {
    assert.equal(request.headers.apikey, internalEnv.DATA_API_SERVICE_ROLE_KEY);
    assert.equal(request.headers.authorization, `Bearer ${internalEnv.DATA_API_SERVICE_ROLE_KEY}`);
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test("a running or queued job is work", async () => {
  const { result } = await check({ project_jobs: { body: [{ id: "job" }] }, project_analysis_requests: empty });
  assert.equal(result, true);
});

test("a pending automatic analysis is work even with no job rows", async () => {
  const { result } = await check({ project_jobs: empty, project_analysis_requests: { body: [{ project_id: "p" }] } });
  assert.equal(result, true);
});

test("work found by one query wins over a failure of the other", async () => {
  const { result } = await check({
    project_jobs: { body: [{ id: "job" }] },
    project_analysis_requests: { status: 503, body: { message: "unavailable" } },
  });
  assert.equal(result, true);
});

test("an empty answer with a failed query is unknown, not idle", async () => {
  for (const [answer, reason] of [
    [{ status: 503, body: { message: "unavailable" } }, "http_503"],
    [{ status: 404, body: { code: "PGRST205" } }, "http_404"],
    [{ body: { not: "an array" } }, "invalid_response"],
    [new TypeError("fetch failed"), "request_failed"],
  ]) {
    const { result, reasons } = await check({ project_jobs: empty, project_analysis_requests: answer });
    assert.equal(result, null, reason);
    assert.deepEqual(reasons, [reason]);
  }
});

test("a slow data API times out as unknown", async () => {
  // A real hung request holds its socket open; AbortSignal.timeout alone
  // does not keep the process alive, so hold a timer in its place.
  const hang = (init) => new Promise((_, reject) => {
    const socket = setTimeout(() => {}, 60_000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(socket);
      reject(init.signal.reason);
    });
  });
  const { result, reasons } = await check(
    { project_jobs: hang, project_analysis_requests: empty },
    internalEnv,
    { timeoutMs: 20 },
  );
  assert.equal(result, null);
  assert.deepEqual(reasons, ["timeout"]);
});

test("failure reasons never quote the response body", async () => {
  const leakyBody = () => new Response("<html>secret-body-text</html>", { status: 200 });
  const { result, reasons } = await check({ project_jobs: leakyBody, project_analysis_requests: empty });
  assert.equal(result, null);
  assert.deepEqual(reasons, ["request_failed"]);
});

test("a trailing slash or base path is kept in the request root", async () => {
  const { requests } = await check(
    { project_jobs: empty, project_analysis_requests: empty },
    { ...internalEnv, DATA_API_URL: `${internalEnv.DATA_API_URL}/rest//` },
  );
  assert.ok(requests.every((request) => request.url.startsWith(`${internalEnv.DATA_API_URL}/rest/project_`)));
});

const configurationCases = [
  ["the internal HTTPS host", internalEnv],
  ["a missing URL", { ...internalEnv, DATA_API_URL: "" }],
  ["a missing key", { ...internalEnv, DATA_API_SERVICE_ROLE_KEY: " " }],
  ["a missing host suffix", { ...internalEnv, DATA_API_ALLOWED_HOST_SUFFIX: "" }],
  ["a non-internal host suffix", { ...internalEnv, DATA_API_ALLOWED_HOST_SUFFIX: ".azurecontainerapps.io" }],
  ["plain HTTP", { ...internalEnv, DATA_API_URL: internalEnv.DATA_API_URL.replace("https:", "http:") }],
  ["a host outside the suffix", { ...internalEnv, DATA_API_URL: "https://attacker.example" }],
  ["the bare suffix as host", { ...internalEnv, DATA_API_URL: `https://${internalEnv.DATA_API_ALLOWED_HOST_SUFFIX.slice(1)}` }],
  ["URL credentials", { ...internalEnv, DATA_API_URL: internalEnv.DATA_API_URL.replace("https://", "https://user:pass@") }],
  ["a query string", { ...internalEnv, DATA_API_URL: `${internalEnv.DATA_API_URL}?x=1` }],
  ["a fragment", { ...internalEnv, DATA_API_URL: `${internalEnv.DATA_API_URL}#x` }],
  ["an unparsable URL", { ...internalEnv, DATA_API_URL: "not a url" }],
];

test("the key goes only to a data API the production server would also accept", async () => {
  const saved = { ...process.env };
  try {
    for (const [label, env] of configurationCases) {
      for (const name of Object.keys(internalEnv)) delete process.env[name];
      Object.assign(process.env, env, { NODE_ENV: "production" });
      const server = dataApiConfiguration();
      const { result, reasons, requests } = await check({ project_jobs: empty, project_analysis_requests: empty }, env);

      if (server) {
        assert.equal(result, false, label);
        assert.ok(requests.every((request) => request.url.startsWith(`${server.baseUrl}/`)), label);
      } else {
        assert.equal(result, null, label);
        assert.deepEqual(reasons, ["no_internal_data_api"], label);
        assert.equal(requests.length, 0, `${label}: the key must not be sent`);
      }
    }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
