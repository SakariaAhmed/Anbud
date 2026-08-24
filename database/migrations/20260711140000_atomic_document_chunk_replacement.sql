alter table public.documents
  add column if not exists chunk_source_revision bigint not null default 0;

alter table public.service_documents
  add column if not exists chunk_source_revision bigint not null default 0;

create or replace function public.bump_project_document_chunk_source_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if jsonb_build_array(
       v_old -> 'project_id',
       v_old -> 'role',
       v_old -> 'supporting_subtype',
       v_old -> 'subtype',
       v_old -> 'title',
       v_old -> 'display_name',
       v_old -> 'file_name',
       v_old -> 'file_format',
       v_old -> 'raw_text',
       v_old -> 'structure_map',
       v_old -> 'source_map'
     ) is distinct from jsonb_build_array(
       v_new -> 'project_id',
       v_new -> 'role',
       v_new -> 'supporting_subtype',
       v_new -> 'subtype',
       v_new -> 'title',
       v_new -> 'display_name',
       v_new -> 'file_name',
       v_new -> 'file_format',
       v_new -> 'raw_text',
       v_new -> 'structure_map',
       v_new -> 'source_map'
     ) then
    new.chunk_source_revision := old.chunk_source_revision + 1;
  else
    new.chunk_source_revision := old.chunk_source_revision;
  end if;
  return new;
end;
$$;

create or replace function public.bump_service_document_chunk_source_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if jsonb_build_array(
       v_old -> 'service_id',
       v_old -> 'title',
       v_old -> 'display_name',
       v_old -> 'file_name',
       v_old -> 'file_format',
       v_old -> 'raw_text',
       v_old -> 'structure_map',
       v_old -> 'source_map'
     ) is distinct from jsonb_build_array(
       v_new -> 'service_id',
       v_new -> 'title',
       v_new -> 'display_name',
       v_new -> 'file_name',
       v_new -> 'file_format',
       v_new -> 'raw_text',
       v_new -> 'structure_map',
       v_new -> 'source_map'
     ) then
    new.chunk_source_revision := old.chunk_source_revision + 1;
  else
    new.chunk_source_revision := old.chunk_source_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_chunk_source_revision on public.documents;
create trigger documents_chunk_source_revision
  before update on public.documents
  for each row
  execute function public.bump_project_document_chunk_source_revision();

drop trigger if exists service_documents_chunk_source_revision
  on public.service_documents;
create trigger service_documents_chunk_source_revision
  before update on public.service_documents
  for each row
  execute function public.bump_service_document_chunk_source_revision();

revoke all on function public.bump_project_document_chunk_source_revision()
  from public, anon, authenticated;
revoke all on function public.bump_service_document_chunk_source_revision()
  from public, anon, authenticated;

drop function if exists public.replace_document_chunks_atomic(
  text,
  uuid,
  text,
  integer,
  jsonb
);

