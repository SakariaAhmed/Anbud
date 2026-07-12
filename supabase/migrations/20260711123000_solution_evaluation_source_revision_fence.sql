alter table public.projects
  add column if not exists source_revision bigint not null default 0;

create or replace function public.bump_project_source_revision_from_document()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_invalidates_analysis boolean;
begin
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  v_invalidates_analysis := case
    when tg_op = 'INSERT' then new.role <> 'primary_solution_document'
    when tg_op = 'DELETE' then old.role <> 'primary_solution_document'
    else old.role <> 'primary_solution_document'
      or new.role <> 'primary_solution_document'
  end;
  update public.projects
  set source_revision = source_revision + 1,
      solution_evaluation_generated = false,
      customer_analysis_generated = case
        when v_invalidates_analysis then false
        else customer_analysis_generated
      end
  where id = v_project_id;
  if v_invalidates_analysis then
    delete from public.customer_analyses where project_id = v_project_id;
  end if;
  delete from public.solution_evaluations where project_id = v_project_id;
  delete from public.executive_summaries where project_id = v_project_id;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_source_revision_insert on public.documents;
create trigger documents_source_revision_insert
after insert on public.documents
for each row execute function public.bump_project_source_revision_from_document();

drop trigger if exists documents_source_revision_delete on public.documents;
create trigger documents_source_revision_delete
after delete on public.documents
for each row execute function public.bump_project_source_revision_from_document();

drop trigger if exists documents_source_revision_update on public.documents;
create trigger documents_source_revision_update
after update of role, supporting_subtype, subtype, title, display_name,
  file_name, file_format, content_type, file_size_bytes, page_count,
  file_storage_bucket, file_storage_path, file_base64, raw_text,
  structure_map on public.documents
for each row execute function public.bump_project_source_revision_from_document();

create or replace function public.invalidate_customer_analysis_dependents()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  update public.projects
  set solution_evaluation_generated = false,
      source_revision = source_revision + 1
  where id = v_project_id;
  delete from public.solution_evaluations where project_id = v_project_id;
  delete from public.executive_summaries where project_id = v_project_id;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_analysis_invalidates_dependents
  on public.customer_analyses;
create trigger customer_analysis_invalidates_dependents
after insert or update or delete on public.customer_analyses
for each row execute function public.invalidate_customer_analysis_dependents();

