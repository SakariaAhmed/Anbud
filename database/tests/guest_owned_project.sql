do $$
declare
  guest_id text := 'g_project_creator_000000000000001';
  other_guest_id text := 'g_other_guest_000000000000000001';
  admin_id text := 'u_project_admin_0000000000000001';
  v_project_id uuid := gen_random_uuid();
  v_session_id uuid := gen_random_uuid();
begin
  insert into public.app_principals (id, identity_type, display_name, guest_description)
  values (guest_id, 'guest', 'Project creator', 'Synthetic guest project creator'),
         (other_guest_id, 'guest', 'Other guest', 'Synthetic uninvited guest'),
         (admin_id, 'internal', 'Administrator', null);
  perform public.set_principal_admin(admin_id, true, admin_id);
  insert into public.guest_credentials (principal_id, code_hmac, code_last_four)
  values (guest_id, 'guest-project-credential', 'ABCD');
  insert into public.app_sessions (id, principal_id, token_hmac, auth_method, expires_at)
  values (v_session_id, guest_id, 'guest-project-session', 'guest_code', now() + interval '1 hour');

  insert into public.projects (id, owner_id, client_name, title)
  values (v_project_id, guest_id, 'Synthetic customer', 'Guest-owned project');

  if not exists (
    select 1 from public.project_memberships membership
    where membership.project_id = v_project_id and membership.principal_id = guest_id
      and membership.role = 'owner' and membership.accepted_at is not null
      and membership.revoked_at is null and membership.expires_at is null
  ) then
    raise exception 'Guest creation did not persist an active owner membership';
  end if;
  if public.resolve_project_role(guest_id, v_project_id) is distinct from 'owner' then
    raise exception 'Guest creator cannot access their project as owner';
  end if;
  if public.resolve_project_role(other_guest_id, v_project_id) is not null then
    raise exception 'Uninvited guest gained project access';
  end if;
  if not exists (
    select 1 from public.resolve_app_session(v_session_id, 'guest-project-session') session
    where session.principal_id = guest_id and session.identity_type = 'guest'
      and cardinality(session.global_roles) = 0
  ) then
    raise exception 'Project ownership changed the guest identity, global role or session';
  end if;
  if not exists (
    select 1 from public.guest_credentials credential
    where credential.principal_id = guest_id and credential.revoked_at is null
      and credential.code_hmac = 'guest-project-credential'
  ) then
    raise exception 'Project ownership invalidated guest-code login';
  end if;
  if exists (
    select 1 from public.project_memberships membership
    where membership.project_id = v_project_id and membership.principal_id = admin_id
  ) then
    raise exception 'Global admin access must not require a project-specific grant';
  end if;
end;
$$;
