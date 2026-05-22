alter table project_jobs
  add column if not exists input_json jsonb,
  add column if not exists locked_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

update project_jobs
set input_json = result_json -> '__job_input',
    result_json = null
where input_json is null
  and result_json ? '__job_input';

create index if not exists project_jobs_queue_claim_idx
  on project_jobs(status, locked_at, created_at)
  where status in ('queued', 'running');
