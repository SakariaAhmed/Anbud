do $test$
declare
  v_owner_id text := 'u_access_owner_00000000000000000001';
  v_guest_id text := 'g_access_guest_00000000000000000001';
  v_project_one uuid := gen_random_uuid();
  v_project_two uuid := gen_random_uuid();
  v_group_id uuid := gen_random_uuid();
  v_resolved_role text;
  v_created boolean;
  v_internal_id text;
begin
  insert into public.projects (
    id,
    owner_id,
    client_name,
    title,
    description
  )
  values
    (v_project_one, v_owner_id, 'Testkunde', 'Prosjekt én', ''),
    (v_project_two, v_owner_id, 'Testkunde', 'Prosjekt to', '');

  if not exists (
    select 1
    from public.project_memberships membership
    where membership.project_id = v_project_one
      and membership.principal_id = v_owner_id
      and membership.role = 'owner'
      and membership.revoked_at is null
  ) then
    raise exception 'owner membership trigger did not run';
  end if;

  select credential_created
  into v_created
  from public.grant_guest_project_access(
    v_guest_id,
    repeat('a', 64),
    'encrypted-email',
    'gu***@example.no',
    'Gjest',
    v_project_one,
    'restricted_viewer',
    null,
    v_owner_id,
    repeat('b', 64),
    'ABCD'
  );
  if not v_created then
    raise exception 'first guest grant did not create a credential';
  end if;

  select credential_created
  into v_created
  from public.grant_guest_project_access(
    'g_unused_candidate_000000000000000001',
    repeat('a', 64),
    'encrypted-email',
    'gu***@example.no',
    'Gjest',
    v_project_two,
    'viewer',
    null,
    v_owner_id,
    repeat('c', 64),
    'EFGH'
  );
  if v_created then
    raise exception 'second project unexpectedly created a second credential';
  end if;

  if (
    select count(*)
    from public.project_memberships membership
    where membership.principal_id = v_guest_id
      and membership.revoked_at is null
  ) <> 2 then
    raise exception 'guest did not retain both project memberships';
  end if;

  insert into public.app_groups (
    id,
    name,
    normalized_name,
    created_by
  )
  values (
    v_group_id,
    'Testgruppe',
    'testgruppe',
    v_owner_id
  );
  perform public.replace_group_members(
    v_group_id,
    array[v_owner_id, v_guest_id, v_guest_id],
    v_owner_id
  );
  if (
    select count(*) from public.app_group_members member
    where member.group_id = v_group_id
  ) <> 2 then
    raise exception 'atomic group membership replacement failed';
  end if;

  perform public.set_principal_admin(
    v_owner_id,
    true,
    v_owner_id
  );
  if (
    select count(*) from public.app_principal_roles role_row
    where role_row.principal_id = v_owner_id
  ) <> 1 then
    raise exception 'administrator status replacement failed';
  end if;

  v_resolved_role := public.resolve_project_role(v_guest_id, v_project_two);
  if v_resolved_role <> 'viewer' then
    raise exception 'unexpected effective project role: %', v_resolved_role;
  end if;

  insert into public.app_sessions (
    principal_id,
    token_hmac,
    auth_method,
    expires_at
  )
  values (
    v_guest_id,
    repeat('d', 64),
    'guest_code',
    now() + interval '1 hour'
  );

  perform public.rotate_guest_credential(
    v_guest_id,
    repeat('e', 64),
    'JKLM',
    v_owner_id
  );
  if exists (
    select 1
    from public.app_sessions session
    where session.principal_id = v_guest_id
      and session.revoked_at is null
  ) then
    raise exception 'guest sessions survived credential rotation';
  end if;

  insert into public.app_sessions (
    principal_id,
    token_hmac,
    auth_method,
    expires_at
  )
  values (
    v_guest_id,
    repeat('f', 64),
    'guest_code',
    now() + interval '1 hour'
  );
  select principal_id
  into v_internal_id
  from public.upsert_internal_principal(
    'u_entra_subject_0000000000000000001',
    'Intern bruker',
    repeat('a', 64),
    'encrypted-email',
    'gu***@example.no'
  );
  if v_internal_id <> v_guest_id then
    raise exception 'guest-to-internal upgrade lost project identity';
  end if;
  if exists (
    select 1
    from public.app_sessions session
    where session.principal_id = v_guest_id
      and session.revoked_at is null
  ) then
    raise exception 'guest-to-internal upgrade left a guest session active';
  end if;
  if not exists (
    select 1
    from public.app_principal_aliases alias_row
    where alias_row.alias_id = 'u_entra_subject_0000000000000000001'
      and alias_row.principal_id = v_guest_id
  ) then
    raise exception 'Entra subject alias was not persisted';
  end if;
end;
$test$;
