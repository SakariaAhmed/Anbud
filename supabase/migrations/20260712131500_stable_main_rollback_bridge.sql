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
