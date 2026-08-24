-- The stable application persists an analysis and its derived context keywords
-- in two requests. Record the unverified insert so exactly the immediately
-- following context-only project update can be recognized without trusting a
-- caller-controlled GUC. The marker is consumed atomically by the project
-- BEFORE trigger and expires quickly if the second request never arrives.
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

create or replace function public.bump_artifact_revision_from_project_metadata()
returns trigger
language plpgsql
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

create or replace function public.invalidate_project_metadata_dependents()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_analysis_inputs_changed boolean;
  v_persisting_analysis_context boolean;
begin
  v_analysis_inputs_changed := jsonb_build_object(
      'name', to_jsonb(old) -> 'name',
      'title', to_jsonb(old) -> 'title',
      'customer_name', to_jsonb(old) -> 'customer_name',
      'client_name', to_jsonb(old) -> 'client_name',
      'description', to_jsonb(old) -> 'description',
      'industry', to_jsonb(old) -> 'industry',
      'context_keywords', to_jsonb(old) -> 'context_keywords'
    ) is distinct from jsonb_build_object(
      'name', to_jsonb(new) -> 'name',
      'title', to_jsonb(new) -> 'title',
      'customer_name', to_jsonb(new) -> 'customer_name',
      'client_name', to_jsonb(new) -> 'client_name',
      'description', to_jsonb(new) -> 'description',
      'industry', to_jsonb(new) -> 'industry',
      'context_keywords', to_jsonb(new) -> 'context_keywords'
    );
  v_persisting_analysis_context := coalesce(
    pg_catalog.current_setting('anbud.persisting_customer_analysis_context', true),
    ''
  ) = 'on';

  if v_analysis_inputs_changed and not v_persisting_analysis_context then
    delete from public.customer_analyses where project_id = new.id;
    delete from public.solution_evaluations where project_id = new.id;
    delete from public.executive_summaries where project_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_analysis_input_invalidation on public.projects;
create trigger projects_analysis_input_invalidation
after update on public.projects
for each row execute function public.invalidate_project_metadata_dependents();

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

create or replace function public.reject_project_service_selection_identity_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.project_id is distinct from new.project_id
     or old.service_id is distinct from new.service_id then
    raise exception using
      errcode = 'P0001',
      message = 'PROJECT_SERVICE_SELECTION_IDENTITY_IMMUTABLE: replace the selection set instead of reparenting a row';
  end if;
  return new;
end;
$$;

drop trigger if exists project_service_selections_identity_immutable
  on public.project_service_selections;
create trigger project_service_selections_identity_immutable
before update of project_id, service_id on public.project_service_selections
for each row execute function public.reject_project_service_selection_identity_change();

drop trigger if exists project_service_selections_artifact_source_revision
  on public.project_service_selections;
create trigger project_service_selections_artifact_source_revision
after insert or update or delete on public.project_service_selections
for each row execute function public.bump_artifact_revision_from_service_selection();

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

create or replace function public.bump_service_library_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(old) - 'updated_at')
       is not distinct from (to_jsonb(new) - 'updated_at') then
    return new;
  end if;
  if coalesce(
       pg_catalog.current_setting('anbud.service_library_invalidated', true),
       ''
     ) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  perform pg_catalog.set_config(
    'anbud.service_library_invalidated',
    'on',
    true
  );

  -- Service recommendations use the top candidates from the entire library.
  -- Lock every project in one deterministic order before invalidating them.
  perform 1
  from public.projects project
  order by project.id
  for no key update;

  update public.projects
  set source_revision = source_revision + 1,
      artifact_source_revision = artifact_source_revision + 1,
      customer_analysis_generated = false,
      solution_evaluation_generated = false;
  delete from public.customer_analyses;
  delete from public.solution_evaluations;
  delete from public.executive_summaries;

  -- Keep project -> global source-state order aligned with artifact saves.
  update public.artifact_source_state
  set service_library_revision = service_library_revision + 1,
      updated_at = now()
  where singleton = true;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists service_descriptions_artifact_source_revision
  on public.service_descriptions;
create trigger service_descriptions_artifact_source_revision
after insert or update or delete on public.service_descriptions
for each row execute function public.bump_service_library_revision();
drop trigger if exists service_documents_artifact_source_revision
  on public.service_documents;
create trigger service_documents_artifact_source_revision
after insert or update or delete on public.service_documents
for each row execute function public.bump_service_library_revision();

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

  -- context_keywords are analysis output but also influence future candidate
  -- ranking. Mark this one internal write so it cannot invalidate the analysis
  -- being persisted; external metadata edits remain fully fenced.
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

revoke execute on function public.bump_artifact_revision_from_project_metadata()
  from public, anon, authenticated;
revoke execute on function public.invalidate_project_metadata_dependents()
  from public, anon, authenticated;
revoke execute on function public.bump_artifact_revision_from_service_selection()
  from public, anon, authenticated;
revoke execute on function public.reject_project_service_selection_identity_change()
  from public, anon, authenticated;
revoke execute on function public.bump_service_library_revision()
  from public, anon, authenticated;
revoke execute on function public.replace_project_service_selections(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.bump_artifact_revision_from_project_metadata()
  to service_role;
grant execute on function public.invalidate_project_metadata_dependents()
  to service_role;
grant execute on function public.bump_artifact_revision_from_service_selection()
  to service_role;
grant execute on function public.reject_project_service_selection_identity_change()
  to service_role;
grant execute on function public.bump_service_library_revision()
  to service_role;
grant execute on function public.replace_project_service_selections(uuid, uuid[])
  to service_role;
grant execute on function public.save_customer_analysis_if_source_revision(uuid, jsonb)
  to service_role;
revoke execute on function public.track_stable_customer_analysis_context_sync()
  from public, anon, authenticated;
grant execute on function public.track_stable_customer_analysis_context_sync()
  to service_role;
