import assert from "node:assert/strict";
import test from "node:test";

import {
  validatePostgresProvisioning,
  validatePostgrestProvisioning,
} from "./azure_migration_guardrails.mjs";

test("PostgreSQL provisioning accepts exact IPv4 addresses and source collation", () => {
  assert.deepEqual(
    validatePostgresProvisioning({
      allowedIpv4Addresses: ["20.100.165.210", "203.0.113.7", "20.100.165.210"],
      databaseCollation: "en_US.UTF-8",
    }),
    {
      allowedIpv4Addresses: ["20.100.165.210", "203.0.113.7"],
      databaseCollation: "en_US.UTF-8",
    },
  );
});

for (const address of ["0.0.0.0", "0.0.0.0/0", "20.100.165.0/24", "::1", "banana"]) {
  test(`PostgreSQL provisioning rejects unsafe address ${address}`, () => {
    assert.throws(
      () =>
        validatePostgresProvisioning({
          allowedIpv4Addresses: [address],
          databaseCollation: "en_US.UTF-8",
        }),
      /exact IPv4|Unsafe/u,
    );
  });
}

test("PostgREST provisioning requires an immutable digest", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    validatePostgrestProvisioning({ image: `postgrest/postgrest@sha256:${digest}` }),
    { image: `postgrest/postgrest@sha256:${digest}` },
  );
  assert.throws(
    () => validatePostgrestProvisioning({ image: "postgrest/postgrest:v12" }),
    /immutable/u,
  );
});
