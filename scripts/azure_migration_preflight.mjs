#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_POSTGRES_MAJOR = 17;
const DEFAULT_TARGET_STORAGE_GIB = 32;
const MAX_SOURCE_STORAGE_RATIO = 0.7;
const EXPECTED_APPLICATION_SECURITY_DEFINERS = new Set([
  "audit_project_job_terminal_state",
  "sync_project_owner_membership",
]);
const SUPABASE_PLATFORM_SECURITY_DEFINER = "rls_auto_enable";
const SUPABASE_PLATFORM_SECURITY_DEFINER_SHA256 =
  "2782e98b348aca7d6f6f73c420fd78d2e094957dd7a52b0483d4c34f29d2a7a1";
const EXPECTED_PUBLIC_TABLES = [
  "activity_events",
  "app_group_members",
  "app_groups",
  "app_principal_aliases",
  "app_principal_roles",
  "app_principals",
  "app_rate_limits",
  "app_sessions",
  "artifact_source_state",
  "audit_events",
  "chat_messages",
  "chat_sessions",
  "customer_analyses",
  "document_chunks",
  "document_intelligence_artifacts",
  "document_intelligence_events",
  "documents",
  "executive_summaries",
  "generated_artifacts",
  "guest_credentials",
  "project_group_grants",
  "project_job_claim_control",
  "project_jobs",
  "project_memberships",
  "project_service_selections",
  "projects",
  "service_descriptions",
  "service_documents",
  "solution_evaluations",
  "stable_customer_analysis_context_sync",
  "stable_primary_document_authority",
];

function expectedMigrationVersions() {
  const migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../supabase/migrations",
  );
  return readdirSync(migrationsDirectory)
    .map((name) => name.match(/^(\d{14})_.+\.sql$/u)?.[1] || "")
    .filter(Boolean)
    .sort();
}

function stop(message) {
  console.error(JSON.stringify({ status: "stop", reason: message }));
  process.exit(2);
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) stop(`${command} is unavailable.`);
  const major = Number(result.stdout.match(/\b(\d+)\./u)?.[1]);
  if (major !== EXPECTED_POSTGRES_MAJOR) {
    stop(`${command} major ${major || "unknown"} is unsafe; PostgreSQL 17 is required.`);
  }
  return major;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) stop(`Missing protected environment variable ${name}.`);
  return value;
}

function validateSourceUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    stop("SOURCE_DATABASE_URL is not a valid PostgreSQL URL.");
  }
  if (!/^postgres(?:ql)?:$/u.test(parsed.protocol)) {
    stop("SOURCE_DATABASE_URL must use the postgresql protocol.");
  }
  if (parsed.port === "6543") {
    stop("The transaction pooler on port 6543 cannot be used for a consistent dump.");
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    stop("SOURCE_DATABASE_URL must require TLS and hostname verification with sslmode=verify-full.");
  }
  if (!parsed.hostname || !parsed.username || !parsed.pathname.slice(1)) {
    stop("SOURCE_DATABASE_URL must include a host, user, and database name.");
  }
  return parsed;
}

function databaseEnvironment(raw) {
  const parsed = new URL(raw);
  const environment = { ...process.env };
  delete environment.SOURCE_DATABASE_URL;
  delete environment.TARGET_DATABASE_URL;
  environment.PGHOST = parsed.hostname;
  environment.PGPORT = parsed.port || "5432";
  environment.PGUSER = decodeURIComponent(parsed.username);
  environment.PGPASSWORD = decodeURIComponent(parsed.password);
  environment.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
  environment.PGSSLMODE = "verify-full";
  environment.PGCONNECT_TIMEOUT = environment.PGCONNECT_TIMEOUT || "15";
  const sslRootCert = parsed.searchParams.get("sslrootcert");
  if (sslRootCert) environment.PGSSLROOTCERT = sslRootCert;
  return environment;
}

function query(databaseUrl, sql) {
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql],
    {
      encoding: "utf8",
      // libpq treats PGDATABASE as a database name, not as a connection URI.
      // Parse the protected URI into environment fields so credentials never
      // enter the process argument list and psql cannot fall back to a local socket.
      env: databaseEnvironment(databaseUrl),
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    stop(`A read-only database preflight query failed: ${result.stderr.trim() || "unknown psql error"}`);
  }
  return result.stdout.trim();
}

