create table if not exists public.document_intelligence_artifacts (
  document_id uuid primary key references public.documents(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_revision bigint not null check (source_revision >= 0),
  compiler_version text not null,
  content_hash text not null,
  parser_used text not null,
  quality jsonb not null default '{}'::jsonb,
  evidence_counts jsonb not null default '{}'::jsonb,
  artifact_encrypted jsonb not null,
  analysis_context_encrypted text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_intelligence_artifacts_project_updated_idx
  on public.document_intelligence_artifacts(project_id, updated_at desc);

create table if not exists public.document_intelligence_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete cascade,
  event_type text not null check (event_type in (
    'parse_compiled',
    'parser_escalated',
    'parser_fallback',
    'customer_analysis_used',
    'analysis_regenerated',
    'analysis_manually_edited'
  )),
  source_revision bigint check (source_revision is null or source_revision >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_intelligence_events_project_created_idx
  on public.document_intelligence_events(project_id, created_at desc);
create index if not exists document_intelligence_events_document_created_idx
  on public.document_intelligence_events(document_id, created_at desc)
  where document_id is not null;

alter table public.document_intelligence_artifacts enable row level security;
alter table public.document_intelligence_events enable row level security;

revoke all on table public.document_intelligence_artifacts
  from public, anon, authenticated;
revoke all on table public.document_intelligence_events
  from public, anon, authenticated;

grant select, insert, update, delete on table public.document_intelligence_artifacts
  to service_role;
grant select, insert, update, delete on table public.document_intelligence_events
  to service_role;

create or replace function public.save_document_intelligence_artifact(
  p_document_id uuid,
  p_project_id uuid,
  p_source_revision bigint,
  p_compiler_version text,
  p_content_hash text,
  p_parser_used text,
  p_quality jsonb,
  p_evidence_counts jsonb,
  p_artifact_encrypted jsonb,
  p_analysis_context_encrypted text,
  p_updated_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
  from public.documents document
  where document.id = p_document_id
    and document.project_id = p_project_id
    and document.chunk_source_revision = p_source_revision
  for update;

  if not found then
    return false;
  end if;

  insert into public.document_intelligence_artifacts (
    document_id,
    project_id,
    source_revision,
    compiler_version,
    content_hash,
    parser_used,
    quality,
    evidence_counts,
    artifact_encrypted,
    analysis_context_encrypted,
    updated_at
  ) values (
    p_document_id,
    p_project_id,
    p_source_revision,
    p_compiler_version,
    p_content_hash,
    p_parser_used,
    p_quality,
    p_evidence_counts,
    p_artifact_encrypted,
    p_analysis_context_encrypted,
    p_updated_at
  )
  on conflict (document_id) do update set
    project_id = excluded.project_id,
    source_revision = excluded.source_revision,
    compiler_version = excluded.compiler_version,
    content_hash = excluded.content_hash,
    parser_used = excluded.parser_used,
    quality = excluded.quality,
    evidence_counts = excluded.evidence_counts,
    artifact_encrypted = excluded.artifact_encrypted,
    analysis_context_encrypted = excluded.analysis_context_encrypted,
    updated_at = excluded.updated_at
  where public.document_intelligence_artifacts.source_revision <= excluded.source_revision;

  return true;
end;
$$;

revoke all on function public.save_document_intelligence_artifact(
  uuid, uuid, bigint, text, text, text, jsonb, jsonb, jsonb, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.save_document_intelligence_artifact(
  uuid, uuid, bigint, text, text, text, jsonb, jsonb, jsonb, text, timestamptz
) to service_role;
