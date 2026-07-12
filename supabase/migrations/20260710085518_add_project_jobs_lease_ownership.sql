do $$
begin
  if to_regclass('public.project_jobs') is null then
    raise exception 'Required table public.project_jobs does not exist';
  end if;
end $$;

alter table public.project_jobs
  add column if not exists input_json jsonb,
  add column if not exists locked_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

update public.project_jobs
set input_json = result_json -> '__job_input',
    result_json = null
where input_json is null
  and result_json ? '__job_input';

create index if not exists project_jobs_queue_claim_idx
  on public.project_jobs(status, locked_at, created_at)
  where status in ('queued', 'running');

create index if not exists project_jobs_running_lease_idx
  on public.project_jobs(id, lease_token)
  where status = 'running' and lease_token is not null;

create table if not exists public.project_job_claim_control (
  singleton boolean primary key default true check (singleton),
  claims_enabled boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.project_job_claim_control(singleton, claims_enabled)
values (true, true)
on conflict (singleton) do nothing;
alter table public.project_job_claim_control enable row level security;
revoke all on table public.project_job_claim_control
  from public, anon, authenticated;
grant select, insert, update on table public.project_job_claim_control
  to service_role;

create or replace function public.enforce_project_job_claim_gate()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claims_enabled boolean;
begin
  -- A queued row must never retain an old candidate lease. This also protects
  -- exact stable reset/claim DML, which does not know about lease_token.
  if new.status = 'queued' then
    new.lease_token := null;
    new.locked_at := null;
  end if;

  if (tg_op = 'INSERT' and new.status = 'running')
     or (tg_op = 'UPDATE' and old.status = 'queued' and new.status = 'running') then
    select control.claims_enabled
      into v_claims_enabled
    from public.project_job_claim_control control
    where control.singleton = true
    for share;
    if not found or not v_claims_enabled then
      raise exception using
        errcode = 'P0001',
        message = 'PROJECT_JOB_CLAIMS_CLOSED: project-job claims are disabled for deployment cutover';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists project_jobs_enforce_claim_gate on public.project_jobs;
create trigger project_jobs_enforce_claim_gate
before insert or update on public.project_jobs
for each row execute function public.enforce_project_job_claim_gate();

create or replace function public.set_project_job_claims_enabled(
  p_claims_enabled boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claims_enabled boolean;
begin
  if p_claims_enabled is null then
    raise exception using
      errcode = '22004',
      message = 'PROJECT_JOB_CLAIM_GATE_VALUE_REQUIRED: claims_enabled must be boolean';
  end if;

  update public.project_job_claim_control control
  set claims_enabled = p_claims_enabled,
      updated_at = clock_timestamp()
  where control.singleton = true
  returning control.claims_enabled into v_claims_enabled;
  if not found then
    raise exception 'Project-job claim control singleton is missing';
  end if;

  return jsonb_build_object(
    'version', 'project-job-cutover-v1',
    'claims_enabled', v_claims_enabled
  );
end;
$$;

create or replace function public.requeue_project_jobs_for_cutover()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claims_enabled boolean;
  v_requeued_jobs integer;
begin
  select control.claims_enabled
    into v_claims_enabled
  from public.project_job_claim_control control
  where control.singleton = true
  for update;
  if not found or v_claims_enabled then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_CLAIMS_MUST_BE_CLOSED: close claims before requeueing jobs';
  end if;

  update public.project_jobs job
  set status = 'queued',
      locked_at = null,
      lease_token = null,
      started_at = null,
      completed_at = null,
      message = 'Klargjort for kontrollert utrulling.',
      updated_at = clock_timestamp()
  where job.status = 'running';
  get diagnostics v_requeued_jobs = row_count;

  return jsonb_build_object(
    'version', 'project-job-cutover-v1',
    'requeued_jobs', v_requeued_jobs
  );
end;
$$;

create or replace function public.prepare_stable_main_rollback()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claims_enabled boolean;
  v_requeued_jobs integer;
  v_cleared_encrypted_results integer := 0;
begin
  select control.claims_enabled
    into v_claims_enabled
  from public.project_job_claim_control control
  where control.singleton = true
  for update;
  if not found or v_claims_enabled then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_CLAIMS_MUST_BE_CLOSED: close claims before preparing stable rollback';
  end if;

  update public.project_jobs job
  set status = 'queued',
      locked_at = null,
      lease_token = null,
      started_at = null,
      completed_at = null,
      message = 'Klargjort for stabil produksjonsversjon.',
      updated_at = clock_timestamp()
  where job.status = 'running';
  get diagnostics v_requeued_jobs = row_count;

  return jsonb_build_object(
    'version', 'project-job-cutover-v1',
    'requeued_jobs', v_requeued_jobs,
    'cleared_encrypted_results', v_cleared_encrypted_results
  );
end;
$$;

revoke execute on function public.enforce_project_job_claim_gate()
  from public, anon, authenticated;
revoke execute on function public.set_project_job_claims_enabled(boolean)
  from public, anon, authenticated;
revoke execute on function public.requeue_project_jobs_for_cutover()
  from public, anon, authenticated;
revoke execute on function public.prepare_stable_main_rollback()
  from public, anon, authenticated;
grant execute on function public.enforce_project_job_claim_gate()
  to service_role;
grant execute on function public.set_project_job_claims_enabled(boolean)
  to service_role;
grant execute on function public.requeue_project_jobs_for_cutover()
  to service_role;
grant execute on function public.prepare_stable_main_rollback()
  to service_role;
