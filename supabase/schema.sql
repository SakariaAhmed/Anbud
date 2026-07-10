create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

do $$
begin
  if current_setting('anbud.allow_destructive_schema_rebuild', true) is distinct from 'on' then
    raise exception
      'supabase/schema.sql is a destructive baseline rebuild. Use migrations for populated databases, or run `set anbud.allow_destructive_schema_rebuild = on;` first for an intentional reset.';
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('anbud-documents', 'anbud-documents', false, 41943040)
on conflict (id) do update
set
  public = false,
  file_size_limit = 41943040;

drop table if exists generated_artifacts cascade;
drop table if exists project_jobs cascade;
drop table if exists chat_messages cascade;
drop table if exists chat_sessions cascade;
drop table if exists app_rate_limits cascade;
drop table if exists audit_events cascade;
drop table if exists solution_evaluations cascade;
drop table if exists executive_summaries cascade;
drop table if exists customer_analyses cascade;
drop table if exists project_service_selections cascade;
drop table if exists document_chunks cascade;
drop table if exists service_documents cascade;
drop table if exists service_descriptions cascade;
drop table if exists documents cascade;
drop table if exists projects cascade;

drop table if exists bid_compliance_results cascade;
drop table if exists bid_customer_analysis cascade;
drop table if exists bid_requirements cascade;
drop table if exists bid_documents cascade;
drop table if exists bids cascade;
drop table if exists bid_tasks cascade;
drop table if exists bid_decisions cascade;
drop table if exists bid_notes cascade;
drop table if exists bid_events cascade;

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  title text not null,
  description text not null default '',
  context_keywords text[] not null default '{}',
  customer_document_uploaded boolean not null default false,
  customer_analysis_generated boolean not null default false,
  solution_document_uploaded boolean not null default false,
  solution_evaluation_generated boolean not null default false,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_last_activity_idx on projects(last_activity_at desc);

