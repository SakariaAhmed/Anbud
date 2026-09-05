-- Authentication must not undo an administrator disabling an identity.
-- Existing identities, aliases, memberships, and roles are preserved.
create or replace function public.upsert_internal_principal(
  p_candidate_principal_id text,
  p_display_name text,
  p_email_hmac text,
  p_email_encrypted text,
  p_email_masked text
)
returns table (
  principal_id text,
  identity_type text,
  display_name text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_principal public.app_principals%rowtype;
  v_was_guest boolean := false;
  v_subject_lock bigint;
  v_email_lock bigint;
begin
  v_subject_lock := pg_catalog.hashtextextended(
    p_candidate_principal_id,
    0
  );
  v_email_lock := pg_catalog.hashtextextended(
    coalesce(p_email_hmac, p_candidate_principal_id),
    0
  );
  perform pg_catalog.pg_advisory_xact_lock(
    least(v_subject_lock, v_email_lock)
  );
  if v_subject_lock <> v_email_lock then
    perform pg_catalog.pg_advisory_xact_lock(
      greatest(v_subject_lock, v_email_lock)
    );
  end if;

  select principal.*
  into v_principal
  from public.app_principals principal
  left join public.app_principal_aliases alias_row
    on alias_row.principal_id = principal.id
    and alias_row.alias_id = p_candidate_principal_id
  where alias_row.alias_id is not null
     or principal.id = p_candidate_principal_id
     or (
       p_email_hmac is not null
       and principal.email_hmac = p_email_hmac
  )
  order by case
    when alias_row.alias_id is not null then 0
    when principal.id = p_candidate_principal_id then 1
    when principal.email_hmac = p_email_hmac then 2
    else 3
  end
  limit 1
  for update of principal;

  if found then
    if v_principal.disabled_at is not null then
      raise exception using errcode = '42501', message = 'Principal is disabled';
    end if;
    v_was_guest := v_principal.identity_type = 'guest';
    update public.app_principals principal
    set
      identity_type = 'internal',
      display_name = p_display_name,
      email_hmac = coalesce(p_email_hmac, principal.email_hmac),
      email_encrypted = coalesce(p_email_encrypted, principal.email_encrypted),
      email_masked = coalesce(p_email_masked, principal.email_masked),
      last_login_at = now(),
      updated_at = now()
    where principal.id = v_principal.id
    returning principal.* into v_principal;
  else
    insert into public.app_principals (
      id,
      identity_type,
      display_name,
      email_hmac,
      email_encrypted,
      email_masked,
      last_login_at
    )
    values (
      p_candidate_principal_id,
      'internal',
      p_display_name,
      p_email_hmac,
      p_email_encrypted,
      p_email_masked,
      now()
    )
    returning * into v_principal;
  end if;

  insert into public.app_principal_aliases (
    alias_id,
    principal_id
  )
  values (
    p_candidate_principal_id,
    v_principal.id
  )
  on conflict (alias_id) do nothing;

  if v_was_guest then
    update public.guest_credentials credential
    set revoked_at = coalesce(credential.revoked_at, now())
    where credential.principal_id = v_principal.id;

    update public.app_sessions session
    set revoked_at = coalesce(session.revoked_at, now())
    where session.principal_id = v_principal.id
      and session.revoked_at is null;
  end if;

  return query
  select
    v_principal.id,
    v_principal.identity_type,
    v_principal.display_name;
end;
$$;

revoke execute on function public.upsert_internal_principal(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_internal_principal(text, text, text, text, text)
  to service_role;
