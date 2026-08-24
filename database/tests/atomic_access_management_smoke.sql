do $test$
declare
  v_actor_id text := 'u_atomic_access_actor_000000000000001';
  v_guest_id text := 'g_atomic_access_guest_000000000000001';
  v_project_one uuid := gen_random_uuid();
  v_project_two uuid := gen_random_uuid();
  v_group_id uuid := gen_random_uuid();
  v_created boolean;
begin
  insert into public.app_principals (
    id,
    identity_type,
    display_name,
    email_hmac,
    email_encrypted,
    email_masked
  )
  values (
    v_actor_id,
    'internal',
    'Atomic Access Actor',
    repeat('1', 64),
    'encrypted-actor',
    'ac***@example.no'
  );

  insert into public.projects (
    id,
    owner_id,
    client_name,
    title,
    description
  )
  values
    (v_project_one, v_actor_id, 'Testkunde', 'Atomic project one', ''),
    (v_project_two, null, 'Testkunde', 'Atomic project two', '');

  insert into public.project_memberships (
    project_id,
    principal_id,
    role,
    accepted_at,
    revoked_at
  )
  values (
    v_project_one,
    v_actor_id,
    'owner',
    now(),
    null
  )
  on conflict on constraint project_memberships_pkey do update
  set role = 'owner', revoked_at = null, expires_at = null;

  insert into public.app_groups (
    id,
    name,
    normalized_name,
    created_by
  )
  values (
    v_group_id,
    'Atomic access group',
    'atomic access group',
    v_actor_id
  );

  select credential_created
  into v_created
  from public.grant_guest_project_access_batch(
    v_guest_id,
    repeat('2', 64),
    'encrypted-guest',
    'gu***@example.no',
    'Atomic Guest',
    'Atomic access smoke-test guest',
    array[v_project_one, v_project_two],
    array['viewer', 'restricted_viewer'],
    array[v_group_id],
    null,
    v_actor_id,
    repeat('3', 64),
    'ABCD'
  );
  if not v_created then
    raise exception 'batch invitation did not create the guest credential';
  end if;
  if (
    select count(*)
    from public.project_memberships membership
    where membership.principal_id = v_guest_id
      and membership.revoked_at is null
  ) <> 2 then
    raise exception 'batch invitation did not persist both project grants';
  end if;
  if not exists (
    select 1
    from public.app_group_members member
    where member.group_id = v_group_id
      and member.principal_id = v_guest_id
  ) then
    raise exception 'batch invitation did not persist the group membership';
  end if;

  perform public.set_admin_managed_project_access(
    v_project_one,
    v_actor_id,
    'editor',
    v_actor_id,
    false
  );
  if exists (
    select 1 from public.projects project
    where project.id = v_project_one and project.owner_id is not null
  ) then
    raise exception 'atomic owner downgrade did not release project ownership';
  end if;
  if not exists (
    select 1
    from public.project_memberships membership
    where membership.project_id = v_project_one
      and membership.principal_id = v_actor_id
      and membership.role = 'editor'
      and membership.expires_at is null
      and membership.revoked_at is null
  ) then
    raise exception 'atomic owner downgrade did not persist the replacement role';
  end if;

  update public.project_memberships
  set expires_at = now() - interval '1 day'
  where project_id = v_project_two
    and principal_id = v_guest_id;
  perform public.set_admin_managed_project_access(
    v_project_two,
    v_guest_id,
    'viewer',
    v_actor_id,
    false
  );
  if not exists (
    select 1
    from public.project_memberships membership
    where membership.project_id = v_project_two
      and membership.principal_id = v_guest_id
      and membership.role = 'viewer'
      and membership.expires_at is null
      and membership.revoked_at is null
  ) then
    raise exception 'renewed access retained its expired timestamp';
  end if;

  update public.projects
  set owner_id = v_actor_id
  where id = v_project_one;
  update public.project_memberships
  set role = 'owner', revoked_at = null, expires_at = null
  where project_id = v_project_one
    and principal_id = v_actor_id;

  begin
    perform public.grant_guest_project_access_batch(
      'g_unused_atomic_candidate_000000000001',
      repeat('1', 64),
      'changed-encrypted-actor',
      'ch***@example.no',
      'Changed Actor',
      'This description must roll back',
      array[v_project_one],
      array['viewer'],
      array[]::uuid[],
      null,
      v_actor_id,
      repeat('4', 64),
      'EFGH'
    );
    raise exception 'owner replacement unexpectedly succeeded';
  exception
    when others then
      if sqlerrm <> 'Invitation cannot replace project ownership' then
        raise;
      end if;
  end;
  if (
    select principal.display_name
    from public.app_principals principal
    where principal.id = v_actor_id
  ) <> 'Atomic Access Actor' then
    raise exception 'failed batch invitation did not roll back principal changes';
  end if;

  if has_function_privilege(
    'anon',
    'public.grant_guest_project_access_batch(text,text,text,text,text,text,uuid[],text[],uuid[],timestamptz,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon can execute the batch invitation function';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.set_admin_managed_project_access(uuid,text,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can execute administrator access changes';
  end if;
end;
$test$;
