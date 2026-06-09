create table if not exists project_jobs (
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
  result_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_jobs_project_id_idx
  on project_jobs(project_id, created_at desc);

create index if not exists project_jobs_status_idx
  on project_jobs(status, updated_at desc);
