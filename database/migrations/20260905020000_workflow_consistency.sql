-- Preserve encrypted results and serialize project workflows. Additive; safe for populated databases.
begin;
-- UI ordering is independent of the input revision used to fence generation.
alter table public.projects add column if not exists snapshot_revision bigint not null default 0;
create or replace function public.advance_project_snapshot_revision()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.snapshot_revision := old.snapshot_revision + 1;
 return new;
end;
$$;
drop trigger if exists project_snapshot_revision on public.projects;
create trigger project_snapshot_revision before update on public.projects
for each row execute function public.advance_project_snapshot_revision();
revoke all on function public.advance_project_snapshot_revision() from public,anon,authenticated;
grant execute on function public.advance_project_snapshot_revision() to service_role;
alter table public.customer_analyses add column if not exists revision uuid not null default gen_random_uuid();
create table if not exists public.project_result_history (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.projects(id) on delete cascade,
 kind text not null check (kind in ('customer_analyses','solution_evaluations','executive_summaries')),
 result_json jsonb not null,
 source_document_ids uuid[] not null default '{}',
 source_revision bigint not null,
 original_updated_at timestamptz not null,
 archived_at timestamptz not null default clock_timestamp(),
 reason text not null check (reason in ('replaced','source_changed'))
);
create index if not exists project_result_history_project_time_idx
 on public.project_result_history(project_id, archived_at desc, id desc);
alter table public.project_result_history enable row level security;
revoke all on public.project_result_history from public, anon, authenticated;
revoke all on public.project_result_history from service_role;
grant select, insert on public.project_result_history to service_role;

create or replace function public.archive_project_result()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 -- Parent deletion must cascade, without retaining deleted customer data.
 if exists (select 1 from public.projects where id=old.project_id) then
   insert into public.project_result_history(project_id,kind,result_json,source_document_ids,
     source_revision,original_updated_at,reason)
   select old.project_id,tg_table_name,old.result_json,
     coalesce(array(select jsonb_array_elements_text(to_jsonb(old)->'source_document_ids')::uuid),'{}'),
     p.source_revision,old.updated_at,case when tg_op='DELETE' then 'source_changed' else 'replaced' end
   from public.projects p where p.id=old.project_id;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
create or replace function public.advance_customer_analysis_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 new.revision := gen_random_uuid();
 return new;
end;
$$;
drop trigger if exists customer_analysis_revision on public.customer_analyses;
create trigger customer_analysis_revision before update on public.customer_analyses
for each row execute function public.advance_customer_analysis_revision();
drop trigger if exists archive_result on public.customer_analyses;
create trigger archive_result before delete or update of result_json on public.customer_analyses
for each row execute function public.archive_project_result();
drop trigger if exists archive_result on public.solution_evaluations;
create trigger archive_result before delete or update of result_json on public.solution_evaluations
for each row execute function public.archive_project_result();
drop trigger if exists archive_result on public.executive_summaries;
create trigger archive_result before delete or update of result_json on public.executive_summaries
for each row execute function public.archive_project_result();
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
  if tg_op = 'UPDATE' and
    (to_jsonb(old) - array['updated_at','processing_status','processing_message','processing_error','parser_used','indexed_at'])
    is not distinct from
    (to_jsonb(new) - array['updated_at','processing_status','processing_message','processing_error','parser_used','indexed_at']) then
    return new;
  end if;
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  v_invalidates_analysis := case
    when tg_op = 'INSERT' then public.project_document_affects_customer_analysis(
      new.role,
      new.supporting_subtype,
      new.subtype
    )
    when tg_op = 'DELETE' then public.project_document_affects_customer_analysis(
      old.role,
      old.supporting_subtype,
      old.subtype
    )
    else public.project_document_affects_customer_analysis(
      old.role,
      old.supporting_subtype,
      old.subtype
    ) or public.project_document_affects_customer_analysis(
      new.role,
      new.supporting_subtype,
      new.subtype
    )
  end;
  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
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
  v_previous_context_setting text;
