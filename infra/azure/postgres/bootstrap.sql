\set ON_ERROR_STOP on

-- Run once as the Azure bootstrap administrator before restoring the sanitized
-- public-schema dump. This script intentionally creates no Supabase platform roles.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anbud_owner') THEN
    CREATE ROLE anbud_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'anbud_owner'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Existing role anbud_owner has unexpected privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'anon'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Existing role anon has unexpected privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'authenticated'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Existing role authenticated has unexpected privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'service_role'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Existing role service_role has unexpected privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anbud_authenticator') THEN
    CREATE ROLE anbud_authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'anbud_authenticator'
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Existing role anbud_authenticator has unexpected privileges';
  END IF;
END
$bootstrap$;

GRANT anbud_owner TO CURRENT_USER;
GRANT service_role TO anbud_authenticator;
REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE, CREATE ON SCHEMA public TO anbud_owner;

CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION anbud_owner;
ALTER SCHEMA extensions OWNER TO anbud_owner;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC, anon, authenticated;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA public, extensions TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE anbud_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE anbud_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE anbud_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anbud_owner, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE anbud_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Re-run this script after pg_restore. pg_restore --role uses SET ROLE, and
-- PostgreSQL can combine role defaults in ways that preserve PUBLIC function
-- execute. These explicit existing-object grants make the post-restore state
-- deterministic and are verified by verify.sql.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Set the authenticator password interactively with `\password anbud_authenticator`.
-- Do not put it in a command-line argument, repository file, or shell history.
