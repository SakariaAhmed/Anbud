alter table project_jobs
  add column if not exists submission_sequence bigint generated always as identity,
  add column if not exists input_json jsonb,
  add column if not exists locked_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists terminal_metadata jsonb not null default '{}'::jsonb,
  add column if not exists parent_job_id uuid,
  add column if not exists idempotency_key text;

alter table solution_evaluations
  add column if not exists customer_document_id uuid,
  add column if not exists solution_document_id uuid,
  add column if not exists analysis_id uuid,
  add column if not exists evaluated_generated_artifact_id uuid,
  add column if not exists evaluation_provenance_mode text not null default 'legacy_unknown';

alter table customer_analyses
  add column if not exists provenance_verified boolean not null default false;

alter table executive_summaries
  add column if not exists input_solution_evaluation_id uuid,
  add column if not exists input_solution_evaluation_updated_at timestamptz,
  add column if not exists input_solution_evaluation_hash text,
  add column if not exists provenance_verified boolean not null default false;

alter table generated_artifacts
  add column if not exists artifact_version bigint,
  add column if not exists generation_job_id uuid references project_jobs(id) on delete set null,
  add column if not exists generation_submission_sequence bigint,
  add column if not exists input_artifact_source_revision bigint,
  add column if not exists input_service_library_revision bigint,
  add column if not exists used_solution_evaluation boolean not null default false,
  add column if not exists input_solution_evaluation_id uuid,
  add column if not exists input_solution_evaluation_updated_at timestamptz,
  add column if not exists input_solution_evaluation_hash text,
  add column if not exists generator_revision text,
  add column if not exists origin text,
  add column if not exists parent_artifact_id uuid references generated_artifacts(id) on delete set null,
  add column if not exists source_snapshot_hash text,
  add column if not exists knowledge_base_manifest jsonb not null default '[]'::jsonb,
  add column if not exists knowledge_artifact_manifest jsonb not null default '[]'::jsonb;

update projects project
set customer_analysis_generated = false
where project.customer_analysis_generated
  and not exists (
    select 1 from customer_analyses analysis
    where analysis.project_id = project.id and analysis.provenance_verified
  );

alter table projects
  add column if not exists source_revision bigint not null default 0,
  add column if not exists artifact_source_revision bigint not null default 0;

