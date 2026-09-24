-- Separate project sharing from account-wide guest credential management.

create or replace function public.grant_guest_project_access(
  p_candidate_principal_id text,
  p_email_hmac text,
  p_email_encrypted text,
  p_email_masked text,
  p_display_name text,
  p_guest_description text,
  p_project_id uuid,
  p_role text,
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
begin
  if char_length(btrim(coalesce(p_display_name, ''))) not between 2 and 120 then
    raise exception 'Guest name must be between 2 and 120 characters';
  end if;
  if char_length(btrim(coalesce(p_guest_description, ''))) not between 3 and 240 then
    raise exception 'Guest description must be between 3 and 240 characters';
  end if;
  if p_role not in ('editor', 'viewer', 'restricted_viewer') then
    raise exception 'Guests cannot receive project role %', p_role;
  end if;

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

  -- An invitation must not issue an existing account's missing global credential.
  if v_principal.identity_type = 'guest' and (
    v_principal.id = p_candidate_principal_id or exists (
      select 1 from public.app_principals actor
      join public.app_principal_roles actor_role on actor_role.principal_id = actor.id
      where actor.id = p_created_by and actor.disabled_at is null
        and actor_role.role = 'admin'
    )
  ) then
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
  values (
    p_project_id,
    v_principal.id,
    p_role,
    p_created_by,
    now(),
    p_expires_at,
    null
  )
  on conflict on constraint project_memberships_pkey do update
  set
    role = excluded.role,
    invited_by = excluded.invited_by,
    invitation_sent_at = excluded.invitation_sent_at,
    expires_at = excluded.expires_at,
    revoked_at = null,
    updated_at = now();

  return query
  select
    v_principal.id,
    v_principal.identity_type,
    v_credential_created;
end;
$$;

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

  -- An invitation must not issue an existing account's missing global credential.
  if v_principal.identity_type = 'guest' and (
    v_principal.id = p_candidate_principal_id or exists (
      select 1 from public.app_principals actor
      join public.app_principal_roles actor_role on actor_role.principal_id = actor.id
      where actor.id = p_created_by and actor.disabled_at is null
        and actor_role.role = 'admin'
    )
  ) then
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

create or replace function public.rotate_guest_credential(
  p_principal_id text,
  p_code_hmac text,
  p_code_last_four text,
  p_rotated_by text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version integer;
begin
  -- Account-wide credentials require active global administrator authority.
  if not exists (
    select 1 from public.app_principals actor
    join public.app_principal_roles actor_role on actor_role.principal_id = actor.id
    where actor.id = p_rotated_by and actor.disabled_at is null
      and actor_role.role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Administrator access required';
  end if;
  perform principal.id from public.app_principals principal
  where principal.id = p_principal_id and principal.identity_type = 'guest'
    and principal.disabled_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Active guest required';
  end if;
  update public.guest_credentials
  set
    code_hmac = p_code_hmac,
    code_last_four = p_code_last_four,
    credential_version = credential_version + 1,
    created_by = p_rotated_by,
    rotated_at = now(),
    revoked_at = null
  where principal_id = p_principal_id
  returning credential_version into v_version;

  if v_version is null then
    raise exception 'Guest credential does not exist';
  end if;

  update public.app_sessions
  set revoked_at = coalesce(revoked_at, now())
  where principal_id = p_principal_id
    and revoked_at is null;

  return v_version;
end;
$$;
