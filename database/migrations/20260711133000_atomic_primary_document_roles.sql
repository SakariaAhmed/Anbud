with ranked_primary_documents as (
  select
    document.id,
    document.role,
    row_number() over (
      partition by document.project_id, document.role
      order by document.updated_at desc, document.created_at desc, document.id desc
    ) as authority_rank
  from public.documents document
  where document.role in (
    'primary_customer_document',
    'primary_solution_document'
  )
)
update public.documents document
set role = 'supporting_document',
    supporting_subtype = case ranked.role
      when 'primary_customer_document' then 'rfp'
      else 'utkast'
    end,
    subtype = case ranked.role
      when 'primary_customer_document' then 'rfp'
      else 'utkast'
    end
from ranked_primary_documents ranked
where ranked.id = document.id
  and ranked.authority_rank > 1;

create unique index if not exists documents_one_primary_customer_per_project_idx
  on public.documents(project_id)
  where role = 'primary_customer_document';

create unique index if not exists documents_one_primary_solution_per_project_idx
  on public.documents(project_id)
  where role = 'primary_solution_document';

create table if not exists public.stable_primary_document_authority (
  project_id uuid not null references public.projects(id) on delete cascade,
  primary_role text not null check (
    primary_role in ('primary_customer_document', 'primary_solution_document')
  ),
  document_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, primary_role)
);
alter table public.stable_primary_document_authority enable row level security;
revoke all on table public.stable_primary_document_authority
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.stable_primary_document_authority
  to service_role;

-- The stable application inserts a replacement primary document before its
-- follow-up request demotes the old row. Serialize that direct INSERT on the
-- project parent and demote the old authority before the partial unique index
-- is checked. The feature RPC already follows this lock order, so its insert
-- reaches this trigger with no previous primary left to change.
create or replace function public.prepare_legacy_primary_document_insert()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_demoted_subtype text;
  v_previous_atomic_setting text;
begin
  if new.role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    return new;
  end if;

  perform 1
  from public.projects project
  where project.id = new.project_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'insert or update on table "documents" violates foreign key constraint';
  end if;

  v_demoted_subtype := case new.role
    when 'primary_customer_document' then 'rfp'
    else 'utkast'
  end;

  v_previous_atomic_setting := pg_catalog.current_setting(
    'anbud.atomic_primary_document_write',
    true
  );

  -- Let this newer INSERT demote the prior pending authority, while the
  -- separate guard below still blocks an older request's late follow-up.
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );

  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = new.project_id
    and document.role = new.role;

  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    coalesce(v_previous_atomic_setting, ''),
    true
  );

  insert into public.stable_primary_document_authority (
    project_id,
    primary_role,
    document_id,
    created_at
  ) values (
    new.project_id,
    new.role,
    new.id,
    clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;

  return new;
end;
$$;

drop trigger if exists documents_prepare_legacy_primary_insert
  on public.documents;
create trigger documents_prepare_legacy_primary_insert
before insert on public.documents
for each row execute function public.prepare_legacy_primary_document_insert();

create or replace function public.guard_stale_stable_primary_demotion()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if old.role in ('primary_customer_document', 'primary_solution_document')
     and new.role = 'supporting_document'
     and coalesce(
       pg_catalog.current_setting('anbud.atomic_primary_document_write', true),
       ''
     ) <> 'on'
     and exists (
       select 1
       from public.stable_primary_document_authority authority
       where authority.project_id = old.project_id
         and authority.primary_role = old.role
         and authority.document_id = old.id
     ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_guard_stale_stable_primary_demotion
  on public.documents;
create trigger documents_guard_stale_stable_primary_demotion
before update of role on public.documents
for each row execute function public.guard_stale_stable_primary_demotion();

-- Stable markDocumentAsPrimary performs demote and promote in two requests.
-- The demotion guard intentionally keeps the current authority in request one;
-- request two performs the replacement atomically here before the partial
-- unique index is checked.
create or replace function public.prepare_legacy_primary_document_promotion()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_demoted_subtype text;
  v_previous_atomic_setting text;
begin
  if old.role <> 'supporting_document'
     or new.role not in (
       'primary_customer_document',
       'primary_solution_document'
     )
     or coalesce(
       pg_catalog.current_setting('anbud.atomic_primary_document_write', true),
       ''
     ) = 'on' then
    return new;
  end if;

  perform 1
  from public.projects project
  where project.id = new.project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;
  v_demoted_subtype := case new.role
    when 'primary_customer_document' then 'rfp'
    else 'utkast'
  end;
  v_previous_atomic_setting := pg_catalog.current_setting(
    'anbud.atomic_primary_document_write',
    true
  );
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );
  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = new.project_id
    and document.role = new.role
    and document.id <> old.id;
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    coalesce(v_previous_atomic_setting, ''),
    true
  );
  insert into public.stable_primary_document_authority (
    project_id, primary_role, document_id, created_at
  ) values (
    new.project_id, new.role, new.id, clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;
  return new;
end;
$$;

drop trigger if exists documents_prepare_legacy_primary_promotion
  on public.documents;
create trigger documents_prepare_legacy_primary_promotion
before update of role on public.documents
for each row execute function public.prepare_legacy_primary_document_promotion();

create or replace function public.consume_stable_primary_document_authority()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  delete from public.stable_primary_document_authority authority
  where authority.project_id = new.id
    and not exists (
      select 1
      from public.documents document
      where document.project_id = authority.project_id
        and document.id = authority.document_id
        and document.role = authority.primary_role
    );
  return new;
end;
$$;

drop trigger if exists projects_consume_stable_primary_document_authority
  on public.projects;
create trigger projects_consume_stable_primary_document_authority
after update of last_activity_at, customer_document_uploaded,
  solution_document_uploaded on public.projects
for each row execute function public.consume_stable_primary_document_authority();

revoke execute on function public.prepare_legacy_primary_document_insert()
  from public, anon, authenticated;
grant execute on function public.prepare_legacy_primary_document_insert()
  to service_role;
revoke execute on function public.guard_stale_stable_primary_demotion()
  from public, anon, authenticated;
grant execute on function public.guard_stale_stable_primary_demotion()
  to service_role;
revoke execute on function public.prepare_legacy_primary_document_promotion()
  from public, anon, authenticated;
grant execute on function public.prepare_legacy_primary_document_promotion()
  to service_role;
revoke execute on function public.consume_stable_primary_document_authority()
  from public, anon, authenticated;
grant execute on function public.consume_stable_primary_document_authority()
  to service_role;

create or replace function public.set_primary_project_document(
  p_project_id uuid,
  p_document_id uuid,
  p_primary_role text
)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_demoted_subtype text;
begin
  if p_primary_role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_INVALID: requested role is not a primary document role';
  end if;

  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );

  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  select * into v_document
  from public.documents document
  where document.project_id = p_project_id
    and document.id = p_document_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_NOT_FOUND: document does not belong to the project';
  end if;

  insert into public.stable_primary_document_authority (
    project_id,
    primary_role,
    document_id,
    created_at
  ) values (
    p_project_id,
    p_primary_role,
    p_document_id,
    clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;

  if v_document.role = p_primary_role then
    update public.projects project
    set customer_document_uploaded = exists (
          select 1
          from public.documents document
          where document.project_id = p_project_id
            and document.role = 'primary_customer_document'
        ),
        solution_document_uploaded = exists (
          select 1
          from public.documents document
          where document.project_id = p_project_id
            and document.role = 'primary_solution_document'
        ),
        last_activity_at = now()
    where project.id = p_project_id;
    return v_document;
  end if;

  if v_document.role in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_CONFLICT: a primary document cannot replace the opposite primary role';
  end if;

  v_demoted_subtype := case p_primary_role
    when 'primary_customer_document' then 'rfp'
    else 'utkast'
  end;

  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = p_project_id
    and document.role = p_primary_role
    and document.id <> p_document_id;

  update public.documents document
  set role = p_primary_role,
      supporting_subtype = null,
      subtype = null,
      updated_at = now()
  where document.project_id = p_project_id
    and document.id = p_document_id
  returning * into v_document;

  update public.projects project
  set customer_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_customer_document'
      ),
      solution_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_solution_document'
      ),
      last_activity_at = now()
  where project.id = p_project_id;

  return v_document;
