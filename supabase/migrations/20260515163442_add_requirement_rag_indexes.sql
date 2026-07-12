create extension if not exists vector with schema extensions;

create table if not exists project_requirement_index (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  requirement_ref text not null,
  requirement_text text not null,
  document_title text not null,
  file_name text not null,
  page_start integer,
  page_end integer,
  section_path text not null default '',
  table_id text not null default '',
  row_label text not null default '',
  source_kind text not null default 'structured-text',
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_requirement_index_unique
  on project_requirement_index(document_id, requirement_ref, content_hash);
create index if not exists project_requirement_index_project_idx
  on project_requirement_index(project_id, document_id, page_start);

create table if not exists project_evidence_chunks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  source_document_id uuid,
  source_service_document_id uuid,
  source_kind text not null check (source_kind in ('project', 'service')),
  document_title text not null,
  file_name text not null,
  page_start integer,
  page_end integer,
  section_path text not null default '',
  chunk_text text not null,
  content_hash text not null,
  embedding_model text,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (source_kind = 'project' and source_document_id is not null) or
    (source_kind = 'service' and source_service_document_id is not null)
  )
);

create unique index if not exists project_evidence_chunks_project_unique
  on project_evidence_chunks(source_kind, coalesce(source_document_id, source_service_document_id), content_hash);
create index if not exists project_evidence_chunks_project_idx
  on project_evidence_chunks(project_id, source_kind, page_start);
create index if not exists project_evidence_chunks_embedding_idx
  on project_evidence_chunks using hnsw (embedding extensions.vector_cosine_ops);

create or replace function match_project_evidence_chunks(
  query_embedding extensions.vector(1536),
  target_project_id uuid,
  match_count int default 12
)
returns table (
  id uuid,
  project_id uuid,
  source_document_id uuid,
  source_service_document_id uuid,
  source_kind text,
  document_title text,
  file_name text,
  page_start integer,
  page_end integer,
  section_path text,
  chunk_text text,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.project_id,
    c.source_document_id,
    c.source_service_document_id,
    c.source_kind,
    c.document_title,
    c.file_name,
    c.page_start,
    c.page_end,
    c.section_path,
    c.chunk_text,
    1 - (c.embedding <=> query_embedding) as similarity
  from project_evidence_chunks c
  where c.embedding is not null
    and (c.project_id = target_project_id or c.source_kind = 'service')
  order by c.embedding <=> query_embedding
  limit least(match_count, 100);
$$;;
