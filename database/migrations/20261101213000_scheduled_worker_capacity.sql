-- The worker may wake every minute, but only one scheduled job may run
-- across replicas at a time. Web jobs retain their existing per-project
-- concurrency. Stale job recovery and lease fencing remain their owners.
begin;
set local lock_timeout = '5s';
alter table public.project_jobs add column if not exists run_class text not null default 'web'
 check (run_class in ('web','scheduled'));
create index if not exists project_jobs_scheduled_running_idx on public.project_jobs(id)
 where status='running' and run_class='scheduled';

create or replace function public.claim_project_job_serialized(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_project_id uuid;
 v_job public.project_jobs%rowtype;
 v_run_class text := case when (nullif(current_setting('request.headers',true),'')::jsonb ->> 'x-anbud-job-runner') = 'scheduled' then 'scheduled' else 'web' end;
begin
 select project_id into v_project_id from public.project_jobs where id=p_job_id;
 if not found then return null; end if;
 perform 1 from public.projects where id=v_project_id for no key update;
 if not found then return null; end if;
 if exists(select 1 from public.project_jobs where project_id=v_project_id and status='running' and id<>p_job_id) then return null; end if;
 if v_run_class = 'scheduled' then
  -- Transaction-scoped serialization covers claims across different projects
  -- and cron executions. Existing per-project/lease fencing remains intact.
  if not pg_catalog.pg_try_advisory_xact_lock(1095647829, 1) then return null; end if;
  if exists(select 1 from public.project_jobs where status='running' and run_class='scheduled') then return null; end if;
 end if;
 update public.project_jobs set status='running',run_class=v_run_class,lease_token=p_lease_token,locked_at=clock_timestamp(),
 started_at=clock_timestamp(),updated_at=clock_timestamp(),message='Starter jobben ...'
 where id=p_job_id and status='queued' returning * into v_job;
 if not found then return null; end if;
 return jsonb_build_object('id',v_job.id);
end;
$$;
revoke all on function public.claim_project_job_serialized(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_project_job_serialized(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
