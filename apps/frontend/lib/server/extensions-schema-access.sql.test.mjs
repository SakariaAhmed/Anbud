import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../..");
const databaseUrl = process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL;

function sql(url, input) {
  return spawnSync("psql", [url, "-X", "-Atq", "-v", "ON_ERROR_STOP=1"], {
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("postgres: baseline and upgrade allow service-role vector writes without schema creation or public access", {
  skip: !databaseUrl,
  timeout: 60_000,
}, () => {
  const name = `anbud_extensions_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${name}`;
  const target = isolatedUrl.toString();
  succeeds(sql(databaseUrl, `create database "${name}";`));
  try {
    succeeds(sql(target, "set anbud.allow_destructive_schema_rebuild=on;\n" +
      readFileSync(path.join(root, "database/schema.sql"), "utf8")));
    succeeds(sql(target, `
      create table public.vector_probe (id integer primary key, embedding extensions.vector(3));
      grant select, insert on public.vector_probe to service_role;
    `));
    const writeAsService = (id) => sql(target, `
      set role service_role;
      insert into public.vector_probe values (${id}, '[1,2,3]'::extensions.vector);
      select extensions.vector_dims(embedding) from public.vector_probe where id=${id};
    `);
    assert.equal(succeeds(writeAsService(1)), "3");

    // Reproduce an existing installation with the missing schema privilege.
    succeeds(sql(target, "revoke usage on schema extensions from service_role;"));
    const failure = writeAsService(2);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /permission denied for schema extensions/u);
    const migration = readFileSync(path.join(root,
      "database/migrations/20260924183000_service_role_extensions_access.sql"), "utf8");
    succeeds(sql(target, migration));
    succeeds(sql(target, migration));
    assert.equal(succeeds(writeAsService(2)), "3");
    assert.equal(succeeds(sql(target,
      "select count(*) from public.vector_probe where embedding::text='[1,2,3]';")), "2");

    const schemaCreate = sql(target,
      "set role service_role; create table extensions.must_not_be_created(id integer);");
    assert.notEqual(schemaCreate.status, 0);
    assert.match(schemaCreate.stderr, /permission denied for schema extensions/u);
    for (const role of ["anon", "authenticated"]) {
      const denied = sql(target, `set role ${role}; select '[1,2,3]'::extensions.vector;`);
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /permission denied for schema extensions/u);
      assert.equal(succeeds(sql(target, `select has_function_privilege('${role}',
        'public.replace_document_chunks_atomic(text,uuid,text,bigint,integer,jsonb)', 'EXECUTE');`)), "f");
    }
  } finally {
    succeeds(sql(databaseUrl, `drop database "${name}" with (force);`));
  }
});
