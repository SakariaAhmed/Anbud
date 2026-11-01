-- Apply with psql -f (autocommit), never --single-transaction.
alter table document_chunks
  add column if not exists fts tsvector not null default ''::tsvector;

create index if not exists document_chunks_fts_idx
  on document_chunks using gin(fts);

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

-- Derive Norwegian stems from the existing plaintext lexemes. Original
-- encrypted text and the simple FTS index remain unchanged. Original
-- positions and weights survive stemming, including merged stem lexemes;
-- quoted queries must not acquire invented phrase matches.
alter table public.document_chunks
  add column if not exists fts_norwegian tsvector not null default ''::tsvector;

create or replace function public.norwegian_document_chunk_fts(source_vector tsvector)
returns tsvector
language sql stable parallel safe
set search_path = pg_catalog
as $$
  select coalesce(string_agg(
    chr(39) || replace(replace(stem.lexeme, chr(92), chr(92) || chr(92)), chr(39), chr(39) || chr(39)) || chr(39) ||
    case when cardinality(original.positions) > 0 then ':' || (
      select string_agg(p.position::text || case when p.weight = 'D' then '' else p.weight::text end, ',' order by p.position)
      from unnest(original.positions, original.weights) as p(position, weight)
    ) else '' end, ' '
  )::tsvector, ''::tsvector)
  from unnest(source_vector) as original(lexeme, positions, weights)
  cross join lateral unnest(ts_lexize('pg_catalog.norwegian_stem'::regdictionary, original.lexeme)) as stem(lexeme);
$$;
revoke all on function public.norwegian_document_chunk_fts(tsvector) from public;

create or replace function public.sync_document_chunk_norwegian_fts()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.fts_norwegian := public.norwegian_document_chunk_fts(new.fts);
  return new;
end;
$$;
revoke all on function public.sync_document_chunk_norwegian_fts() from public;

drop trigger if exists document_chunks_norwegian_fts on public.document_chunks;
create trigger document_chunks_norwegian_fts before insert or update of fts on public.document_chunks
for each row execute function public.sync_document_chunk_norwegian_fts();

comment on column public.document_chunks.fts_norwegian is
  'Norwegian stems derived solely from the existing plaintext FTS lexemes; the existing content-at-rest policy also applies here.';

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
      websearch_to_tsquery('norwegian', coalesce(query_text, '')) as norwegian_query,
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
        order by greatest(ts_rank_cd(document_chunks.fts, settings.keyword_query), ts_rank_cd(document_chunks.fts_norwegian, settings.norwegian_query)) desc, document_chunks.chunk_index asc
      )::int as keyword_rank
    from document_chunks
    cross join settings
    where (numnode(settings.keyword_query) > 0 or numnode(settings.norwegian_query) > 0)
      and (document_chunks.fts @@ settings.keyword_query or document_chunks.fts_norwegian @@ settings.norwegian_query)
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
    order by greatest(ts_rank_cd(document_chunks.fts, settings.keyword_query), ts_rank_cd(document_chunks.fts_norwegian, settings.norwegian_query)) desc, document_chunks.chunk_index asc
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
grant execute on function public.norwegian_document_chunk_fts(tsvector) to service_role;
grant execute on function public.sync_document_chunk_norwegian_fts() to service_role;

-- Backfill in independently committed, bounded batches. New/changed rows are
-- maintained by the trigger, including IDs behind the cursor. A busy row can
-- interrupt this safely; rerun the file to resume before releasing new code.
set lock_timeout = '5s';
do $$
declare
  last_id uuid := null;
  batch_ids uuid[];
begin
  loop
    select array_agg(id order by id) into batch_ids
    from (select id from public.document_chunks
      where last_id is null or id > last_id order by id limit 500) as batch;
    exit when batch_ids is null;
    update public.document_chunks
    set fts_norwegian = public.norwegian_document_chunk_fts(fts)
    where id = any(batch_ids)
      and fts_norwegian is distinct from public.norwegian_document_chunk_fts(fts);
    last_id := batch_ids[cardinality(batch_ids)];
    commit;
  end loop;
end;
$$;
reset lock_timeout;

-- A previously interrupted concurrent build needs deliberate recovery before
-- retrying; IF NOT EXISTS alone would silently keep an invalid index.
do $$
begin
  if exists (select 1 from pg_catalog.pg_index where indexrelid = to_regclass('public.document_chunks_norwegian_fts_idx') and not indisvalid) then
    raise exception 'Norwegian FTS index is invalid. Drop that index CONCURRENTLY, then rerun this migration.';
  end if;
end;
$$;
create index concurrently if not exists document_chunks_norwegian_fts_idx
  on public.document_chunks using gin(fts_norwegian);
