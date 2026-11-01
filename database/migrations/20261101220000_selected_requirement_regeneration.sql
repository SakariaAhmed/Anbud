-- Keep selected answer regeneration fenced against manual/newer versions.
begin;
set local lock_timeout = '5s';
create or replace function public.lease_fenced_save_generated_artifact(
  p_job_id uuid, p_lease_token uuid, p_project_id uuid, p_payload jsonb
)
returns jsonb language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_job public.project_jobs%rowtype;
  v_artifact public.generated_artifacts%rowtype;
  v_parent public.generated_artifacts%rowtype;
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
  -- A selected-row run may never replace a manual edit or a newer answer.
  -- Both this publication and manual versions hold the project row lock.
  if v_job.input_json ? 'regenerateRequirements' and v_job.input_json -> 'regenerateRequirements' <> 'null'::jsonb then
    if v_artifact_type <> 'forbedret_kravsvar'
       or jsonb_typeof(v_job.input_json -> 'regenerateRequirements') is distinct from 'object' then
      raise exception using errcode = 'P0001', message = 'REQUIREMENT_REGENERATION_INVALID: selected rows require a requirement response';
    end if;
    select * into v_parent from public.generated_artifacts
    where project_id = p_project_id and artifact_type = v_artifact_type
    order by artifact_version desc limit 1;
    if not found
       or v_parent.id::text is distinct from (v_job.input_json -> 'regenerateRequirements' ->> 'artifactId')
       or v_parent.artifact_version::text is distinct from (v_job.input_json -> 'regenerateRequirements' ->> 'artifactVersion') then
      raise exception using errcode = 'P0001', message = 'REQUIREMENT_REGENERATION_PARENT_CHANGED: requirement response changed while selected answers were generated';
    end if;
  end if;
  select coalesce(max(artifact_version), 0) + 1 into v_next_version
  from public.generated_artifacts where project_id = p_project_id and artifact_type = v_artifact_type;
  insert into public.generated_artifacts (
    project_id, artifact_type, artifact_version, title, content_markdown, input_snapshot,
    generation_job_id, generation_submission_sequence, input_artifact_source_revision,
    input_service_library_revision, used_solution_evaluation, input_solution_evaluation_id,
    input_solution_evaluation_updated_at, input_solution_evaluation_hash,
    generator_revision, origin, parent_artifact_id, source_snapshot_hash,
    knowledge_base_manifest, knowledge_artifact_manifest
  ) values (
    p_project_id, v_artifact_type, v_next_version, p_payload ->> 'title', p_payload ->> 'content_markdown',
    p_payload -> 'input_snapshot', p_job_id, v_job.submission_sequence, v_expected_artifact_revision,
    v_expected_service_revision, coalesce((p_payload ->> 'used_solution_evaluation')::boolean, false),
    (p_payload -> 'solution_evaluation_dependency' ->> 'id')::uuid,
    (p_payload -> 'solution_evaluation_dependency' ->> 'updated_at')::timestamptz,
    p_payload -> 'solution_evaluation_dependency' ->> 'content_hash',
    p_payload ->> 'generator_revision', 'generated', v_parent.id, p_payload ->> 'source_snapshot_hash',
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

revoke execute on function public.lease_fenced_save_generated_artifact(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.lease_fenced_save_generated_artifact(uuid,uuid,uuid,jsonb) to service_role;
commit;
