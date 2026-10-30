import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const databaseUrl = process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL;
const schema = readFileSync(new URL("../../../../../database/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../../../../database/migrations/20261030120000_vacant_primary_document_insert.sql", import.meta.url),
  "utf8",
);
const regression = readFileSync(
  new URL("../../../../../database/tests/vacant_primary_document.sql", import.meta.url),
  "utf8",
);

function sql(url, input) {
  const result = spawnSync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], {
    input, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function sqlAsync(url, input) {
  return new Promise((resolve) => {
    const child = spawn("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr }));
    child.stdin.end(input);
  });
}

function withDatabase(run) {
  const name = `vacant_primary_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  sql(databaseUrl, `create database ${name};`);
  return Promise.resolve()
    .then(() => {
      sql(target.toString(), [
        "set client_min_messages = warning; set anbud.allow_destructive_schema_rebuild = on;",
        schema,
      ].join("\n"));
      return run(target.toString());
    })
    .finally(() => sql(databaseUrl, `drop database ${name} with (force);`));
}

const payload = (title) => `jsonb_build_object('id', gen_random_uuid(), 'title', '${title}',
  'file_name', '${title}.pdf', 'file_format', 'pdf', 'content_type', 'application/pdf',
  'file_storage_bucket', 'documents', 'file_storage_path', 'projects/p/${title}.pdf')`;

test("postgres: a suggested primary role fills only a vacant role, on the baseline, after re-applying and after upgrading", {
  skip: !databaseUrl, timeout: 90_000,
}, () => withDatabase((url) => {
  sql(url, `set role service_role;\n${regression}`);
  // The migration is safe to apply to a database that already has it.
  sql(url, `reset role;\n${migration}\nset role service_role;\n${regression}`);
  // On a database from before it, the migration creates the function in one
  // transaction with its grants, so service_role can call it right away.
  sql(url, `drop function public.insert_vacant_primary_project_document(uuid, text, jsonb);
${migration}
set role service_role;
${regression}`);
  assert.equal(
    sql(url, "select has_function_privilege('anon', 'public.insert_vacant_primary_project_document(uuid, text, jsonb)', 'execute');"),
    "f",
    "the API roles cannot call it",
  );
  // The release preflight confirms the function and its grants.
  assert.equal(
    sql(url, "set role service_role; select public.vacant_primary_document_insert_preflight();"),
    "vacant-primary-document-insert-v1",
  );
  const missing = spawnSync("psql", [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: `drop function public.insert_vacant_primary_project_document(uuid, text, jsonb);
set role service_role;
select public.vacant_primary_document_insert_preflight();`,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /insert_vacant_primary_project_document is missing/u);
}));

test("postgres: concurrent suggested uploads leave exactly one primary customer document", {
  skip: !databaseUrl, timeout: 90_000,
}, () => withDatabase(async (url) => {
  const projectId = randomUUID();
  sql(url, `insert into public.projects (id, client_name, title) values ('${projectId}', 'Kunde', 'Samtidige opplastinger');`);
  const suggest = (title, holdSeconds) => sqlAsync(url, `set role service_role;
begin;
select coalesce(public.insert_vacant_primary_project_document('${projectId}', 'primary_customer_document', ${payload(title)}) ->> 'title', 'refused');
select pg_sleep(${holdSeconds});
commit;`);
  const first = suggest("first", 0.6);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = suggest("second", 0);
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(results.map((result) => result.stdout.split("\n")[0]), ["first", "refused"]);
  assert.equal(
    sql(url, `select string_agg(title || ':' || role, ',') from public.documents where project_id = '${projectId}';`),
    "first:primary_customer_document",
  );
}));
