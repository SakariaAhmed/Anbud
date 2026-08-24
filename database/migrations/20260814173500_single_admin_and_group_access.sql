-- Keep the password-backed administrator as the only global administrator and
-- make group project grants replaceable in one transaction.

with ranked_admins as (
  select
    principal_id,
    row_number() over (
      order by (principal_id = granted_by) desc, granted_at desc, principal_id
    ) as position
  from public.app_principal_roles
  where role = 'admin'
), removed_admins as (
  delete from public.app_principal_roles roles
  using ranked_admins ranked
  where roles.principal_id = ranked.principal_id
    and roles.role = 'admin'
    and ranked.position > 1
  returning roles.principal_id
)
update public.app_sessions session
set revoked_at = coalesce(session.revoked_at, now())
where session.principal_id in (
  select principal_id from removed_admins
)
  and session.revoked_at is null;

create unique index if not exists app_principal_roles_single_admin_idx
  on public.app_principal_roles ((role))
  where role = 'admin';

create or replace function public.set_principal_admin(
  p_principal_id text,
  p_is_admin boolean,
  p_granted_by text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not p_is_admin then
    raise exception 'The administrator role is locked';
  end if;
  if not exists (
    select 1
    from public.app_principals principal
    where principal.id = p_principal_id
      and principal.identity_type = 'internal'
      and principal.disabled_at is null
  ) then
    raise exception 'Administrator status requires an active internal principal';
  end if;

  update public.app_sessions session
  set revoked_at = coalesce(session.revoked_at, now())
  where session.principal_id in (
    select roles.principal_id
    from public.app_principal_roles roles
    where roles.role = 'admin'
      and roles.principal_id <> p_principal_id
  )
    and session.revoked_at is null;

  delete from public.app_principal_roles
  where role = 'admin'
    and principal_id <> p_principal_id;

  insert into public.app_principal_roles (
    principal_id,
    role,
    granted_by
  )
  values (
    p_principal_id,
    'admin',
    p_granted_by
  )
  on conflict (principal_id, role) do update
  set
    granted_by = excluded.granted_by,
    granted_at = now();
end;
$$;

create or replace function public.replace_group_project_access(
  p_group_id uuid,
  p_project_ids uuid[],
  p_roles text[],
  p_granted_by text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.app_groups app_group where app_group.id = p_group_id
  ) then
    raise exception 'Group does not exist';
  end if;
  if cardinality(coalesce(p_project_ids, array[]::uuid[]))
      <> cardinality(coalesce(p_roles, array[]::text[])) then
    raise exception 'Project and role counts must match';
  end if;
  if exists (
    select 1
    from unnest(
      coalesce(p_project_ids, array[]::uuid[]),
      coalesce(p_roles, array[]::text[])
    ) requested(project_id, role)
    where requested.role not in ('editor', 'viewer', 'restricted_viewer')
  ) then
    raise exception 'Invalid group role';
  end if;
  if (
    select count(*)
    from unnest(coalesce(p_project_ids, array[]::uuid[])) project_id
  ) <> (
    select count(distinct project_id)
    from unnest(coalesce(p_project_ids, array[]::uuid[])) project_id
  ) then
    raise exception 'Duplicate project grant';
  end if;

  update public.project_group_grants
  set revoked_at = coalesce(revoked_at, now())
  where group_id = p_group_id
    and revoked_at is null;

  insert into public.project_group_grants (
    project_id,
    group_id,
    role,
    granted_by,
    revoked_at
  )
  select
    requested.project_id,
    p_group_id,
    requested.role,
    p_granted_by,
    null
  from unnest(
    coalesce(p_project_ids, array[]::uuid[]),
    coalesce(p_roles, array[]::text[])
  ) requested(project_id, role)
  on conflict (project_id, group_id) do update
  set
    role = excluded.role,
    granted_by = excluded.granted_by,
    expires_at = null,
    revoked_at = null,
    updated_at = now();
end;
$$;

revoke execute on function public.set_principal_admin(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_principal_admin(text, boolean, text)
  to service_role;

revoke execute on function public.replace_group_project_access(uuid, uuid[], text[], text)
  from public, anon, authenticated;
grant execute on function public.replace_group_project_access(uuid, uuid[], text[], text)
  to service_role;
