-- Keep invitation grants and administrator-managed ownership changes atomic.
-- Both functions run with the caller's service-role privileges and are not
-- executable through public Data API roles.

create or replace function public.grant_guest_project_access_batch(
  p_candidate_principal_id text,
  p_email_hmac text,
  p_email_encrypted text,
  p_email_masked text,
  p_display_name text,
  p_guest_description text,
  p_project_ids uuid[],
  p_roles text[],
  p_group_ids uuid[],
  p_expires_at timestamptz,
  p_created_by text,
  p_code_hmac text,
  p_code_last_four text
)
returns table (
  principal_id text,
  identity_type text,
  credential_created boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_principal public.app_principals%rowtype;
  v_credential_created boolean := false;
  v_credential_rows bigint := 0;
  v_project_count integer := cardinality(coalesce(p_project_ids, array[]::uuid[]));
  v_group_count integer := cardinality(coalesce(p_group_ids, array[]::uuid[]));
begin
  if char_length(btrim(coalesce(p_display_name, ''))) not between 2 and 120 then
    raise exception 'Guest name must be between 2 and 120 characters';
  end if;
  if char_length(btrim(coalesce(p_guest_description, ''))) not between 3 and 240 then
    raise exception 'Guest description must be between 3 and 240 characters';
  end if;
  if v_project_count not between 1 and 100 then
    raise exception 'Invitation must contain between 1 and 100 projects';
  end if;
  if v_project_count <> cardinality(coalesce(p_roles, array[]::text[])) then
    raise exception 'Project and role counts must match';
  end if;
  if v_group_count > 100 then
    raise exception 'Invitation cannot contain more than 100 groups';
  end if;
  if exists (
    select 1
    from unnest(
      coalesce(p_project_ids, array[]::uuid[]),
      coalesce(p_roles, array[]::text[])
    ) requested(project_id, role)
    where requested.role not in ('editor', 'viewer', 'restricted_viewer')
  ) then
    raise exception 'Invalid invitation project role';
  end if;
  if (
    select count(*)
    from unnest(coalesce(p_project_ids, array[]::uuid[])) project_id
  ) <> (
    select count(distinct project_id)
    from unnest(coalesce(p_project_ids, array[]::uuid[])) project_id
  ) then
    raise exception 'Duplicate invitation project';
  end if;
  if (
    select count(*)
    from unnest(coalesce(p_group_ids, array[]::uuid[])) group_id
  ) <> (
    select count(distinct group_id)
    from unnest(coalesce(p_group_ids, array[]::uuid[])) group_id
  ) then
    raise exception 'Duplicate invitation group';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_project_ids, array[]::uuid[])) requested(project_id)
    left join public.projects project on project.id = requested.project_id
    where project.id is null
  ) then
    raise exception 'Invitation project does not exist';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_group_ids, array[]::uuid[])) requested(group_id)
    left join public.app_groups app_group on app_group.id = requested.group_id
    where app_group.id is null
  ) then
    raise exception 'Invitation group does not exist';
  end if;

  -- Serialize with ownership changes, which lock the same project rows first.
  perform project.id
  from public.projects project
  where project.id = any(coalesce(p_project_ids, array[]::uuid[]))
  order by project.id
  for update;

  insert into public.app_principals (
    id,
    identity_type,
    display_name,
    guest_description,
    email_hmac,
    email_encrypted,
    email_masked
  )
  values (
    p_candidate_principal_id,
    'guest',
    btrim(p_display_name),
    btrim(p_guest_description),
    p_email_hmac,
    p_email_encrypted,
    p_email_masked
  )
  on conflict (email_hmac) do update
  set
    display_name = case
      when public.app_principals.identity_type = 'guest'
        then excluded.display_name
      else public.app_principals.display_name
    end,
    guest_description = case
      when public.app_principals.identity_type = 'guest'
        then excluded.guest_description
      else public.app_principals.guest_description
    end,
    email_encrypted = coalesce(
      public.app_principals.email_encrypted,
      excluded.email_encrypted
    ),
    email_masked = coalesce(
      public.app_principals.email_masked,
      excluded.email_masked
    ),
    updated_at = now()
  returning * into v_principal;

  if exists (
    select 1
    from public.project_memberships membership
    where membership.principal_id = v_principal.id
      and membership.project_id = any(coalesce(p_project_ids, array[]::uuid[]))
      and membership.role = 'owner'
      and membership.revoked_at is null
  ) then
    raise exception 'Invitation cannot replace project ownership';
  end if;

  if v_principal.identity_type = 'guest' then
    insert into public.guest_credentials (
      principal_id,
      code_hmac,
      code_last_four,
      created_by
    )
    values (
      v_principal.id,
      p_code_hmac,
      p_code_last_four,
      p_created_by
    )
    on conflict on constraint guest_credentials_pkey do nothing;
    get diagnostics v_credential_rows = row_count;
    v_credential_created := v_credential_rows = 1;
  end if;

  insert into public.project_memberships (
    project_id,
    principal_id,
    role,
    invited_by,
    invitation_sent_at,
    expires_at,
    revoked_at
  )
  select
    requested.project_id,
    v_principal.id,
    requested.role,
    p_created_by,
    now(),
    p_expires_at,
    null
  from unnest(
    coalesce(p_project_ids, array[]::uuid[]),
    coalesce(p_roles, array[]::text[])
  ) requested(project_id, role)
  on conflict on constraint project_memberships_pkey do update
  set
    role = excluded.role,
    invited_by = excluded.invited_by,
    invitation_sent_at = excluded.invitation_sent_at,
    expires_at = excluded.expires_at,
    revoked_at = null,
    updated_at = now();

  insert into public.app_group_members (
    group_id,
    principal_id,
    added_by
  )
  select
    requested.group_id,
    v_principal.id,
    p_created_by
  from unnest(coalesce(p_group_ids, array[]::uuid[])) requested(group_id)
  on conflict on constraint app_group_members_pkey do update
  set added_by = excluded.added_by;

  return query
  select
    v_principal.id,
    v_principal.identity_type,
    v_credential_created;
