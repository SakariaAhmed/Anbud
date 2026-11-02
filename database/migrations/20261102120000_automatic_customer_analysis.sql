begin;

-- An explicit upload choice, not a background policy or an automatic retry.
create table if not exists public.project_analysis_requests (
  project_id uuid primary key references public.projects(id) on delete cascade,
  request_id uuid not null default gen_random_uuid(),
  status text not null check (status in ('pending','scheduled','completed','failed','cancelled')),
  job_id uuid references public.project_jobs(id) on delete set null,
  source_revision bigint,
  reason_code text,
  updated_at timestamptz not null default now()
);
alter table public.project_analysis_requests add column if not exists last_checked_at timestamptz;
alter table public.project_analysis_requests enable row level security;
revoke all on public.project_analysis_requests from public,anon,authenticated;
grant all on public.project_analysis_requests to service_role;

create unique index if not exists project_jobs_automatic_analysis_request_idx
on public.project_jobs(project_id,(input_json->>'automaticRequestId'))
where kind='customer_analysis' and input_json ? 'automaticRequestId';

create or replace function public.record_upload_analysis_request()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.kind <> 'document_ingestion' or (new.input_json ? 'requestAutoAnalysis') is not true then return new; end if;
  if jsonb_typeof(new.input_json->'requestAutoAnalysis') is distinct from 'boolean' then
    raise exception 'AUTOMATIC_ANALYSIS_CHOICE_INVALID';
  end if;
  if new.input_json->'requestAutoAnalysis'='true'::jsonb then
    insert into public.project_analysis_requests(project_id,status) values(new.project_id,'pending')
    on conflict(project_id) do update set
      request_id=case when project_analysis_requests.status='pending' then project_analysis_requests.request_id else gen_random_uuid() end,
      status='pending',job_id=null,source_revision=null,reason_code=null,last_checked_at=null,updated_at=now();
  else
    update public.project_analysis_requests set status='cancelled',reason_code='user_opted_out',updated_at=now()
    where project_id=new.project_id and status in ('pending','scheduled');
  end if;
  return new;
end;
$$;
drop trigger if exists project_jobs_upload_analysis_request on public.project_jobs;
create trigger project_jobs_upload_analysis_request after insert on public.project_jobs
for each row execute function public.record_upload_analysis_request();

