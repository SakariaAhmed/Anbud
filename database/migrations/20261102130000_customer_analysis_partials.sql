-- Incomplete previews are deliberately separate from authoritative analyses.
create table public.customer_analysis_partials (
  job_id uuid primary key references public.project_jobs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  generation_id uuid not null,
  lease_token uuid not null,
  source_revision bigint not null check (source_revision >= 0),
  expected_analysis_revision uuid,
  automatic_request_id uuid,
  source_document_ids uuid[] not null,
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  field_digests jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
create index customer_analysis_partials_project_idx on public.customer_analysis_partials(project_id);
alter table public.customer_analysis_partials enable row level security;
revoke all on public.customer_analysis_partials from public, anon, authenticated;
grant select, insert, update, delete on public.customer_analysis_partials to service_role;

create or replace function public.save_customer_analysis_partial(
  p_project_id uuid, p_job_id uuid, p_lease_token uuid, p_payload jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_job public.project_jobs%rowtype;
  v_partial public.customer_analysis_partials%rowtype;
  v_source bigint;
  v_revision uuid;
  v_field text := p_payload->>'field';
  v_generation uuid := (p_payload->>'generation_id')::uuid;
begin
  select source_revision into v_source from public.projects where id=p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  select * into v_job from public.project_jobs where id=p_job_id and project_id=p_project_id for update;
  if not found or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token
    or v_job.locked_at is null or v_job.locked_at < clock_timestamp()-interval '15 minutes' then
    raise exception 'PROJECT_JOB_LEASE_LOST: preview lease is no longer authoritative';
  end if;
  if v_job.kind <> 'customer_analysis' or v_job.result_checkpoint is not null then
    raise exception 'PARTIAL_ANALYSIS_NOT_ALLOWED';
  end if;
  if exists(select 1 from public.project_jobs where project_id=p_project_id
    and kind in ('customer_analysis','high_level_design') and submission_sequence > v_job.submission_sequence) then
    raise exception 'PROJECT_JOB_SUPERSEDED';
  end if;
  if jsonb_typeof(p_payload->'expected_source_revision') is distinct from 'number'
    or (p_payload->>'expected_source_revision')::bigint is distinct from v_source then
    raise exception 'PROJECT_SOURCE_REVISION_CHANGED';
  end if;
  select revision into v_revision from public.customer_analyses where project_id=p_project_id;
  if not (p_payload ? 'expected_analysis_revision')
    or v_revision is distinct from (p_payload->>'expected_analysis_revision')::uuid then
    raise exception 'CUSTOMER_ANALYSIS_CHANGED';
  end if;
  if p_payload->>'automatic_request_id' is not null and not exists(
    select 1 from public.project_analysis_requests where project_id=p_project_id
      and request_id=(p_payload->>'automatic_request_id')::uuid and status='scheduled' and source_revision=v_source
  ) then raise exception 'AUTOMATIC_ANALYSIS_CANCELLED'; end if;
  if v_generation is null or v_field is null or not (v_field = any(array[
    'customer_profile_summary','customer_goals_summary','high_level_solution_design','high_level_architecture_mermaid',
    'customer_profile','customer_goals','implicit_requirements','prioritized_requirements','ambiguities',
    'risks','risks_for_us','risks_for_customer','likely_evaluation_criteria','signal_words','expected_solution_direction',
    'recommended_services','value_opportunities','positioning_recommendations','executive_summary']))
    or jsonb_typeof(p_payload->'value') is distinct from 'object'
    or p_payload->'value'->'encrypted' is distinct from 'true'::jsonb
    or ((p_payload->'value') - 'encrypted' - 'payload') <> '{}'::jsonb
    or coalesce(p_payload->'value'->>'payload','') not like 'enc:v1:%'
    or coalesce(p_payload->>'digest','') !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_ANALYSIS_PARTIAL';
  end if;
  if jsonb_typeof(p_payload->'source_document_ids') is distinct from 'array'
    or jsonb_array_length(p_payload->'source_document_ids')=0
    or exists(select 1 from jsonb_array_elements_text(p_payload->'source_document_ids') s(id)
      where not exists(select 1 from public.documents d where d.id=s.id::uuid and d.project_id=p_project_id)) then
    raise exception 'INVALID_ANALYSIS_PARTIAL_SOURCES';
  end if;
  insert into public.customer_analysis_partials(job_id,project_id,generation_id,lease_token,source_revision,
    expected_analysis_revision,automatic_request_id,source_document_ids)
    values(p_job_id,p_project_id,v_generation,p_lease_token,v_source,v_revision,
      (p_payload->>'automatic_request_id')::uuid,
      array(select jsonb_array_elements_text(p_payload->'source_document_ids')::uuid))
    on conflict(job_id) do nothing;
  select * into v_partial from public.customer_analysis_partials where job_id=p_job_id for update;
  if v_partial.generation_id is distinct from v_generation or v_partial.lease_token is distinct from p_lease_token
    or v_partial.source_revision is distinct from v_source or v_partial.expected_analysis_revision is distinct from v_revision
    or v_partial.automatic_request_id is distinct from (p_payload->>'automatic_request_id')::uuid
    or v_partial.source_document_ids is distinct from array(select jsonb_array_elements_text(p_payload->'source_document_ids')::uuid) then
    raise exception 'ANALYSIS_PARTIAL_GENERATION_CHANGED';
  end if;
  if v_partial.fields ? v_field then
    if v_partial.field_digests->>v_field is distinct from p_payload->>'digest' then
      raise exception 'ANALYSIS_PARTIAL_FIELD_CHANGED';
    end if;
    return; -- Idempotent retry retains the original ciphertext and value.
  end if;
  update public.customer_analysis_partials set fields=fields || jsonb_build_object(v_field,p_payload->'value'),
    field_digests=field_digests || jsonb_build_object(v_field,p_payload->>'digest'), updated_at=clock_timestamp()
    where job_id=p_job_id;
end;
$$;

create or replace function public.read_customer_analysis_partial(p_project_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_source bigint;
  v_revision uuid;
  v_job public.project_jobs%rowtype;
  v_partial public.customer_analysis_partials%rowtype;
begin
  select source_revision into v_source from public.projects where id=p_project_id for share;
  if not found then return null; end if;
  select * into v_job from public.project_jobs where project_id=p_project_id
    and kind in ('customer_analysis','high_level_design') order by submission_sequence desc limit 1 for share;
  if not found or v_job.kind <> 'customer_analysis' or v_job.status not in ('running','failed')
    or v_job.result_checkpoint is not null then return null; end if;
  select * into v_partial from public.customer_analysis_partials where job_id=v_job.id;
  if not found then return null; end if;
  if v_job.status='running' and (v_job.lease_token is distinct from v_partial.lease_token
    or v_job.locked_at is null or v_job.locked_at < clock_timestamp()-interval '15 minutes') then return null; end if;
  select revision into v_revision from public.customer_analyses where project_id=p_project_id;
  if v_partial.source_revision is distinct from v_source or v_partial.expected_analysis_revision is distinct from v_revision then return null; end if;
  if v_partial.automatic_request_id is not null and not exists(
    select 1 from public.project_analysis_requests where project_id=p_project_id and request_id=v_partial.automatic_request_id
      and status in ('scheduled','failed') and source_revision=v_source
  ) then return null; end if;
  return jsonb_build_object('status','incomplete','job_id',v_job.id,'job_status',v_job.status,
    'source_revision',v_source,'updated_at',v_partial.updated_at,'fields',v_partial.fields);
end;
$$;

-- A failed original attempt retains its preview. Restart, takeover and final
-- completion discard it; a restarted stream must never mix old/new sections.
create or replace function public.invalidate_customer_analysis_partial_job()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status not in ('running','failed') or
    (new.status='running' and new.lease_token is distinct from old.lease_token) or
    (new.status='failed' and old.status <> 'running') then
    delete from public.customer_analysis_partials where job_id=new.id;
  end if;
  return new;
end;
$$;
create trigger invalidate_customer_analysis_partial_job after update of status,lease_token on public.project_jobs
for each row execute function public.invalidate_customer_analysis_partial_job();
revoke execute on function public.save_customer_analysis_partial(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.read_customer_analysis_partial(uuid) from public,anon,authenticated;
revoke execute on function public.invalidate_customer_analysis_partial_job() from public,anon,authenticated;
grant execute on function public.save_customer_analysis_partial(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.read_customer_analysis_partial(uuid) to service_role;
