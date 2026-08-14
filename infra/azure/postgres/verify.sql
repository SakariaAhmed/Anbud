\set ON_ERROR_STOP on

\if :{?expected_collation}
\else
  \echo 'expected_collation must be supplied from the source preflight'
  \quit 2
\endif
\if :{?expected_ctype}
\else
  \echo 'expected_ctype must be supplied from the source preflight'
  \quit 2
\endif
\if :{?expected_locale_provider}
\else
  \echo 'expected_locale_provider must be supplied from the source preflight'
  \quit 2
\endif
\if :{?expected_locale}
\else
  \echo 'expected_locale must be supplied from the source preflight'
  \quit 2
\endif
\if :{?expected_collation_version}
\else
  \echo 'expected_collation_version must be supplied from the source preflight'
  \quit 2
\endif

SELECT set_config('anbud.expected_collation', :'expected_collation', false);
SELECT set_config('anbud.expected_ctype', :'expected_ctype', false);
SELECT set_config('anbud.expected_locale_provider', :'expected_locale_provider', false);
SELECT set_config('anbud.expected_locale', :'expected_locale', false);
SELECT set_config('anbud.expected_collation_version', :'expected_collation_version', false);

DO $verify$
DECLARE
  expected_tables text[] := ARRAY[
    'activity_events',
    'app_group_members',
    'app_groups',
    'app_principal_aliases',
    'app_principal_roles',
    'app_principals',
    'app_rate_limits',
    'app_sessions',
    'artifact_source_state',
    'audit_events',
    'chat_messages',
    'chat_sessions',
    'customer_analyses',
    'document_chunks',
    'document_intelligence_artifacts',
    'document_intelligence_events',
    'documents',
    'executive_summaries',
    'generated_artifacts',
    'guest_credentials',
    'project_group_grants',
    'project_job_claim_control',
    'project_jobs',
    'project_memberships',
    'project_service_selections',
    'projects',
    'service_descriptions',
    'service_documents',
    'solution_evaluations',
    'stable_customer_analysis_context_sync',
    'stable_primary_document_authority'
  ];
  actual_tables text[];
  invalid_names text[];
  role_count integer;
  definer_count integer;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'PostgreSQL major must be 17';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = current_database()
      AND (
        datcollate <> current_setting('anbud.expected_collation')
        OR datctype <> current_setting('anbud.expected_ctype')
        OR pg_encoding_to_char(encoding) <> 'UTF8'
        OR datlocprovider::text <> current_setting('anbud.expected_locale_provider')
        OR datlocale IS DISTINCT FROM current_setting('anbud.expected_locale')
        OR daticurules IS NOT NULL
        OR datcollversion IS DISTINCT FROM current_setting('anbud.expected_collation_version')
        OR datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
      )
  ) THEN
    RAISE EXCEPTION 'Target encoding or ICU locale contract differs from the validated source';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension extension_state
    JOIN pg_namespace namespace_state
      ON namespace_state.oid = extension_state.extnamespace
    WHERE extension_state.extname = 'pgcrypto'
      AND namespace_state.nspname = 'extensions'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_extension extension_state
    JOIN pg_namespace namespace_state
      ON namespace_state.oid = extension_state.extnamespace
    WHERE extension_state.extname = 'vector'
      AND namespace_state.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'pgcrypto and vector must both exist in extensions';
  END IF;

  SELECT count(*) INTO role_count
  FROM pg_roles
  WHERE (rolname = 'anbud_owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
     OR (rolname = 'anon' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
     OR (rolname = 'authenticated' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
     OR (rolname = 'service_role' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolbypassrls)
     OR (rolname = 'anbud_authenticator' AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls);
  IF role_count <> 5 THEN
    RAISE EXCEPTION 'One or more runtime roles have missing or excessive attributes';
  END IF;

  IF NOT pg_has_role('anbud_authenticator', 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'anbud_authenticator must be a member of service_role';
  END IF;
  IF pg_has_role('anon', 'service_role', 'MEMBER')
     OR pg_has_role('authenticated', 'service_role', 'MEMBER') THEN
    RAISE EXCEPTION 'Unprivileged roles must not inherit service_role';
  END IF;

  IF NOT has_schema_privilege('anbud_owner', 'public', 'USAGE')
     OR NOT has_schema_privilege('anbud_owner', 'public', 'CREATE')
     OR NOT has_schema_privilege('service_role', 'public', 'USAGE')
     OR NOT has_schema_privilege('service_role', 'extensions', 'USAGE')
     OR has_schema_privilege('service_role', 'public', 'CREATE')
     OR has_schema_privilege('service_role', 'extensions', 'CREATE')
     OR has_schema_privilege('anon', 'public', 'USAGE,CREATE')
     OR has_schema_privilege('anon', 'extensions', 'USAGE,CREATE')
     OR has_schema_privilege('authenticated', 'public', 'USAGE,CREATE')
     OR has_schema_privilege('authenticated', 'extensions', 'USAGE,CREATE')
     OR EXISTS (
       SELECT 1
       FROM pg_namespace namespace_state,
            LATERAL aclexplode(COALESCE(
              namespace_state.nspacl,
              acldefault('n', namespace_state.nspowner)
            )) acl
       WHERE namespace_state.nspname IN ('public', 'extensions')
         AND acl.grantee = 0
     ) THEN
    RAISE EXCEPTION 'Schema privileges are incomplete or excessive';
  END IF;

  SELECT array_agg(class_state.relname ORDER BY class_state.relname)
    INTO actual_tables
  FROM pg_class class_state
  JOIN pg_namespace namespace_state
    ON namespace_state.oid = class_state.relnamespace
  WHERE namespace_state.nspname = 'public'
    AND class_state.relkind = 'r';
  IF actual_tables IS DISTINCT FROM expected_tables THEN
    RAISE EXCEPTION 'Public table inventory differs from the canonical 31-table set';
  END IF;

  SELECT array_agg(class_state.relname ORDER BY class_state.relname)
    INTO invalid_names
  FROM pg_class class_state
  JOIN pg_namespace namespace_state
    ON namespace_state.oid = class_state.relnamespace
  WHERE namespace_state.nspname = 'public'
    AND class_state.relkind = 'r'
    AND (
      NOT class_state.relrowsecurity
      OR pg_get_userbyid(class_state.relowner) <> 'anbud_owner'
      OR NOT has_table_privilege('service_role', class_state.oid, 'SELECT')
      OR NOT has_table_privilege('service_role', class_state.oid, 'INSERT')
      OR NOT has_table_privilege('service_role', class_state.oid, 'UPDATE')
      OR NOT has_table_privilege('service_role', class_state.oid, 'DELETE')
      OR has_table_privilege('service_role', class_state.oid, 'TRUNCATE')
      OR has_table_privilege('service_role', class_state.oid, 'REFERENCES')
      OR has_table_privilege('service_role', class_state.oid, 'TRIGGER')
      OR has_table_privilege('service_role', class_state.oid, 'MAINTAIN')
      OR has_table_privilege('anon', class_state.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_table_privilege('authenticated', class_state.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          class_state.relacl,
          acldefault('r', class_state.relowner)
        )) acl
        WHERE acl.grantee = 0
      )
    );
  IF invalid_names IS NOT NULL THEN
    RAISE EXCEPTION 'Public table RLS, owner, or service_role grants are invalid: %', invalid_names;
  END IF;

  SELECT array_agg(class_state.relname ORDER BY class_state.relname)
    INTO invalid_names
  FROM pg_class class_state
  JOIN pg_namespace namespace_state
    ON namespace_state.oid = class_state.relnamespace
  WHERE namespace_state.nspname = 'public'
    AND class_state.relkind = 'S'
    AND (
      pg_get_userbyid(class_state.relowner) <> 'anbud_owner'
      OR NOT has_sequence_privilege('service_role', class_state.oid, 'USAGE')
      OR NOT has_sequence_privilege('service_role', class_state.oid, 'SELECT')
      OR has_sequence_privilege('service_role', class_state.oid, 'UPDATE')
      OR has_sequence_privilege('anon', class_state.oid, 'USAGE,SELECT,UPDATE')
      OR has_sequence_privilege('authenticated', class_state.oid, 'USAGE,SELECT,UPDATE')
      OR EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          class_state.relacl,
          acldefault('s', class_state.relowner)
        )) acl
        WHERE acl.grantee = 0
      )
    );
  IF invalid_names IS NOT NULL THEN
    RAISE EXCEPTION 'Public sequence owner or ACLs are invalid: %', invalid_names;
  END IF;

  SELECT array_agg(procedure_state.proname ORDER BY procedure_state.proname)
    INTO invalid_names
  FROM pg_proc procedure_state
  JOIN pg_namespace namespace_state
    ON namespace_state.oid = procedure_state.pronamespace
  WHERE namespace_state.nspname = 'public'
    AND (
      pg_get_userbyid(procedure_state.proowner) <> 'anbud_owner'
      OR NOT has_function_privilege('service_role', procedure_state.oid, 'EXECUTE')
      OR has_function_privilege('anon', procedure_state.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure_state.oid, 'EXECUTE')
      OR EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(
          procedure_state.proacl,
          acldefault('f', procedure_state.proowner)
        )) acl
        WHERE acl.grantee = 0
          AND acl.privilege_type = 'EXECUTE'
      )
    );
  IF invalid_names IS NOT NULL THEN
    RAISE EXCEPTION 'Public function owner or ACLs are invalid: %', invalid_names;
  END IF;

  SELECT count(*) INTO definer_count
  FROM pg_proc procedure_state
  JOIN pg_namespace namespace_state
    ON namespace_state.oid = procedure_state.pronamespace
  JOIN pg_roles owner_state
    ON owner_state.oid = procedure_state.proowner
  WHERE namespace_state.nspname = 'public'
    AND procedure_state.prosecdef
    AND procedure_state.proname IN (
      'audit_project_job_terminal_state',
      'sync_project_owner_membership'
    )
    AND pg_get_function_identity_arguments(procedure_state.oid) = ''
    AND owner_state.rolname = 'anbud_owner'
    AND procedure_state.proconfig @> ARRAY['search_path=""']
    AND NOT EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(
        procedure_state.proacl,
        acldefault('f', procedure_state.proowner)
      )) acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    )
    AND NOT has_function_privilege('anon', procedure_state.oid, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', procedure_state.oid, 'EXECUTE')
    AND has_function_privilege('service_role', procedure_state.oid, 'EXECUTE');
  IF definer_count <> 2 OR (
    SELECT count(*)
    FROM pg_proc procedure_state
    JOIN pg_namespace namespace_state
      ON namespace_state.oid = procedure_state.pronamespace
    WHERE namespace_state.nspname = 'public'
      AND procedure_state.prosecdef
  ) <> 2 THEN
    RAISE EXCEPTION 'SECURITY DEFINER allowlist, ownership, settings, or ACLs are invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint constraint_state
    WHERE NOT constraint_state.convalidated
  ) THEN
    RAISE EXCEPTION 'One or more constraints are not validated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index index_state
    WHERE NOT index_state.indisvalid OR NOT index_state.indisready
  ) THEN
    RAISE EXCEPTION 'One or more indexes are invalid or not ready';
  END IF;
END
$verify$;

SELECT json_build_object(
  'status', 'verified',
  'postgres_major', current_setting('server_version_num')::integer / 10000,
  'database', current_database(),
  'collation', datcollate,
  'ctype', datctype,
  'encoding', pg_encoding_to_char(encoding)
)
FROM pg_database
WHERE datname = current_database();
