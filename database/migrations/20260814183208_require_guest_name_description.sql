-- Persist a short, administrator-supplied description for every guest. Existing
-- guests receive an explicit legacy marker so the invariant can be enforced
-- without making the migration unsafe on populated environments.

alter table public.app_principals
  add column if not exists guest_description text;

update public.app_principals
set guest_description = 'Eksisterende gjest uten registrert beskrivelse.'
where identity_type = 'guest'
  and nullif(btrim(guest_description), '') is null;

alter table public.app_principals
  drop constraint if exists app_principals_guest_description_length;

alter table public.app_principals
  add constraint app_principals_guest_description_length
  check (
    identity_type <> 'guest'
    or (
      guest_description is not null
      and char_length(btrim(guest_description)) between 3 and 240
    )
  );

drop function if exists public.grant_guest_project_access(
  text, text, text, text, text, uuid, text, timestamptz, text, text, text
);

create function public.grant_guest_project_access(
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

revoke execute on function public.grant_guest_project_access(
  text, text, text, text, text, text, uuid, text, timestamptz, text, text, text
) from public, anon, authenticated;

grant execute on function public.grant_guest_project_access(
  text, text, text, text, text, text, uuid, text, timestamptz, text, text, text
) to service_role;
