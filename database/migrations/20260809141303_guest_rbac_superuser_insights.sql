-- Application identities, revocable sessions, project RBAC, guest credentials,
-- groups, and immutable activity events. The application continues to use the
-- service role on the server, so every table stays unavailable to public Data
-- API roles and authorization remains explicit in the application policy layer.

create extension if not exists pgcrypto;

create table if not exists public.app_principals (
  id text primary key,
  identity_type text not null
    check (identity_type in ('internal', 'guest')),
  display_name text not null,
  email_hmac text unique,
  email_encrypted text,
  email_masked text,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_principals_id_format
    check (id ~ '^[A-Za-z0-9_-]{20,128}$'),
  constraint app_principals_email_pair
    check (
      (email_hmac is null and email_encrypted is null)
      or
      (email_hmac is not null and email_encrypted is not null)
    )
);

create table if not exists public.app_principal_roles (
  principal_id text not null
    references public.app_principals(id) on delete cascade,
  role text not null check (role in ('admin', 'super_user')),
  granted_by text references public.app_principals(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (principal_id, role)
);

create table if not exists public.app_principal_aliases (
  alias_id text primary key,
  principal_id text not null
    references public.app_principals(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint app_principal_aliases_id_format
    check (alias_id ~ '^[A-Za-z0-9_-]{20,128}$')
);

create index if not exists app_principal_aliases_principal_idx
  on public.app_principal_aliases(principal_id);

create index if not exists app_principal_roles_role_principal_idx
  on public.app_principal_roles(role, principal_id);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  principal_id text not null
    references public.app_principals(id) on delete cascade,
  token_hmac text not null unique,
  auth_method text not null
    check (auth_method in ('entra', 'guest_code', 'development_password')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint app_sessions_expiry_after_creation
    check (expires_at > created_at)
);

create index if not exists app_sessions_principal_active_idx
  on public.app_sessions(principal_id, expires_at desc)
  where revoked_at is null;

create table if not exists public.app_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null unique,
  description text,
  created_by text references public.app_principals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_groups_name_length
    check (char_length(name) between 2 and 100)
);

create table if not exists public.app_group_members (
  group_id uuid not null
    references public.app_groups(id) on delete cascade,
  principal_id text not null
    references public.app_principals(id) on delete cascade,
  added_by text references public.app_principals(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (group_id, principal_id)
);

create index if not exists app_group_members_principal_group_idx
  on public.app_group_members(principal_id, group_id);

create table if not exists public.project_memberships (
  project_id uuid not null
    references public.projects(id) on delete cascade,
  principal_id text not null
    references public.app_principals(id) on delete cascade,
  role text not null
    check (role in ('owner', 'editor', 'viewer', 'restricted_viewer')),
  invited_by text references public.app_principals(id) on delete set null,
  invitation_sent_at timestamptz,
  accepted_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, principal_id)
);

create index if not exists project_memberships_principal_active_idx
  on public.project_memberships(principal_id, project_id, role)
  where revoked_at is null;

create index if not exists project_memberships_project_active_idx
  on public.project_memberships(project_id, role, principal_id)
  where revoked_at is null;

create table if not exists public.project_group_grants (
  project_id uuid not null
    references public.projects(id) on delete cascade,
  group_id uuid not null
    references public.app_groups(id) on delete cascade,
  role text not null
    check (role in ('editor', 'viewer', 'restricted_viewer')),
  granted_by text references public.app_principals(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, group_id)
);

create index if not exists project_group_grants_group_active_idx
  on public.project_group_grants(group_id, project_id, role)
  where revoked_at is null;

create table if not exists public.guest_credentials (
  principal_id text primary key
    references public.app_principals(id) on delete cascade,
  code_hmac text not null unique,
  code_last_four text not null,
  credential_version integer not null default 1
    check (credential_version > 0),
  created_by text references public.app_principals(id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint guest_credentials_last_four_format
    check (code_last_four ~ '^[A-Z2-9]{4}$')
);

create table if not exists public.activity_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_principal_id text
    references public.app_principals(id) on delete set null,
  actor_session_id uuid
    references public.app_sessions(id) on delete set null,
  action text not null,
  result text not null check (result in ('ok', 'denied', 'error')),
  project_id uuid references public.projects(id) on delete set null,
  entity_type text,
  entity_id text,
  request_id text,
  ip_hmac text,
  user_agent_hmac text,
  metadata jsonb not null default '{}'::jsonb,
  constraint activity_events_action_length
    check (char_length(action) between 2 and 120),
  constraint activity_events_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists activity_events_occurred_idx
  on public.activity_events(occurred_at desc);

create index if not exists activity_events_actor_occurred_idx
  on public.activity_events(actor_principal_id, occurred_at desc);

create index if not exists activity_events_project_occurred_idx
  on public.activity_events(project_id, occurred_at desc);

create index if not exists activity_events_action_occurred_idx
  on public.activity_events(action, occurred_at desc);

create or replace function public.touch_access_control_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_app_principals_updated_at
  on public.app_principals;
create trigger touch_app_principals_updated_at
before update on public.app_principals
for each row execute function public.touch_access_control_updated_at();

drop trigger if exists touch_app_groups_updated_at
  on public.app_groups;
create trigger touch_app_groups_updated_at
before update on public.app_groups
for each row execute function public.touch_access_control_updated_at();

drop trigger if exists touch_project_memberships_updated_at
  on public.project_memberships;
create trigger touch_project_memberships_updated_at
before update on public.project_memberships
for each row execute function public.touch_access_control_updated_at();

drop trigger if exists touch_project_group_grants_updated_at
  on public.project_group_grants;
create trigger touch_project_group_grants_updated_at
before update on public.project_group_grants
for each row execute function public.touch_access_control_updated_at();

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
    v_was_guest := v_principal.identity_type = 'guest';
    update public.app_principals principal
    set
      identity_type = 'internal',
      display_name = p_display_name,
      email_hmac = coalesce(p_email_hmac, principal.email_hmac),
      email_encrypted = coalesce(p_email_encrypted, principal.email_encrypted),
      email_masked = coalesce(p_email_masked, principal.email_masked),
      disabled_at = null,
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

create or replace function public.grant_guest_project_access(
  p_candidate_principal_id text,
  p_email_hmac text,
  p_email_encrypted text,
  p_email_masked text,
  p_display_name text,
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
  if p_role not in ('editor', 'viewer', 'restricted_viewer') then
    raise exception 'Guests cannot receive project role %', p_role;
  end if;

  insert into public.app_principals (
    id,
    identity_type,
    display_name,
    email_hmac,
    email_encrypted,
    email_masked
  )
  values (
    p_candidate_principal_id,
    'guest',
    p_display_name,
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

create or replace function public.revoke_project_member_access(
  p_project_id uuid,
  p_principal_id text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_is_guest boolean;
  v_has_other_access boolean;
begin
  update public.project_memberships
  set revoked_at = coalesce(revoked_at, now())
  where project_id = p_project_id
    and principal_id = p_principal_id
    and role <> 'owner';

  select principal.identity_type = 'guest'
  into v_is_guest
  from public.app_principals principal
  where principal.id = p_principal_id;

  if coalesce(v_is_guest, false) then
    select exists (
      select 1
      from public.project_memberships membership
      where membership.principal_id = p_principal_id
        and membership.revoked_at is null
        and (
          membership.expires_at is null
          or membership.expires_at > now()
        )
    )
    into v_has_other_access;

    if not v_has_other_access then
      update public.app_sessions
      set revoked_at = coalesce(revoked_at, now())
      where principal_id = p_principal_id
        and revoked_at is null;
    end if;
  end if;
end;
$$;

create or replace function public.replace_group_members(
  p_group_id uuid,
  p_principal_ids text[],
  p_added_by text
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
  if exists (
    select 1
    from unnest(coalesce(p_principal_ids, array[]::text[]))
      requested(principal_id)
    left join public.app_principals principal
      on principal.id = requested.principal_id
    where principal.id is null or principal.disabled_at is not null
  ) then
    raise exception 'Group member is missing or disabled';
  end if;

  delete from public.app_group_members
  where group_id = p_group_id;

  insert into public.app_group_members (
    group_id,
    principal_id,
    added_by
  )
  select
    p_group_id,
    requested.principal_id,
    p_added_by
  from (
    select distinct unnest(coalesce(p_principal_ids, array[]::text[]))
      as principal_id
  ) requested
  join public.app_principals principal
    on principal.id = requested.principal_id
  where principal.disabled_at is null;
end;
$$;

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
    where requested.role not in ('admin', 'super_user')
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

create or replace function public.resolve_app_session(
  p_session_id uuid,
  p_token_hmac text
)
returns table (
  session_id uuid,
  principal_id text,
  identity_type text,
  display_name text,
  global_roles text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    session.id,
    principal.id,
    principal.identity_type,
    principal.display_name,
    coalesce(
      array_agg(role.role order by role.role)
        filter (where role.role is not null),
      array[]::text[]
    )
  from public.app_sessions session
  join public.app_principals principal
    on principal.id = session.principal_id
  left join public.app_principal_roles role
    on role.principal_id = principal.id
  where session.id = p_session_id
    and session.token_hmac = p_token_hmac
    and session.revoked_at is null
    and session.expires_at > now()
    and principal.disabled_at is null
  group by session.id, principal.id;
$$;

create or replace function public.resolve_project_role(
  p_principal_id text,
  p_project_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  with candidate_roles(role) as (
    select membership.role
    from public.project_memberships membership
    where membership.project_id = p_project_id
      and membership.principal_id = p_principal_id
      and membership.revoked_at is null
      and (
        membership.expires_at is null
        or membership.expires_at > now()
      )

    union all

    select grant_row.role
    from public.app_group_members group_member
    join public.project_group_grants grant_row
      on grant_row.group_id = group_member.group_id
    where group_member.principal_id = p_principal_id
      and grant_row.project_id = p_project_id
      and grant_row.revoked_at is null
      and (
        grant_row.expires_at is null
        or grant_row.expires_at > now()
      )

    union all

    select 'owner'::text
    from public.projects project
    where project.id = p_project_id
      and project.owner_id = p_principal_id
  )
  select candidate.role
  from candidate_roles candidate
  order by case candidate.role
    when 'owner' then 4
    when 'editor' then 3
    when 'viewer' then 2
    when 'restricted_viewer' then 1
    else 0
  end desc
  limit 1;
$$;

create or replace function public.sync_project_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is null or btrim(new.owner_id) = '' then
    return new;
  end if;

  insert into public.app_principals (
    id,
    identity_type,
    display_name
  )
  values (
    new.owner_id,
    'internal',
    'Bidsite-bruker'
  )
  on conflict (id) do nothing;

  insert into public.project_memberships (
    project_id,
    principal_id,
    role,
    accepted_at,
    invited_by,
    revoked_at
  )
  values (
    new.id,
    new.owner_id,
    'owner',
    now(),
    new.owner_id,
    null
  )
  on conflict (project_id, principal_id) do update
  set role = 'owner',
      accepted_at = coalesce(public.project_memberships.accepted_at, now()),
      revoked_at = null,
      updated_at = now();

  if tg_op = 'UPDATE' and old.owner_id is distinct from new.owner_id then
    update public.project_memberships
    set revoked_at = coalesce(revoked_at, now()),
        updated_at = now()
    where project_id = new.id
      and principal_id = old.owner_id
      and role = 'owner';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_sync_owner_membership
  on public.projects;
create trigger projects_sync_owner_membership
after insert or update of owner_id on public.projects
for each row execute function public.sync_project_owner_membership();

insert into public.app_principals (
  id,
  identity_type,
  display_name
)
select distinct
  project.owner_id,
  'internal',
  'Eksisterende bruker'
from public.projects project
where project.owner_id is not null
  and project.owner_id ~ '^[A-Za-z0-9_-]{20,128}$'
on conflict (id) do nothing;

insert into public.project_memberships (
  project_id,
  principal_id,
  role,
  accepted_at
)
select
  project.id,
  project.owner_id,
  'owner',
  now()
from public.projects project
where project.owner_id is not null
  and exists (
    select 1
    from public.app_principals principal
    where principal.id = project.owner_id
  )
on conflict (project_id, principal_id) do update
set
  role = 'owner',
  revoked_at = null,
updated_at = now();

insert into public.app_principal_aliases (
  alias_id,
  principal_id
)
select principal.id, principal.id
from public.app_principals principal
where principal.identity_type = 'internal'
on conflict (alias_id) do nothing;

alter table public.app_principals enable row level security;
alter table public.app_principal_aliases enable row level security;
alter table public.app_principal_roles enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_groups enable row level security;
alter table public.app_group_members enable row level security;
alter table public.project_memberships enable row level security;
alter table public.project_group_grants enable row level security;
alter table public.guest_credentials enable row level security;
alter table public.activity_events enable row level security;

revoke all on table public.app_principals
  from public, anon, authenticated;
revoke all on table public.app_principal_aliases
  from public, anon, authenticated;
revoke all on table public.app_principal_roles
  from public, anon, authenticated;
revoke all on table public.app_sessions
  from public, anon, authenticated;
revoke all on table public.app_groups
  from public, anon, authenticated;
revoke all on table public.app_group_members
  from public, anon, authenticated;
revoke all on table public.project_memberships
  from public, anon, authenticated;
revoke all on table public.project_group_grants
  from public, anon, authenticated;
revoke all on table public.guest_credentials
  from public, anon, authenticated;
revoke all on table public.activity_events
  from public, anon, authenticated;

grant select, insert, update, delete on table public.app_principals
  to service_role;
grant select, insert, update, delete on table public.app_principal_aliases
  to service_role;
grant select, insert, update, delete on table public.app_principal_roles
  to service_role;
grant select, insert, update, delete on table public.app_sessions
  to service_role;
grant select, insert, update, delete on table public.app_groups
  to service_role;
grant select, insert, update, delete on table public.app_group_members
  to service_role;
grant select, insert, update, delete on table public.project_memberships
  to service_role;
grant select, insert, update, delete on table public.project_group_grants
  to service_role;
grant select, insert, update, delete on table public.guest_credentials
  to service_role;
grant select, insert on table public.activity_events
  to service_role;
grant usage, select on sequence public.activity_events_id_seq
  to service_role;

revoke execute on function public.touch_access_control_updated_at()
  from public, anon, authenticated;
revoke execute on function public.upsert_internal_principal(
  text, text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.grant_guest_project_access(
  text, text, text, text, text, uuid, text, timestamptz, text, text, text
) from public, anon, authenticated;
revoke execute on function public.rotate_guest_credential(
  text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.revoke_project_member_access(
  uuid, text
) from public, anon, authenticated;
revoke execute on function public.resolve_app_session(
  uuid, text
) from public, anon, authenticated;
revoke execute on function public.resolve_project_role(
  text, uuid
) from public, anon, authenticated;
revoke execute on function public.replace_group_members(
  uuid, text[], text
) from public, anon, authenticated;
revoke execute on function public.replace_principal_roles(
  text, text[], text
) from public, anon, authenticated;
revoke execute on function public.sync_project_owner_membership()
  from public, anon, authenticated;

grant execute on function public.touch_access_control_updated_at()
  to service_role;
grant execute on function public.upsert_internal_principal(
  text, text, text, text, text
) to service_role;
grant execute on function public.grant_guest_project_access(
  text, text, text, text, text, uuid, text, timestamptz, text, text, text
) to service_role;
grant execute on function public.rotate_guest_credential(
  text, text, text, text
) to service_role;
grant execute on function public.revoke_project_member_access(
  uuid, text
) to service_role;
grant execute on function public.resolve_app_session(
  uuid, text
) to service_role;
grant execute on function public.resolve_project_role(
  text, uuid
) to service_role;
grant execute on function public.replace_group_members(
  uuid, text[], text
) to service_role;
grant execute on function public.replace_principal_roles(
  text, text[], text
) to service_role;
grant execute on function public.sync_project_owner_membership()
  to service_role;
