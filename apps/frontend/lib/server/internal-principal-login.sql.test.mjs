import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test("identity login preserves the singleton admin and rejects disabled identities and their sessions", {
  skip: !databaseUrl,
  timeout: 60_000,
}, () => {
  const name = `auth_test_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  const run = (url, sql) => spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-q"], {
    input: sql, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  const created = run(databaseUrl, `create database ${name};`);
  assert.equal(created.status, 0, created.stderr);
  try {
    const schema = readFileSync(path.join(root, "database/schema.sql"), "utf8");
    const migration = readFileSync(path.join(root, "database/migrations/20260905030000_preserve_disabled_principals_on_login.sql"), "utf8");
    const regression = readFileSync(path.join(root, "database/tests/internal_principal_login.sql"), "utf8");
    const result = run(target.toString(), [
      "set anbud.allow_destructive_schema_rebuild = on;",
      schema,
      migration,
      "set role service_role;",
      regression,
    ].join("\n"));
    assert.equal(result.status, 0, result.stderr);
  } finally {
    const dropped = run(databaseUrl, `drop database ${name} with (force);`);
    assert.equal(dropped.status, 0, dropped.stderr);
  }
});