create or replace function public.schedule_ready_customer_analysis(
  p_project_id uuid,p_parent_job_id uuid,p_parent_lease_token uuid
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_request public.project_analysis_requests%rowtype;
  v_revision bigint;
  v_job_id uuid;
begin
  select source_revision into v_revision from public.projects where id=p_project_id for update;
  if not found then
    if p_parent_job_id is null then return null; end if;
    raise exception 'Project does not exist';
  end if;
  if p_parent_job_id is not null then
    perform 1 from public.project_jobs where id=p_parent_job_id and project_id=p_project_id
      and status='running' and lease_token=p_parent_lease_token for update;
    if not found then raise exception 'PROJECT_JOB_LEASE_LOST: automatic analysis parent is no longer authoritative'; end if;
  elsif p_parent_lease_token is not null then
    raise exception 'PROJECT_JOB_LEASE_LOST: parent lease requires a parent job';
  end if;
  select * into v_request from public.project_analysis_requests where project_id=p_project_id for update;
  if not found or v_request.status <> 'pending' then return null; end if;
  update public.project_analysis_requests set last_checked_at=clock_timestamp() where project_id=p_project_id;
  -- Existing current/manual work wins. Source changes invalidate this row via
  -- the existing project/document/service revision triggers.
  if exists(select 1 from public.customer_analyses where project_id=p_project_id and provenance_verified) then
    update public.project_analysis_requests set status='completed',reason_code='existing_analysis_preserved',updated_at=now() where project_id=p_project_id;
    return null;
  end if;
  if exists(select 1 from public.project_jobs where project_id=p_project_id and (p_parent_job_id is null or id<>p_parent_job_id) and status in ('queued','running')) then return null; end if;
  if not exists(select 1 from public.documents where project_id=p_project_id and role='primary_customer_document') then
    update public.project_analysis_requests set status='failed',reason_code='customer_document_required',updated_at=now() where project_id=p_project_id;
    return null;
  end if;
  -- An upload can briefly exist before its ingestion job is inserted.
  if exists(select 1 from public.documents d where d.project_id=p_project_id
    and public.project_document_affects_customer_analysis(d.role,d.supporting_subtype,d.subtype)
    and d.processing_status in ('queued','processing')
    and d.updated_at > clock_timestamp() - interval '15 minutes') then return null; end if;
  if exists(
    select 1 from public.documents d where d.project_id=p_project_id
      and public.project_document_affects_customer_analysis(d.role,d.supporting_subtype,d.subtype)
      and (d.processing_status in ('queued','processing','failed') or d.indexed_at is null
        or not exists(select 1 from public.document_chunks c where c.source_type='project_document' and c.source_id=d.id and c.project_id=p_project_id))
  ) then
    update public.project_analysis_requests set status='failed',reason_code='document_basis_not_ready',updated_at=now() where project_id=p_project_id;
    return null;
  end if;
  -- Compiled artifacts are optional caches. Legacy/demoted ready documents
  -- are compiled on demand by the normal analysis context owner.

  v_job_id:=gen_random_uuid();
  insert into public.project_jobs(id,project_id,kind,message,input_json,parent_job_id,idempotency_key)
  values(v_job_id,p_project_id,'customer_analysis','Køer automatisk kundeanalyse ...',
    jsonb_build_object('kind','customer_analysis','projectId',p_project_id,'automaticRequestId',v_request.request_id,'automaticSourceRevision',v_revision),
    p_parent_job_id,'automatic_customer_analysis:'||v_request.request_id::text);
  update public.project_analysis_requests set status='scheduled',job_id=v_job_id,source_revision=v_revision,reason_code=null,updated_at=now() where project_id=p_project_id;
  return jsonb_build_object('job_id',v_job_id);
end;
$$;

-- Recovery for a process exit after readiness publication, or a newer upload
-- intent left behind a superseded job. Failed intents are never dispatched.
create index if not exists project_analysis_requests_pending_idx on public.project_analysis_requests(updated_at) where status='pending';
create or replace function public.dispatch_ready_customer_analyses(p_limit integer default 20)
returns integer language plpgsql security invoker set search_path='' as $$
declare v_project_id uuid; v_count integer:=0;
begin
  for v_project_id in select project_id from public.project_analysis_requests where status='pending' order by last_checked_at nulls first,updated_at limit least(greatest(p_limit,1),20) loop
    if public.schedule_ready_customer_analysis(v_project_id,null,null) is not null then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.dispatch_ready_customer_analyses(integer) from public,anon,authenticated;
grant execute on function public.dispatch_ready_customer_analyses(integer) to service_role;

create or replace function public.finish_automatic_customer_analysis()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.status not in ('completed','failed') or old.status=new.status then return new; end if;
  if new.kind='customer_analysis' then
    update public.project_analysis_requests set
      status=case when new.status='completed' then 'completed' else 'failed' end,
      reason_code=case when new.status='failed' then 'analysis_failed' else null end,updated_at=now()
    where project_id=new.project_id and job_id=new.id and request_id::text=new.input_json->>'automaticRequestId' and status='scheduled';
    if new.status='completed' and (new.input_json ? 'automaticRequestId') is not true
      and exists(select 1 from public.customer_analyses where project_id=new.project_id and provenance_verified) then
      update public.project_analysis_requests set status='completed',reason_code='existing_analysis_preserved',updated_at=now()
      where project_id=new.project_id and status in ('pending','failed');
    end if;
  elsif new.kind in ('document_ingestion','document_docling_enhancement') and new.status='failed'
    and exists(select 1 from public.documents d where d.project_id=new.project_id and d.id::text=new.input_json->>'documentId' and public.project_document_affects_customer_analysis(d.role,d.supporting_subtype,d.subtype)) then
    update public.project_analysis_requests set status='failed',reason_code='document_processing_failed',updated_at=now()
    where project_id=new.project_id and status='pending';
  end if;
  return new;
end;
$$;
drop trigger if exists project_jobs_finish_automatic_analysis on public.project_jobs;
create trigger project_jobs_finish_automatic_analysis after update of status on public.project_jobs
for each row execute function public.finish_automatic_customer_analysis();

revoke all on function public.record_upload_analysis_request() from public,anon,authenticated;
revoke all on function public.schedule_ready_customer_analysis(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_automatic_customer_analysis() from public,anon,authenticated;
grant execute on function public.record_upload_analysis_request() to service_role;
grant execute on function public.schedule_ready_customer_analysis(uuid,uuid,uuid) to service_role;
grant execute on function public.finish_automatic_customer_analysis() to service_role;

-- Publication also checks the one-shot request while holding the project lock.
-- The full existing analysis owner is replaced below, retaining its CAS and
-- source revision, context publication and provenance contracts.
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

  if p_payload ? 'automatic_request_id' and (
    not (p_payload ? 'expected_analysis_revision') or p_payload->'expected_analysis_revision' <> 'null'::jsonb
  ) then
    raise exception 'AUTOMATIC_ANALYSIS_INVALID_PUBLICATION: explicit first-save CAS is required';
  end if;

  if p_payload ? 'automatic_request_id' and not exists(
    select 1 from public.project_analysis_requests where project_id=p_project_id
      and request_id::text=p_payload->>'automatic_request_id' and status='scheduled'
      and source_revision=v_expected_source_revision
  ) then
    raise exception 'AUTOMATIC_ANALYSIS_CANCELLED: the upload analysis request is no longer current';
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

-- Fail the release before automatic upload analysis reaches an unmigrated schema.
create or replace function public.automatic_customer_analysis_preflight()
returns text language plpgsql stable security invoker set search_path='' as $$
declare v_function regprocedure; v_signature text; v_column text;
begin
  if not exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.project_analysis_requests') and relrowsecurity) then
    raise exception 'project_analysis_requests is missing or RLS is disabled';
  end if;
  foreach v_column in array array['project_id','request_id','status','job_id','source_revision','reason_code','updated_at','last_checked_at'] loop
    if not exists(select 1 from pg_catalog.pg_attribute where attrelid='public.project_analysis_requests'::regclass and attname=v_column and not attisdropped) then
      raise exception 'project_analysis_requests column missing: %',v_column;
    end if;
  end loop;
  if not (pg_catalog.has_table_privilege('service_role','public.project_analysis_requests','SELECT')
    and pg_catalog.has_table_privilege('service_role','public.project_analysis_requests','INSERT')
    and pg_catalog.has_table_privilege('service_role','public.project_analysis_requests','UPDATE')
    and pg_catalog.has_table_privilege('service_role','public.project_analysis_requests','DELETE'))
    or pg_catalog.has_table_privilege('anon','public.project_analysis_requests','SELECT,INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated','public.project_analysis_requests','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'project_analysis_requests has unexpected grants';
  end if;
  foreach v_signature in array array['public.record_upload_analysis_request()','public.schedule_ready_customer_analysis(uuid,uuid,uuid)','public.dispatch_ready_customer_analyses(integer)','public.finish_automatic_customer_analysis()'] loop
    v_function:=pg_catalog.to_regprocedure(v_signature);
    if v_function is null or not pg_catalog.has_function_privilege('service_role',v_function,'execute')
      or pg_catalog.has_function_privilege('anon',v_function,'execute')
      or pg_catalog.has_function_privilege('authenticated',v_function,'execute') then
      raise exception 'automatic analysis function missing or has unexpected grants: %',v_signature;
    end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_index where indexrelid=pg_catalog.to_regclass('public.project_jobs_automatic_analysis_request_idx') and indisunique and indisvalid) then
    raise exception 'automatic analysis request uniqueness is missing';
  end if;
  if not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.project_jobs'::regclass and tgname='project_jobs_upload_analysis_request' and tgenabled in ('O','A') and tgfoid='public.record_upload_analysis_request()'::regprocedure)
    or not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.project_jobs'::regclass and tgname='project_jobs_finish_automatic_analysis' and tgenabled in ('O','A') and tgfoid='public.finish_automatic_customer_analysis()'::regprocedure) then
    raise exception 'automatic analysis triggers are missing or disabled';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.save_customer_analysis_if_source_revision(uuid,jsonb)'::regprocedure),'automatic_request_id')=0
    or pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.save_customer_analysis_if_source_revision(uuid,jsonb)'::regprocedure),'expected_analysis_revision')=0 then
    raise exception 'automatic analysis publication guards are missing';
  end if;
  return 'automatic-customer-analysis-v1';
end;
$$;
revoke all on function public.automatic_customer_analysis_preflight() from public,anon,authenticated;
grant execute on function public.automatic_customer_analysis_preflight() to service_role;

commit;
notify pgrst, 'reload schema';
