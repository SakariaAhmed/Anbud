create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('project_document', 'service_document')),
  source_id uuid not null,
  project_id uuid references projects(id) on delete cascade,
  service_id uuid references service_descriptions(id) on delete cascade,
  document_title text not null,
  file_name text not null,
  file_format text not null check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')),
  role text check (role is null or role in ('primary_customer_document', 'primary_solution_document', 'supporting_document')),
  supporting_subtype text check (
    supporting_subtype is null
    or supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'tidligere_losning', 'annet')
  ),
  chunk_index integer not null,
  kind text not null check (kind in ('section', 'page', 'paragraph', 'table', 'requirement', 'spreadsheet_rows')),
  reference text not null default '',
  heading_path text[] not null default '{}',
  page_start integer,
  page_end integer,
  token_count integer not null default 0,
  text_encrypted text not null,
  fts tsvector not null default ''::tsvector,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_id, chunk_index)
);

alter table document_chunks
  add column if not exists fts tsvector not null default ''::tsvector;

alter table document_chunks enable row level security;

revoke all on table document_chunks from anon;
revoke all on table document_chunks from authenticated;

create index if not exists document_chunks_source_idx
  on document_chunks(source_type, source_id, chunk_index);

create index if not exists document_chunks_project_idx
  on document_chunks(project_id, source_type, chunk_index)
  where project_id is not null;

create index if not exists document_chunks_service_idx
  on document_chunks(service_id, source_id, chunk_index)
  where service_id is not null;

create index if not exists document_chunks_content_hash_idx
  on document_chunks(source_type, source_id, content_hash);

create index if not exists document_chunks_fts_idx
  on document_chunks using gin(fts);

create index if not exists document_chunks_embedding_hnsw_idx
  on document_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.document_chunks'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%kind%'
    and pg_get_constraintdef(oid) like '%spreadsheet_rows%';

  if constraint_name is not null then
    execute format('alter table public.document_chunks drop constraint %I', constraint_name);
  end if;
end $$;

alter table document_chunks
  add constraint document_chunks_kind_check
  check (kind in (
    'section',
    'page',
    'paragraph',
    'table',
    'requirement',
    'requirement_row',
    'answer_cell',
    'evaluation_criteria',
    'risk',
    'commercial_term',
    'architecture_signal',
    'spreadsheet_rows'
  ));

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

revoke all on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  to service_role;
grant execute on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  to service_role;

create or replace function match_document_chunks(
  query_embedding extensions.vector(1536),
  match_count int default 12,
  match_threshold float default 0.15,
  project_filter uuid default null,
  source_id_filter uuid[] default null
)
returns table (
  id uuid,
  source_type text,
  source_id uuid,
  similarity float
)
language sql stable
set search_path = public, extensions
as $$
  select
    document_chunks.id,
    document_chunks.source_type,
    document_chunks.source_id,
    1 - (document_chunks.embedding <=> query_embedding) as similarity
  from document_chunks
  where document_chunks.embedding is not null
    and (
      project_filter is null
      or document_chunks.project_id = project_filter
      or (
        source_id_filter is not null
        and document_chunks.source_type = 'service_document'
        and document_chunks.project_id is null
        and document_chunks.source_id = any(source_id_filter)
      )
    )
    and (source_id_filter is null or document_chunks.source_id = any(source_id_filter))
    and 1 - (document_chunks.embedding <=> query_embedding) >= match_threshold
  order by document_chunks.embedding <=> query_embedding asc
  limit least(greatest(match_count, 1), 200);
$$;

revoke execute on function match_document_chunks(extensions.vector, int, float, uuid, uuid[]) from anon;
revoke execute on function match_document_chunks(extensions.vector, int, float, uuid, uuid[]) from authenticated;
grant execute on function match_document_chunks(extensions.vector, int, float, uuid, uuid[]) to service_role;

create or replace function update_document_chunk_search_vectors(
  source_type_filter text,
  source_id_filter uuid,
  chunks jsonb
)
returns void
language plpgsql
set search_path = public, extensions
as $$
begin
  if source_type_filter not in ('project_document', 'service_document') then
    raise exception 'Invalid document chunk source type: %', source_type_filter;
  end if;

  update document_chunks
  set
    fts = to_tsvector(
      'simple',
      left(coalesce(chunk_payload.search_text, ''), 200000)
    ),
    updated_at = now()
  from jsonb_to_recordset(chunks) as chunk_payload(
    chunk_index integer,
    search_text text
  )
  where document_chunks.source_type = source_type_filter
    and document_chunks.source_id = source_id_filter
    and document_chunks.chunk_index = chunk_payload.chunk_index;
