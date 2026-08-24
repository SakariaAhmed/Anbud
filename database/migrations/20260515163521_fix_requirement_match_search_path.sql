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
set search_path = public, extensions
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