create table documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role text not null check (role in ('primary_customer_document', 'primary_solution_document', 'supporting_document')),
  supporting_subtype text check (supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')),
  subtype text check (subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')),
  title text not null default 'Dokument',
  display_name text not null default 'Dokument',
  file_name text not null default 'document.txt',
  content_type text not null default 'application/octet-stream',
  file_format text not null default 'txt' check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')),
  file_size_bytes integer not null default 0,
  page_count integer,
  file_storage_bucket text not null default 'anbud-documents',
  file_storage_path text,
  file_base64 text not null default '',
  raw_text text not null default '',
  structure_map jsonb not null default '[]'::jsonb,
  processing_status text not null default 'enhanced_ready' check (processing_status in ('queued', 'processing', 'basic_ready', 'enhanced_ready', 'failed')),
  processing_message text,
  processing_error text,
  parser_used text,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index documents_project_id_idx on documents(project_id);
create index documents_project_role_idx on documents(project_id, role, created_at desc);
create index documents_processing_status_idx on documents(project_id, processing_status, updated_at desc);

comment on column documents.file_base64 is
  'Plaintext compatibility cache for legacy downloads. Current encrypted object storage is file_storage_bucket/file_storage_path; do not treat chunk encryption as full document-body encryption while this column is populated.';
comment on column documents.raw_text is
  'Plaintext extraction cache used by parsers, previews, and reindexing. document_chunks.text_encrypted protects only chunk bodies, not this source text.';

create table service_descriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  keywords text[] not null default '{}',
  inclusion_mode text not null default 'selected' check (inclusion_mode in ('fixed', 'selected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index service_descriptions_mode_idx on service_descriptions(inclusion_mode, name);
create index service_descriptions_keywords_idx on service_descriptions using gin(keywords);

create table service_documents (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references service_descriptions(id) on delete cascade,
  title text not null default 'Tjenestedokument',
  file_name text not null default 'document.txt',
  file_format text not null default 'txt' check (file_format in ('pdf', 'docx', 'txt', 'md', 'xlsx', 'xls')),
  content_type text not null default 'application/octet-stream',
  file_size_bytes integer not null default 0,
  page_count integer,
  file_storage_bucket text not null default 'anbud-documents',
  file_storage_path text,
  file_base64 text not null default '',
  raw_text text not null default '',
  structure_map jsonb not null default '[]'::jsonb,
  ai_summary text not null default '',
  ai_summary_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index service_documents_service_id_idx on service_documents(service_id, created_at desc);

comment on column service_documents.file_base64 is
  'Plaintext compatibility cache for legacy downloads. Current encrypted object storage is file_storage_bucket/file_storage_path; do not treat chunk encryption as full document-body encryption while this column is populated.';
comment on column service_documents.raw_text is
  'Plaintext extraction cache used by parsers, previews, and reindexing. document_chunks.text_encrypted protects only chunk bodies, not this source text.';

create table document_chunks (
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
    or supporting_subtype in ('rfp', 'kravdokument', 'prosjektbeskrivelse', 'notat', 'motenotat', 'workshop', 'vedlegg', 'strategi', 'utkast', 'annet')
  ),
  chunk_index integer not null,
  kind text not null check (kind in ('section', 'page', 'paragraph', 'table', 'requirement', 'requirement_row', 'answer_cell', 'evaluation_criteria', 'risk', 'commercial_term', 'architecture_signal', 'spreadsheet_rows')),
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

alter table document_chunks enable row level security;

revoke all on table document_chunks from anon;
revoke all on table document_chunks from authenticated;

create index document_chunks_source_idx on document_chunks(source_type, source_id, chunk_index);
create index document_chunks_project_idx on document_chunks(project_id, source_type, chunk_index) where project_id is not null;
create index document_chunks_service_idx on document_chunks(service_id, source_id, chunk_index) where service_id is not null;
create index document_chunks_content_hash_idx on document_chunks(source_type, source_id, content_hash);
create index document_chunks_fts_idx on document_chunks using gin(fts);
create index document_chunks_embedding_hnsw_idx on document_chunks using hnsw (embedding vector_cosine_ops) where embedding is not null;

comment on column document_chunks.fts is
  'Plaintext lexical index for hybrid retrieval. This intentionally stores searchable lexemes outside text_encrypted; disable/drop it if full content-at-rest encryption becomes a hard requirement.';

create or replace function delete_document_chunks_for_project_document()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from document_chunks
  where source_type = 'project_document'
    and source_id = old.id;
  return old;
end;
$$;

create or replace function delete_document_chunks_for_service_document()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from document_chunks
  where source_type = 'service_document'
    and source_id = old.id;
  return old;
end;
$$;

create or replace function validate_document_chunk_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_type = 'project_document' then
    if not exists (select 1 from documents where id = new.source_id) then
      raise foreign_key_violation using message = 'document_chunks.source_id does not reference an existing project document';
    end if;
    return new;
  end if;

  if new.source_type = 'service_document' then
    if not exists (select 1 from service_documents where id = new.source_id) then
      raise foreign_key_violation using message = 'document_chunks.source_id does not reference an existing service document';
    end if;
    return new;
  end if;

  raise check_violation using message = 'Invalid document_chunks.source_type';
end;
$$;

revoke execute on function delete_document_chunks_for_project_document() from anon;
revoke execute on function delete_document_chunks_for_project_document() from authenticated;
revoke execute on function delete_document_chunks_for_service_document() from anon;
revoke execute on function delete_document_chunks_for_service_document() from authenticated;
revoke execute on function validate_document_chunk_source() from anon;
revoke execute on function validate_document_chunk_source() from authenticated;

create trigger document_chunks_validate_source
  before insert or update of source_type, source_id on document_chunks
  for each row
  execute function validate_document_chunk_source();

create trigger documents_delete_chunks
  after delete on documents
  for each row
  execute function delete_document_chunks_for_project_document();

create trigger service_documents_delete_chunks
  after delete on service_documents
  for each row
  execute function delete_document_chunks_for_service_document();

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
    and (project_filter is null or document_chunks.project_id = project_filter)
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
      and (project_filter is null or document_chunks.project_id = project_filter)
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
      and (project_filter is null or document_chunks.project_id = project_filter)
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

create table project_service_selections (
  project_id uuid not null references projects(id) on delete cascade,
  service_id uuid not null references service_descriptions(id) on delete cascade,
  selected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, service_id)
);

create index project_service_selections_project_idx on project_service_selections(project_id);
create index project_service_selections_service_idx on project_service_selections(service_id);

create table customer_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  source_document_ids uuid[] not null default '{}',
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table solution_evaluations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  source_document_ids uuid[] not null default '{}',
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table executive_summaries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references projects(id) on delete cascade,
  result_json jsonb not null,
  input_snapshot jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table generated_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  artifact_type text not null check (
    artifact_type in (
      'losningsutkast',
      'bilag1_rekonstruksjon',
      'forbedret_kravsvar',
      'tilbudsstrategi',
      'verdiargumentasjon',
      'anbefalt_arkitektur',
      'gjennomforing_og_risiko'
    )
  ),
  title text not null,
  content_markdown text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index generated_artifacts_project_id_idx on generated_artifacts(project_id, created_at desc);
create index generated_artifacts_project_type_idx on generated_artifacts(project_id, artifact_type, created_at desc);

create table project_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (
    kind in (
      'document_ingestion',
      'document_docling_enhancement',
      'customer_analysis',
      'solution_evaluation',
      'artifact_generation',
      'high_level_design',
      'perfect_system_solution',
      'executive_summary'
    )
  ),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  message text not null default '',
  error text,
  input_json jsonb,
  result_json jsonb,
  locked_at timestamptz,
  lease_token uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_jobs_project_id_idx on project_jobs(project_id, created_at desc);
create index project_jobs_status_idx on project_jobs(status, updated_at desc);
create index project_jobs_project_status_idx on project_jobs(project_id, status, updated_at desc);
create index project_jobs_queue_claim_idx on project_jobs(status, locked_at, created_at) where status in ('queued', 'running');
create index project_jobs_running_lease_idx on project_jobs(id, lease_token) where status = 'running' and lease_token is not null;

create table chat_sessions (
  id text not null,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null default 'Ny chat',
  summary_encrypted text not null default '',
  domain_hints text[] not null default '{}',
  pinned boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  message_count integer not null default 0,
  last_message_preview text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id)
);

create index chat_sessions_project_updated_idx on chat_sessions(project_id, pinned desc, updated_at desc);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  session_id text,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint chat_messages_project_session_fk
    foreign key (project_id, session_id) references chat_sessions(project_id, id) on delete cascade
);

create index chat_messages_project_id_idx on chat_messages(project_id, created_at asc);
create index chat_messages_project_session_idx on chat_messages(project_id, session_id, created_at asc) where session_id is not null;

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  project_id uuid references projects(id) on delete set null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_project_idx on audit_events(project_id, created_at desc);
create index audit_events_action_idx on audit_events(action, created_at desc);

create table app_rate_limits (
  key text primary key,
  scope text not null,
  identity_hash text not null,
  count integer not null default 0 check (count >= 0),
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index app_rate_limits_reset_idx on app_rate_limits(reset_at);

create or replace function check_app_rate_limit(
  p_scope text,
  p_identity_hash text,
  p_limit integer,
  p_window_ms integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_key text;
  v_count integer;
  v_reset_at timestamptz;
  v_window interval;
  v_limit integer;
begin
  v_limit := greatest(coalesce(p_limit, 1), 1);
  v_window := make_interval(secs => greatest(coalesce(p_window_ms, 1000), 1000) / 1000.0);
  v_key := encode(digest(coalesce(p_scope, '') || ':' || coalesce(p_identity_hash, ''), 'sha256'), 'hex');

  insert into app_rate_limits as limits (
    key,
    scope,
    identity_hash,
    count,
    reset_at,
    updated_at
  )
  values (
    v_key,
    coalesce(p_scope, ''),
    coalesce(p_identity_hash, ''),
    1,
    now() + v_window,
    now()
  )
  on conflict (key) do update
  set
    count = case
      when limits.reset_at <= now() then 1
      else limits.count + 1
    end,
    reset_at = case
      when limits.reset_at <= now() then now() + v_window
      else limits.reset_at
    end,
    updated_at = now()
  returning count, reset_at
  into v_count, v_reset_at;

  allowed := v_count <= v_limit;
  retry_after_seconds := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_reset_at - now())))::integer)
  end;
  return next;
end;
$$;

alter table projects enable row level security;
alter table documents enable row level security;
alter table service_descriptions enable row level security;
alter table service_documents enable row level security;
alter table document_chunks enable row level security;
alter table project_service_selections enable row level security;
alter table customer_analyses enable row level security;
alter table solution_evaluations enable row level security;
alter table executive_summaries enable row level security;
alter table generated_artifacts enable row level security;
alter table project_jobs enable row level security;
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;
alter table audit_events enable row level security;
alter table app_rate_limits enable row level security;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from anon;
revoke all on all sequences in schema public from authenticated;
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

grant execute on all functions in schema public to service_role;
grant execute on function check_app_rate_limit(text, text, integer, integer) to service_role;
grant execute on function match_document_chunks(extensions.vector, int, float, uuid, uuid[]) to service_role;
grant execute on function update_document_chunk_search_vectors(text, uuid, jsonb) to service_role;
grant execute on function hybrid_match_document_chunks(extensions.vector, text, int, float, uuid, uuid[], int, float, float) to service_role;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;
alter default privileges in schema public grant execute on functions to service_role;
