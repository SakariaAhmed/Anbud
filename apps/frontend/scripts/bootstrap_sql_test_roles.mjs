#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const databaseUrls = [
  process.env.PRIMARY_DOCUMENT_SQL_TEST_DATABASE_URL,
  process.env.PROJECT_JOB_LOCK_SQL_TEST_DATABASE_URL,
  process.env.DOCUMENT_CHUNKS_SQL_TEST_DATABASE_URL,
  process.env.SERVICE_DOCUMENT_SQL_TEST_DATABASE_URL,
].filter(Boolean);

const uniqueDatabaseUrls = [...new Set(databaseUrls)];

if (uniqueDatabaseUrls.length === 0) {
  process.exit(0);
}

const sql = `
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin nosuperuser nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
end
$roles$;
`;

for (const databaseUrl of uniqueDatabaseUrls) {
  const result = spawnSync(
    "psql",
    [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Could not initialize PostgreSQL test roles.\n${details}`);
  }
}

console.log(`Initialized PostgreSQL API roles for ${uniqueDatabaseUrls.length} test database(s).`);
