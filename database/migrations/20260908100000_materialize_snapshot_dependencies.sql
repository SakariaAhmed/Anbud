-- Evaluate snapshot dependencies once per statement. No cross-request cache.
-- Keep STABLE/invoker semantics and existing source/knowledge-currentness checks.
begin;


create or replace function public.get_current_project_derived_snapshot(p_project_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with current_dependency as materialized (
    select public.artifact_solution_evaluation_dependency(p_project_id) as dependency
  )
  select case when current_dependency.dependency is null then null else jsonb_build_object(
    'evaluation_row', (select to_jsonb(evaluation) from public.solution_evaluations evaluation
      where evaluation.id = (current_dependency.dependency ->> 'id')::uuid),
    'dependency', current_dependency.dependency,
    'executive_summary_row', (select to_jsonb(summary) from public.executive_summaries summary
      where summary.project_id = p_project_id and summary.provenance_verified
        and summary.input_solution_evaluation_id::text = current_dependency.dependency ->> 'id'
        and to_char(summary.input_solution_evaluation_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = current_dependency.dependency ->> 'updated_at'
        and summary.input_solution_evaluation_hash = current_dependency.dependency ->> 'content_hash'
      order by summary.updated_at desc, summary.id desc limit 1)
  ) end from current_dependency;
$$;

revoke execute on function public.get_current_project_derived_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.get_current_project_derived_snapshot(uuid) to service_role;

create or replace function public.get_artifact_authority_summary(p_project_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with latest as (
    select distinct on (artifact.artifact_type)
      artifact.id, artifact.artifact_type, artifact.artifact_version,
      artifact.input_artifact_source_revision, artifact.input_service_library_revision,
      artifact.used_solution_evaluation, artifact.input_solution_evaluation_id,
      artifact.input_solution_evaluation_updated_at, artifact.input_solution_evaluation_hash
    from public.generated_artifacts artifact where artifact.project_id = p_project_id
    order by artifact.artifact_type, artifact.artifact_version desc,
             artifact.created_at desc, artifact.id desc
  ), authority as materialized (
    select project.artifact_source_revision, source_state.service_library_revision,
           case when exists (select 1 from latest where used_solution_evaluation)
             then public.raw_artifact_solution_evaluation_dependency(project.id)
             else null end as evaluation_dependency
    from public.projects project cross join public.artifact_source_state source_state
    where project.id = p_project_id and source_state.singleton = true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', latest.id, 'artifact_type', latest.artifact_type,
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

revoke execute on function public.get_artifact_authority_summary(uuid) from public, anon, authenticated;
grant execute on function public.get_artifact_authority_summary(uuid) to service_role;

create or replace function public.artifact_base_knowledge_candidates(p_project_id uuid, p_artifact_type text)
returns table (
  candidate_id uuid, candidate_artifact_type text,
  candidate_artifact_version bigint, candidate_updated_at timestamptz,
  candidate_content_markdown text, candidate_created_at timestamptz
)
language sql stable security invoker set search_path = '' as $$
  with latest as (
    select distinct on (artifact.artifact_type) artifact.*
    from public.generated_artifacts artifact
    where artifact.project_id = p_project_id
    order by artifact.artifact_type, artifact.artifact_version desc,
             artifact.created_at desc, artifact.id desc
  ), authority as materialized (
    select project.artifact_source_revision,
           source_state.service_library_revision,
           case when exists (
             select 1 from latest where used_solution_evaluation and artifact_type <> p_artifact_type
           ) then public.raw_artifact_solution_evaluation_dependency(project.id)
             else null end as evaluation_dependency
    from public.projects project cross join public.artifact_source_state source_state
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

revoke execute on function public.artifact_base_knowledge_candidates(uuid, text) from public, anon, authenticated;
grant execute on function public.artifact_base_knowledge_candidates(uuid, text) to service_role;

commit;
