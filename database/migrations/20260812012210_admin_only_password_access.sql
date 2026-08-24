-- Collapse global authorization to one administrator role and allow the
-- dedicated, hash-verified administrator login to create revocable sessions.

update public.app_sessions session
set revoked_at = coalesce(session.revoked_at, now())
where session.principal_id in (
  select role_row.principal_id
  from public.app_principal_roles role_row
  where role_row.role = 'super_user'
);

delete from public.app_principal_roles
where role = 'super_user';

alter table public.app_principal_roles
  drop constraint if exists app_principal_roles_role_check;

alter table public.app_principal_roles
  add constraint app_principal_roles_role_check
  check (role = 'admin');

alter table public.app_sessions
  drop constraint if exists app_sessions_auth_method_check;

alter table public.app_sessions
  add constraint app_sessions_auth_method_check
  check (
    auth_method in (
      'entra',
      'guest_code',
      'development_password',
      'admin_password'
    )
  );

create or replace function public.replace_principal_roles(
  p_principal_id text,
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
    select 1
    from public.app_principals principal
    where principal.id = p_principal_id
      and principal.identity_type = 'internal'
  ) then
    raise exception 'Global roles require an internal principal';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_roles, array[]::text[])) requested(role)
    where requested.role <> 'admin'
  ) then
    raise exception 'Invalid global role';
  end if;

  delete from public.app_principal_roles
  where principal_id = p_principal_id;

  insert into public.app_principal_roles (
    principal_id,
    role,
    granted_by
  )
  select
    p_principal_id,
    requested.role,
    p_granted_by
  from (
    select distinct unnest(coalesce(p_roles, array[]::text[])) as role
  ) requested;
end;
$$;
