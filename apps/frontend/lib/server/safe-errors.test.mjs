import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "safe-errors-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});

const { productionSafeErrorMessage, safeErrorTelemetry } = jiti(
  path.join(frontendRoot, "lib/server/safe-errors.ts"),
);

test("production error messages expose only a request id and stable hash", (t) => {
  const previousNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });
  process.env.NODE_ENV = "production";

  const error = Object.assign(
    new Error('Raw model output: {"customer_secret":"do-not-log"}'),
    { request_id: "req_safe-123" },
  );
  const telemetry = safeErrorTelemetry(error);
  const message = productionSafeErrorMessage(error, "AI-kallet feilet.");

  assert.deepEqual(telemetry.request_id, "req_safe-123");
  assert.match(telemetry.error_hash, /^[a-f0-9]{24}$/u);
  assert.match(message, /req_safe-123/u);
  assert.match(message, new RegExp(telemetry.error_hash, "u"));
  assert.doesNotMatch(message, /customer_secret|do-not-log|Raw model output/u);
  assert.deepEqual(Object.keys(telemetry).sort(), ["error_hash", "request_id"]);
});

test("unsafe request ids are discarded", () => {
  const telemetry = safeErrorTelemetry(
    Object.assign(new Error("provider failed"), {
      request_id: "request id with spaces and raw data",
    }),
  );

  assert.equal(telemetry.request_id, null);
  assert.match(telemetry.error_hash, /^[a-f0-9]{24}$/u);
});
