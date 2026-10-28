import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;

test("postgres: the destructive baseline reset can run twice and restores project foreign keys", {
  skip: !databaseUrl, timeout: 120_000,
}, () => {
  const name = `schema_rerun_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  target.searchParams.delete("dbname");
  function sql(url, input) {
    const result = spawnSync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], {
      input, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  sql(databaseUrl, `create database ${name};`);
  try {
    const schema = readFileSync(new URL("../../../../database/schema.sql", import.meta.url), "utf8");
    const reset = ["set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;", schema].join("\n");
    const projectForeignKeys = `
      select count(*) from pg_constraint
      where contype = 'f' and confrelid = 'public.projects'::regclass
        and conrelid in ('public.project_memberships'::regclass, 'public.project_group_grants'::regclass,
                         'public.activity_events'::regclass);
    `;
    const allForeignKeys = `
      select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public';
    `;
    assert.equal(sql(target.toString(), "select current_database()"), name);
    sql(target.toString(), reset);
    assert.equal(Number(sql(target.toString(), projectForeignKeys)), 3);
    const totalAfterFirst = Number(sql(target.toString(), allForeignKeys));
    sql(target.toString(), reset);
    assert.equal(Number(sql(target.toString(), projectForeignKeys)), 3);
    assert.equal(Number(sql(target.toString(), allForeignKeys)), totalAfterFirst);
  } finally {
    sql(databaseUrl, `drop database ${name} with (force);`);
  }
});