create table if not exists artifact_source_state (
  singleton boolean primary key default true check (singleton),
  service_library_revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into artifact_source_state(singleton)
values (true)
on conflict (singleton) do nothing;
alter table artifact_source_state enable row level security;
revoke all on table artifact_source_state from public, anon, authenticated;
grant select, insert, update on table artifact_source_state to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'solution_evaluations_generated_artifact_fkey'
      and conrelid = 'public.solution_evaluations'::regclass
  ) then
    alter table solution_evaluations
      add constraint solution_evaluations_generated_artifact_fkey
      foreign key (evaluated_generated_artifact_id)
      references generated_artifacts(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'solution_evaluations_provenance_mode_check'
      and conrelid = 'public.solution_evaluations'::regclass
  ) then
    alter table solution_evaluations
      add constraint solution_evaluations_provenance_mode_check
      check (evaluation_provenance_mode in ('document_only', 'generated_artifact', 'legacy_unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'project_jobs_parent_job_id_fkey'
      and conrelid = 'public.project_jobs'::regclass
  ) then
    alter table project_jobs
      add constraint project_jobs_parent_job_id_fkey
      foreign key (parent_job_id) references project_jobs(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'project_jobs_parent_idempotency_key_key'
      and conrelid = 'public.project_jobs'::regclass
  ) then
    alter table project_jobs
      add constraint project_jobs_parent_idempotency_key_key
      unique (parent_job_id, idempotency_key);
  end if;
end $$;

create index if not exists generated_artifacts_parent_artifact_id_idx
  on generated_artifacts(parent_artifact_id);

create index if not exists solution_evaluations_evaluated_generated_artifact_id_idx
  on solution_evaluations(evaluated_generated_artifact_id);

update project_jobs
set input_json = result_json -> '__job_input',
    result_json = null
where input_json is null
  and result_json ? '__job_input';

create index if not exists project_jobs_queue_claim_idx
  on project_jobs(status, locked_at, created_at)
  where status in ('queued', 'running');

create index if not exists project_jobs_running_lease_idx
  on project_jobs(id, lease_token)
  where status = 'running' and lease_token is not null;

create index if not exists project_jobs_parent_job_idx
  on project_jobs(parent_job_id)
  where parent_job_id is not null;

create index if not exists project_jobs_solution_evaluation_order_idx
  on project_jobs(project_id, submission_sequence desc)
  where kind in ('solution_evaluation', 'perfect_system_solution');

create or replace function public.raw_artifact_solution_evaluation_dependency(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', evaluation.id,
    'updated_at', to_char(evaluation.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'content_hash', encode(digest(evaluation.result_json::text, 'sha256'), 'hex'),
    'evaluated_generated_artifact_id', evaluation.evaluated_generated_artifact_id,
    'provenance_mode', evaluation.evaluation_provenance_mode
  )
  from public.solution_evaluations evaluation
  where evaluation.project_id = p_project_id
    and (
      evaluation.evaluation_provenance_mode <> 'generated_artifact'
      or exists (
        select 1 from public.generated_artifacts artifact
        where artifact.id = evaluation.evaluated_generated_artifact_id
          and artifact.project_id = evaluation.project_id
      )
    )
  order by evaluation.updated_at desc, evaluation.id desc
  limit 1;
$$;

create or replace function public.artifact_base_knowledge_candidates(
  p_project_id uuid,
  p_artifact_type text
)
returns table (
  candidate_id uuid,
  candidate_artifact_type text,
  candidate_artifact_version bigint,
  candidate_updated_at timestamptz,
  candidate_content_markdown text,
  candidate_created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (artifact.artifact_type) artifact.*
    from public.generated_artifacts artifact
    where artifact.project_id = p_project_id
    order by artifact.artifact_type, artifact.artifact_version desc,
             artifact.created_at desc, artifact.id desc
  ), authority as (
    select project.artifact_source_revision,
           source_state.service_library_revision,
           public.raw_artifact_solution_evaluation_dependency(project.id) as evaluation_dependency
    from public.projects project
    cross join public.artifact_source_state source_state
    where project.id = p_project_id and source_state.singleton = true
  )
  select latest.id, latest.artifact_type, latest.artifact_version,
         latest.updated_at, latest.content_markdown, latest.created_at
  from latest cross join authority
  where latest.input_artifact_source_revision = authority.artifact_source_revision
    and latest.input_service_library_revision = authority.service_library_revision
    and (
      not latest.used_solution_evaluation
      or authority.evaluation_dependency ->> 'evaluated_generated_artifact_id' = latest.id::text
      or (
        latest.input_solution_evaluation_id::text = authority.evaluation_dependency ->> 'id'
        and to_char(latest.input_solution_evaluation_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = authority.evaluation_dependency ->> 'updated_at'
        and latest.input_solution_evaluation_hash = authority.evaluation_dependency ->> 'content_hash'
      )
    )
    and latest.artifact_type <> p_artifact_type;
$$;

create or replace function public.artifact_base_knowledge_manifest(
  p_project_id uuid,
  p_artifact_type text
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with eligible as (
    select *
    from public.artifact_base_knowledge_candidates(p_project_id, p_artifact_type)
    order by candidate_created_at desc, candidate_id desc
    limit case when p_artifact_type = 'gjennomforing_og_risiko' then 2 else 4 end
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', eligible.candidate_id,
    'artifact_type', eligible.candidate_artifact_type,
    'artifact_version', eligible.candidate_artifact_version,
    'updated_at', to_char(eligible.candidate_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'content_hash', encode(digest(eligible.candidate_content_markdown, 'sha256'), 'hex')
  ) order by eligible.candidate_created_at desc, eligible.candidate_id desc), '[]'::jsonb)
  from eligible;
$$;

create or replace function public.artifact_cross_type_knowledge_is_current(
  p_artifact_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce((
    select (
      select coalesce(jsonb_agg(dependency.value order by dependency.ordinality), '[]'::jsonb)
      from jsonb_array_elements(artifact.knowledge_base_manifest)
        with ordinality as dependency(value, ordinality)
      where dependency.value ->> 'artifact_type' is distinct from artifact.artifact_type
    ) = (
      select coalesce(jsonb_agg(dependency.value order by dependency.ordinality), '[]'::jsonb)
      from jsonb_array_elements(
        public.artifact_base_knowledge_manifest(artifact.project_id, artifact.artifact_type)
      ) with ordinality as dependency(value, ordinality)
      where dependency.value ->> 'artifact_type' is distinct from artifact.artifact_type
    )
    from public.generated_artifacts artifact
    where artifact.id = p_artifact_id
  ), false);
$$;

create or replace function public.solution_evaluation_is_current(
  p_project_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select case evaluation.evaluation_provenance_mode
      when 'document_only' then true
      when 'generated_artifact' then exists (
        select 1
        from public.generated_artifacts artifact
        cross join public.projects project
        cross join public.artifact_source_state source_state
        where artifact.id = evaluation.evaluated_generated_artifact_id
          and artifact.project_id = evaluation.project_id
          and project.id = evaluation.project_id
          and source_state.singleton = true
          and artifact.artifact_type = 'losningsutkast'
          and artifact.artifact_version = (
            select max(latest.artifact_version)
            from public.generated_artifacts latest
            where latest.project_id = evaluation.project_id
              and latest.artifact_type = artifact.artifact_type
          )
          and artifact.input_artifact_source_revision = project.artifact_source_revision
          and artifact.input_service_library_revision = source_state.service_library_revision
          and public.artifact_cross_type_knowledge_is_current(artifact.id)
      )
      else false
    end
    from public.solution_evaluations evaluation
    where evaluation.project_id = p_project_id
  ), false);
$$;

create or replace function public.artifact_solution_evaluation_dependency(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.raw_artifact_solution_evaluation_dependency(p_project_id)
  where public.solution_evaluation_is_current(p_project_id);
$$;

create or replace function public.get_artifact_source_revisions(p_project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'artifact_source_revision', project.artifact_source_revision,
    'service_library_revision', source_state.service_library_revision,
    'solution_evaluation_dependency', public.artifact_solution_evaluation_dependency(project.id)
  )
  from public.projects project
  cross join public.artifact_source_state source_state
  where project.id = p_project_id and source_state.singleton = true;
$$;

create or replace function public.get_current_solution_evaluation_snapshot(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'evaluation_row', to_jsonb(evaluation),
    'dependency', public.artifact_solution_evaluation_dependency(p_project_id)
  )
  from public.solution_evaluations evaluation
  where evaluation.project_id = p_project_id
    and public.solution_evaluation_is_current(p_project_id)
  order by evaluation.updated_at desc, evaluation.id desc
  limit 1;
$$;

create or replace function public.get_current_executive_summary(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select to_jsonb(summary)
  from public.executive_summaries summary
  cross join lateral (
    select public.artifact_solution_evaluation_dependency(p_project_id) as dependency
  ) current_evaluation
  where summary.project_id = p_project_id
    and summary.provenance_verified
    and summary.input_solution_evaluation_id::text = current_evaluation.dependency ->> 'id'
    and to_char(summary.input_solution_evaluation_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = current_evaluation.dependency ->> 'updated_at'
    and summary.input_solution_evaluation_hash = current_evaluation.dependency ->> 'content_hash'
  order by summary.updated_at desc, summary.id desc
  limit 1;
$$;

create or replace function public.get_solution_evaluation_currentness(
  p_project_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(project_id::text, public.solution_evaluation_is_current(project_id)),
    '{}'::jsonb
  )
  from unnest(coalesce(p_project_ids, '{}'::uuid[])) as project_id;
$$;

create or replace function public.get_current_project_derived_snapshot(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with current_dependency as (
    select public.artifact_solution_evaluation_dependency(p_project_id) as dependency
  )
  select case when current_dependency.dependency is null then null else
    jsonb_build_object(
      'evaluation_row', (
        select to_jsonb(evaluation)
        from public.solution_evaluations evaluation
        where evaluation.id = (current_dependency.dependency ->> 'id')::uuid
      ),
      'dependency', current_dependency.dependency,
      'executive_summary_row', (
        select to_jsonb(summary)
        from public.executive_summaries summary
        where summary.project_id = p_project_id
          and summary.provenance_verified
          and summary.input_solution_evaluation_id::text = current_dependency.dependency ->> 'id'
          and to_char(summary.input_solution_evaluation_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = current_dependency.dependency ->> 'updated_at'
          and summary.input_solution_evaluation_hash = current_dependency.dependency ->> 'content_hash'
        order by summary.updated_at desc, summary.id desc limit 1
      )
    ) end
  from current_dependency;
$$;

create or replace function public.get_artifact_authority_summary(p_project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (artifact.artifact_type)
      artifact.id, artifact.artifact_type, artifact.artifact_version,
      artifact.input_artifact_source_revision, artifact.input_service_library_revision,
      artifact.used_solution_evaluation, artifact.input_solution_evaluation_id,
      artifact.input_solution_evaluation_updated_at, artifact.input_solution_evaluation_hash
    from public.generated_artifacts artifact
    where artifact.project_id = p_project_id
    order by artifact.artifact_type, artifact.artifact_version desc,
             artifact.created_at desc, artifact.id desc
  ), authority as (
    select project.artifact_source_revision,
           source_state.service_library_revision,
           public.raw_artifact_solution_evaluation_dependency(project.id) as evaluation_dependency
    from public.projects project
    cross join public.artifact_source_state source_state
    where project.id = p_project_id and source_state.singleton = true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', latest.id,
    'artifact_type', latest.artifact_type,
    'artifact_version', latest.artifact_version,
    'source_is_current', coalesce(
      latest.input_artifact_source_revision = authority.artifact_source_revision
      and latest.input_service_library_revision = authority.service_library_revision
      and public.artifact_cross_type_knowledge_is_current(latest.id)
      and (
        not latest.used_solution_evaluation
        or authority.evaluation_dependency ->> 'evaluated_generated_artifact_id' = latest.id::text
        or (
          latest.input_solution_evaluation_id::text = authority.evaluation_dependency ->> 'id'
          and to_char(latest.input_solution_evaluation_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = authority.evaluation_dependency ->> 'updated_at'
          and latest.input_solution_evaluation_hash = authority.evaluation_dependency ->> 'content_hash'
        )
      ), false
  )) order by latest.artifact_type), '[]'::jsonb)
  from latest cross join authority;
$$;

create or replace function public.artifact_knowledge_manifest(
  p_project_id uuid,
  p_artifact_type text
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with eligible as (
    select *
    from public.artifact_base_knowledge_candidates(p_project_id, p_artifact_type)
    where public.artifact_cross_type_knowledge_is_current(candidate_id)
    order by candidate_created_at desc, candidate_id desc
    limit case when p_artifact_type = 'gjennomforing_og_risiko' then 2 else 4 end
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', eligible.candidate_id,
    'artifact_type', eligible.candidate_artifact_type,
    'artifact_version', eligible.candidate_artifact_version,
    'updated_at', to_char(eligible.candidate_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'content_hash', encode(digest(eligible.candidate_content_markdown, 'sha256'), 'hex')
  ) order by eligible.candidate_created_at desc, eligible.candidate_id desc), '[]'::jsonb)
  from eligible;
$$;

alter table public.documents
  add column if not exists chunk_source_revision bigint not null default 0;

alter table public.service_documents
  add column if not exists chunk_source_revision bigint not null default 0;

create or replace function public.bump_project_document_chunk_source_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if jsonb_build_array(
       v_old -> 'project_id',
       v_old -> 'role',
       v_old -> 'supporting_subtype',
       v_old -> 'subtype',
       v_old -> 'title',
       v_old -> 'display_name',
       v_old -> 'file_name',
       v_old -> 'file_format',
       v_old -> 'raw_text',
       v_old -> 'structure_map',
       v_old -> 'source_map'
     ) is distinct from jsonb_build_array(
       v_new -> 'project_id',
       v_new -> 'role',
       v_new -> 'supporting_subtype',
       v_new -> 'subtype',
       v_new -> 'title',
       v_new -> 'display_name',
       v_new -> 'file_name',
       v_new -> 'file_format',
       v_new -> 'raw_text',
       v_new -> 'structure_map',
       v_new -> 'source_map'
     ) then
    new.chunk_source_revision := old.chunk_source_revision + 1;
  else
    new.chunk_source_revision := old.chunk_source_revision;
  end if;
  return new;
end;
$$;

create or replace function public.bump_service_document_chunk_source_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if jsonb_build_array(
       v_old -> 'service_id',
       v_old -> 'title',
       v_old -> 'display_name',
       v_old -> 'file_name',
       v_old -> 'file_format',
       v_old -> 'raw_text',
       v_old -> 'structure_map',
       v_old -> 'source_map'
     ) is distinct from jsonb_build_array(
       v_new -> 'service_id',
       v_new -> 'title',
       v_new -> 'display_name',
       v_new -> 'file_name',
       v_new -> 'file_format',
       v_new -> 'raw_text',
       v_new -> 'structure_map',
       v_new -> 'source_map'
     ) then
    new.chunk_source_revision := old.chunk_source_revision + 1;
  else
    new.chunk_source_revision := old.chunk_source_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_chunk_source_revision on public.documents;
create trigger documents_chunk_source_revision
  before update on public.documents
  for each row
  execute function public.bump_project_document_chunk_source_revision();

drop trigger if exists service_documents_chunk_source_revision
  on public.service_documents;
create trigger service_documents_chunk_source_revision
  before update on public.service_documents
  for each row
  execute function public.bump_service_document_chunk_source_revision();

revoke all on function public.bump_project_document_chunk_source_revision()
  from public, anon, authenticated;
revoke all on function public.bump_service_document_chunk_source_revision()
  from public, anon, authenticated;

drop function if exists public.replace_document_chunks_atomic(
  text,
  uuid,
  text,
  integer,
  jsonb
);

create or replace function public.replace_document_chunks_atomic(
  p_source_type text,
  p_source_id uuid,
  p_source_fingerprint text,
  p_expected_source_revision bigint,
  p_expected_chunk_count integer,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_service_id uuid;
  v_revalidated_parent_id uuid;
  v_source_revision bigint;
  v_document_title text;
  v_file_name text;
  v_file_format text;
  v_role text;
  v_supporting_subtype text;
  v_row_count integer;
  v_distinct_index_count integer;
  v_min_index integer;
  v_max_index integer;
  v_inserted_count integer;
begin
  if p_source_type is null
     or p_source_type not in ('project_document', 'service_document') then
    raise exception using
      errcode = '23514',
      message = 'Invalid document chunk source type';
  end if;

  if p_source_id is null then
    raise exception using
      errcode = '23502',
      message = 'Document chunk source id is required';
  end if;

  if p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'A valid document chunk source fingerprint is required';
  end if;

  if p_expected_source_revision is null or p_expected_source_revision < 0 then
    raise exception using
      errcode = '23514',
      message = 'Expected document chunk source revision is required';
  end if;

  if p_expected_chunk_count is null or p_expected_chunk_count < 0 then
    raise exception using
      errcode = '23514',
      message = 'Expected document chunk count must be non-negative';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'Document chunk rows must be a JSON array';
  end if;

  if jsonb_array_length(p_rows) <> p_expected_chunk_count then
    raise exception using
      errcode = '23514',
      message = 'Document chunk payload count does not match the expected count';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as payload(row_json)
    where jsonb_typeof(payload.row_json) is distinct from 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Every document chunk row must be a JSON object';
  end if;

  if p_source_type = 'project_document' then
    select document.project_id
    into v_project_id
    from public.documents document
    where document.id = p_source_id;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source does not reference an existing project document';
    end if;

    perform 1
    from public.projects project
    where project.id = v_project_id
    for key share;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source project does not exist';
    end if;

    select document.project_id, document.chunk_source_revision,
           document.title, document.file_name, document.file_format,
           document.role, document.supporting_subtype
    into v_revalidated_parent_id, v_source_revision,
         v_document_title, v_file_name, v_file_format,
         v_role, v_supporting_subtype
    from public.documents document
    where document.id = p_source_id
    for update nowait;

    if not found
       or v_revalidated_parent_id is distinct from v_project_id
       or v_source_revision is distinct from p_expected_source_revision then
      raise exception using
        errcode = '40001',
        message = 'Document chunk project source changed before replacement';
    end if;
  else
    select document.service_id
    into v_service_id
    from public.service_documents document
    where document.id = p_source_id;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source does not reference an existing service document';
    end if;

    perform 1
    from public.service_descriptions service
    where service.id = v_service_id
    for key share;

    if not found then
      raise exception using
        errcode = '23503',
        message = 'Document chunk source service does not exist';
    end if;

    select document.service_id, document.chunk_source_revision,
           document.title, document.file_name, document.file_format
    into v_revalidated_parent_id, v_source_revision,
         v_document_title, v_file_name, v_file_format
    from public.service_documents document
    where document.id = p_source_id
    for update nowait;

    if not found
       or v_revalidated_parent_id is distinct from v_service_id
       or v_source_revision is distinct from p_expected_source_revision then
      raise exception using
        errcode = '40001',
        message = 'Document chunk service source changed before replacement';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as payload(row_json)
    where payload.row_json ->> 'source_type' is distinct from p_source_type
       or payload.row_json ->> 'source_id' is distinct from p_source_id::text
       or payload.row_json ->> 'document_title' is distinct from v_document_title
       or payload.row_json ->> 'file_name' is distinct from v_file_name
       or payload.row_json ->> 'file_format' is distinct from v_file_format
       or (
         p_source_type = 'project_document'
         and (
           payload.row_json ->> 'project_id' is distinct from v_project_id::text
           or payload.row_json ->> 'service_id' is not null
           or payload.row_json ->> 'role' is distinct from v_role
           or payload.row_json ->> 'supporting_subtype'
                is distinct from v_supporting_subtype
         )
       )
       or (
         p_source_type = 'service_document'
         and (
           payload.row_json ->> 'project_id' is not null
           or payload.row_json ->> 'service_id' is distinct from v_service_id::text
           or payload.row_json ->> 'role' is not null
           or payload.row_json ->> 'supporting_subtype' is not null
         )
       )
       or jsonb_typeof(payload.row_json -> 'metadata') is distinct from 'object'
       or payload.row_json -> 'metadata' ->> 'source_fingerprint'
            is distinct from p_source_fingerprint
       or payload.row_json -> 'metadata' -> 'source_fingerprint_version'
            is distinct from '1'::jsonb
       or payload.row_json -> 'metadata' ->> 'content_hash'
            is distinct from payload.row_json ->> 'content_hash'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Document chunk payload does not match its source manifest';
  end if;

  select
    count(*)::integer,
    count(distinct (payload.row_json ->> 'chunk_index')::integer)::integer,
    min((payload.row_json ->> 'chunk_index')::integer),
    max((payload.row_json ->> 'chunk_index')::integer)
  into
    v_row_count,
    v_distinct_index_count,
    v_min_index,
    v_max_index
  from jsonb_array_elements(p_rows) as payload(row_json);

  if v_row_count <> p_expected_chunk_count
     or v_distinct_index_count <> p_expected_chunk_count
     or (
       p_expected_chunk_count > 0
       and (v_min_index <> 0 or v_max_index <> p_expected_chunk_count - 1)
     ) then
    raise exception using
      errcode = '23514',
      message = 'Document chunk indexes must be unique and contiguous from zero';
  end if;

  delete from public.document_chunks
  where source_type = p_source_type
    and source_id = p_source_id;

  insert into public.document_chunks (
    source_type,
    source_id,
    project_id,
    service_id,
    document_title,
    file_name,
    file_format,
    role,
    supporting_subtype,
    chunk_index,
    kind,
    reference,
    heading_path,
    page_start,
    page_end,
    token_count,
    text_encrypted,
    fts,
    content_hash,
    metadata,
    embedding,
    embedding_model,
    embedding_created_at
  )
  select
    chunk.source_type,
    chunk.source_id,
    chunk.project_id,
    chunk.service_id,
    chunk.document_title,
    chunk.file_name,
    chunk.file_format,
    chunk.role,
    chunk.supporting_subtype,
    chunk.chunk_index,
    chunk.kind,
    chunk.reference,
    chunk.heading_path,
    chunk.page_start,
    chunk.page_end,
    chunk.token_count,
    chunk.text_encrypted,
    to_tsvector('simple', left(coalesce(chunk.search_text, ''), 200000)),
    chunk.content_hash,
    chunk.metadata,
    case
      when chunk.embedding is null then null
      else chunk.embedding::extensions.vector
    end,
    chunk.embedding_model,
    chunk.embedding_created_at
  from jsonb_to_recordset(p_rows) as chunk(
    source_type text,
    source_id uuid,
    project_id uuid,
    service_id uuid,
    document_title text,
    file_name text,
    file_format text,
    role text,
    supporting_subtype text,
    chunk_index integer,
    kind text,
    reference text,
    heading_path text[],
    page_start integer,
    page_end integer,
    token_count integer,
    text_encrypted text,
    content_hash text,
    metadata jsonb,
    embedding text,
    embedding_model text,
    embedding_created_at timestamptz,
    search_text text
  );

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> p_expected_chunk_count then
    raise exception using
      errcode = '23514',
      message = 'Atomic document chunk replacement inserted an incomplete set';
  end if;

  return v_inserted_count;
end;
$$;

drop function if exists public.document_chunks_are_complete(
  text,
  uuid,
  text,
  integer,
  text,
  timestamptz
);

create or replace function public.document_chunks_are_complete(
  p_source_type text,
  p_source_id uuid,
  p_source_fingerprint text,
  p_expected_source_revision bigint,
  p_expected_chunk_count integer,
  p_embedding_model text,
  p_checked_at timestamptz
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_service_id uuid;
  v_source_revision bigint;
  v_complete boolean;
begin
  if p_source_type is null
     or p_source_type not in ('project_document', 'service_document')
     or p_source_id is null
     or p_source_fingerprint is null
     or p_source_fingerprint !~ '^[0-9a-f]{64}$'
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_expected_chunk_count is null
     or p_expected_chunk_count < 0
     or p_checked_at is null
     or (p_embedding_model is not null and btrim(p_embedding_model) = '') then
    return false;
  end if;

  if p_source_type = 'project_document' then
    select document.project_id, document.chunk_source_revision
    into v_project_id, v_source_revision
    from public.documents document
    where document.id = p_source_id;

    if not found
       or v_source_revision is distinct from p_expected_source_revision then
      return false;
    end if;
  else
    select document.service_id, document.chunk_source_revision
    into v_service_id, v_source_revision
    from public.service_documents document
    where document.id = p_source_id;

    if not found
       or v_source_revision is distinct from p_expected_source_revision then
      return false;
    end if;
  end if;

  if p_expected_chunk_count = 0 then
    return not exists (
      select 1
      from public.document_chunks chunk
      where chunk.source_type = p_source_type
        and chunk.source_id = p_source_id
    );
  end if;

  begin
    select
      count(*) = p_expected_chunk_count
      and count(distinct chunk.chunk_index) = p_expected_chunk_count
      and min(chunk.chunk_index) = 0
      and max(chunk.chunk_index) = p_expected_chunk_count - 1
      and coalesce(
        bool_and(
          coalesce(
            chunk.metadata ->> 'source_fingerprint' = p_source_fingerprint
            and chunk.metadata -> 'source_fingerprint_version' = '1'::jsonb
            and chunk.metadata ->> 'content_hash' = chunk.content_hash
            and case
              when p_source_type = 'project_document' then
                chunk.project_id = v_project_id and chunk.service_id is null
              else
                chunk.project_id is null and chunk.service_id = v_service_id
            end,
            false
          )
        ),
        false
      )
      and case
        when p_embedding_model is null then true
        else coalesce(
          bool_and(
            coalesce(
              (
                chunk.embedding is not null
                and chunk.embedding_model = p_embedding_model
                and chunk.embedding_created_at is not null
              )
              or (
                chunk.embedding is null
                and chunk.embedding_model is null
                and chunk.embedding_created_at is null
                and (chunk.metadata ->> 'embedding_retry_after')::timestamptz
                      > p_checked_at
              ),
              false
            )
          ),
          false
        )
      end
    into v_complete
    from public.document_chunks chunk
    where chunk.source_type = p_source_type
      and chunk.source_id = p_source_id;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      return false;
  end;

  return coalesce(v_complete, false);
end;
$$;

revoke all on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.replace_document_chunks_atomic(text, uuid, text, bigint, integer, jsonb)
  to service_role;
grant execute on function public.document_chunks_are_complete(text, uuid, text, bigint, integer, text, timestamptz)
  to service_role;

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
    returning * into v_document;

    if not found then
      raise exception 'Document does not belong to the leased project';
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
      message = 'PROJECT_SOURCE_REVISION_REQUIRED: a non-negative integer source revision is required';
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
      raise exception using
        errcode = 'P0001',
        message = 'EVALUATED_ARTIFACT_REQUIRED: perfect-system evaluation requires an exact generated artifact id';
    end if;
    v_evaluated_artifact_id := (p_payload ->> 'evaluated_generated_artifact_id')::uuid;
    if not exists (
      select 1 from public.generated_artifacts artifact
      where artifact.id = v_evaluated_artifact_id
        and artifact.project_id = p_project_id
        and artifact.artifact_type = 'losningsutkast'
        and artifact.generation_job_id = p_job_id
        and artifact.artifact_version = (
          select max(latest.artifact_version)
          from public.generated_artifacts latest
          where latest.project_id = p_project_id
            and latest.artifact_type = 'losningsutkast'
        )
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'EVALUATED_ARTIFACT_MISMATCH: evaluation artifact is not the authoritative output of this job';
    end if;
    v_provenance_mode := 'generated_artifact';
  else
    if nullif(p_payload ->> 'evaluated_generated_artifact_id', '') is not null then
      raise exception using
        errcode = 'P0001',
        message = 'EVALUATED_ARTIFACT_MISMATCH: document-only evaluation cannot claim a generated artifact';
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

  return to_jsonb(v_evaluation);
end;
$$;

create or replace function public.lease_fenced_save_executive_summary(
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
  v_summary public.executive_summaries%rowtype;
  v_current_dependency jsonb;
  v_expected_dependency jsonb;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;

  select * into v_job from public.project_jobs
  where id = p_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_lease_token
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;
  if v_job.kind <> 'executive_summary' then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist an executive summary';
  end if;
  if exists (
    select 1 from public.project_jobs newer_job
    where newer_job.project_id = p_project_id
      and newer_job.kind = 'executive_summary'
      and newer_job.submission_sequence > v_job.submission_sequence
  ) then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer executive-summary job is authoritative';
  end if;
  v_expected_dependency := p_payload -> 'solution_evaluation_dependency';
  v_current_dependency := public.artifact_solution_evaluation_dependency(p_project_id);
  if v_expected_dependency is null
     or v_current_dependency is distinct from v_expected_dependency then
    raise exception using errcode = 'P0001', message = 'EXECUTIVE_SUMMARY_EVALUATION_CHANGED: evaluation changed while summary generation was running';
  end if;
  insert into public.executive_summaries (
    project_id, result_json, input_snapshot,
    input_solution_evaluation_id, input_solution_evaluation_updated_at,
    input_solution_evaluation_hash, provenance_verified, updated_at
  ) values (
    p_project_id, p_payload -> 'result_json', p_payload -> 'input_snapshot',
    (v_expected_dependency ->> 'id')::uuid,
    (v_expected_dependency ->> 'updated_at')::timestamptz,
    v_expected_dependency ->> 'content_hash', true, now()
  )
  on conflict (project_id) do update set
    result_json = excluded.result_json,
    input_snapshot = excluded.input_snapshot,
    input_solution_evaluation_id = excluded.input_solution_evaluation_id,
    input_solution_evaluation_updated_at = excluded.input_solution_evaluation_updated_at,
    input_solution_evaluation_hash = excluded.input_solution_evaluation_hash,
    provenance_verified = true,
    updated_at = now()
  returning * into v_summary;
  update public.projects
  set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
  where id = p_project_id;
  return to_jsonb(v_summary);
end;
$$;

create or replace function public.lease_fenced_save_generated_artifact(
  p_job_id uuid,
  p_lease_token uuid,
  p_project_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
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
    and status = 'running' and lease_token = p_lease_token
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;
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

  if exists (
    select 1 from public.project_jobs newer
    where newer.project_id = p_project_id
      and newer.submission_sequence > v_job.submission_sequence
      and case
        when newer.kind = 'artifact_generation' then newer.input_json ->> 'artifactType'
        when newer.kind = 'perfect_system_solution' then 'losningsutkast'
        else null
      end = v_artifact_type
  ) then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer artifact job is authoritative';
  end if;

  if jsonb_typeof(p_payload -> 'expected_artifact_source_revision') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'expected_service_library_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_artifact_source_revision', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_payload ->> 'expected_service_library_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_REQUIRED: expected revisions are required';
  end if;
  v_expected_artifact_revision := (p_payload ->> 'expected_artifact_source_revision')::bigint;
  v_expected_service_revision := (p_payload ->> 'expected_service_library_revision')::bigint;
  if v_current_artifact_revision is distinct from v_expected_artifact_revision then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_CHANGED: project inputs changed while generation was running';
  end if;
  if v_current_service_revision is distinct from v_expected_service_revision then
    raise exception using errcode = 'P0001', message = 'SERVICE_LIBRARY_REVISION_CHANGED: service inputs changed while generation was running';
  end if;
  select public.artifact_knowledge_manifest(p_project_id, v_artifact_type),
         public.artifact_base_knowledge_manifest(p_project_id, v_artifact_type)
  into v_current_knowledge_manifest, v_knowledge_base_manifest;
  if v_current_knowledge_manifest is distinct from
       coalesce(p_payload -> 'knowledge_artifact_manifest', '[]'::jsonb) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_KNOWLEDGE_CHANGED: prior artifact context changed while generation was running';
  end if;
  if coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false)
     and v_current_evaluation_dependency is distinct from (p_payload -> 'solution_evaluation_dependency') then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOLUTION_EVALUATION_CHANGED: solution evaluation context changed while generation was running';
  end if;

  select * into v_artifact from public.generated_artifacts
  where generation_job_id = p_job_id
    and project_id = p_project_id
    and artifact_type = v_artifact_type;
  if found then
    if v_artifact.input_artifact_source_revision is distinct from v_expected_artifact_revision
       or v_artifact.input_service_library_revision is distinct from v_expected_service_revision
       or v_artifact.generator_revision is distinct from (p_payload ->> 'generator_revision')
       or v_artifact.source_snapshot_hash is distinct from (p_payload ->> 'source_snapshot_hash')
       or v_artifact.knowledge_base_manifest is distinct from v_knowledge_base_manifest
       or v_artifact.knowledge_artifact_manifest is distinct from
            coalesce(p_payload -> 'knowledge_artifact_manifest', '[]'::jsonb)
       or coalesce(v_artifact.used_solution_evaluation, false) is distinct from
            coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false)
       or (
         coalesce(v_artifact.used_solution_evaluation, false)
         and (
           v_artifact.input_solution_evaluation_id is distinct from
             (p_payload -> 'solution_evaluation_dependency' ->> 'id')::uuid
           or v_artifact.input_solution_evaluation_hash is distinct from
             (p_payload -> 'solution_evaluation_dependency' ->> 'content_hash')
         )
       ) then
      raise exception using errcode = 'P0001', message = 'ARTIFACT_IDEMPOTENCY_CONFLICT: existing artifact authority differs from retry payload';
    end if;
    return to_jsonb(v_artifact);
  end if;

  select coalesce(max(artifact_version), 0) + 1 into v_next_version
  from public.generated_artifacts
  where project_id = p_project_id and artifact_type = v_artifact_type;
  insert into public.generated_artifacts (
    project_id, artifact_type, artifact_version, title, content_markdown,
    input_snapshot, generation_job_id, generation_submission_sequence,
    input_artifact_source_revision, input_service_library_revision,
    used_solution_evaluation, input_solution_evaluation_id,
    input_solution_evaluation_updated_at, input_solution_evaluation_hash,
    generator_revision, origin, source_snapshot_hash,
    knowledge_base_manifest, knowledge_artifact_manifest
  ) values (
    p_project_id, v_artifact_type, v_next_version, p_payload ->> 'title',
    p_payload ->> 'content_markdown', p_payload -> 'input_snapshot', p_job_id,
    v_job.submission_sequence, v_expected_artifact_revision,
    v_expected_service_revision,
    coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false),
    (p_payload -> 'solution_evaluation_dependency' ->> 'id')::uuid,
    (p_payload -> 'solution_evaluation_dependency' ->> 'updated_at')::timestamptz,
    p_payload -> 'solution_evaluation_dependency' ->> 'content_hash',
    p_payload ->> 'generator_revision', 'generated',
    p_payload ->> 'source_snapshot_hash', v_knowledge_base_manifest,
    p_payload -> 'knowledge_artifact_manifest'
  ) returning * into v_artifact;
  v_evaluation_current := public.solution_evaluation_is_current(p_project_id);
  update public.projects
  set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz,
      solution_evaluation_generated = case
        when v_artifact_type = 'losningsutkast'
          and exists (
            select 1 from public.solution_evaluations evaluation
            where evaluation.project_id = p_project_id
              and evaluation.evaluation_provenance_mode = 'generated_artifact'
          )
        then v_evaluation_current
        else solution_evaluation_generated
      end
  where id = p_project_id;
  if v_artifact_type = 'losningsutkast' and not v_evaluation_current then
    delete from public.executive_summaries where project_id = p_project_id;
  end if;
  return to_jsonb(v_artifact);
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
  where project_id = p_project_id
    and kind = p_job ->> 'kind'
    and input_json = p_job -> 'input_json'
    and status in ('queued', 'running')
  order by submission_sequence desc
  limit 1;
  if found then return to_jsonb(v_job); end if;
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

create or replace function public.lease_fenced_enqueue_project_job(
  p_parent_job_id uuid,
  p_parent_lease_token uuid,
  p_project_id uuid,
  p_job jsonb,
  p_idempotency_key text
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

  perform 1
  from public.project_jobs
  where id = p_parent_job_id
    and project_id = p_project_id
    and status = 'running'
    and lease_token = p_parent_lease_token
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative';
  end if;

  insert into public.project_jobs (
    id,
    project_id,
    kind,
    status,
    message,
    error,
    input_json,
    result_json,
    parent_job_id,
    idempotency_key,
    created_at,
    updated_at
  ) values (
    (p_job ->> 'id')::uuid,
    p_project_id,
    p_job ->> 'kind',
    'queued',
    p_job ->> 'message',
    null,
    p_job -> 'input_json',
    null,
    p_parent_job_id,
    p_idempotency_key,
    (p_job ->> 'created_at')::timestamptz,
    (p_job ->> 'updated_at')::timestamptz
  )
  on conflict (parent_job_id, idempotency_key) do nothing;

  select * into v_job
  from public.project_jobs
  where parent_job_id = p_parent_job_id
    and idempotency_key = p_idempotency_key;

  return to_jsonb(v_job);
end;
$$;

create or replace function public.project_job_fencing_preflight()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select 'authoritative-lease-fencing-v1'::text;
$$;

revoke execute on function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_customer_analysis(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_solution_evaluation(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_executive_summary(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_generated_artifact(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.raw_artifact_solution_evaluation_dependency(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_base_knowledge_candidates(uuid, text) from public, anon, authenticated;
revoke execute on function public.artifact_base_knowledge_manifest(uuid, text) from public, anon, authenticated;
revoke execute on function public.artifact_cross_type_knowledge_is_current(uuid) from public, anon, authenticated;
revoke execute on function public.solution_evaluation_is_current(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_solution_evaluation_dependency(uuid) from public, anon, authenticated;
revoke execute on function public.get_artifact_source_revisions(uuid) from public, anon, authenticated;
revoke execute on function public.get_current_solution_evaluation_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.get_current_executive_summary(uuid) from public, anon, authenticated;
revoke execute on function public.get_solution_evaluation_currentness(uuid[]) from public, anon, authenticated;
revoke execute on function public.get_current_project_derived_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.get_artifact_authority_summary(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_knowledge_manifest(uuid, text) from public, anon, authenticated;
revoke execute on function public.lease_fenced_enqueue_project_job(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.project_job_fencing_preflight() from public, anon, authenticated;

grant execute on function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_customer_analysis(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_solution_evaluation(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_executive_summary(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_generated_artifact(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.raw_artifact_solution_evaluation_dependency(uuid) to service_role;
grant execute on function public.artifact_base_knowledge_candidates(uuid, text) to service_role;
grant execute on function public.artifact_base_knowledge_manifest(uuid, text) to service_role;
grant execute on function public.artifact_cross_type_knowledge_is_current(uuid) to service_role;
grant execute on function public.solution_evaluation_is_current(uuid) to service_role;
grant execute on function public.artifact_solution_evaluation_dependency(uuid) to service_role;
grant execute on function public.get_artifact_source_revisions(uuid) to service_role;
grant execute on function public.get_current_solution_evaluation_snapshot(uuid) to service_role;
grant execute on function public.get_current_executive_summary(uuid) to service_role;
grant execute on function public.get_solution_evaluation_currentness(uuid[]) to service_role;
grant execute on function public.get_current_project_derived_snapshot(uuid) to service_role;
grant execute on function public.get_artifact_authority_summary(uuid) to service_role;
grant execute on function public.artifact_knowledge_manifest(uuid, text) to service_role;
grant execute on function public.lease_fenced_enqueue_project_job(uuid, uuid, uuid, jsonb, text) to service_role;
grant execute on function public.project_job_fencing_preflight() to service_role;

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

revoke execute on function public.invalidate_customer_analysis_dependents() from public, anon, authenticated;
grant execute on function public.invalidate_customer_analysis_dependents() to service_role;

create or replace function public.project_document_affects_customer_analysis(
  p_role text,
  p_supporting_subtype text,
  p_legacy_subtype text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_role <> 'primary_solution_document'
    and not (
      p_role = 'supporting_document'
      and coalesce(p_supporting_subtype, p_legacy_subtype, '') = 'tidligere_losning'
    );
$$;

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

create or replace function public.invalidate_document_on_readiness_loss()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_invalidates_analysis boolean;
begin
  if old.processing_status not in ('basic_ready', 'enhanced_ready')
     or new.processing_status not in ('queued', 'processing', 'failed') then
    return new;
  end if;
  v_invalidates_analysis := public.project_document_affects_customer_analysis(
    new.role,
    new.supporting_subtype,
    new.subtype
  );
  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      solution_evaluation_generated = false,
      customer_analysis_generated = case
        when v_invalidates_analysis then false
        else customer_analysis_generated
      end
  where id = new.project_id;
  if v_invalidates_analysis then
    delete from public.customer_analyses where project_id = new.project_id;
  end if;
  delete from public.solution_evaluations where project_id = new.project_id;
  delete from public.executive_summaries where project_id = new.project_id;
  return new;
end;
$$;

drop trigger if exists documents_readiness_loss_invalidation on public.documents;
create trigger documents_readiness_loss_invalidation
after update of processing_status on public.documents
for each row execute function public.invalidate_document_on_readiness_loss();

revoke execute on function public.bump_project_source_revision_from_document() from public, anon, authenticated;
revoke execute on function public.invalidate_document_on_readiness_loss() from public, anon, authenticated;
revoke execute on function public.project_document_affects_customer_analysis(text, text, text) from public, anon, authenticated;
grant execute on function public.bump_project_source_revision_from_document() to service_role;
grant execute on function public.invalidate_document_on_readiness_loss() to service_role;
grant execute on function public.project_document_affects_customer_analysis(text, text, text) to service_role;

-- Keep terminal job audit delivery atomic with the lease-fenced status update.
alter table public.project_jobs
  add column if not exists terminal_metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if exists (
    select 1
    from public.project_jobs job
    where job.terminal_metadata -> 'produced_solution_evaluation' =
        'true'::jsonb
      and (
        job.status <> 'completed'
        or job.kind not in ('solution_evaluation', 'perfect_system_solution')
      )
  ) then
    raise exception 'Invalid produced solution-evaluation terminal marker';
  end if;
end;
$$;

alter table public.audit_events
  add column if not exists subject_project_id uuid;

update public.audit_events
set subject_project_id = coalesce(
  project_id,
  case
    when coalesce(metadata ->> 'project_id', '') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (metadata ->> 'project_id')::uuid
    else null
  end
)
where subject_project_id is null;

create index if not exists audit_events_subject_project_idx
  on public.audit_events(subject_project_id, created_at desc);

create or replace function public.audit_project_job_terminal_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_produced_solution_evaluation boolean := false;
  v_solution_document_id text;
  v_marker_source text := 'legacy_unknown';
  v_requirement_response_handoff jsonb;
begin
  if new.terminal_metadata -> 'produced_solution_evaluation' = 'true'::jsonb
     and (
       new.status <> 'completed'
       or new.kind not in ('solution_evaluation', 'perfect_system_solution')
     ) then
    raise exception 'Invalid produced solution-evaluation terminal marker';
  end if;
  if new.terminal_metadata ? 'requirement_response_handoff' then
    if jsonb_typeof(
      new.terminal_metadata -> 'requirement_response_handoff'
    ) <> 'object' then
      raise exception 'Invalid requirement-response handoff terminal metadata';
    end if;
    v_requirement_response_handoff :=
      new.terminal_metadata -> 'requirement_response_handoff';
  end if;

  if jsonb_typeof(new.terminal_metadata -> 'produced_solution_evaluation') =
     'boolean' then
    v_produced_solution_evaluation :=
      new.status = 'completed'
      and (new.terminal_metadata -> 'produced_solution_evaluation') =
        'true'::jsonb;
    v_solution_document_id :=
      nullif(new.terminal_metadata ->> 'solution_document_id', '');
    v_marker_source := 'terminal_metadata';
  elsif new.status = 'completed' and new.kind = 'solution_evaluation' then
    -- Legacy direct evaluation jobs cannot complete successfully without
    -- persisting an evaluation, even if that mutable singleton was later reset.
    v_produced_solution_evaluation := true;
    v_solution_document_id := nullif(
      new.input_json ->> 'solutionDocumentId',
      ''
    );
    v_marker_source := 'legacy_job_contract';
  end if;

  v_action := case
    when new.status = 'failed' then 'project_job_failed'
    when v_produced_solution_evaluation then 'solution_evaluation_generated'
    else 'project_job_completed'
  end;

  insert into public.audit_events (
    id,
    action,
    project_id,
    subject_project_id,
    entity_type,
    entity_id,
    metadata,
    created_at
  )
  values (
    new.id,
    v_action,
    null,
    new.project_id,
    'project_job',
    new.id,
    pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'job_id', new.id,
        'project_id', new.project_id,
        'kind', new.kind,
        'status', new.status,
        'produced_solution_evaluation', v_produced_solution_evaluation,
        'production_marker_source', v_marker_source,
        'solution_document_id', v_solution_document_id,
        'requirement_response_handoff', v_requirement_response_handoff,
        'started_at', new.started_at,
        'completed_at', new.completed_at
      )
    ),
    coalesce(new.completed_at, pg_catalog.now())
  )
  on conflict (id) do nothing;

  if not found then
    if not exists (
      select 1
      from public.audit_events event
      where event.id = new.id
        and event.action = v_action
        and event.project_id is null
        and event.subject_project_id = new.project_id
        and event.entity_type = 'project_job'
        and event.entity_id = new.id
        and event.metadata ->> 'job_id' = new.id::text
        and event.metadata ->> 'project_id' = new.project_id::text
        and event.metadata ->> 'kind' = new.kind
        and event.metadata ->> 'status' = new.status
        and event.metadata ->> 'produced_solution_evaluation' =
          v_produced_solution_evaluation::text
        and event.metadata ->> 'production_marker_source' = v_marker_source
        and (event.metadata ->> 'solution_document_id')
          is not distinct from v_solution_document_id
        and (event.metadata -> 'requirement_response_handoff')
          is not distinct from v_requirement_response_handoff
    ) then
      raise exception 'Terminal audit id conflict for project job %', new.id;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.audit_project_job_terminal_state()
  from public, anon, authenticated;
grant execute on function public.audit_project_job_terminal_state()
  to service_role;

drop trigger if exists protect_project_job_terminal_metadata
  on public.project_jobs;
drop function if exists public.protect_project_job_terminal_metadata();

create or replace function public.protect_project_job_terminal_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Terminal project-job state and metadata are immutable';
end;
$$;

revoke execute on function public.protect_project_job_terminal_state()
  from public, anon, authenticated;
grant execute on function public.protect_project_job_terminal_state()
  to service_role;

drop trigger if exists protect_project_job_terminal_state
  on public.project_jobs;
create trigger protect_project_job_terminal_state
before update of status, terminal_metadata on public.project_jobs
for each row
when (
  old.status in ('completed', 'failed')
  and (
    old.status is distinct from new.status
    or old.terminal_metadata is distinct from new.terminal_metadata
  )
)
execute function public.protect_project_job_terminal_state();

-- Install capture triggers before backfill. CREATE TRIGGER takes the table lock;
-- transitions after installation are captured, while older rows are backfilled.
drop trigger if exists audit_project_job_terminal_state on public.project_jobs;
create trigger audit_project_job_terminal_state
after update of status on public.project_jobs
for each row
when (
  old.status is distinct from new.status
  and new.status in ('completed', 'failed')
)
execute function public.audit_project_job_terminal_state();

drop trigger if exists audit_project_job_terminal_insert on public.project_jobs;
create trigger audit_project_job_terminal_insert
after insert on public.project_jobs
for each row
when (new.status in ('completed', 'failed'))
execute function public.audit_project_job_terminal_state();

-- Backfill only immutable job facts. Perfect-system jobs from before the marker
-- are honestly legacy_unknown instead of being inferred from mutable snapshots.
with terminal_jobs as (
  select
    job.*,
    case
      when jsonb_typeof(
        job.terminal_metadata -> 'produced_solution_evaluation'
      ) = 'boolean' then
        job.status = 'completed'
        and (job.terminal_metadata -> 'produced_solution_evaluation') =
          'true'::jsonb
      when job.status = 'completed' and job.kind = 'solution_evaluation' then true
      else false
    end as produced_solution_evaluation,
    case
      when jsonb_typeof(
        job.terminal_metadata -> 'produced_solution_evaluation'
      ) = 'boolean' then 'terminal_metadata'
      when job.status = 'completed' and job.kind = 'solution_evaluation'
        then 'legacy_job_contract'
      else 'legacy_unknown'
    end as marker_source,
    case
      when jsonb_typeof(
        job.terminal_metadata -> 'produced_solution_evaluation'
      ) = 'boolean'
        then nullif(job.terminal_metadata ->> 'solution_document_id', '')
      when job.status = 'completed' and job.kind = 'solution_evaluation'
        then nullif(job.input_json ->> 'solutionDocumentId', '')
      else null
    end as solution_document_id,
    case
      when jsonb_typeof(
        job.terminal_metadata -> 'requirement_response_handoff'
      ) = 'object'
        then job.terminal_metadata -> 'requirement_response_handoff'
      else null
    end as requirement_response_handoff
  from public.project_jobs job
  where job.status in ('completed', 'failed')
)
insert into public.audit_events (
  id,
  action,
  project_id,
  subject_project_id,
  entity_type,
  entity_id,
  metadata,
  created_at
)
select
  job.id,
  case
    when job.status = 'failed' then 'project_job_failed'
    when job.produced_solution_evaluation then 'solution_evaluation_generated'
    else 'project_job_completed'
  end,
  null,
  job.project_id,
  'project_job',
  job.id,
  pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'job_id', job.id,
      'project_id', job.project_id,
      'kind', job.kind,
      'status', job.status,
      'produced_solution_evaluation', job.produced_solution_evaluation,
      'production_marker_source', job.marker_source,
      'solution_document_id', job.solution_document_id,
      'requirement_response_handoff', job.requirement_response_handoff,
      'started_at', job.started_at,
      'completed_at', job.completed_at
    )
  ),
  coalesce(job.completed_at, job.started_at, pg_catalog.now())
from terminal_jobs job
on conflict (id) do nothing;

do $$
begin
  if exists (
    with terminal_jobs as (
      select
        job.*,
        case
          when jsonb_typeof(
            job.terminal_metadata -> 'produced_solution_evaluation'
          ) = 'boolean' then
            job.status = 'completed'
            and (job.terminal_metadata -> 'produced_solution_evaluation') =
              'true'::jsonb
          when job.status = 'completed'
            and job.kind = 'solution_evaluation' then true
          else false
        end as produced_solution_evaluation,
        case
          when jsonb_typeof(
            job.terminal_metadata -> 'produced_solution_evaluation'
          ) = 'boolean' then 'terminal_metadata'
          when job.status = 'completed'
            and job.kind = 'solution_evaluation' then 'legacy_job_contract'
          else 'legacy_unknown'
        end as marker_source,
        case
          when jsonb_typeof(
            job.terminal_metadata -> 'produced_solution_evaluation'
          ) = 'boolean'
            then nullif(job.terminal_metadata ->> 'solution_document_id', '')
          when job.status = 'completed'
            and job.kind = 'solution_evaluation'
            then nullif(job.input_json ->> 'solutionDocumentId', '')
          else null
        end as solution_document_id,
        case
          when jsonb_typeof(
            job.terminal_metadata -> 'requirement_response_handoff'
          ) = 'object'
            then job.terminal_metadata -> 'requirement_response_handoff'
          else null
        end as requirement_response_handoff
      from public.project_jobs job
      where job.status in ('completed', 'failed')
    )
    select 1
    from terminal_jobs job
    left join public.audit_events event on event.id = job.id
    where (
        event.id is null
        or event.action is distinct from case
          when job.status = 'failed' then 'project_job_failed'
          when job.produced_solution_evaluation
            then 'solution_evaluation_generated'
          else 'project_job_completed'
        end
        or event.project_id is not null
        or event.subject_project_id is distinct from job.project_id
        or event.entity_type is distinct from 'project_job'
        or event.entity_id is distinct from job.id
        or event.metadata ->> 'job_id' is distinct from job.id::text
        or event.metadata ->> 'project_id' is distinct from job.project_id::text
        or event.metadata ->> 'kind' is distinct from job.kind
        or event.metadata ->> 'status' is distinct from job.status
        or event.metadata ->> 'produced_solution_evaluation'
          is distinct from job.produced_solution_evaluation::text
        or event.metadata ->> 'production_marker_source'
          is distinct from job.marker_source
        or (event.metadata ->> 'solution_document_id')
          is distinct from job.solution_document_id
        or (event.metadata -> 'requirement_response_handoff')
          is distinct from job.requirement_response_handoff
      )
  ) then
    raise exception 'Existing terminal project-job audit rows are incomplete or conflicting';
  end if;
end;
$$;

create or replace function public.project_job_terminal_audit_preflight()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = pg_catalog.to_regclass('public.project_jobs')
      and attribute.attname = 'terminal_metadata'
      and attribute.atttypid = pg_catalog.to_regtype('pg_catalog.jsonb')
      and attribute.attnotnull
      and not attribute.attisdropped
      and exists (
        select 1
        from pg_catalog.pg_attrdef default_state
        where default_state.adrelid = attribute.attrelid
          and default_state.adnum = attribute.attnum
          and pg_catalog.pg_get_expr(
            default_state.adbin,
            default_state.adrelid
          ) = '''{}''::jsonb'
      )
  ) then
    raise exception 'Immutable project-job terminal_metadata or its default is missing or unexpected';
  end if;

  if exists (
    select 1
    from public.project_jobs job
    where job.terminal_metadata -> 'produced_solution_evaluation' =
        'true'::jsonb
      and (
        job.status <> 'completed'
        or job.kind not in ('solution_evaluation', 'perfect_system_solution')
      )
  ) then
    raise exception 'Invalid produced solution-evaluation terminal marker';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = pg_catalog.to_regclass('public.audit_events')
      and attribute.attname = 'subject_project_id'
      and attribute.atttypid = pg_catalog.to_regtype('pg_catalog.uuid')
      and not attribute.attisdropped
  ) then
    raise exception 'Audit subject_project_id is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_state.indexrelid
    where index_state.indrelid = pg_catalog.to_regclass('public.audit_events')
      and index_relation.relname = 'audit_events_subject_project_idx'
      and index_state.indisvalid
      and index_state.indisready
      and pg_catalog.pg_get_indexdef(index_state.indexrelid) =
        $index$CREATE INDEX audit_events_subject_project_idx ON public.audit_events USING btree (subject_project_id, created_at DESC)$index$
  ) then
    raise exception 'Audit subject project index is missing or invalid';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_trigger trigger
    where trigger.tgname in (
        'audit_project_job_terminal_state',
        'audit_project_job_terminal_insert'
      )
      and trigger.tgrelid = pg_catalog.to_regclass('public.project_jobs')
      and trigger.tgfoid = pg_catalog.to_regprocedure(
        'public.audit_project_job_terminal_state()'
      )
      and trigger.tgenabled in ('O', 'A')
      and not trigger.tgisinternal
      and pg_catalog.pg_get_triggerdef(trigger.oid) = case trigger.tgname
        when 'audit_project_job_terminal_state' then
          $trigger_update$CREATE TRIGGER audit_project_job_terminal_state AFTER UPDATE OF status ON public.project_jobs FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) AND (new.status = ANY (ARRAY['completed'::text, 'failed'::text])))) EXECUTE FUNCTION public.audit_project_job_terminal_state()$trigger_update$
        when 'audit_project_job_terminal_insert' then
          $trigger_insert$CREATE TRIGGER audit_project_job_terminal_insert AFTER INSERT ON public.project_jobs FOR EACH ROW WHEN ((new.status = ANY (ARRAY['completed'::text, 'failed'::text]))) EXECUTE FUNCTION public.audit_project_job_terminal_state()$trigger_insert$
      end
  ) <> 2 then
    raise exception 'Transactional project-job terminal audit trigger definitions are missing or unexpected';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger
    where trigger.tgname = 'protect_project_job_terminal_state'
      and trigger.tgrelid = pg_catalog.to_regclass('public.project_jobs')
      and trigger.tgfoid = pg_catalog.to_regprocedure(
        'public.protect_project_job_terminal_state()'
      )
      and trigger.tgenabled in ('O', 'A')
      and not trigger.tgisinternal
      and trigger.tgtype = 19
      and trigger.tgqual is not null
      and pg_catalog.pg_get_triggerdef(trigger.oid) =
        $guard_trigger$CREATE TRIGGER protect_project_job_terminal_state BEFORE UPDATE OF status, terminal_metadata ON public.project_jobs FOR EACH ROW WHEN (((old.status = ANY (ARRAY['completed'::text, 'failed'::text])) AND ((old.status IS DISTINCT FROM new.status) OR (old.terminal_metadata IS DISTINCT FROM new.terminal_metadata)))) EXECUTE FUNCTION public.protect_project_job_terminal_state()$guard_trigger$
  ) then
    raise exception 'Terminal project-job state guard is missing or unexpected';
  end if;

  return 'transactional-project-job-terminal-audit-v2';
end;
$$;

revoke execute on function public.project_job_terminal_audit_preflight()
  from public, anon, authenticated;
grant execute on function public.project_job_terminal_audit_preflight()
  to service_role;

-- Canonical atomic service-document writer. Keep this repair bootstrap in
-- parity with migration 20260712133000_atomic_service_document_write.sql.
-- Persist a service document and its derived service keywords in one
-- transaction. The existing service-document trigger performs the one global
-- library invalidation; its transaction-local marker coalesces the following
-- keyword update instead of scanning and invalidating every project twice.

create or replace function public.insert_service_document_with_keywords(
  p_service_id uuid,
  p_payload jsonb,
  p_keywords text[]
)
returns public.service_documents
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_document public.service_documents%rowtype;
  v_keywords text[];
begin
  if p_service_id is null then
    raise exception using
      errcode = '23502',
      message = 'SERVICE_DOCUMENT_SERVICE_REQUIRED: service id is required';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or nullif(btrim(p_payload ->> 'id'), '') is null
     or nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'file_name'), '') is null
     or nullif(btrim(p_payload ->> 'file_format'), '') is null
     or nullif(btrim(p_payload ->> 'content_type'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_bucket'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_path'), '') is null then
    raise exception using
      errcode = '22023',
      message = 'SERVICE_DOCUMENT_PAYLOAD_INVALID: required fields are missing';
  end if;
  if (p_payload ->> 'service_id')::uuid is distinct from p_service_id then
    raise exception using
      errcode = '22023',
      message = 'SERVICE_DOCUMENT_SERVICE_MISMATCH: payload service differs from argument';
  end if;
  if coalesce(p_payload ->> 'file_format', '') not in (
    'pdf', 'docx', 'txt', 'md', 'xlsx', 'xls'
  ) then
    raise exception using
      errcode = '23514',
      message = 'SERVICE_DOCUMENT_FORMAT_INVALID: file format is unsupported';
  end if;
  if p_keywords is null or array_position(p_keywords, null) is not null then
    raise exception using
      errcode = '22004',
      message = 'SERVICE_DOCUMENT_KEYWORDS_INVALID: keywords must be a non-null text array';
  end if;

  perform 1
  from public.service_descriptions service
  where service.id = p_service_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'SERVICE_DOCUMENT_SERVICE_NOT_FOUND: service does not exist';
  end if;

  insert into public.service_documents (
    id,
    service_id,
    title,
    file_name,
    file_format,
    content_type,
    file_size_bytes,
    page_count,
    file_storage_bucket,
    file_storage_path,
    file_base64,
    raw_text,
    structure_map
  ) values (
    (p_payload ->> 'id')::uuid,
    p_service_id,
    p_payload ->> 'title',
    p_payload ->> 'file_name',
    p_payload ->> 'file_format',
    p_payload ->> 'content_type',
    coalesce((p_payload ->> 'file_size_bytes')::integer, 0),
    (p_payload ->> 'page_count')::integer,
    p_payload ->> 'file_storage_bucket',
    p_payload ->> 'file_storage_path',
    coalesce(p_payload ->> 'file_base64', ''),
    coalesce(p_payload ->> 'raw_text', ''),
    coalesce(p_payload -> 'structure_map', '[]'::jsonb)
  )
  returning * into v_document;

  select coalesce(array_agg(keyword order by first_ordinal), '{}'::text[])
    into v_keywords
  from (
    select lower(btrim(candidate.value)) as keyword,
           min(candidate.ordinality) as first_ordinal
    from public.service_descriptions service
    cross join lateral unnest(
      coalesce(service.keywords, '{}'::text[]) || p_keywords
    ) with ordinality as candidate(value, ordinality)
    where service.id = p_service_id
      and btrim(candidate.value) <> ''
    group by lower(btrim(candidate.value))
    order by min(candidate.ordinality)
    limit 96
  ) normalized;

  update public.service_descriptions service
  set keywords = v_keywords,
      updated_at = clock_timestamp()
  where service.id = p_service_id;

  return v_document;
end;
$$;

create or replace function public.atomic_service_document_write_preflight()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.to_regprocedure(
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])'
     ) is null then
    raise exception 'Atomic service-document writer is missing';
  end if;
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.insert_service_document_with_keywords(uuid,jsonb,text[])',
       'EXECUTE'
     ) then
    raise exception 'Atomic service-document writer ACL is missing or unsafe';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_trigger trigger
    where trigger.tgname in (
        'service_descriptions_artifact_source_revision',
        'service_documents_artifact_source_revision'
      )
      and trigger.tgfoid = pg_catalog.to_regprocedure(
        'public.bump_service_library_revision()'
      )
      and trigger.tgenabled in ('O', 'A')
      and not trigger.tgisinternal
  ) <> 2 then
    raise exception 'Service-library invalidation triggers are missing';
  end if;
  if pg_catalog.strpos(
       pg_catalog.pg_get_functiondef(
         pg_catalog.to_regprocedure('public.bump_service_library_revision()')
       ),
       'anbud.service_library_invalidated'
     ) = 0 then
    raise exception 'Service-library invalidation coalescing marker is missing';
  end if;
  return 'atomic-service-document-write-v1';
end;
$$;

revoke execute on function public.insert_service_document_with_keywords(
  uuid, jsonb, text[]
) from public, anon, authenticated;
grant execute on function public.insert_service_document_with_keywords(
  uuid, jsonb, text[]
) to service_role;
revoke execute on function public.atomic_service_document_write_preflight()
  from public, anon, authenticated;
grant execute on function public.atomic_service_document_write_preflight()
  to service_role;

-- Canonical stable-main rollback and cutover bridge. Keep this bootstrap in
-- exact parity with migration 20260712131500_stable_main_rollback_bridge.sql.
-- Compatibility and cutover contract for rolling back to stable main
-- 2ff6792d37bcb35cf585864cef1e28035bcda307.

alter table public.generated_artifacts
  add column if not exists artifact_version bigint,
  add column if not exists origin text;

with ranked as (
  select artifact.id,
         row_number() over (
           partition by artifact.project_id, artifact.artifact_type
           order by artifact.created_at, artifact.id
         )::bigint as artifact_version
  from public.generated_artifacts artifact
)
update public.generated_artifacts artifact
set artifact_version = ranked.artifact_version,
    origin = coalesce(artifact.origin, 'legacy')
from ranked
where ranked.id = artifact.id
  and (artifact.artifact_version is null or artifact.origin is null);

alter table public.generated_artifacts
  alter column artifact_version set not null,
  alter column origin set default 'legacy',
  alter column origin set not null;

create unique index if not exists generated_artifacts_project_type_version_key
  on public.generated_artifacts(project_id, artifact_type, artifact_version);

create or replace function public.assign_generated_artifact_insert_defaults()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if new.artifact_version is not null then
    return new;
  end if;
  perform 1
  from public.projects project
  where project.id = new.project_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'insert or update on table "generated_artifacts" violates foreign key constraint';
  end if;
  select coalesce(max(artifact.artifact_version), 0) + 1
    into new.artifact_version
  from public.generated_artifacts artifact
  where artifact.project_id = new.project_id
    and artifact.artifact_type = new.artifact_type;
  return new;
end;
$$;

drop trigger if exists generated_artifacts_insert_defaults
  on public.generated_artifacts;
create trigger generated_artifacts_insert_defaults
before insert on public.generated_artifacts
for each row execute function public.assign_generated_artifact_insert_defaults();

create or replace function public.downgrade_legacy_artifact_content_update()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if old.title is not distinct from new.title
     and old.content_markdown is not distinct from new.content_markdown
     and old.input_snapshot is not distinct from new.input_snapshot then
    return new;
  end if;

  new.origin := 'manual_edit';
  new.generation_job_id := null;
  new.generation_submission_sequence := null;
  new.input_artifact_source_revision := null;
  new.input_service_library_revision := null;
  new.used_solution_evaluation := false;
  new.input_solution_evaluation_id := null;
  new.input_solution_evaluation_updated_at := null;
  new.input_solution_evaluation_hash := null;
  new.generator_revision := null;
  new.source_snapshot_hash := null;
  new.knowledge_base_manifest := '[]'::jsonb;
  new.knowledge_artifact_manifest := '[]'::jsonb;
  new.updated_at := clock_timestamp();

  if old.artifact_type = 'losningsutkast' and exists (
    select 1
    from public.solution_evaluations evaluation
    where evaluation.project_id = new.project_id
      and evaluation.evaluated_generated_artifact_id = old.id
  ) then
    delete from public.solution_evaluations evaluation
    where evaluation.project_id = new.project_id
      and evaluation.evaluated_generated_artifact_id = old.id;
    delete from public.executive_summaries summary
    where summary.project_id = new.project_id;
    update public.projects project
    set solution_evaluation_generated = false
    where project.id = new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists generated_artifacts_downgrade_legacy_content_update
  on public.generated_artifacts;
create trigger generated_artifacts_downgrade_legacy_content_update
before update of title, content_markdown, input_snapshot
on public.generated_artifacts
for each row execute function public.downgrade_legacy_artifact_content_update();

create or replace function public.guard_legacy_generated_artifact_delete()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.solution_evaluations evaluation
    where evaluation.project_id = old.project_id
      and evaluation.evaluated_generated_artifact_id = old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ARTIFACT_IS_EVALUATED: reevaluate another version before deleting the evaluated system artifact';
  end if;
  if exists (
    select 1
    from public.generated_artifacts child
    where child.project_id = old.project_id
      and child.parent_artifact_id = old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ARTIFACT_HAS_CHILD_VERSION: delete the derived version first to preserve provenance';
  end if;
  return old;
end;
$$;

drop trigger if exists generated_artifacts_guard_legacy_delete
  on public.generated_artifacts;
create trigger generated_artifacts_guard_legacy_delete
before delete on public.generated_artifacts
for each row execute function public.guard_legacy_generated_artifact_delete();

create table if not exists public.stable_primary_document_authority (
  project_id uuid not null references public.projects(id) on delete cascade,
  primary_role text not null check (
    primary_role in ('primary_customer_document', 'primary_solution_document')
  ),
  document_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (project_id, primary_role)
);
alter table public.stable_primary_document_authority enable row level security;
revoke all on table public.stable_primary_document_authority
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.stable_primary_document_authority
  to service_role;

create or replace function public.prepare_legacy_primary_document_insert()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_demoted_subtype text;
  v_previous_atomic_setting text;
begin
  if new.role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    return new;
  end if;
  perform 1
  from public.projects project
  where project.id = new.project_id
  for update;
  if not found then
    raise exception using
      errcode = '23503',
      message = 'insert or update on table "documents" violates foreign key constraint';
  end if;

  v_demoted_subtype := case new.role
    when 'primary_customer_document' then 'rfp'
    else 'tidligere_losning'
  end;
  v_previous_atomic_setting := pg_catalog.current_setting(
    'anbud.atomic_primary_document_write',
    true
  );
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );
  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = new.project_id
    and document.role = new.role;
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    coalesce(v_previous_atomic_setting, ''),
    true
  );

  insert into public.stable_primary_document_authority (
    project_id,
    primary_role,
    document_id,
    created_at
  ) values (
    new.project_id,
    new.role,
    new.id,
    clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;
  return new;
end;
$$;

drop trigger if exists documents_prepare_legacy_primary_insert
  on public.documents;
create trigger documents_prepare_legacy_primary_insert
before insert on public.documents
for each row execute function public.prepare_legacy_primary_document_insert();

create or replace function public.guard_stale_stable_primary_demotion()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if old.role in ('primary_customer_document', 'primary_solution_document')
     and new.role = 'supporting_document'
     and coalesce(
       pg_catalog.current_setting('anbud.atomic_primary_document_write', true),
       ''
     ) <> 'on'
     and exists (
       select 1
       from public.stable_primary_document_authority authority
       where authority.project_id = old.project_id
         and authority.primary_role = old.role
         and authority.document_id = old.id
     ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_guard_stale_stable_primary_demotion
  on public.documents;
create trigger documents_guard_stale_stable_primary_demotion
before update of role on public.documents
for each row execute function public.guard_stale_stable_primary_demotion();

create or replace function public.prepare_legacy_primary_document_promotion()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_demoted_subtype text;
  v_previous_atomic_setting text;
begin
  if old.role <> 'supporting_document'
     or new.role not in (
       'primary_customer_document',
       'primary_solution_document'
     )
     or coalesce(
       pg_catalog.current_setting('anbud.atomic_primary_document_write', true),
       ''
     ) = 'on' then
    return new;
  end if;
  perform 1
  from public.projects project
  where project.id = new.project_id
  for update;
  if not found then raise exception 'Project does not exist'; end if;
  v_demoted_subtype := case new.role
    when 'primary_customer_document' then 'rfp'
    else 'tidligere_losning'
  end;
  v_previous_atomic_setting := pg_catalog.current_setting(
    'anbud.atomic_primary_document_write',
    true
  );
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write', 'on', true
  );
  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = new.project_id
    and document.role = new.role
    and document.id <> old.id;
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    coalesce(v_previous_atomic_setting, ''),
    true
  );
  insert into public.stable_primary_document_authority (
    project_id, primary_role, document_id, created_at
  ) values (
    new.project_id, new.role, new.id, clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;
  return new;
end;
$$;

drop trigger if exists documents_prepare_legacy_primary_promotion
  on public.documents;
create trigger documents_prepare_legacy_primary_promotion
before update of role on public.documents
for each row execute function public.prepare_legacy_primary_document_promotion();

create or replace function public.consume_stable_primary_document_authority()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  delete from public.stable_primary_document_authority authority
  where authority.project_id = new.id
    and not exists (
      select 1
      from public.documents document
      where document.project_id = authority.project_id
        and document.id = authority.document_id
        and document.role = authority.primary_role
    );
  return new;
end;
$$;

drop trigger if exists projects_consume_stable_primary_document_authority
  on public.projects;
create trigger projects_consume_stable_primary_document_authority
after update of last_activity_at, customer_document_uploaded,
  solution_document_uploaded on public.projects
for each row execute function public.consume_stable_primary_document_authority();

create table if not exists public.stable_customer_analysis_context_sync (
  project_id uuid primary key references public.projects(id) on delete cascade,
  analysis_id uuid not null unique
    references public.customer_analyses(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.stable_customer_analysis_context_sync enable row level security;
revoke all on table public.stable_customer_analysis_context_sync
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.stable_customer_analysis_context_sync
  to service_role;

create or replace function public.track_stable_customer_analysis_context_sync()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.stable_customer_analysis_context_sync pending
    where pending.project_id = old.project_id
       or pending.analysis_id = old.id;
    return old;
  end if;
  if new.provenance_verified then
    delete from public.stable_customer_analysis_context_sync pending
    where pending.project_id = new.project_id
       or pending.analysis_id = new.id;
  else
    insert into public.stable_customer_analysis_context_sync (
      project_id,
      analysis_id,
      created_at
    ) values (
      new.project_id,
      new.id,
      clock_timestamp()
    )
    on conflict (project_id) do update
      set analysis_id = excluded.analysis_id,
          created_at = excluded.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists track_stable_customer_analysis_context_sync
  on public.customer_analyses;
create trigger track_stable_customer_analysis_context_sync
after insert or update or delete on public.customer_analyses
for each row execute function public.track_stable_customer_analysis_context_sync();

create or replace function public.bump_artifact_revision_from_project_metadata()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_analysis_inputs_changed boolean;
  v_non_context_inputs_changed boolean;
  v_context_keywords_changed boolean;
  v_persisting_analysis_context boolean;
  v_stable_context_sync boolean := false;
begin
  v_non_context_inputs_changed := jsonb_build_object(
      'name', to_jsonb(old) -> 'name',
      'title', to_jsonb(old) -> 'title',
      'customer_name', to_jsonb(old) -> 'customer_name',
      'client_name', to_jsonb(old) -> 'client_name',
      'description', to_jsonb(old) -> 'description',
      'industry', to_jsonb(old) -> 'industry'
    ) is distinct from jsonb_build_object(
      'name', to_jsonb(new) -> 'name',
      'title', to_jsonb(new) -> 'title',
      'customer_name', to_jsonb(new) -> 'customer_name',
      'client_name', to_jsonb(new) -> 'client_name',
      'description', to_jsonb(new) -> 'description',
      'industry', to_jsonb(new) -> 'industry'
    );
  v_context_keywords_changed :=
    to_jsonb(old) -> 'context_keywords'
      is distinct from to_jsonb(new) -> 'context_keywords';
  v_analysis_inputs_changed :=
    v_non_context_inputs_changed or v_context_keywords_changed;
  v_persisting_analysis_context := coalesce(
    pg_catalog.current_setting('anbud.persisting_customer_analysis_context', true),
    ''
  ) = 'on';

  if not v_non_context_inputs_changed
     and not v_persisting_analysis_context
     and new.customer_analysis_generated
     and new.last_activity_at is distinct from old.last_activity_at then
    delete from public.stable_customer_analysis_context_sync pending
    using public.customer_analyses analysis
    where pending.project_id = new.id
      and pending.analysis_id = analysis.id
      and analysis.project_id = new.id
      and not analysis.provenance_verified
      and pending.created_at >= clock_timestamp() - interval '5 minutes'
    returning true into v_stable_context_sync;
    if v_stable_context_sync and v_context_keywords_changed then
      perform pg_catalog.set_config(
        'anbud.persisting_customer_analysis_context',
        'on',
        true
      );
      v_persisting_analysis_context := true;
    end if;
  end if;

  if v_analysis_inputs_changed then
    new.artifact_source_revision := old.artifact_source_revision + 1;
    if not v_persisting_analysis_context then
      new.source_revision := old.source_revision + 1;
      new.customer_analysis_generated := false;
      new.solution_evaluation_generated := false;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_artifact_source_revision on public.projects;
create trigger projects_artifact_source_revision
before update on public.projects
for each row execute function public.bump_artifact_revision_from_project_metadata();

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

-- Final service-selection definitions also suppress the customer-analysis row
-- trigger until the RPC performs its one explicit invalidation.
create or replace function public.invalidate_customer_analysis_dependents()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  if coalesce(
       pg_catalog.current_setting(
         'anbud.replacing_project_service_selections',
         true
       ),
       ''
     ) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  update public.projects
  set solution_evaluation_generated = false,
      source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1
  where id = v_project_id;
  delete from public.solution_evaluations where project_id = v_project_id;
  delete from public.executive_summaries where project_id = v_project_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create or replace function public.bump_artifact_revision_from_service_selection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  v_project_id := case when tg_op = 'DELETE' then old.project_id else new.project_id end;

  if tg_op = 'UPDATE'
     and old.selected is not distinct from new.selected then
    return new;
  end if;

  if coalesce(
       pg_catalog.current_setting(
         'anbud.replacing_project_service_selections',
         true
       ),
       ''
     ) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Lock the project before invalidating dependent rows so in-flight saves are
  -- fenced through source_revision before their outputs can remain visible.
  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      customer_analysis_generated = false,
      solution_evaluation_generated = false
  where id = v_project_id;

  delete from public.customer_analyses
  where project_id = v_project_id;
  delete from public.solution_evaluations
  where project_id = v_project_id;
  delete from public.executive_summaries
  where project_id = v_project_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create or replace function public.replace_project_service_selections(
  p_project_id uuid,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_requested_ids uuid[];
  v_current_ids uuid[];
  v_current_rows_are_canonical boolean;
  v_matched_service_count integer;
  v_source_revision bigint;
  v_artifact_source_revision bigint;
  v_previous_replacement_setting text;
begin
  if p_service_ids is null or array_position(p_service_ids, null) is not null then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SERVICE_SELECTION_REQUIRED: service ids must be a non-null UUID array';
  end if;

  -- Normalize duplicate client values before comparison, while preserving a
  -- deterministic order for no-op detection and the response.
  select coalesce(
      array_agg(distinct requested.service_id order by requested.service_id),
      '{}'::uuid[]
    )
    into v_requested_ids
  from unnest(p_service_ids) as requested(service_id);

  -- Serialize replacements without taking the project row first. This lets us
  -- lock both requested and currently selected service parents before the
  -- project, matching service DELETE -> FK cascade -> project trigger order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'project-service-selections:' || p_project_id::text,
      0
    )
  );

  -- Lock every requested service before any mutation. A missing or concurrently
  -- deleted id rejects the entire replacement and leaves the old set intact.
  -- Service rows are locked before the project to match the service DELETE ->
  -- FK cascade -> selection trigger -> project lock order and avoid deadlocks.
  perform 1
  from public.service_descriptions service
  where service.id = any(v_requested_ids)
  order by service.id
  for key share;
  get diagnostics v_matched_service_count = row_count;

  if v_matched_service_count is distinct from cardinality(v_requested_ids) then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SERVICE_SELECTION_INVALID: one or more service ids do not exist';
  end if;

  perform 1
  from public.service_descriptions service
  where exists (
    select 1
    from public.project_service_selections selection
    where selection.project_id = p_project_id
      and selection.service_id = service.id
  )
  order by service.id
  for key share;

  -- During a rolling deploy, an older app may still issue direct DELETE/INSERT
  -- statements. Serialize those table writers before taking the project lock;
  -- otherwise an old child-row lock and this project lock can deadlock or mix
  -- a late INSERT into the replacement set.
  lock table public.project_service_selections
    in share row exclusive mode;

  select project.source_revision, project.artifact_source_revision
    into v_source_revision, v_artifact_source_revision
  from public.projects project
  where project.id = p_project_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_NOT_FOUND: cannot replace service selections for a missing project';
  end if;

  select
    coalesce(
      array_agg(selection.service_id order by selection.service_id),
      '{}'::uuid[]
    ),
    coalesce(bool_and(selection.selected), true)
    into v_current_ids, v_current_rows_are_canonical
  from public.project_service_selections selection
  where selection.project_id = p_project_id;

  -- Retried UI saves of the same canonical set must not invalidate good work.
  if v_current_rows_are_canonical and v_current_ids = v_requested_ids then
    return jsonb_build_object(
      'changed', false,
      'selected_service_ids', to_jsonb(v_requested_ids),
      'source_revision', v_source_revision,
      'artifact_source_revision', v_artifact_source_revision
    );
  end if;

  v_previous_replacement_setting := pg_catalog.current_setting(
    'anbud.replacing_project_service_selections',
    true
  );
  perform pg_catalog.set_config(
    'anbud.replacing_project_service_selections',
    'on',
    true
  );

  delete from public.project_service_selections
  where project_id = p_project_id;

  insert into public.project_service_selections (
    project_id,
    service_id,
    selected
  )
  select p_project_id, requested.service_id, true
  from unnest(v_requested_ids) as requested(service_id)
  order by requested.service_id;

  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      customer_analysis_generated = false,
      solution_evaluation_generated = false
  where id = p_project_id;
  delete from public.customer_analyses where project_id = p_project_id;
  delete from public.solution_evaluations where project_id = p_project_id;
  delete from public.executive_summaries where project_id = p_project_id;

  perform pg_catalog.set_config(
    'anbud.replacing_project_service_selections',
    coalesce(v_previous_replacement_setting, ''),
    true
  );

  select project.source_revision, project.artifact_source_revision
    into v_source_revision, v_artifact_source_revision
  from public.projects project
  where project.id = p_project_id;

  return jsonb_build_object(
    'changed', true,
    'selected_service_ids', to_jsonb(v_requested_ids),
    'source_revision', v_source_revision,
    'artifact_source_revision', v_artifact_source_revision
  );
end;
$$;
-- Recreate the feature primary-document RPCs so an already-migrated database
-- also marks their internal demotion/promotion as one atomic write.
create or replace function public.set_primary_project_document(
  p_project_id uuid,
  p_document_id uuid,
  p_primary_role text
)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_demoted_subtype text;
begin
  if p_primary_role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_INVALID: requested role is not a primary document role';
  end if;

  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );

  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  select * into v_document
  from public.documents document
  where document.project_id = p_project_id
    and document.id = p_document_id
  for update;
  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_NOT_FOUND: document does not belong to the project';
  end if;

  insert into public.stable_primary_document_authority (
    project_id,
    primary_role,
    document_id,
    created_at
  ) values (
    p_project_id,
    p_primary_role,
    p_document_id,
    clock_timestamp()
  )
  on conflict (project_id, primary_role) do update
    set document_id = excluded.document_id,
        created_at = excluded.created_at;

  if v_document.role = p_primary_role then
    update public.projects project
    set customer_document_uploaded = exists (
          select 1
          from public.documents document
          where document.project_id = p_project_id
            and document.role = 'primary_customer_document'
        ),
        solution_document_uploaded = exists (
          select 1
          from public.documents document
          where document.project_id = p_project_id
            and document.role = 'primary_solution_document'
        ),
        last_activity_at = now()
    where project.id = p_project_id;
    return v_document;
  end if;

  if v_document.role in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_CONFLICT: a primary document cannot replace the opposite primary role';
  end if;

  v_demoted_subtype := case p_primary_role
    when 'primary_customer_document' then 'rfp'
    else 'tidligere_losning'
  end;

  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = p_project_id
    and document.role = p_primary_role
    and document.id <> p_document_id;

  update public.documents document
  set role = p_primary_role,
      supporting_subtype = null,
      subtype = null,
      updated_at = now()
  where document.project_id = p_project_id
    and document.id = p_document_id
  returning * into v_document;

  update public.projects project
  set customer_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_customer_document'
      ),
      solution_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_solution_document'
      ),
      last_activity_at = now()
  where project.id = p_project_id;

  return v_document;
end;
$$;

create or replace function public.insert_primary_project_document(
  p_project_id uuid,
  p_primary_role text,
  p_payload jsonb
)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_demoted_subtype text;
begin
  if p_primary_role not in (
    'primary_customer_document',
    'primary_solution_document'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_ROLE_INVALID: requested role is not a primary document role';
  end if;
  perform pg_catalog.set_config(
    'anbud.atomic_primary_document_write',
    'on',
    true
  );
  if jsonb_typeof(p_payload) is distinct from 'object'
     or nullif(btrim(p_payload ->> 'id'), '') is null
     or nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'file_name'), '') is null
     or nullif(btrim(p_payload ->> 'file_format'), '') is null
     or nullif(btrim(p_payload ->> 'content_type'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_bucket'), '') is null
     or nullif(btrim(p_payload ->> 'file_storage_path'), '') is null then
    raise exception using
      errcode = 'P0001',
      message = 'PRIMARY_DOCUMENT_PAYLOAD_INVALID: required document fields are missing';
  end if;

  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;

  v_demoted_subtype := case p_primary_role
    when 'primary_customer_document' then 'rfp'
    else 'tidligere_losning'
  end;

  update public.documents document
  set role = 'supporting_document',
      supporting_subtype = v_demoted_subtype,
      subtype = v_demoted_subtype
  where document.project_id = p_project_id
    and document.role = p_primary_role;

  insert into public.documents (
    id,
    project_id,
    role,
    supporting_subtype,
    subtype,
    title,
    display_name,
    file_name,
    file_format,
    content_type,
    file_size_bytes,
    page_count,
    file_storage_bucket,
    file_storage_path,
    file_base64,
    raw_text,
    structure_map,
    processing_status,
    processing_message,
    processing_error,
    parser_used,
    indexed_at
  ) values (
    (p_payload ->> 'id')::uuid,
    p_project_id,
    p_primary_role,
    null,
    null,
    p_payload ->> 'title',
    coalesce(nullif(btrim(p_payload ->> 'display_name'), ''), p_payload ->> 'title'),
    p_payload ->> 'file_name',
    p_payload ->> 'file_format',
    p_payload ->> 'content_type',
    coalesce((p_payload ->> 'file_size_bytes')::integer, 0),
    (p_payload ->> 'page_count')::integer,
    p_payload ->> 'file_storage_bucket',
    p_payload ->> 'file_storage_path',
    coalesce(p_payload ->> 'file_base64', ''),
    coalesce(p_payload ->> 'raw_text', ''),
    coalesce(p_payload -> 'structure_map', '[]'::jsonb),
    coalesce(nullif(p_payload ->> 'processing_status', ''), 'queued'),
    p_payload ->> 'processing_message',
    p_payload ->> 'processing_error',
    p_payload ->> 'parser_used',
    (p_payload ->> 'indexed_at')::timestamptz
  )
  returning * into v_document;

  update public.projects project
  set customer_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_customer_document'
      ),
      solution_document_uploaded = exists (
        select 1
        from public.documents document
        where document.project_id = p_project_id
          and document.role = 'primary_solution_document'
      ),
      last_activity_at = now()
  where project.id = p_project_id;

  return v_document;
end;
$$;


revoke execute on function public.assign_generated_artifact_insert_defaults()
  from public, anon, authenticated;
revoke execute on function public.downgrade_legacy_artifact_content_update()
  from public, anon, authenticated;
revoke execute on function public.guard_legacy_generated_artifact_delete()
  from public, anon, authenticated;
revoke execute on function public.prepare_legacy_primary_document_insert()
  from public, anon, authenticated;
revoke execute on function public.guard_stale_stable_primary_demotion()
  from public, anon, authenticated;
revoke execute on function public.prepare_legacy_primary_document_promotion()
  from public, anon, authenticated;
revoke execute on function public.consume_stable_primary_document_authority()
  from public, anon, authenticated;
revoke execute on function public.track_stable_customer_analysis_context_sync()
  from public, anon, authenticated;
revoke execute on function public.bump_artifact_revision_from_project_metadata()
  from public, anon, authenticated;
revoke execute on function public.enforce_project_job_claim_gate()
  from public, anon, authenticated;
revoke execute on function public.set_project_job_claims_enabled(boolean)
  from public, anon, authenticated;
revoke execute on function public.requeue_project_jobs_for_cutover()
  from public, anon, authenticated;
revoke execute on function public.prepare_stable_main_rollback()
  from public, anon, authenticated;
revoke execute on function public.set_primary_project_document(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.insert_primary_project_document(uuid, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.bump_artifact_revision_from_service_selection()
  from public, anon, authenticated;
revoke execute on function public.replace_project_service_selections(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.invalidate_customer_analysis_dependents()
  from public, anon, authenticated;

grant execute on function public.assign_generated_artifact_insert_defaults()
  to service_role;
grant execute on function public.downgrade_legacy_artifact_content_update()
  to service_role;
grant execute on function public.guard_legacy_generated_artifact_delete()
  to service_role;
grant execute on function public.prepare_legacy_primary_document_insert()
  to service_role;
grant execute on function public.guard_stale_stable_primary_demotion()
  to service_role;
grant execute on function public.prepare_legacy_primary_document_promotion()
  to service_role;
grant execute on function public.consume_stable_primary_document_authority()
  to service_role;
grant execute on function public.track_stable_customer_analysis_context_sync()
  to service_role;
grant execute on function public.bump_artifact_revision_from_project_metadata()
  to service_role;
grant execute on function public.enforce_project_job_claim_gate()
  to service_role;
grant execute on function public.set_project_job_claims_enabled(boolean)
  to service_role;
grant execute on function public.requeue_project_jobs_for_cutover()
  to service_role;
grant execute on function public.prepare_stable_main_rollback()
  to service_role;
grant execute on function public.set_primary_project_document(uuid, uuid, text)
  to service_role;
grant execute on function public.insert_primary_project_document(uuid, text, jsonb)
  to service_role;
grant execute on function public.bump_artifact_revision_from_service_selection()
  to service_role;
grant execute on function public.replace_project_service_selections(uuid, uuid[])
  to service_role;
grant execute on function public.invalidate_customer_analysis_dependents()
  to service_role;

create or replace function public.stable_main_rollback_bridge_preflight()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_function_oid oid;
  v_relation_oid oid;
  v_service_role_oid oid;
begin
  select role_state.oid into v_service_role_oid
  from pg_catalog.pg_roles role_state
  where role_state.rolname = 'service_role';
  if v_service_role_oid is null then
    raise exception 'service_role is missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = pg_catalog.to_regclass('public.generated_artifacts')
      and attribute.attname = 'artifact_version'
      and attribute.atttypid = pg_catalog.to_regtype('pg_catalog.int8')
      and attribute.attnotnull
      and not attribute.attisdropped
      and not exists (
        select 1 from pg_catalog.pg_attrdef default_state
        where default_state.adrelid = attribute.attrelid
          and default_state.adnum = attribute.attnum
      )
  ) then
    raise exception 'generated_artifacts.artifact_version is missing or unexpected';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_attrdef default_state
      on default_state.adrelid = attribute.attrelid
     and default_state.adnum = attribute.attnum
    where attribute.attrelid = pg_catalog.to_regclass('public.generated_artifacts')
      and attribute.attname = 'origin'
      and attribute.atttypid = pg_catalog.to_regtype('pg_catalog.text')
      and attribute.attnotnull
      and not attribute.attisdropped
      and pg_catalog.pg_get_expr(default_state.adbin, default_state.adrelid) =
        '''legacy''::text'
  ) then
    raise exception 'generated_artifacts.origin or its legacy default is missing';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_state.indexrelid
    where index_state.indrelid =
        pg_catalog.to_regclass('public.generated_artifacts')
      and index_relation.relname =
        'generated_artifacts_project_type_version_key'
      and index_state.indisunique
      and index_state.indisvalid
      and index_state.indisready
      and index_state.indpred is null
      and index_state.indexprs is null
      and pg_catalog.pg_get_indexdef(index_state.indexrelid) =
        'CREATE UNIQUE INDEX generated_artifacts_project_type_version_key ON public.generated_artifacts USING btree (project_id, artifact_type, artifact_version)'
  ) then
    raise exception 'generated artifact version uniqueness is missing or invalid';
  end if;
  if (
    select count(*)
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_state.indexrelid
    where index_state.indrelid = pg_catalog.to_regclass('public.documents')
      and index_relation.relname in (
        'documents_one_primary_customer_per_project_idx',
        'documents_one_primary_solution_per_project_idx'
      )
      and index_state.indisunique
      and index_state.indisvalid
      and index_state.indisready
      and index_state.indexprs is null
      and pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid)
        = case index_relation.relname
          when 'documents_one_primary_customer_per_project_idx' then
            '(role = ''primary_customer_document''::text)'
          else '(role = ''primary_solution_document''::text)'
        end
  ) <> 2 then
    raise exception 'primary-document uniqueness indexes are missing or invalid';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = pg_catalog.to_regclass(
        'public.stable_primary_document_authority'
      )
      and relation.relkind = 'r'
      and relation.relrowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = pg_catalog.to_regclass(
        'public.stable_customer_analysis_context_sync'
      )
      and relation.relkind = 'r'
      and relation.relrowsecurity
  ) or not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = pg_catalog.to_regclass(
        'public.project_job_claim_control'
      )
      and relation.relkind = 'r'
      and relation.relrowsecurity
  ) then
    raise exception 'stable rollback bridge state tables or RLS are missing';
  end if;
  if not exists (
    select 1 from public.project_job_claim_control control
    where control.singleton = true
      and control.claims_enabled is not null
  ) then
    raise exception 'project-job claim control singleton is missing';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_attrdef default_state
      on default_state.adrelid = attribute.attrelid
     and default_state.adnum = attribute.attnum
    where attribute.attrelid = pg_catalog.to_regclass(
        'public.project_job_claim_control'
      )
      and attribute.attname = 'claims_enabled'
      and attribute.atttypid = pg_catalog.to_regtype('pg_catalog.bool')
      and attribute.attnotnull
      and not attribute.attisdropped
      and pg_catalog.pg_get_expr(default_state.adbin, default_state.adrelid) =
        'true'
  ) then
    raise exception 'project-job claim control default is missing or unexpected';
  end if;

  foreach v_relation_oid in array array[
    pg_catalog.to_regclass('public.stable_primary_document_authority'),
    pg_catalog.to_regclass('public.stable_customer_analysis_context_sync'),
    pg_catalog.to_regclass('public.project_job_claim_control')
  ] loop
    if v_relation_oid is null or not exists (
      select 1
      from pg_catalog.pg_class relation,
           lateral pg_catalog.aclexplode(relation.relacl) acl
      where relation.oid = v_relation_oid
        and acl.grantee = v_service_role_oid
        and acl.privilege_type = 'SELECT'
    ) or exists (
      select 1
      from pg_catalog.pg_class relation,
           lateral pg_catalog.aclexplode(relation.relacl) acl
      where relation.oid = v_relation_oid
        and acl.grantee not in (relation.relowner, v_service_role_oid)
    ) then
      raise exception 'rollback bridge table ACL is not service-role-only';
    end if;
  end loop;

  if (
    select count(*)
    from pg_catalog.pg_trigger trigger_state
    join (
      values
        ('generated_artifacts_insert_defaults',
         'public.generated_artifacts',
         'public.assign_generated_artifact_insert_defaults()', 7),
        ('generated_artifacts_downgrade_legacy_content_update',
         'public.generated_artifacts',
         'public.downgrade_legacy_artifact_content_update()', 19),
        ('generated_artifacts_guard_legacy_delete',
         'public.generated_artifacts',
         'public.guard_legacy_generated_artifact_delete()', 11),
        ('documents_prepare_legacy_primary_insert',
         'public.documents',
         'public.prepare_legacy_primary_document_insert()', 7),
        ('documents_guard_stale_stable_primary_demotion',
         'public.documents',
         'public.guard_stale_stable_primary_demotion()', 19),
        ('documents_prepare_legacy_primary_promotion',
         'public.documents',
         'public.prepare_legacy_primary_document_promotion()', 19),
        ('projects_consume_stable_primary_document_authority',
         'public.projects',
         'public.consume_stable_primary_document_authority()', 17),
        ('track_stable_customer_analysis_context_sync',
         'public.customer_analyses',
         'public.track_stable_customer_analysis_context_sync()', 29),
        ('projects_artifact_source_revision',
         'public.projects',
         'public.bump_artifact_revision_from_project_metadata()', 19),
        ('project_jobs_enforce_claim_gate',
         'public.project_jobs',
         'public.enforce_project_job_claim_gate()', 23)
    ) expected(trigger_name, relation_name, function_name, trigger_type)
      on expected.trigger_name = trigger_state.tgname
     and trigger_state.tgrelid = pg_catalog.to_regclass(expected.relation_name)
     and trigger_state.tgfoid = pg_catalog.to_regprocedure(expected.function_name)
     and trigger_state.tgtype = expected.trigger_type
    where trigger_state.tgenabled = 'O'
      and not trigger_state.tgisinternal
  ) <> 10 then
    raise exception 'stable rollback bridge trigger definitions are missing or unexpected';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.assign_generated_artifact_insert_defaults()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'for update') > 0
      and pg_catalog.strpos(function_state.prosrc, 'for update') <
        pg_catalog.strpos(function_state.prosrc, 'max(artifact.artifact_version)')
      and pg_catalog.strpos(
        function_state.prosrc,
        'if new.artifact_version is not null'
      ) > 0
  ) then
    raise exception 'generated artifact insert allocator is not project-first';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.downgrade_legacy_artifact_content_update()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'new.origin := ''manual_edit''') > 0
      and pg_catalog.strpos(function_state.prosrc, 'old.artifact_type = ''losningsutkast''') > 0
      and pg_catalog.strpos(function_state.prosrc, 'new.generation_job_id := null') > 0
  ) then
    raise exception 'legacy artifact edit downgrade is missing or over-broad';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.prepare_legacy_primary_document_insert()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'for update') > 0
      and pg_catalog.strpos(function_state.prosrc, '''tidligere_losning''') > 0
      and pg_catalog.strpos(function_state.prosrc, 'stable_primary_document_authority') > 0
  ) then
    raise exception 'legacy primary-document insertion bridge is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.prepare_legacy_primary_document_promotion()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'old.role <> ''supporting_document''') > 0
      and pg_catalog.strpos(function_state.prosrc, '''tidligere_losning''') > 0
      and pg_catalog.strpos(function_state.prosrc, 'stable_primary_document_authority') > 0
  ) then
    raise exception 'legacy primary-document promotion bridge is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.set_primary_project_document(uuid,uuid,text)'
      )
      and pg_catalog.strpos(
        function_state.prosrc,
        'anbud.atomic_primary_document_write'
      ) > 0
      and pg_catalog.strpos(
        function_state.prosrc,
        'stable_primary_document_authority'
      ) > 0
  ) or not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.insert_primary_project_document(uuid,text,jsonb)'
      )
      and pg_catalog.strpos(
        function_state.prosrc,
        'anbud.atomic_primary_document_write'
      ) > 0
  ) then
    raise exception 'atomic primary-document RPC bridge marker is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.bump_artifact_revision_from_project_metadata()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'stable_customer_analysis_context_sync') > 0
      and pg_catalog.strpos(function_state.prosrc, 'not analysis.provenance_verified') > 0
      and pg_catalog.strpos(function_state.prosrc, 'interval ''5 minutes''') > 0
  ) then
    raise exception 'stable customer-analysis context bridge is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.enforce_project_job_claim_gate()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'new.lease_token := null') > 0
      and pg_catalog.strpos(function_state.prosrc, 'for share') > 0
      and pg_catalog.strpos(function_state.prosrc, 'old.status = ''queued''') > 0
  ) then
    raise exception 'project-job claim gate or queued lease normalization is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.set_project_job_claims_enabled(boolean)'
      )
      and pg_catalog.strpos(function_state.prosrc, '''project-job-cutover-v1''') > 0
      and pg_catalog.strpos(function_state.prosrc, 'claims_enabled = p_claims_enabled') > 0
  ) or not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.requeue_project_jobs_for_cutover()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'PROJECT_JOB_CLAIMS_MUST_BE_CLOSED') > 0
      and pg_catalog.strpos(function_state.prosrc, 'where job.status = ''running''') > 0
      and pg_catalog.strpos(function_state.prosrc, '''project-job-cutover-v1''') > 0
  ) then
    raise exception 'project-job cutover RPC contract is missing or unexpected';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.prepare_stable_main_rollback()'
      )
      and pg_catalog.strpos(function_state.prosrc, 'PROJECT_JOB_CLAIMS_MUST_BE_CLOSED') > 0
      and pg_catalog.strpos(function_state.prosrc, 'result_json = null') = 0
      and pg_catalog.strpos(function_state.prosrc, '''project-job-cutover-v1''') > 0
  ) then
    raise exception 'stable rollback preparation is missing or mutates terminal results';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.bump_artifact_revision_from_service_selection()'
      )
      and pg_catalog.strpos(
        function_state.prosrc,
        'anbud.replacing_project_service_selections'
      ) > 0
  ) or not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.replace_project_service_selections(uuid,uuid[])'
      )
      and pg_catalog.strpos(
        function_state.prosrc,
        'anbud.replacing_project_service_selections'
      ) > 0
      and pg_catalog.strpos(function_state.prosrc, 'update public.projects') > 0
  ) then
    raise exception 'single-invalidation service-selection replacement is missing';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc function_state
    where function_state.oid = pg_catalog.to_regprocedure(
        'public.invalidate_customer_analysis_dependents()'
      )
      and pg_catalog.strpos(
        function_state.prosrc,
        'anbud.replacing_project_service_selections'
      ) > 0
  ) then
    raise exception 'customer-analysis invalidation suppression is missing';
  end if;

  foreach v_function_oid in array array[
    pg_catalog.to_regprocedure('public.assign_generated_artifact_insert_defaults()'),
    pg_catalog.to_regprocedure('public.downgrade_legacy_artifact_content_update()'),
    pg_catalog.to_regprocedure('public.guard_legacy_generated_artifact_delete()'),
    pg_catalog.to_regprocedure('public.prepare_legacy_primary_document_insert()'),
    pg_catalog.to_regprocedure('public.guard_stale_stable_primary_demotion()'),
    pg_catalog.to_regprocedure('public.prepare_legacy_primary_document_promotion()'),
    pg_catalog.to_regprocedure('public.consume_stable_primary_document_authority()'),
    pg_catalog.to_regprocedure('public.track_stable_customer_analysis_context_sync()'),
    pg_catalog.to_regprocedure('public.bump_artifact_revision_from_project_metadata()'),
    pg_catalog.to_regprocedure('public.enforce_project_job_claim_gate()'),
    pg_catalog.to_regprocedure('public.set_project_job_claims_enabled(boolean)'),
    pg_catalog.to_regprocedure('public.requeue_project_jobs_for_cutover()'),
    pg_catalog.to_regprocedure('public.prepare_stable_main_rollback()'),
    pg_catalog.to_regprocedure('public.set_primary_project_document(uuid,uuid,text)'),
    pg_catalog.to_regprocedure('public.insert_primary_project_document(uuid,text,jsonb)'),
    pg_catalog.to_regprocedure('public.bump_artifact_revision_from_service_selection()'),
    pg_catalog.to_regprocedure('public.replace_project_service_selections(uuid,uuid[])'),
    pg_catalog.to_regprocedure('public.invalidate_customer_analysis_dependents()'),
    pg_catalog.to_regprocedure('public.stable_main_rollback_bridge_preflight()')
  ] loop
    if v_function_oid is null or not exists (
      select 1
      from pg_catalog.pg_proc function_state
      join pg_catalog.pg_language language_state
        on language_state.oid = function_state.prolang
      where function_state.oid = v_function_oid
        and language_state.lanname = 'plpgsql'
        and not function_state.prosecdef
        and function_state.proconfig @> array['search_path=""']::text[]
        and function_state.provolatile = case
          when v_function_oid = pg_catalog.to_regprocedure(
            'public.stable_main_rollback_bridge_preflight()'
          ) then 's'::"char"
          else 'v'::"char"
        end
    ) then
      raise exception 'rollback bridge function metadata is missing or unexpected';
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_proc function_state,
           lateral pg_catalog.aclexplode(function_state.proacl) acl
      where function_state.oid = v_function_oid
        and acl.grantee = v_service_role_oid
        and acl.privilege_type = 'EXECUTE'
    ) or exists (
      select 1
      from pg_catalog.pg_proc function_state,
           lateral pg_catalog.aclexplode(function_state.proacl) acl
      where function_state.oid = v_function_oid
        and acl.privilege_type = 'EXECUTE'
        and acl.grantee not in (function_state.proowner, v_service_role_oid)
    ) then
      raise exception 'rollback bridge function ACL is not service-role-only';
    end if;
  end loop;

  return 'stable-main-rollback-bridge-v1';
end;
$$;

revoke execute on function public.stable_main_rollback_bridge_preflight()
  from public, anon, authenticated;
grant execute on function public.stable_main_rollback_bridge_preflight()
  to service_role;
