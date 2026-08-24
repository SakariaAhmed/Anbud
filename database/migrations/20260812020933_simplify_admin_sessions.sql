-- Retire pre-database cookie sessions and replace the generic role-array RPC
-- with the single explicit global capability supported by the application.

update public.app_sessions
set revoked_at = coalesce(revoked_at, now())
where auth_method = 'development_password';

alter table public.app_sessions
  drop constraint if exists app_sessions_auth_method_check;

alter table public.app_sessions
  add constraint app_sessions_auth_method_check
  check (auth_method in ('entra', 'guest_code', 'admin_password'));

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
  if not exists (
    select 1
    from public.app_principals principal
    where principal.id = p_principal_id
      and principal.identity_type = 'internal'
  ) then
    raise exception 'Administrator status requires an internal principal';
  end if;

  delete from public.app_principal_roles
  where principal_id = p_principal_id;

  if p_is_admin then
    insert into public.app_principal_roles (
      principal_id,
      role,
      granted_by
    )
    values (
      p_principal_id,
      'admin',
      p_granted_by
    );
  end if;
end;
$$;

revoke execute on function public.set_principal_admin(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_principal_admin(text, boolean, text)
  to service_role;

-- Keep the already admin-only RPC as a temporary rolling-deploy bridge. It is
-- service-role-only and the table constraint rejects every role except admin.
-- A later cleanup migration may drop it after all app revisions use the
-- boolean RPC.
revoke execute on function public.replace_principal_roles(text, text[], text)
  from public, anon, authenticated;
grant execute on function public.replace_principal_roles(text, text[], text)
  to service_role;
