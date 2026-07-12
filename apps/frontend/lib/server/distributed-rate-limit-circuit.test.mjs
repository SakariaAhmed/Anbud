import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "rate-limit-circuit-tests.cjs"), {
  interopDefault: true,
  alias: {
    "@": frontendRoot,
    "server-only": "/dev/null",
  },
});

const {
  beginDistributedRateLimitAttempt,
  createDistributedRateLimitCircuitState,
  recordDistributedRateLimitFailure,
  recordDistributedRateLimitSuccess,
  withAbortTimeout,
} = jiti(
  path.join(frontendRoot, "lib/server/distributed-rate-limit-circuit.ts"),
);
const { checkRateLimit } = jiti(
  path.join(frontendRoot, "lib/server/observability.ts"),
);

test("distributed rate-limit circuit opens, admits one recovery probe and closes", () => {
  const state = createDistributedRateLimitCircuitState();

  assert.equal(beginDistributedRateLimitAttempt(state, 0), true);
  recordDistributedRateLimitFailure(state, 0);
  assert.equal(state.status, "closed");

  assert.equal(beginDistributedRateLimitAttempt(state, 1), true);
  recordDistributedRateLimitFailure(state, 1);
  assert.equal(state.status, "open");
  assert.equal(beginDistributedRateLimitAttempt(state, state.openUntil - 1), false);

  assert.equal(beginDistributedRateLimitAttempt(state, state.openUntil), true);
  assert.equal(state.status, "half_open");
  assert.equal(beginDistributedRateLimitAttempt(state, state.openUntil), false);

  recordDistributedRateLimitSuccess(state);
  assert.equal(state.status, "closed");
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(beginDistributedRateLimitAttempt(state, state.openUntil), true);
});

test("distributed rate-limit timeout aborts the in-flight request", async () => {
  let observedAbort = false;
  const result = await withAbortTimeout(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    5,
  );

  assert.equal(result, null);
  assert.equal(observedAbort, true);
});

test("database outage uses the configured conservative local fallback", async (t) => {
  const saved = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    trust: process.env.TRUST_FORWARDED_RATE_LIMIT_HEADERS,
  };
  t.after(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    if (saved.trust === undefined) {
      delete process.env.TRUST_FORWARDED_RATE_LIMIT_HEADERS;
    } else {
      process.env.TRUST_FORWARDED_RATE_LIMIT_HEADERS = saved.trust;
    }
  });

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.TRUST_FORWARDED_RATE_LIMIT_HEADERS = "true";
  globalThis.__anbudRateLimits = new Map();
  globalThis.__anbudDatabaseRateLimitCircuit =
    createDistributedRateLimitCircuitState();

  const request = new Request("http://localhost/api/test", {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  const options = { limit: 10, fallbackLimit: 2, windowMs: 60_000 };

  assert.equal((await checkRateLimit(request, "outage-test", options)).allowed, true);
  assert.equal((await checkRateLimit(request, "outage-test", options)).allowed, true);
  const rejected = await checkRateLimit(request, "outage-test", options);
  assert.equal(rejected.allowed, false);
  assert.ok(rejected.retryAfterSeconds > 0);
});
