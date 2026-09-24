import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

for (const mode of ["baseline", "populated upgrade"]) {
  test(`guest credential authority (${mode}) denies owners and preserves administrator recovery`, {
    skip: !databaseUrl, timeout: 60_000,
  }, () => {
    const name = `guest_auth_test_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(databaseUrl);
    target.pathname = `/${name}`;
    const run = (url, sql) => spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-q"], {
      input: sql, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(run(databaseUrl, `create database ${name};`).status, 0);
    try {
      const schema = readFileSync(path.join(root, "database/schema.sql"), "utf8");
      const migration = readFileSync(path.join(root, "database/migrations/20260906093000_guest_credential_authority.sql"), "utf8");
      const regression = readFileSync(path.join(root, "database/tests/guest_credential_authority.sql"), "utf8");
      const marker = schema.lastIndexOf("-- Separate project sharing from account-wide guest credential management.");
      assert.ok(marker > 0);
      const result = run(target.toString(), [
        "set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;",
        mode === "baseline" ? schema : schema.slice(0, marker),
        // This existing account state predates the migration in the upgrade case.
        `insert into public.app_principals(id, identity_type, display_name, email_hmac, email_encrypted, email_masked, guest_description)
         values ('g_security_missing_000000000000001', 'guest', 'Existing Guest', 'security-missing', 'encrypted', 'gu***@example.test', 'Guest reviewer');`,
        mode === "baseline" ? "" : migration,
        "set role service_role;",
        regression,
      ].join("\n"));
      assert.equal(result.status, 0, result.stderr);
    } finally {
      const dropped = run(databaseUrl, `drop database ${name} with (force);`);
      assert.equal(dropped.status, 0, dropped.stderr);
    }
  });
}