end;
$$;

create or replace function public.set_admin_managed_project_access(
  p_project_id uuid,
  p_principal_id text,
  p_role text,
  p_granted_by text,
  p_revoke boolean
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner_id text;
  v_membership_role text;
begin
  if p_revoke is null then
    raise exception 'Administrator-managed access operation is required';
  end if;
  if p_revoke and p_role is not null then
    raise exception 'Revocation cannot include a replacement role';
  end if;
  if not p_revoke and (
    p_role not in ('editor', 'viewer', 'restricted_viewer')
    or p_granted_by is null
  ) then
    raise exception 'Invalid administrator-managed project role';
  end if;
  if not exists (
    select 1
    from public.app_principals principal
    where principal.id = p_principal_id
      and principal.disabled_at is null
  ) then
    raise exception 'Project access requires an active principal';
  end if;

  select project.owner_id
  into v_owner_id
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  select membership.role
  into v_membership_role
  from public.project_memberships membership
  where membership.project_id = p_project_id
    and membership.principal_id = p_principal_id
    and membership.revoked_at is null
  for update;

  if p_revoke and not found then
    raise exception 'Active project membership does not exist';
  end if;

  if v_owner_id = p_principal_id then
    update public.projects
    set owner_id = null
    where id = p_project_id
      and owner_id = p_principal_id;
  end if;

  if p_revoke then
    if v_membership_role = 'owner' then
      update public.project_memberships
      set
        role = 'restricted_viewer',
        updated_at = now()
      where project_id = p_project_id
        and principal_id = p_principal_id
        and revoked_at is null;
    end if;
    perform public.revoke_project_member_access(
      p_project_id,
      p_principal_id
    );
    return;
  end if;

  insert into public.project_memberships (
    project_id,
    principal_id,
    role,
    invited_by,
    invitation_sent_at,
    expires_at,
    revoked_at
  )
  values (
    p_project_id,
    p_principal_id,
    p_role,
    p_granted_by,
    now(),
    null,
    null
  )
  on conflict on constraint project_memberships_pkey do update
  set
    role = excluded.role,
    invited_by = excluded.invited_by,
    invitation_sent_at = excluded.invitation_sent_at,
    expires_at = null,
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke execute on function public.grant_guest_project_access_batch(
  text, text, text, text, text, text, uuid[], text[], uuid[], timestamptz,
  text, text, text
) from public, anon, authenticated;
grant execute on function public.grant_guest_project_access_batch(
  text, text, text, text, text, text, uuid[], text[], uuid[], timestamptz,
  text, text, text
) to service_role;

revoke execute on function public.set_admin_managed_project_access(
  uuid, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.set_admin_managed_project_access(
  uuid, text, text, text, boolean
) to service_role;
