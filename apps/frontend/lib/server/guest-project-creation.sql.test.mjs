import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test("postgres: guest project ownership preserves guest identity, login and access boundaries", {
  skip: !databaseUrl, timeout: 60_000,
}, () => {
  const name = `guest_project_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  function sql(url, input) {
    const result = spawnSync("psql", [url, "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
      input, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  sql(databaseUrl, `create database ${name};`);
  try {
    const schema = readFileSync(new URL("../../../../database/schema.sql", import.meta.url), "utf8");
    const regression = readFileSync(new URL("../../../../database/tests/guest_owned_project.sql", import.meta.url), "utf8");
    sql(target.toString(), [
      "set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;",
      schema, "set role service_role;", regression,
    ].join("\n"));
  } finally {
    sql(databaseUrl, `drop database ${name} with (force);`);
  }
});