function lines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function sameOrderedValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sourceInventory(databaseUrl) {
  const serverVersion = Number(query(databaseUrl, "SELECT current_setting('server_version_num');"));
  const postgresMajor = Math.floor(serverVersion / 10000);
  const publicTables = lines(
    query(
      databaseUrl,
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname;",
    ),
  );
  const rlsDisabledTables = lines(
    query(
      databaseUrl,
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity ORDER BY c.relname;",
    ),
  );
  const migrations = lines(
    query(
      databaseUrl,
      "SELECT version::text FROM supabase_migrations.schema_migrations ORDER BY version::text;",
    ),
  );
  const databaseBytes = Number(query(databaseUrl, "SELECT pg_database_size(current_database());"));
  const databaseLocale = JSON.parse(query(
    databaseUrl,
    `SELECT json_build_object(
      'collation', datcollate,
      'ctype', datctype,
      'encoding', pg_encoding_to_char(encoding),
      'provider', datlocprovider::text,
      'locale', datlocale,
      'icu_rules', daticurules,
      'collation_version', datcollversion
    )::text FROM pg_database WHERE datname=current_database();`,
  ));
  const runningJobs = Number(
    query(
      databaseUrl,
      "SELECT CASE WHEN to_regclass('public.project_jobs') IS NULL THEN -1 ELSE (SELECT count(*) FROM public.project_jobs WHERE status='running') END;",
    ),
  );
  const securityDefiners = lines(
    query(
      databaseUrl,
      `SELECT json_build_object(
        'name', p.proname,
        'arguments', pg_get_function_identity_arguments(p.oid),
        'owner', owner.rolname,
        'language', language_state.lanname,
        'result', pg_get_function_result(p.oid),
        'source_sha256', encode(sha256(convert_to(COALESCE(p.prosrc, ''), 'UTF8')), 'hex'),
        'settings', COALESCE(p.proconfig, ARRAY[]::text[]),
        'public_execute', EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
        ),
        'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
        'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
        'service_execute', has_function_privilege('service_role', p.oid, 'EXECUTE')
      )::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_roles owner ON owner.oid=p.proowner
      JOIN pg_language language_state ON language_state.oid=p.prolang
      WHERE n.nspname='public' AND p.prosecdef
      ORDER BY p.proname, p.oid;`,
    ),
  ).map((row) => JSON.parse(row));
  const securityDefinersValid =
    securityDefiners.length === EXPECTED_APPLICATION_SECURITY_DEFINERS.size + 1 &&
    securityDefiners.every(
      (definition) => {
        const isApplicationDefiner = EXPECTED_APPLICATION_SECURITY_DEFINERS.has(
          definition.name,
        );
        const isSupabasePlatformDefiner =
          definition.name === SUPABASE_PLATFORM_SECURITY_DEFINER;
        return (
          definition.arguments === "" &&
          definition.owner === "postgres" &&
          !definition.public_execute &&
          !definition.anon_execute &&
          !definition.authenticated_execute &&
          definition.service_execute &&
          ((isApplicationDefiner && definition.settings.includes('search_path=""')) ||
            (isSupabasePlatformDefiner &&
              definition.language === "plpgsql" &&
              definition.result === "event_trigger" &&
              definition.source_sha256 === SUPABASE_PLATFORM_SECURITY_DEFINER_SHA256 &&
              definition.settings.includes("search_path=pg_catalog")))
        );
      },
    ) &&
    new Set(securityDefiners.map((definition) => definition.name)).size ===
      EXPECTED_APPLICATION_SECURITY_DEFINERS.size + 1;
  return {
    postgresMajor,
    publicTables,
    rlsDisabledTables,
    migrations,
    databaseBytes,
    databaseCollation: databaseLocale.collation || "",
    databaseCtype: databaseLocale.ctype || "",
    databaseEncoding: databaseLocale.encoding || "",
    databaseLocaleProvider: databaseLocale.provider || "",
    databaseLocale: databaseLocale.locale || "",
    databaseIcuRules: databaseLocale.icu_rules ?? null,
    databaseCollationVersion: databaseLocale.collation_version || "",
    runningJobs,
    securityDefiners,
    securityDefinersValid,
  };
}

for (const tool of ["pg_dump", "pg_restore", "psql"]) commandVersion(tool);
const sourceDatabaseUrl = requiredEnvironment("SOURCE_DATABASE_URL");
validateSourceUrl(sourceDatabaseUrl);

const source = sourceInventory(sourceDatabaseUrl);
const expectedMigrations = expectedMigrationVersions();
const targetStorageGiB = Number(process.env.TARGET_STORAGE_GIB || DEFAULT_TARGET_STORAGE_GIB);
if (![32, 64, 128].includes(targetStorageGiB)) {
  stop("TARGET_STORAGE_GIB must be one of 32, 64, or 128.");
}
const maximumSourceBytes = targetStorageGiB * 1024 ** 3 * MAX_SOURCE_STORAGE_RATIO;
const failures = [];
if (source.postgresMajor !== EXPECTED_POSTGRES_MAJOR) failures.push("source PostgreSQL major is not 17");
if (!sameOrderedValues(source.publicTables, EXPECTED_PUBLIC_TABLES)) failures.push("public table inventory differs from the canonical 31-table set");
if (source.rlsDisabledTables.length) failures.push("one or more public tables do not have RLS enabled");
if (!sameOrderedValues(source.migrations, expectedMigrations)) failures.push("source migration history differs from the complete repository migration set");
if (source.databaseEncoding !== "UTF8") failures.push("source database encoding is not UTF8");
if (source.databaseCollation !== source.databaseCtype) failures.push("source collation and ctype differ; the Azure database template cannot preserve them independently");
if (
  source.databaseLocaleProvider !== "i" ||
  source.databaseLocale !== "en-US" ||
  source.databaseIcuRules !== null ||
  source.databaseCollationVersion !== "153.120"
) {
  failures.push("source ICU provider, locale, rules, or collation version differs from the validated Azure target contract");
}
if (source.runningJobs !== 0) failures.push(`${source.runningJobs} project job(s) are running`);
if (source.databaseBytes > maximumSourceBytes) failures.push("source size exceeds the 70% storage safety margin");
if (!source.securityDefinersValid) failures.push("SECURITY DEFINER inventory, settings, or ACLs are unexpected");

const report = {
  status: failures.length ? "stop" : "ready-for-database-validation-dump",
  source: {
    postgres_major: source.postgresMajor,
    public_tables: source.publicTables,
    rls_disabled_tables: source.rlsDisabledTables,
    database_bytes: source.databaseBytes,
    database_collation: source.databaseCollation,
    database_ctype: source.databaseCtype,
    database_encoding: source.databaseEncoding,
    database_locale_provider: source.databaseLocaleProvider,
    database_locale: source.databaseLocale,
    database_icu_rules: source.databaseIcuRules,
    database_collation_version: source.databaseCollationVersion,
    migrations: source.migrations,
    running_jobs: source.runningJobs,
    security_definers: source.securityDefiners,
  },
  target_storage_gib: targetStorageGiB,
  note: "This gate covers the database only. Blob inventory, checksums, references, and decryption have separate mandatory cutover gates.",
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(2);