end;
$$;

create or replace function public.insert_primary_project_document(
  p_project_id uuid,
  p_primary_role text,
  p_payload jsonb
)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_demoted_subtype text;
begin
  if p_primary_role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_INVALID: requested role is not a primary document role';
  end if;

  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );
  if jsonb_typeof(p_payload) is distinct from 'object'
     or nullif(btrim(p_payload ->> 'id'), '') is null
     or nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'file_name'), '') is null
     or nullif(btrim(p_payload ->> 'file_format'), '') is null
     or nullif(btrim(p_payload ->> 'content_type'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_bucket'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_path'), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_PAYLOAD_INVALID: required document fields are missing';
  end if;

  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  v_demoted_subtype := case p_primary_role
    when 'primary_customer_document' then 'rfp'
    else 'utkast'
  end;

  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = p_project_id
    and document.role = p_primary_role;

  insert into public.documents (
    id,
    project_id,
    role,
    supporting_subtype,
    subtype,
    title,
    display_name,
    file_name,
    file_format,
    content_type,
    file_size_bytes,
    page_count,
    file_storage_bucket,
    file_storage_path,
    file_base64,
    raw_text,
    structure_map,
    processing_status,
    processing_message,
    processing_error,
    parser_used,
    indexed_at
  ) values (
    (p_payload ->> 'id')::uuid,
    p_project_id,
    p_primary_role,
    null,
    null,
    p_payload ->> 'title',
    coalesce(nullif(btrim(p_payload ->> 'display_name'), ''), p_payload ->> 'title'),
    p_payload ->> 'file_name',
    p_payload ->> 'file_format',
    p_payload ->> 'content_type',
    coalesce((p_payload ->> 'file_size_bytes')::integer, 0),
    (p_payload ->> 'page_count')::integer,
    p_payload ->> 'file_storage_bucket',
    p_payload ->> 'file_storage_path',
    coalesce(p_payload ->> 'file_base64', ''),
    coalesce(p_payload ->> 'raw_text', ''),
    coalesce(p_payload -> 'structure_map', '[]'::jsonb),
    coalesce(nullif(p_payload ->> 'processing_status', ''), 'queued'),
    p_payload ->> 'processing_message',
    p_payload ->> 'processing_error',
    p_payload ->> 'parser_used',
    (p_payload ->> 'indexed_at')::timestamptz
  )
  returning * into v_document;

  update public.projects project
  set customer_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_customer_document'
      ),
      solution_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_solution_document'
      ),
      last_activity_at = now()
  where project.id = p_project_id;

  return v_document;
end;
$$;

revoke execute on function public.set_primary_project_document(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_primary_project_document(uuid, uuid, text)
  to service_role;
revoke execute on function public.insert_primary_project_document(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.insert_primary_project_document(uuid, text, jsonb)
  to service_role;