create or replace function public.save_customer_analysis_if_source_revision(
  p_project_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_analysis public.customer_analyses%rowtype;
  v_source_document_ids uuid[];
  v_expected_source_revision bigint;
  v_current_source_revision bigint;
begin
  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number' then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SOURCE_REVISION_REQUIRED: expected_source_revision is required';
  end if;
  v_expected_source_revision := (p_payload ->> 'expected_source_revision')::bigint;

  select source_revision into v_current_source_revision
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'Project does not exist';
  end if;

  if v_current_source_revision is distinct from v_expected_source_revision then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running';
  end if;

  select coalesce(
      array_agg(source.value::uuid order by source.ordinality),
      '{}'::uuid[]
    )
    into v_source_document_ids
  from jsonb_array_elements_text(
    coalesce(p_payload -> 'source_document_ids', '[]'::jsonb)
  ) with ordinality as source(value, ordinality);

  insert into public.customer_analyses (
    project_id,
    source_document_ids,
    result_json,
    updated_at
  ) values (
    p_project_id,
    v_source_document_ids,
    p_payload -> 'result_json',
    now()
  )
  on conflict (project_id) do update
    set source_document_ids = excluded.source_document_ids,
        result_json = excluded.result_json,
        updated_at = now()
  returning * into v_analysis;

  update public.projects
  set customer_analysis_generated = true,
      solution_evaluation_generated = false,
      last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz,
      context_keywords = array(
        select jsonb_array_elements_text(p_payload -> 'context_keywords')
      )
  where id = p_project_id;

  return to_jsonb(v_analysis);
end;
$$;

create or replace function public.lease_fenced_save_customer_analysis(
  p_job_id uuid,
  p_lease_token uuid,
  p_project_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.project_jobs%rowtype;
begin
  select * into v_job
  from public.project_jobs
  where id = p_job_id
    and project_id = p_project_id
    and status = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;

  if v_job.kind not in ('customer_analysis', 'high_level_design') then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist a customer analysis';
  end if;

  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  if exists (
    select 1
    from public.project_jobs newer_job
    where newer_job.project_id = p_project_id
      and newer_job.kind in ('customer_analysis', 'high_level_design')
      and newer_job.submission_sequence > v_job.submission_sequence
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_SUPERSEDED: a newer customer analysis job is authoritative';
  end if;

  return public.save_customer_analysis_if_source_revision(p_project_id, p_payload);
end;
$$;


create or replace function public.lease_fenced_save_solution_evaluation(
  p_job_id uuid,
  p_lease_token uuid,
  p_project_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.project_jobs%rowtype;
  v_evaluation public.solution_evaluations%rowtype;
  v_source_document_ids uuid[];
  v_expected_source_revision bigint;
  v_current_source_revision bigint;
begin
  select * into v_job
  from public.project_jobs
  where id = p_job_id
    and project_id = p_project_id
    and status = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;

  if v_job.kind not in ('solution_evaluation', 'perfect_system_solution') then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist a solution evaluation';
  end if;

  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number' then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SOURCE_REVISION_REQUIRED: expected_source_revision is required';
  end if;
  v_expected_source_revision := (p_payload ->> 'expected_source_revision')::bigint;

  select source_revision into v_current_source_revision
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'Project does not exist';
  end if;

  if exists (
    select 1
    from public.project_jobs newer_job
    where newer_job.project_id = p_project_id
      and newer_job.kind in ('solution_evaluation', 'perfect_system_solution')
      and newer_job.submission_sequence > v_job.submission_sequence
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_SUPERSEDED: a newer solution evaluation job is authoritative';
  end if;

  if v_current_source_revision is distinct from v_expected_source_revision then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the evaluation was running';
  end if;

  select coalesce(
      array_agg(source.value::uuid order by source.ordinality),
      '{}'::uuid[]
    )
    into v_source_document_ids
  from jsonb_array_elements_text(
    coalesce(p_payload -> 'source_document_ids', '[]'::jsonb)
  ) with ordinality as source(value, ordinality);

  insert into public.solution_evaluations (
    project_id,
    source_document_ids,
    customer_document_id,
    solution_document_id,
    analysis_id,
    result_json,
    updated_at
  ) values (
    p_project_id,
    v_source_document_ids,
    (p_payload ->> 'customer_document_id')::uuid,
    (p_payload ->> 'solution_document_id')::uuid,
    (p_payload ->> 'analysis_id')::uuid,
    p_payload -> 'result_json',
    now()
  )
  on conflict (project_id) do update
    set source_document_ids = excluded.source_document_ids,
        customer_document_id = excluded.customer_document_id,
        solution_document_id = excluded.solution_document_id,
        analysis_id = excluded.analysis_id,
        result_json = excluded.result_json,
        updated_at = now()
  returning * into v_evaluation;

  delete from public.executive_summaries
  where project_id = p_project_id;

  update public.projects
  set solution_evaluation_generated = true,
      last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
  where id = p_project_id;

  return to_jsonb(v_evaluation);
end;
$$;

revoke execute on function public.bump_project_source_revision_from_document()
  from public, anon, authenticated;
revoke execute on function public.invalidate_customer_analysis_dependents()
  from public, anon, authenticated;
revoke execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_customer_analysis(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_solution_evaluation(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.bump_project_source_revision_from_document()
  to service_role;
grant execute on function public.invalidate_customer_analysis_dependents()
  to service_role;
grant execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb)
  to service_role;
grant execute on function public.lease_fenced_save_customer_analysis(uuid, uuid, uuid, jsonb)
  to service_role;
grant execute on function public.lease_fenced_save_solution_evaluation(uuid, uuid, uuid, jsonb)
  to service_role;