create or replace function public.replace_document_chunks_atomic(
  p_source_type text,
  p_source_id uuid,
  p_source_fingerprint text,
  p_expected_source_revision bigint,
  p_expected_chunk_count integer,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_service_id uuid;
  v_revalidated_parent_id uuid;
  v_source_revision bigint;
  v_document_title text;
  v_file_name text;
  v_file_format text;
  v_role text;
  v_supporting_subtype text;
  v_row_count integer;
  v_distinct_index_count integer;
  v_min_index integer;
  v_max_index integer;
  v_inserted_count integer;
begin
  if p_source_type is null
     or p_source_type not in ('project_document', 'service_document') then
    raise exception using
      errcode = '23514',
      message = 'Invalid document chunk source type';
  end if;

  if p_source_id is null then
    raise exception using
      errcode = '23502',
      message = 'Document chunk source id is required';
  end if;

  if p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'A valid document chunk source fingerprint is required';
  end if;

  if p_expected_source_revision is null or p_expected_source_revision < 0 then
    raise exception using
      errcode = '23514',
      message = 'Expected document chunk source revision is required';
  end if;

  if p_expected_chunk_count is null or p_expected_chunk_count < 0 then
    raise exception using
      errcode = '23514',
      message = 'Expected document chunk count must be non-negative';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Document chunk rows must be a JSON array';
  end if;

  if jsonb_array_length(p_rows) <> p_expected_chunk_count then
    raise exception using
      errcode = '23514',
      message = 'Document chunk payload count does not match the expected count';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as payload(row_json)
    where jsonb_typeof(payload.row_json) is distinct from 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Every document chunk row must be a JSON object';
  end if;

  if p_source_type = 'project_document' then
    select document.project_id
    into v_project_id
    from public.documents document
    where document.id = p_source_id;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source does not reference an existing project document';
    end if;

    perform 1
    from public.projects project
    where project.id = v_project_id
    for key share;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source project does not exist';
    end if;

    select document.project_id, document.chunk_source_revision,
           document.title, document.file_name, document.file_format,
           document.role, document.supporting_subtype
    into v_revalidated_parent_id, v_source_revision,
         v_document_title, v_file_name, v_file_format,
         v_role, v_supporting_subtype
    from public.documents document
    where document.id = p_source_id
    for update nowait;

    if not found
       or v_revalidated_parent_id is distinct from v_project_id
       or v_source_revision is distinct from p_expected_source_revision then
      raise exception using
        errcode = '40001',
        message = 'Document chunk project source changed before replacement';
    end if;
  else
    select document.service_id
    into v_service_id
    from public.service_documents document
    where document.id = p_source_id;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source does not reference an existing service document';
    end if;

    perform 1
    from public.service_descriptions service
    where service.id = v_service_id
    for key share;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source service does not exist';
    end if;

    select document.service_id, document.chunk_source_revision,
           document.title, document.file_name, document.file_format
    into v_revalidated_parent_id, v_source_revision,
         v_document_title, v_file_name, v_file_format
    from public.service_documents document
    where document.id = p_source_id
    for update nowait;

    if not found
       or v_revalidated_parent_id is distinct from v_service_id
       or v_source_revision is distinct from p_expected_source_revision then
      raise exception using
        errcode = '40001',
        message = 'Document chunk service source changed before replacement';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as payload(row_json)
    where payload.row_json ->> 'source_type' is distinct from p_source_type
       or payload.row_json ->> 'source_id' is distinct from p_source_id::text
       or payload.row_json ->> 'document_title' is distinct from v_document_title
       or payload.row_json ->> 'file_name' is distinct from v_file_name
       or payload.row_json ->> 'file_format' is distinct from v_file_format
       or (
         p_source_type = 'project_document'
         and (
           payload.row_json ->> 'project_id' is distinct from v_project_id::text
           or payload.row_json ->> 'service_id' is not null
           or payload.row_json ->> 'role' is distinct from v_role
           or payload.row_json ->> 'supporting_subtype'
                is distinct from v_supporting_subtype
         )
       )
       or (
         p_source_type = 'service_document'
         and (
           payload.row_json ->> 'project_id' is not null
           or payload.row_json ->> 'service_id' is distinct from v_service_id::text
           or payload.row_json ->> 'role' is not null
           or payload.row_json ->> 'supporting_subtype' is not null
         )
       )
       or jsonb_typeof(payload.row_json -> 'metadata') is distinct from 'object'
       or payload.row_json -> 'metadata' ->> 'source_fingerprint'
            is distinct from p_source_fingerprint
       or payload.row_json -> 'metadata' -> 'source_fingerprint_version'
            is distinct from '1'::jsonb
       or payload.row_json -> 'metadata' ->> 'content_hash'
            is distinct from payload.row_json ->> 'content_hash'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Document chunk payload does not match its source manifest';
  end if;

  select
    count(*)::integer,
    count(distinct (payload.row_json ->> 'chunk_index')::integer)::integer,
    min((payload.row_json ->> 'chunk_index')::integer),
    max((payload.row_json ->> 'chunk_index')::integer)
  into
    v_row_count,
    v_distinct_index_count,
    v_min_index,
    v_max_index
  from jsonb_array_elements(p_rows) as payload(row_json);

  if v_row_count <> p_expected_chunk_count
     or v_distinct_index_count <> p_expected_chunk_count
     or (
       p_expected_chunk_count > 0
       and (v_min_index <> 0 or v_max_index <> p_expected_chunk_count - 1)
     ) then
    raise exception using
      errcode = '23514',
      message = 'Document chunk indexes must be unique and contiguous from zero';
  end if;

  delete from public.document_chunks
  where source_type = p_source_type
    and source_id = p_source_id;

  insert into public.document_chunks (
    source_type,
    source_id,
    project_id,
    service_id,
    document_title,
    file_name,
    file_format,
    role,
    supporting_subtype,
    chunk_index,
    kind,
    reference,
    heading_path,
    page_start,
    page_end,
    token_count,
    text_encrypted,
    fts,
    content_hash,
    metadata,
    embedding,
    embedding_model,
    embedding_created_at
  )
  select
    chunk.source_type,
    chunk.source_id,
    chunk.project_id,
    chunk.service_id,
    chunk.document_title,
    chunk.file_name,
    chunk.file_format,
    chunk.role,
    chunk.supporting_subtype,
    chunk.chunk_index,
    chunk.kind,
    chunk.reference,
    chunk.heading_path,
    chunk.page_start,
    chunk.page_end,
    chunk.token_count,
    chunk.text_encrypted,
    to_tsvector('simple', left(coalesce(chunk.search_text, ''), 200000)),
    chunk.content_hash,
    chunk.metadata,
    case
      when chunk.embedding is null then null
      else chunk.embedding::extensions.vector
    end,
    chunk.embedding_model,
    chunk.embedding_created_at
  from jsonb_to_recordset(p_rows) as chunk(
    source_type text,
    source_id uuid,
    project_id uuid,
    service_id uuid,
    document_title text,
    file_name text,
    file_format text,
    role text,
    supporting_subtype text,
    chunk_index integer,
    kind text,
    reference text,
    heading_path text[],
    page_start integer,
    page_end integer,
    token_count integer,
    text_encrypted text,
    content_hash text,
    metadata jsonb,
    embedding text,
    embedding_model text,
    embedding_created_at timestamptz,
    search_text text
  );

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> p_expected_chunk_count then
    raise exception using
      errcode = '23514',
      message = 'Atomic document chunk replacement inserted an incomplete set';
  end if;

  return v_inserted_count;
end;
$$;

drop function if exists public.document_chunks_are_complete(
  text,
  uuid,
  text,
  integer,
  text,
  timestamptz
);

create or replace function public.document_chunks_are_complete(
  p_source_type text,
  p_source_id uuid,
  p_source_fingerprint text,
  p_expected_source_revision bigint,
  p_expected_chunk_count integer,
  p_embedding_model text,
  p_checked_at timestamptz
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_service_id uuid;
  v_source_revision bigint;
  v_complete boolean;
begin
  if p_source_type is null
     or p_source_type not in ('project_document', 'service_document')
     or p_source_id is null
     or p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9a-f]{64}$'
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_expected_chunk_count is null
     or p_expected_chunk_count < 0
     or p_checked_at is null
     or (p_embedding_model is not null and btrim(p_embedding_model) = '') then
    return false;
  end if;

  if p_source_type = 'project_document' then
    select document.project_id, document.chunk_source_revision
    into v_project_id, v_source_revision
    from public.documents document
    where document.id = p_source_id;

    if not found
       or v_source_revision is distinct from p_expected_source_revision then
      return false;
    end if;
  else
    select document.service_id, document.chunk_source_revision
    into v_service_id, v_source_revision
    from public.service_documents document
    where document.id = p_source_id;

    if not found
       or v_source_revision is distinct from p_expected_source_revision then
      return false;
    end if;
  end if;

  if p_expected_chunk_count = 0 then
    return not exists (
      select 1
      from public.document_chunks chunk
      where chunk.source_type = p_source_type
        and chunk.source_id = p_source_id
    );
  end if;

  begin
    select
      count(*) = p_expected_chunk_count
      and count(distinct chunk.chunk_index) = p_expected_chunk_count
      and min(chunk.chunk_index) = 0
      and max(chunk.chunk_index) = p_expected_chunk_count - 1
      and coalesce(
        bool_and(
          coalesce(
            chunk.metadata ->> 'source_fingerprint' = p_source_fingerprint
            and chunk.metadata -> 'source_fingerprint_version' = '1'::jsonb
            and chunk.metadata ->> 'content_hash' = chunk.content_hash
            and case
              when p_source_type = 'project_document' then
                chunk.project_id = v_project_id and chunk.service_id is null
              else
                chunk.project_id is null and chunk.service_id = v_service_id
            end,
            false
          )
        ),
        false
      )
      and case
        when p_embedding_model is null then true
        else coalesce(
          bool_and(
            coalesce(
              (
                chunk.embedding is not null
                and chunk.embedding_model = p_embedding_model
                and chunk.embedding_created_at is not null
              )
              or (
                chunk.embedding is null
                and chunk.embedding_model is null
                and chunk.embedding_created_at is null
                and (chunk.metadata ->> 'embedding_retry_after')::timestamptz
                      > p_checked_at
              ),
              false
            )
          ),
          false
        )
      end
    into v_complete
    from public.document_chunks chunk
    where chunk.source_type = p_source_type
      and chunk.source_id = p_source_id;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      return false;
  end;

  return coalesce(v_complete, false);
end;
$$;

create or replace function public.lease_fenced_project_write(
  p_job_id uuid,
  p_lease_token uuid,
  p_project_id uuid,
  p_operation text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_project public.projects%rowtype;
  v_analysis public.customer_analyses%rowtype;
  v_evaluation public.solution_evaluations%rowtype;
  v_summary public.executive_summaries%rowtype;
  v_artifact public.generated_artifacts%rowtype;
  v_source_document_ids uuid[];
begin
  if p_operation <> 'replace_document_chunks'
     or p_payload ->> 'source_type' is distinct from 'service_document' then
    perform 1
    from public.projects
    where id = p_project_id
    for no key update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'PROJECT_JOB_LEASE_LOST: parent project no longer exists';
    end if;
  end if;

  perform 1
  from public.project_jobs
  where id = p_job_id
    and project_id = p_project_id
    and status = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative';
  end if;

  if p_operation = 'document_processing_state' then
    update public.documents
    set processing_status = p_payload ->> 'status',
        processing_message = case
          when p_payload ? 'message' then p_payload ->> 'message'
          else processing_message
        end,
        processing_error = case
          when p_payload ? 'error' then p_payload ->> 'error'
          else processing_error
        end,
        parser_used = case
          when p_payload ? 'parser_used' then p_payload ->> 'parser_used'
          else parser_used
        end,
        indexed_at = case
          when p_payload ? 'indexed_at' then (p_payload ->> 'indexed_at')::timestamptz
          else indexed_at
        end,
        updated_at = (p_payload ->> 'updated_at')::timestamptz
    where id = (p_payload ->> 'document_id')::uuid
      and project_id = p_project_id
    returning * into v_document;

    if not found then
      raise exception 'Document does not belong to the leased project';
    end if;
    return to_jsonb(v_document);
  elsif p_operation = 'document_ingestion_result' then
    update public.documents
    set file_name = p_payload ->> 'file_name',
        file_format = p_payload ->> 'file_format',
        content_type = p_payload ->> 'content_type',
        page_count = (p_payload ->> 'page_count')::integer,
        raw_text = p_payload ->> 'raw_text',
        structure_map = p_payload -> 'structure_map',
        processing_status = p_payload ->> 'status',
        processing_message = p_payload ->> 'message',
        processing_error = null,
        parser_used = p_payload ->> 'parser_used',
        indexed_at = (p_payload ->> 'indexed_at')::timestamptz,
        updated_at = (p_payload ->> 'updated_at')::timestamptz
    where id = (p_payload ->> 'document_id')::uuid
      and project_id = p_project_id
    returning * into v_document;

    if not found then
      raise exception 'Document does not belong to the leased project';
    end if;
    return to_jsonb(v_document);
  elsif p_operation = 'project_metadata' then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'projects'
        and column_name = 'name'
    ) then
      update public.projects
      set name = case when p_payload ? 'name' then p_payload ->> 'name' else name end,
          customer_name = case when p_payload ? 'customer_name' then p_payload ->> 'customer_name' else customer_name end,
          industry = case when p_payload ? 'industry' then p_payload ->> 'industry' else industry end,
          description = case when p_payload ? 'description' then p_payload ->> 'description' else description end,
          context_keywords = case
            when p_payload ? 'context_keywords' then array(
              select jsonb_array_elements_text(p_payload -> 'context_keywords')
            )
            else context_keywords
          end,
          last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
      where id = p_project_id
      returning * into v_project;
    else
      update public.projects
      set title = case when p_payload ? 'name' then p_payload ->> 'name' else title end,
          client_name = case when p_payload ? 'customer_name' then p_payload ->> 'customer_name' else client_name end,
          description = case when p_payload ? 'description' then p_payload ->> 'description' else description end,
          context_keywords = case
            when p_payload ? 'context_keywords' then array(
              select jsonb_array_elements_text(p_payload -> 'context_keywords')
            )
            else context_keywords
          end,
          last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
      where id = p_project_id
      returning * into v_project;
    end if;
    return to_jsonb(v_project);
  elsif p_operation = 'project_context_keywords' then
    update public.projects
    set context_keywords = array(
          select jsonb_array_elements_text(p_payload -> 'context_keywords')
        )
    where id = p_project_id
    returning * into v_project;
    return to_jsonb(v_project);
  elsif p_operation = 'customer_analysis' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: customer_analysis';
  elsif p_operation = 'solution_evaluation' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: solution_evaluation';
  elsif p_operation = 'executive_summary' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: executive_summary';
  elsif p_operation = 'generated_artifact' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: generated_artifact';
  elsif p_operation = 'replace_document_chunks' then
    if p_payload ->> 'source_type' = 'project_document'
       and not exists (
         select 1
         from public.documents document
         where document.id = (p_payload ->> 'source_id')::uuid
           and document.project_id = p_project_id
       ) then
      raise exception using
        errcode = '23503',
        message = 'Leased document chunk source does not belong to the project';
    end if;

    return jsonb_build_object(
      'count',
      public.replace_document_chunks_atomic(
        p_payload ->> 'source_type',
        (p_payload ->> 'source_id')::uuid,
        p_payload ->> 'source_fingerprint',
        (p_payload ->> 'expected_source_revision')::bigint,
        (p_payload ->> 'expected_chunk_count')::integer,
        p_payload -> 'rows'
      )
    );
  end if;

  raise exception 'Unsupported lease-fenced project write operation: %', p_operation;
end;
$$;

revoke all on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  to service_role;
grant execute on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  to service_role;
