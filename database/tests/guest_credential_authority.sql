do $test$
declare
  v_admin text := 'u_security_admin_00000000000000001';
  v_owner text := 'u_security_owner_00000000000000001';
  v_guest text := 'g_security_guest_00000000000000001';
  v_missing text := 'g_security_missing_000000000000001';
  v_project_a uuid := gen_random_uuid();
  v_project_b uuid := gen_random_uuid();
  v_created boolean;
  v_version integer;
begin
  insert into public.app_principals(id, identity_type, display_name, email_hmac, email_encrypted, email_masked, guest_description)
  values (v_admin, 'internal', 'Security Admin', 'security-admin', 'encrypted', 'ad***@example.test', null),
    (v_owner, 'internal', 'Security Owner', 'security-owner', 'encrypted', 'ow***@example.test', null);
  insert into public.app_principal_roles(principal_id, role) values (v_admin, 'admin');
  insert into public.projects(id, owner_id, client_name, title, description)
  values (v_project_a, v_owner, 'Test', 'Project A', ''),
    (v_project_b, v_admin, 'Test', 'Project B', '');

  select credential_created into v_created from public.grant_guest_project_access_batch(
    v_guest, 'security-guest', 'encrypted-guest', 'gu***@example.test', 'Security Guest', 'Guest reviewer',
    array[v_project_b], array['viewer'], array[]::uuid[], null, v_admin, 'original-code', 'ABCD');
  if not v_created then raise exception 'new guest credential not created'; end if;
  -- Re-inviting a known guest to A must preserve its original global credential.
  select credential_created into v_created from public.grant_guest_project_access_batch(
    'g_unused_candidate_000000000000001', 'security-guest', 'encrypted-guest', 'gu***@example.test', 'Security Guest', 'Guest reviewer',
    array[v_project_a], array['viewer'], array[]::uuid[], null, v_owner, 'attacker-code', 'EFGH');
  if v_created then raise exception 'owner replaced existing credential'; end if;
  insert into public.app_sessions(principal_id, token_hmac, auth_method, expires_at)
  values (v_guest, 'security-session', 'guest_code', now() + interval '1 hour');
  begin
    perform public.rotate_guest_credential(v_guest, 'attacker-code', 'EFGH', v_owner);
    raise exception 'owner rotated global guest credential';
  exception when insufficient_privilege then null;
  end;
  if (select code_hmac from public.guest_credentials where principal_id = v_guest) <> 'original-code'
    or exists (select 1 from public.app_sessions where principal_id = v_guest and revoked_at is not null)
  then raise exception 'denied rotation changed credential/session'; end if;

  -- Existing guest without a credential: both current issuance RPCs must deny code creation to owner.
  select credential_created into v_created from public.grant_guest_project_access_batch(
    'g_unused_candidate_000000000000001', 'security-missing', 'encrypted-guest', 'gu***@example.test', 'Existing Guest', 'Guest reviewer',
    array[v_project_a], array['viewer'], array[]::uuid[], null, v_owner, 'attacker-code', 'EFGH');
  if v_created then raise exception 'batch invitation issued an existing account credential to owner'; end if;
  select credential_created into v_created from public.grant_guest_project_access(
    'g_unused_candidate_000000000000001', 'security-missing', 'encrypted-guest', 'gu***@example.test', 'Existing Guest', 'Guest reviewer',
    v_project_b, 'viewer', null, v_owner, 'attacker-code', 'EFGH');
  if v_created or exists (select 1 from public.guest_credentials where principal_id = v_missing)
  then raise exception 'single invitation issued an existing account credential to owner'; end if;
  if (select count(*) from public.project_memberships where principal_id = v_missing) <> 2
  then raise exception 'owner invitations no longer grant membership'; end if;

  select credential_created into v_created from public.grant_guest_project_access_batch(
    'g_unused_candidate_000000000000001', 'security-missing', 'encrypted-guest', 'gu***@example.test', 'Existing Guest', 'Guest reviewer',
    array[v_project_b], array['viewer'], array[]::uuid[], null, v_admin, 'admin-issued', '5678');
  if not v_created then raise exception 'admin failed to issue missing guest credential'; end if;
  select public.rotate_guest_credential(v_guest, 'admin-rotated', '6789', v_admin) into v_version;
  if v_version <> 2 or not exists (select 1 from public.app_sessions where principal_id = v_guest and revoked_at is not null)
  then raise exception 'admin rotation did not revoke sessions/increment version'; end if;

  update public.app_principals set disabled_at = now() where id = v_guest;
  begin
    perform public.rotate_guest_credential(v_guest, 'disabled-guest-code', 'EFGH', v_admin);
    raise exception 'disabled guest received a new credential';
  exception when insufficient_privilege then null;
  end;
  update public.app_principals set disabled_at = null where id = v_guest;
  update public.app_principals set disabled_at = now() where id = v_admin;
  begin
    perform public.rotate_guest_credential(v_guest, 'disabled-admin-code', 'EFGH', v_admin);
    raise exception 'disabled admin rotated guest credential';
  exception when insufficient_privilege then null;
  end;
  if (select code_hmac from public.guest_credentials where principal_id = v_guest) <> 'admin-rotated'
  then raise exception 'disabled actor/guest checks changed credential'; end if;
end;
$test$;