begin
  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_source_revision', '') !~ '^(0|[1-9][0-9]*)$' then
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

  select * into v_analysis from public.customer_analyses where project_id=p_project_id;
  if p_payload ? 'expected_analysis_revision'
     and v_analysis.revision::text is distinct from (p_payload ->> 'expected_analysis_revision') then
    raise exception using errcode='P0001', message='CUSTOMER_ANALYSIS_CHANGED';
  end if;
  if coalesce((p_payload ->> 'unchanged')::boolean,false) then
    if v_analysis.id is null then raise exception 'CUSTOMER_ANALYSIS_CHANGED'; end if;
    return to_jsonb(v_analysis);
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
    provenance_verified,
    updated_at
  ) values (
    p_project_id,
    v_source_document_ids,
    p_payload -> 'result_json',
    true,
    now()
  )
  on conflict (project_id) do update
    set source_document_ids = excluded.source_document_ids,
        result_json = excluded.result_json,
        provenance_verified = true,
        updated_at = now()
  returning * into v_analysis;

  v_previous_context_setting := pg_catalog.current_setting(
    'anbud.persisting_customer_analysis_context',
    true
  );
  perform pg_catalog.set_config(
    'anbud.persisting_customer_analysis_context',
    'on',
    true
  );
  update public.projects
  set customer_analysis_generated = true,
      solution_evaluation_generated = false,
      last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz,
      context_keywords = array(
        select jsonb_array_elements_text(p_payload -> 'context_keywords')
      )
  where id = p_project_id;
  perform pg_catalog.set_config(
    'anbud.persisting_customer_analysis_context',
    coalesce(v_previous_context_setting, ''),
    true
  );

  return to_jsonb(v_analysis);
end;
$$;

