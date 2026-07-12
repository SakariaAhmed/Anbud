-- Persist a service document and its derived service keywords in one
-- transaction. The existing service-document trigger performs the one global
-- library invalidation; its transaction-local marker coalesces the following
-- keyword update instead of scanning and invalidating every project twice.

create or replace function public.insert_service_document_with_keywords(
  p_service_id uuid,
  p_payload jsonb,
  p_keywords text[]
)
returns public.service_documents
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_document public.service_documents%rowtype;
  v_keywords text[];
begin
  if p_service_id is null then
    raise exception using
      errcode = '23502',
      message = 'SERVICE_DOCUMENT_SERVICE_REQUIRED: service id is required';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or nullif(btrim(p_payload ->> 'id'), '') is null
     or nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'file_name'), '') is null
     or nullif(btrim(p_payload ->> 'file_format'), '') is null
     or nullif(btrim(p_payload ->> 'content_type'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_bucket'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_path'), '') is null then
    raise exception using
      errcode = '22023',
      message = 'SERVICE_DOCUMENT_PAYLOAD_INVALID: required fields are missing';
  end if;
  if (p_payload ->> 'service_id')::uuid is distinct from p_service_id then
    raise exception using
      errcode = '22023',
      message = 'SERVICE_DOCUMENT_SERVICE_MISMATCH: payload service differs from argument';
  end if;
  if coalesce(p_payload ->> 'file_format', '') not in (
    'pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'
  ) then
    raise exception using
      errcode = '23514',
      message = 'SERVICE_DOCUMENT_FORMAT_INVALID: file format is unsupported';
  end if;
  if p_keywords is null or array_position(p_keywords, null) is not null then
    raise exception using
      errcode = '22004',
      message = 'SERVICE_DOCUMENT_KEYWORDS_INVALID: keywords must be a non-null text array';
  end if;

  perform 1
  from public.service_descriptions service
  where service.id = p_service_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'SERVICE_DOCUMENT_SERVICE_NOT_FOUND: service does not exist';
  end if;

  insert into public.service_documents (
    id,
    service_id,
    title,
    file_name,
    file_format,
    content_type,
    file_size_bytes,
    page_count,
    file_storage_bucket,
    file_storage_path,
    file_base64,
    raw_text,
    structure_map
  ) values (
    (p_payload ->> 'id')::uuid,
    p_service_id,
    p_payload ->> 'title',
    p_payload ->> 'file_name',
    p_payload ->> 'file_format',
    p_payload ->> 'content_type',
    coalesce((p_payload ->> 'file_size_bytes')::integer, 0),
    (p_payload ->> 'page_count')::integer,
    p_payload ->> 'file_storage_bucket',
    p_payload ->> 'file_storage_path',
    coalesce(p_payload ->> 'file_base64', ''),
    coalesce(p_payload ->> 'raw_text', ''),
    coalesce(p_payload -> 'structure_map', '[]'::jsonb)
  )
  returning * into v_document;

  select coalesce(array_agg(keyword order by first_ordinal), '{}'::text[])
    into v_keywords
  from (
    select lower(btrim(candidate.value)) as keyword,
           min(candidate.ordinality) as first_ordinal
    from public.service_descriptions service
    cross join lateral unnest(
      coalesce(service.keywords, '{}'::text[]) || p_keywords
    ) with ordinality as candidate(value, ordinality)
    where service.id = p_service_id
      and btrim(candidate.value) <> ''
    group by lower(btrim(candidate.value))
    order by min(candidate.ordinality)
    limit 96
  ) normalized;

  update public.service_descriptions service
  set keywords = v_keywords,
      updated_at = clock_timestamp()
  where service.id = p_service_id;

  return v_document;
end;
$$;

create or replace function public.atomic_service_document_write_preflight()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.to_regprocedure(
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])'
     ) is null then
    raise exception 'Atomic service-document writer is missing';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     ) then
    raise exception 'Atomic service-document writer ACL is missing or unsafe';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_trigger trigger
    where trigger.tgname in (
        'service_descriptions_artifact_source_revision',
        'service_documents_artifact_source_revision'
      )
      and trigger.tgfoid = pg_catalog.to_regprocedure(
        'public.bump_service_library_revision()'
      )
      and trigger.tgenabled in ('O', 'A')
      and not trigger.tgisinternal
  ) <> 2 then
    raise exception 'Service-library invalidation triggers are missing';
  end if;
  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure('public.bump_service_library_revision()')
       ),
       'anbud.service_library_invalidated'
     ) = 0 then
    raise exception 'Service-library invalidation coalescing marker is missing';
  end if;
  return 'atomic-service-document-write-v1';
end;
$$;

revoke execute on function public.insert_service_document_with_keywords(
  uuid, jsonb, text[]
) from public, anon, authenticated;
grant execute on function public.insert_service_document_with_keywords(
  uuid, jsonb, text[]
) to service_role;
revoke execute on function public.atomic_service_document_write_preflight()
  from public, anon, authenticated;
grant execute on function public.atomic_service_document_write_preflight()
  to service_role;
