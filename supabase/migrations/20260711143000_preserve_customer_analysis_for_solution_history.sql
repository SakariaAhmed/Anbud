-- A superseded solution is retained for audit/history, but it is not a
-- customer-analysis input. Give it an explicit internal subtype so solution
-- replacement can preserve the existing customer analysis without weakening
-- invalidation for customer, requirement, and other supporting documents.

alter table public.documents
  drop constraint if exists documents_supporting_subtype_check;

alter table public.documents
  add constraint documents_supporting_subtype_check
  check (
    supporting_subtype is null
    or supporting_subtype in (
      'rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat',
      'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet'
    )
  );

alter table public.documents
  drop constraint if exists documents_subtype_check;

alter table public.documents
  add constraint documents_subtype_check
  check (
    subtype is null
    or subtype in (
      'rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat',
      'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet'
    )
  );

alter table if exists public.document_chunks
  drop constraint if exists document_chunks_supporting_subtype_check;

alter table if exists public.document_chunks
  add constraint document_chunks_supporting_subtype_check
  check (
    supporting_subtype is null
    or supporting_subtype in (
      'rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat',
      'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet'
    )
  );

create or replace function public.project_document_affects_customer_analysis(
  p_role text,
  p_supporting_subtype text,
  p_legacy_subtype text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_role <> 'primary_solution_document'
    and not (
      p_role = 'supporting_document'
      and coalesce(p_supporting_subtype, p_legacy_subtype, '') = 'tidligere_losning'
    );
$$;

-- Keep the rolling-rollback INSERT bridge aligned with the final solution
-- history semantics introduced by this migration.
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
    else 'tidligere_losning'
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

revoke execute on function public.prepare_legacy_primary_document_insert()
  from public, anon, authenticated;
grant execute on function public.prepare_legacy_primary_document_insert()
  to service_role;

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
  if not found then raise exception 'Project does not exist'; end if;
  v_demoted_subtype := case new.role
    when 'primary_customer_document' then 'rfp'
    else 'tidligere_losning'
  end;
  v_previous_atomic_setting := pg_catalog.current_setting(
    'anbud.atomic_primary_document_write',
    true
  );
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write', 'on', true
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

revoke execute on function public.prepare_legacy_primary_document_promotion()
  from public, anon, authenticated;
grant execute on function public.prepare_legacy_primary_document_promotion()
  to service_role;

create or replace function public.bump_project_source_revision_from_document()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_invalidates_analysis boolean;
begin
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  v_invalidates_analysis := case
    when tg_op = 'INSERT' then public.project_document_affects_customer_analysis(
      new.role,
      new.supporting_subtype,
      new.subtype
    )
    when tg_op = 'DELETE' then public.project_document_affects_customer_analysis(
      old.role,
      old.supporting_subtype,
      old.subtype
    )
    else public.project_document_affects_customer_analysis(
      old.role,
      old.supporting_subtype,
      old.subtype
    ) or public.project_document_affects_customer_analysis(
      new.role,
      new.supporting_subtype,
      new.subtype
    )
  end;
  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      solution_evaluation_generated = false,
      customer_analysis_generated = case
        when v_invalidates_analysis then false
        else customer_analysis_generated
      end
  where id = v_project_id;
  if v_invalidates_analysis then
    delete from public.customer_analyses where project_id = v_project_id;
  end if;
  delete from public.solution_evaluations where project_id = v_project_id;
  delete from public.executive_summaries where project_id = v_project_id;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.invalidate_document_on_readiness_loss()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_invalidates_analysis boolean;
begin
  if old.processing_status not in ('basic_ready', 'enhanced_ready')
     or new.processing_status not in ('queued', 'processing', 'failed') then
    return new;
  end if;
  v_invalidates_analysis := public.project_document_affects_customer_analysis(
    new.role,
    new.supporting_subtype,
    new.subtype
  );
  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      solution_evaluation_generated = false,
      customer_analysis_generated = case
        when v_invalidates_analysis then false
        else customer_analysis_generated
      end
  where id = new.project_id;
  if v_invalidates_analysis then
    delete from public.customer_analyses where project_id = new.project_id;
  end if;
  delete from public.solution_evaluations where project_id = new.project_id;
  delete from public.executive_summaries where project_id = new.project_id;
  return new;
end;
$$;

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
    else 'tidligere_losning'
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
    else 'tidligere_losning'
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

revoke execute on function public.project_document_affects_customer_analysis(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.bump_project_source_revision_from_document()
  from public, anon, authenticated;
revoke execute on function public.invalidate_document_on_readiness_loss()
  from public, anon, authenticated;
revoke execute on function public.set_primary_project_document(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.insert_primary_project_document(uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.project_document_affects_customer_analysis(text, text, text)
  to service_role;
grant execute on function public.bump_project_source_revision_from_document()
  to service_role;
grant execute on function public.invalidate_document_on_readiness_loss()
  to service_role;
grant execute on function public.set_primary_project_document(uuid, uuid, text)
  to service_role;
grant execute on function public.insert_primary_project_document(uuid, text, jsonb)
  to service_role;
