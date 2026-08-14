import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(path.join(frontendRoot, "node_modules", "jiti"));
const jiti = createJiti(path.join(frontendRoot, "data-api-config-tests.cjs"), {
  interopDefault: true,
  alias: { "@": frontendRoot },
});
const { dataApiConfiguration } = jiti(
  path.join(frontendRoot, "lib/data-api-config.ts"),
);

const variableNames = [
  "DATA_API_URL",
  "DATA_API_SERVICE_ROLE_KEY",
  "DATA_API_ALLOWED_HOST_SUFFIX",
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function withEnvironment(values, action) {
  const saved = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of variableNames) delete process.env[name];
    Object.assign(process.env, values);
    return action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("data API config preserves the existing Supabase REST contract", () => {
  withEnvironment(
    {
      SUPABASE_URL: "https://project.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "supabase-key",
    },
    () =>
      assert.deepEqual(dataApiConfiguration(), {
        baseUrl: "https://project.supabase.co/rest/v1",
        serviceKey: "supabase-key",
        backend: "supabase",
      }),
  );
});

test("explicit internal data API takes precedence and requires a complete pair", () => {
  withEnvironment(
    {
      DATA_API_URL: "https://internal.example/",
      DATA_API_SERVICE_ROLE_KEY: "azure-key",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "supabase-key",
    },
    () =>
      assert.deepEqual(dataApiConfiguration(), {
        baseUrl: "https://internal.example",
        serviceKey: "azure-key",
        backend: "azure",
      }),
  );
  withEnvironment({ DATA_API_URL: "https://incomplete.example" }, () => {
    assert.equal(dataApiConfiguration(), null);
  });
  withEnvironment(
    {
      DATA_API_URL: "https://user:password@internal.example",
      DATA_API_SERVICE_ROLE_KEY: "must-not-be-forwarded",
    },
    () => assert.equal(dataApiConfiguration(), null),
  );
});

test("production data API credentials are limited to the internal ACA domain", () => {
  const valid = {
    NODE_ENV: "production",
    DATA_API_URL:
      "https://anbud-postgrest.internal.kindstone-123.norwayeast.azurecontainerapps.io",
    DATA_API_SERVICE_ROLE_KEY: "azure-key",
    DATA_API_ALLOWED_HOST_SUFFIX:
      ".internal.kindstone-123.norwayeast.azurecontainerapps.io",
  };
  withEnvironment(valid, () => {
    assert.equal(dataApiConfiguration()?.backend, "azure");
  });
  withEnvironment(
    { ...valid, DATA_API_URL: "https://credential-capture.example" },
    () => assert.equal(dataApiConfiguration(), null),
  );
  withEnvironment(
    { ...valid, DATA_API_ALLOWED_HOST_SUFFIX: "credential-capture.example" },
    () => assert.equal(dataApiConfiguration(), null),
  );
});
