begin;
do $test$
declare
  v_id text;
  v_session uuid := gen_random_uuid();
begin
  insert into public.app_principals (id, identity_type, display_name)
  values ('u_auth_test_admin_00000000000000000001', 'internal', 'Administrator');
  perform public.set_principal_admin('u_auth_test_admin_00000000000000000001', true, 'u_auth_test_admin_00000000000000000001');

  select principal_id into v_id from public.upsert_internal_principal(
    'u_auth_test_member_00000000000000000001', 'Member', repeat('a', 64), 'encrypted', 'me***@example.test'
  );
  if v_id <> 'u_auth_test_member_00000000000000000001' then raise exception 'Identity not created'; end if;
  if (select count(*) from public.app_principal_roles where role = 'admin') <> 1
     or not exists (select 1 from public.app_principal_roles where principal_id = 'u_auth_test_admin_00000000000000000001' and role = 'admin') then
    raise exception 'Login changed the singleton administrator';
  end if;

  insert into public.app_sessions (id, principal_id, token_hmac, auth_method, expires_at)
  values (v_session, v_id, repeat('b', 64), 'entra', now() + interval '1 hour');
  if not exists (select 1 from public.resolve_app_session(v_session, repeat('b', 64))) then
    raise exception 'Active session did not resolve';
  end if;
  if exists (select 1 from public.resolve_app_session(v_session, repeat('c', 64))) then
    raise exception 'Wrong session credential was accepted';
  end if;
  update public.app_principals set disabled_at = now() where id = v_id;
  if exists (select 1 from public.resolve_app_session(v_session, repeat('b', 64))) then
    raise exception 'Disabled identity session was accepted';
  end if;

  begin
    perform public.upsert_internal_principal('u_auth_test_member_00000000000000000001', 'Changed', repeat('a', 64), 'new', 'new');
    raise exception 'Disabled identity was re-enabled by login';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.upsert_internal_principal('u_auth_test_alias_00000000000000000001', 'Changed', repeat('a', 64), 'new', 'new');
    raise exception 'Email matching bypassed disabled identity';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.app_principals where id = v_id and (disabled_at is null or display_name <> 'Member')) then
    raise exception 'Denied login mutated the disabled identity';
  end if;
  if exists (select 1 from public.app_principal_aliases where alias_id = 'u_auth_test_alias_00000000000000000001') then
    raise exception 'Denied login created an alias';
  end if;
end;
$test$;
rollback;