end;
$$;

revoke execute on function update_document_chunk_search_vectors(text, uuid, jsonb) from anon;
revoke execute on function update_document_chunk_search_vectors(text, uuid, jsonb) from authenticated;
grant execute on function update_document_chunk_search_vectors(text, uuid, jsonb) to service_role;

create or replace function hybrid_match_document_chunks(
  query_embedding extensions.vector(1536),
  query_text text,
  match_count int default 12,
  match_threshold float default 0.15,
  project_filter uuid default null,
  source_id_filter uuid[] default null,
  rrf_k int default 50,
  full_text_weight float default 1,
  semantic_weight float default 1
)
returns table (
  id uuid,
  source_type text,
  source_id uuid,
  similarity float,
  keyword_rank int,
  semantic_rank int,
  rrf_score float
)
language sql stable
set search_path = public, extensions
as $$
  with settings as (
    select
      websearch_to_tsquery('simple', coalesce(query_text, '')) as keyword_query,
      least(greatest(match_count, 1), 200) as requested_count,
      greatest(rrf_k, 1) as smoothing_k,
      greatest(full_text_weight, 0) as keyword_weight,
      greatest(semantic_weight, 0) as vector_weight
  ),
  semantic_matches as (
    select
      document_chunks.id,
      document_chunks.source_type,
      document_chunks.source_id,
      1 - (document_chunks.embedding <=> query_embedding) as similarity,
      row_number() over (order by document_chunks.embedding <=> query_embedding asc)::int as semantic_rank
    from document_chunks
    where document_chunks.embedding is not null
      and (
        project_filter is null
        or document_chunks.project_id = project_filter
        or (
          source_id_filter is not null
          and document_chunks.source_type = 'service_document'
          and document_chunks.project_id is null
          and document_chunks.source_id = any(source_id_filter)
        )
      )
      and (source_id_filter is null or document_chunks.source_id = any(source_id_filter))
      and 1 - (document_chunks.embedding <=> query_embedding) >= match_threshold
    order by document_chunks.embedding <=> query_embedding asc
    limit least(greatest(match_count * 4, 12), 200)
  ),
  keyword_matches as (
    select
      document_chunks.id,
      document_chunks.source_type,
      document_chunks.source_id,
      row_number() over (
        order by ts_rank_cd(document_chunks.fts, settings.keyword_query) desc, document_chunks.chunk_index asc
      )::int as keyword_rank
    from document_chunks
    cross join settings
    where numnode(settings.keyword_query) > 0
      and document_chunks.fts @@ settings.keyword_query
      and (
        project_filter is null
        or document_chunks.project_id = project_filter
        or (
          source_id_filter is not null
          and document_chunks.source_type = 'service_document'
          and document_chunks.project_id is null
          and document_chunks.source_id = any(source_id_filter)
        )
      )
      and (source_id_filter is null or document_chunks.source_id = any(source_id_filter))
    order by ts_rank_cd(document_chunks.fts, settings.keyword_query) desc, document_chunks.chunk_index asc
    limit least(greatest(match_count * 4, 12), 200)
  ),
  combined_ids as (
    select id from semantic_matches
    union
    select id from keyword_matches
  )
  select
    document_chunks.id,
    document_chunks.source_type,
    document_chunks.source_id,
    semantic_matches.similarity,
    keyword_matches.keyword_rank,
    semantic_matches.semantic_rank,
    (
      coalesce(settings.vector_weight / (settings.smoothing_k + semantic_matches.semantic_rank), 0) +
      coalesce(settings.keyword_weight / (settings.smoothing_k + keyword_matches.keyword_rank), 0)
    )::float as rrf_score
  from combined_ids
  join document_chunks on document_chunks.id = combined_ids.id
  cross join settings
  left join semantic_matches on semantic_matches.id = document_chunks.id
  left join keyword_matches on keyword_matches.id = document_chunks.id
  order by rrf_score desc, semantic_matches.similarity desc nulls last
  limit (select requested_count from settings);
$$;

revoke execute on function hybrid_match_document_chunks(extensions.vector, text, int, float, uuid, uuid[], int, float, float) from anon;
revoke execute on function hybrid_match_document_chunks(extensions.vector, text, int, float, uuid, uuid[], int, float, float) from authenticated;
grant execute on function hybrid_match_document_chunks(extensions.vector, text, int, float, uuid, uuid[], int, float, float) to service_role;