create or replace function public.publish_document_readiness(
 p_project_id uuid, p_document_id uuid, p_source_revision bigint,
 p_status text, p_message text, p_parser_used text,
 p_job_id uuid default null, p_lease_token uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_document public.documents%rowtype;
begin
 perform 1 from public.projects where id=p_project_id for update;
 if not found then raise exception 'PROJECT_SOURCE_REVISION_CHANGED'; end if;
 if p_job_id is not null then
   perform 1 from public.project_jobs where id=p_job_id and project_id=p_project_id
     and status='running' and lease_token=p_lease_token for update;
   if not found then raise exception 'PROJECT_JOB_LEASE_LOST'; end if;
 end if;
 select * into v_document from public.documents where id=p_document_id and project_id=p_project_id for update;
 if not found or v_document.chunk_source_revision <> p_source_revision then
   raise exception 'PROJECT_SOURCE_REVISION_CHANGED';
 end if;
 if p_status not in ('basic_ready','enhanced_ready') then raise exception 'Invalid ready status'; end if;
 if not exists(select 1 from public.document_chunks c where c.source_type='project_document'
     and c.source_id=p_document_id) then raise exception 'DOCUMENT_INDEX_NOT_READY'; end if;
 update public.documents set processing_status=p_status,processing_message=p_message,
   processing_error=null,parser_used=p_parser_used,indexed_at=clock_timestamp(),updated_at=clock_timestamp()
 where id=p_document_id returning * into v_document;
 return to_jsonb(v_document);
end;
$$;

create or replace function public.claim_project_job_serialized(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_project_id uuid; v_job public.project_jobs%rowtype;
begin
 select project_id into v_project_id from public.project_jobs where id=p_job_id;
 if not found then return null; end if;
 perform 1 from public.projects where id=v_project_id for no key update;
 if not found then return null; end if;
 if exists(select 1 from public.project_jobs where project_id=v_project_id and status='running' and id<>p_job_id) then return null; end if;
 update public.project_jobs set status='running',lease_token=p_lease_token,locked_at=clock_timestamp(),
 started_at=clock_timestamp(),updated_at=clock_timestamp(),message='Starter jobben ...'
 where id=p_job_id and status='queued' returning * into v_job;
 if not found then return null; end if;
 return jsonb_build_object('id',v_job.id);
end;
$$;
create or replace function public.enqueue_project_job_serialized(
  p_project_id uuid,
  p_job jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.project_jobs%rowtype;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  if (p_job ->> 'project_id')::uuid is distinct from p_project_id then
    raise exception 'Queued job project does not match locked project';
  end if;
  select * into v_job from public.project_jobs
  where project_id = p_project_id and kind = p_job ->> 'kind'
    and input_json = p_job -> 'input_json' and status in ('queued', 'running')
  order by submission_sequence desc limit 1;
  if found then return to_jsonb(v_job); end if;
  if p_job->>'kind' not in ('document_ingestion','document_docling_enhancement') then
    if exists(select 1 from public.project_jobs where project_id=p_project_id and status in ('queued','running')) then
      raise exception 'PROJECT_WORKFLOW_BUSY';
    end if;
    if exists(select 1 from public.documents where project_id=p_project_id and processing_status in ('queued','processing')) then
      raise exception 'DOCUMENT_INDEX_NOT_READY';
    end if;
    if p_job->>'kind' in ('solution_evaluation','high_level_design','perfect_system_solution')
       and not exists(select 1 from public.customer_analyses where project_id=p_project_id and provenance_verified) then
      raise exception 'CUSTOMER_ANALYSIS_REQUIRED';
    end if;
    if p_job->>'kind' in ('executive_summary','perfect_system_solution')
       and not public.solution_evaluation_is_current(p_project_id)
       and nullif(p_job->'input_json'->>'resumeArtifactId','') is null then
      raise exception 'SOLUTION_EVALUATION_REQUIRED';
    end if;
  end if;
  insert into public.project_jobs (
    id, project_id, kind, status, message, error, input_json, result_json,
    created_at, updated_at
  ) values (
    (p_job ->> 'id')::uuid, p_project_id, p_job ->> 'kind',
    coalesce(p_job ->> 'status', 'queued'), coalesce(p_job ->> 'message', ''),
    p_job ->> 'error', p_job -> 'input_json', p_job -> 'result_json',
    (p_job ->> 'created_at')::timestamptz,
    (p_job ->> 'updated_at')::timestamptz
  ) returning * into v_job;
  return to_jsonb(v_job);
end;
$$;
revoke all on function public.archive_project_result() from public,anon,authenticated;
grant execute on function public.archive_project_result() to service_role;
revoke all on function public.advance_customer_analysis_revision() from public,anon,authenticated;
grant execute on function public.advance_customer_analysis_revision() to service_role;
revoke all on function public.publish_document_readiness(uuid,uuid,bigint,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_document_readiness(uuid,uuid,bigint,text,text,text,uuid,uuid) to service_role;
revoke all on function public.claim_project_job_serialized(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_project_job_serialized(uuid,uuid) to service_role;
alter table public.project_jobs add column if not exists result_checkpoint jsonb;
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
  v_result jsonb;
  v_job public.project_jobs%rowtype;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

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

  v_result := public.save_customer_analysis_if_source_revision(p_project_id, p_payload);
  update public.project_jobs set result_checkpoint=jsonb_build_object(
    'kind','customer_analysis','id',v_result->>'id','revision',v_result->>'revision') where id=p_job_id;
  return v_result;
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
  v_evaluated_artifact_id uuid;
  v_provenance_mode text;
begin
  select source_revision into v_current_source_revision
  from public.projects
  where id = p_project_id
  for update;

  if not found then
    raise exception 'Project does not exist';
  end if;

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

  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_source_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SOURCE_REVISION_REQUIRED: expected_source_revision is required';
  end if;
  v_expected_source_revision := (p_payload ->> 'expected_source_revision')::bigint;

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

  if v_job.kind = 'perfect_system_solution' then
    if jsonb_typeof(p_payload -> 'evaluated_generated_artifact_id') is distinct from 'string'
       or coalesce(p_payload ->> 'evaluated_generated_artifact_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'EVALUATED_ARTIFACT_REQUIRED: perfect-system evaluation requires an exact generated artifact id';
    end if;
    v_evaluated_artifact_id := (p_payload ->> 'evaluated_generated_artifact_id')::uuid;
    if not exists (
      select 1 from public.generated_artifacts artifact
      where artifact.id = v_evaluated_artifact_id
        and artifact.project_id = p_project_id
        and artifact.artifact_type = 'losningsutkast'
        and (artifact.generation_job_id = p_job_id or v_job.input_json->>'resumeArtifactId' = artifact.id::text)
        and artifact.input_artifact_source_revision = (select artifact_source_revision from public.projects where id=p_project_id)
        and artifact.input_service_library_revision = (select service_library_revision from public.artifact_source_state where singleton)
        and artifact.artifact_version = (select max(latest.artifact_version)
          from public.generated_artifacts latest
          where latest.project_id = p_project_id and latest.artifact_type = 'losningsutkast')
    ) then
      raise exception using errcode = 'P0001', message = 'EVALUATED_ARTIFACT_MISMATCH: evaluation artifact is not the authoritative output of this job';
    end if;
    v_provenance_mode := 'generated_artifact';
  else
    if nullif(p_payload ->> 'evaluated_generated_artifact_id', '') is not null then
      raise exception using errcode = 'P0001', message = 'EVALUATED_ARTIFACT_MISMATCH: document-only evaluation cannot claim a generated artifact';
    end if;
    v_evaluated_artifact_id := null;
    v_provenance_mode := 'document_only';
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
    evaluated_generated_artifact_id,
    evaluation_provenance_mode,
    updated_at
  ) values (
    p_project_id,
    v_source_document_ids,
    (p_payload ->> 'customer_document_id')::uuid,
    (p_payload ->> 'solution_document_id')::uuid,
    (p_payload ->> 'analysis_id')::uuid,
    p_payload -> 'result_json',
    v_evaluated_artifact_id,
    v_provenance_mode,
    now()
  )
  on conflict (project_id) do update
    set source_document_ids = excluded.source_document_ids,
        customer_document_id = excluded.customer_document_id,
        solution_document_id = excluded.solution_document_id,
        analysis_id = excluded.analysis_id,
        result_json = excluded.result_json,
        evaluated_generated_artifact_id = excluded.evaluated_generated_artifact_id,
        evaluation_provenance_mode = excluded.evaluation_provenance_mode,
        updated_at = now()
  returning * into v_evaluation;

  delete from public.executive_summaries
  where project_id = p_project_id;

  update public.projects
  set solution_evaluation_generated = true,
      last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
  where id = p_project_id;

  update public.project_jobs set result_checkpoint=jsonb_build_object(
    'kind','solution_evaluation','id',v_evaluation.id,'updated_at',v_evaluation.updated_at) where id=p_job_id;
  return to_jsonb(v_evaluation);
end;
$$;
create or replace function public.lease_fenced_save_executive_summary(
  p_job_id uuid, p_lease_token uuid, p_project_id uuid, p_payload jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_job public.project_jobs%rowtype;
  v_summary public.executive_summaries%rowtype;
  v_current_dependency jsonb;
  v_expected_dependency jsonb;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;

  select * into v_job from public.project_jobs
  where id = p_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_lease_token for update;
  if not found then raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative'; end if;
  if v_job.kind <> 'executive_summary' then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist an executive summary';
  end if;
  if exists (select 1 from public.project_jobs newer_job
    where newer_job.project_id = p_project_id and newer_job.kind = 'executive_summary'
      and newer_job.submission_sequence > v_job.submission_sequence) then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer executive-summary job is authoritative';
  end if;
  v_expected_dependency := p_payload -> 'solution_evaluation_dependency';
  v_current_dependency := public.artifact_solution_evaluation_dependency(p_project_id);
  if v_expected_dependency is null or v_current_dependency is distinct from v_expected_dependency then
    raise exception using errcode = 'P0001', message = 'EXECUTIVE_SUMMARY_EVALUATION_CHANGED: evaluation changed while summary generation was running';
  end if;
  insert into public.executive_summaries (
    project_id, result_json, input_snapshot, input_solution_evaluation_id,
    input_solution_evaluation_updated_at, input_solution_evaluation_hash,
    provenance_verified, updated_at
  ) values (
    p_project_id, p_payload -> 'result_json', p_payload -> 'input_snapshot',
    (v_expected_dependency ->> 'id')::uuid,
    (v_expected_dependency ->> 'updated_at')::timestamptz,
    v_expected_dependency ->> 'content_hash', true, now()
  ) on conflict (project_id) do update set
    result_json = excluded.result_json, input_snapshot = excluded.input_snapshot,
    input_solution_evaluation_id = excluded.input_solution_evaluation_id,
    input_solution_evaluation_updated_at = excluded.input_solution_evaluation_updated_at,
    input_solution_evaluation_hash = excluded.input_solution_evaluation_hash,
    provenance_verified = true, updated_at = now()
  returning * into v_summary;
  update public.projects set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
  where id = p_project_id;
  update public.project_jobs set result_checkpoint=jsonb_build_object(
    'kind','executive_summary','id',v_summary.id,'updated_at',v_summary.updated_at) where id=p_job_id;
  return to_jsonb(v_summary);
end;
$$;
create or replace function public.lease_fenced_save_generated_artifact(
  p_job_id uuid, p_lease_token uuid, p_project_id uuid, p_payload jsonb
)
returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_job public.project_jobs%rowtype;
  v_artifact public.generated_artifacts%rowtype;
  v_artifact_type text;
  v_expected_artifact_revision bigint;
  v_current_artifact_revision bigint;
  v_expected_service_revision bigint;
  v_current_service_revision bigint;
  v_current_evaluation_dependency jsonb;
  v_current_knowledge_manifest jsonb;
  v_knowledge_base_manifest jsonb;
  v_next_version bigint;
  v_evaluation_current boolean;
begin
  select artifact_source_revision into v_current_artifact_revision
  from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;

  select * into v_job from public.project_jobs
  where id = p_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_lease_token for update;
  if not found then raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative'; end if;
  v_artifact_type := p_payload ->> 'artifact_type';
  if v_artifact_type is null or v_artifact_type not in (
    'losningsutkast', 'bilag1_rekonstruksjon', 'forbedret_kravsvar',
    'tilbudsstrategi', 'verdiargumentasjon', 'anbefalt_arkitektur',
    'gjennomforing_og_risiko'
  ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_TYPE_INVALID: artifact type is not supported';
  end if;
  if nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'content_markdown'), '') is null then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_CONTENT_REQUIRED: title and content are required';
  end if;
  if jsonb_typeof(p_payload -> 'input_snapshot') is distinct from 'object'
     or jsonb_typeof(p_payload -> 'knowledge_artifact_manifest') is distinct from 'array'
     or nullif(btrim(p_payload ->> 'generator_revision'), '') is null
     or coalesce(p_payload ->> 'source_snapshot_hash', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PROVENANCE_REQUIRED: manifest, generator revision and snapshot hash are required';
  end if;
  if v_job.kind = 'artifact_generation' then
    if v_job.input_json ->> 'artifactType' is distinct from v_artifact_type then
      raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: artifact type differs from queued job';
    end if;
  elsif v_job.kind = 'perfect_system_solution' then
    if v_artifact_type is distinct from 'losningsutkast' then
      raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: perfect-system job may only save losningsutkast';
    end if;
  else
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist a generated artifact';
  end if;
  select service_library_revision into v_current_service_revision
  from public.artifact_source_state where singleton = true for update;
  if not found then raise exception 'Artifact source state does not exist'; end if;
  v_current_evaluation_dependency := public.artifact_solution_evaluation_dependency(p_project_id);
  if exists (select 1 from public.project_jobs newer
    where newer.project_id = p_project_id and newer.submission_sequence > v_job.submission_sequence
      and case when newer.kind = 'artifact_generation' then newer.input_json ->> 'artifactType'
        when newer.kind = 'perfect_system_solution' then 'losningsutkast' else null end = v_artifact_type
  ) then raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer artifact job is authoritative'; end if;
  if jsonb_typeof(p_payload -> 'expected_artifact_source_revision') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'expected_service_library_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_artifact_source_revision', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_payload ->> 'expected_service_library_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_REQUIRED: expected revisions are required';
  end if;
  v_expected_artifact_revision := (p_payload ->> 'expected_artifact_source_revision')::bigint;
  v_expected_service_revision := (p_payload ->> 'expected_service_library_revision')::bigint;
  if v_current_artifact_revision is distinct from v_expected_artifact_revision then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_CHANGED: project inputs changed while generation was running'; end if;
  if v_current_service_revision is distinct from v_expected_service_revision then
    raise exception using errcode = 'P0001', message = 'SERVICE_LIBRARY_REVISION_CHANGED: service inputs changed while generation was running'; end if;
  select public.artifact_knowledge_manifest(p_project_id, v_artifact_type),
         public.artifact_base_knowledge_manifest(p_project_id, v_artifact_type)
  into v_current_knowledge_manifest, v_knowledge_base_manifest;
  if v_current_knowledge_manifest is distinct from
       coalesce(p_payload -> 'knowledge_artifact_manifest', '[]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_KNOWLEDGE_CHANGED: prior artifact context changed while generation was running'; end if;
  if coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false)
     and v_current_evaluation_dependency is distinct from (p_payload -> 'solution_evaluation_dependency') then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOLUTION_EVALUATION_CHANGED: solution evaluation context changed while generation was running'; end if;
  select * into v_artifact from public.generated_artifacts
  where generation_job_id = p_job_id and project_id = p_project_id and artifact_type = v_artifact_type;
  if found then
    if v_artifact.input_artifact_source_revision is distinct from v_expected_artifact_revision
       or v_artifact.input_service_library_revision is distinct from v_expected_service_revision
       or v_artifact.generator_revision is distinct from (p_payload ->> 'generator_revision')
       or v_artifact.source_snapshot_hash is distinct from (p_payload ->> 'source_snapshot_hash')
       or v_artifact.knowledge_base_manifest is distinct from v_knowledge_base_manifest
       or v_artifact.knowledge_artifact_manifest is distinct from coalesce(p_payload -> 'knowledge_artifact_manifest', '[]'::jsonb)
       or coalesce(v_artifact.used_solution_evaluation, false) is distinct from coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false)
       or (coalesce(v_artifact.used_solution_evaluation, false) and (
         v_artifact.input_solution_evaluation_id is distinct from (p_payload -> 'solution_evaluation_dependency' ->> 'id')::uuid
         or v_artifact.input_solution_evaluation_hash is distinct from (p_payload -> 'solution_evaluation_dependency' ->> 'content_hash')
       )) then
      raise exception using errcode = 'P0001', message = 'ARTIFACT_IDEMPOTENCY_CONFLICT: existing artifact authority differs from retry payload';
    end if;
    update public.project_jobs set result_checkpoint=jsonb_build_object(
    'kind','artifact_generation','id',v_artifact.id,'updated_at',v_artifact.updated_at) where id=p_job_id;
  return to_jsonb(v_artifact);
  end if;
  select coalesce(max(artifact_version), 0) + 1 into v_next_version
  from public.generated_artifacts where project_id = p_project_id and artifact_type = v_artifact_type;
  insert into public.generated_artifacts (
    project_id, artifact_type, artifact_version, title, content_markdown, input_snapshot,
    generation_job_id, generation_submission_sequence, input_artifact_source_revision,
    input_service_library_revision, used_solution_evaluation, input_solution_evaluation_id,
    input_solution_evaluation_updated_at, input_solution_evaluation_hash,
    generator_revision, origin, source_snapshot_hash,
    knowledge_base_manifest, knowledge_artifact_manifest
  ) values (
    p_project_id, v_artifact_type, v_next_version, p_payload ->> 'title', p_payload ->> 'content_markdown',
    p_payload -> 'input_snapshot', p_job_id, v_job.submission_sequence, v_expected_artifact_revision,
    v_expected_service_revision, coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false),
    (p_payload -> 'solution_evaluation_dependency' ->> 'id')::uuid,
    (p_payload -> 'solution_evaluation_dependency' ->> 'updated_at')::timestamptz,
    p_payload -> 'solution_evaluation_dependency' ->> 'content_hash',
    p_payload ->> 'generator_revision', 'generated', p_payload ->> 'source_snapshot_hash',
    v_knowledge_base_manifest,
    p_payload -> 'knowledge_artifact_manifest'
  ) returning * into v_artifact;
  v_evaluation_current := public.solution_evaluation_is_current(p_project_id);
  update public.projects
  set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz,
      solution_evaluation_generated = case
        when v_artifact_type = 'losningsutkast'
          and exists (select 1 from public.solution_evaluations evaluation
            where evaluation.project_id = p_project_id
              and evaluation.evaluation_provenance_mode = 'generated_artifact')
        then v_evaluation_current else solution_evaluation_generated end
  where id = p_project_id;
  if v_artifact_type = 'losningsutkast' and not v_evaluation_current then
    delete from public.executive_summaries where project_id = p_project_id;
  end if;
  update public.project_jobs set result_checkpoint=jsonb_build_object(
    'kind','artifact_generation','id',v_artifact.id,'updated_at',v_artifact.updated_at) where id=p_job_id;
  return to_jsonb(v_artifact);
end;
$$;
create or replace function public.lease_fenced_project_write(
  p_job_id uuid,
  p_lease_token uuid,
  p_project_id uuid,
  p_operation text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_project public.projects%rowtype;
  v_analysis public.customer_analyses%rowtype;
  v_evaluation public.solution_evaluations%rowtype;
  v_summary public.executive_summaries%rowtype;
  v_artifact public.generated_artifacts%rowtype;
  v_source_document_ids uuid[];
begin
  if p_operation <> 'replace_document_chunks'
     or p_payload ->> 'source_type' is distinct from 'service_document' then
    perform 1
    from public.projects
    where id = p_project_id
    for no key update;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'PROJECT_JOB_LEASE_LOST: parent project no longer exists';
    end if;
  end if;

  perform 1
  from public.project_jobs
  where id = p_job_id
    and project_id = p_project_id
    and status = 'running'
    and lease_token = p_lease_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative';
  end if;

  if p_operation = 'document_processing_state' then
    update public.documents
    set processing_status = p_payload ->> 'status',
        processing_message = case
          when p_payload ? 'message' then p_payload ->> 'message'
          else processing_message
        end,
        processing_error = case
          when p_payload ? 'error' then p_payload ->> 'error'
          else processing_error
        end,
        parser_used = case
          when p_payload ? 'parser_used' then p_payload ->> 'parser_used'
          else parser_used
        end,
        indexed_at = case
          when p_payload ? 'indexed_at' then (p_payload ->> 'indexed_at')::timestamptz
          else indexed_at
        end,
        updated_at = (p_payload ->> 'updated_at')::timestamptz
    where id = (p_payload ->> 'document_id')::uuid
      and project_id = p_project_id
    returning * into v_document;

    if not found then
      raise exception 'Document does not belong to the leased project';
    end if;
    return to_jsonb(v_document);
  elsif p_operation = 'document_ingestion_result' then
    update public.documents
    set file_name = p_payload ->> 'file_name',
        file_format = p_payload ->> 'file_format',
        content_type = p_payload ->> 'content_type',
        page_count = (p_payload ->> 'page_count')::integer,
        raw_text = p_payload ->> 'raw_text',
        structure_map = p_payload -> 'structure_map',
        processing_status = p_payload ->> 'status',
        processing_message = p_payload ->> 'message',
        processing_error = null,
        parser_used = p_payload ->> 'parser_used',
        indexed_at = (p_payload ->> 'indexed_at')::timestamptz,
        updated_at = (p_payload ->> 'updated_at')::timestamptz
    where id = (p_payload ->> 'document_id')::uuid
      and project_id = p_project_id
      and (not (p_payload ? 'expected_chunk_source_revision') or chunk_source_revision = (p_payload->>'expected_chunk_source_revision')::bigint)
    returning * into v_document;

    if not found then
      raise exception 'PROJECT_SOURCE_REVISION_CHANGED';
    end if;
    return to_jsonb(v_document);
  elsif p_operation = 'project_metadata' then
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'projects'
        and column_name = 'name'
    ) then
      update public.projects
      set name = case when p_payload ? 'name' then p_payload ->> 'name' else name end,
          customer_name = case when p_payload ? 'customer_name' then p_payload ->> 'customer_name' else customer_name end,
          industry = case when p_payload ? 'industry' then p_payload ->> 'industry' else industry end,
          description = case when p_payload ? 'description' then p_payload ->> 'description' else description end,
          context_keywords = case
            when p_payload ? 'context_keywords' then array(
              select jsonb_array_elements_text(p_payload -> 'context_keywords')
            )
            else context_keywords
          end,
          last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
      where id = p_project_id
      returning * into v_project;
    else
      update public.projects
      set title = case when p_payload ? 'name' then p_payload ->> 'name' else title end,
          client_name = case when p_payload ? 'customer_name' then p_payload ->> 'customer_name' else client_name end,
          description = case when p_payload ? 'description' then p_payload ->> 'description' else description end,
          context_keywords = case
            when p_payload ? 'context_keywords' then array(
              select jsonb_array_elements_text(p_payload -> 'context_keywords')
            )
            else context_keywords
          end,
          last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
      where id = p_project_id
      returning * into v_project;
    end if;
    return to_jsonb(v_project);
  elsif p_operation = 'project_context_keywords' then
    update public.projects
    set context_keywords = array(
          select jsonb_array_elements_text(p_payload -> 'context_keywords')
        )
    where id = p_project_id
    returning * into v_project;
    return to_jsonb(v_project);
  elsif p_operation = 'customer_analysis' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: customer_analysis';
  elsif p_operation = 'solution_evaluation' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: solution_evaluation';
  elsif p_operation = 'executive_summary' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: executive_summary';
  elsif p_operation = 'generated_artifact' then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: generated_artifact';
  elsif p_operation = 'replace_document_chunks' then
    if p_payload ->> 'source_type' = 'project_document'
       and not exists (
         select 1
         from public.documents document
         where document.id = (p_payload ->> 'source_id')::uuid
           and document.project_id = p_project_id
       ) then
      raise exception using
        errcode = '23503',
        message = 'Leased document chunk source does not belong to the project';
    end if;

    return jsonb_build_object(
      'count',
      public.replace_document_chunks_atomic(
        p_payload ->> 'source_type',
        (p_payload ->> 'source_id')::uuid,
        p_payload ->> 'source_fingerprint',
        (p_payload ->> 'expected_source_revision')::bigint,
        (p_payload ->> 'expected_chunk_count')::integer,
        p_payload -> 'rows'
      )
    );
  end if;

  raise exception 'Unsupported lease-fenced project write operation: %', p_operation;
end;
$$;
notify pgrst, 'reload schema';
commit;
