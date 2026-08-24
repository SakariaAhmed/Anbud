alter table documents
  add column if not exists processing_status text not null default 'enhanced_ready',
  add column if not exists processing_message text,
  add column if not exists processing_error text,
  add column if not exists parser_used text,
  add column if not exists indexed_at timestamptz;

alter table documents
  drop constraint if exists documents_processing_status_check;

alter table documents
  add constraint documents_processing_status_check
  check (processing_status in ('queued', 'processing', 'basic_ready', 'enhanced_ready', 'failed'));

create index if not exists documents_processing_status_idx
  on documents(project_id, processing_status, updated_at desc);

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'project_jobs'
  ) then
    alter table project_jobs
      drop constraint if exists project_jobs_kind_check;

    alter table project_jobs
      add constraint project_jobs_kind_check
      check (
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
      );
  end if;
end $$;
