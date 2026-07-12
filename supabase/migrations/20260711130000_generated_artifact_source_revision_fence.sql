alter table public.projects
  add column if not exists artifact_source_revision bigint not null default 0;

alter table public.solution_evaluations
  add column if not exists evaluated_generated_artifact_id uuid,
  add column if not exists evaluation_provenance_mode text not null default 'legacy_unknown';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'solution_evaluations_provenance_mode_check'
      and conrelid = 'public.solution_evaluations'::regclass
  ) then
    alter table public.solution_evaluations
      add constraint solution_evaluations_provenance_mode_check
      check (evaluation_provenance_mode in ('document_only', 'generated_artifact', 'legacy_unknown'));
  end if;
end $$;

alter table public.customer_analyses
  add column if not exists provenance_verified boolean not null default false;

alter table public.executive_summaries
  add column if not exists input_solution_evaluation_id uuid,
  add column if not exists input_solution_evaluation_updated_at timestamptz,
  add column if not exists input_solution_evaluation_hash text,
  add column if not exists provenance_verified boolean not null default false;

update public.projects project
set customer_analysis_generated = false
where project.customer_analysis_generated
  and not exists (
    select 1 from public.customer_analyses analysis
    where analysis.project_id = project.id
      and analysis.provenance_verified
  );

create table if not exists public.artifact_source_state (
  singleton boolean primary key default true check (singleton),
  service_library_revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.artifact_source_state(singleton)
values (true)
on conflict (singleton) do nothing;
alter table public.artifact_source_state enable row level security;
revoke all on table public.artifact_source_state from public, anon, authenticated;
grant select, insert, update on table public.artifact_source_state to service_role;

alter table public.generated_artifacts
  add column if not exists artifact_version bigint,
  add column if not exists generation_job_id uuid references public.project_jobs(id) on delete set null,
  add column if not exists generation_submission_sequence bigint,
  add column if not exists input_artifact_source_revision bigint,
  add column if not exists input_service_library_revision bigint,
  add column if not exists used_solution_evaluation boolean not null default false,
  add column if not exists input_solution_evaluation_id uuid,
  add column if not exists input_solution_evaluation_updated_at timestamptz,
  add column if not exists input_solution_evaluation_hash text,
  add column if not exists generator_revision text,
  add column if not exists origin text,
  add column if not exists parent_artifact_id uuid references public.generated_artifacts(id) on delete set null,
  add column if not exists source_snapshot_hash text,
  add column if not exists knowledge_base_manifest jsonb not null default '[]'::jsonb,
  add column if not exists knowledge_artifact_manifest jsonb not null default '[]'::jsonb;

with ranked as (
  select id,
         row_number() over (
           partition by project_id, artifact_type
           order by created_at asc, id asc
         )::bigint as artifact_version
  from public.generated_artifacts
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'generated_artifacts_origin_check'
      and conrelid = 'public.generated_artifacts'::regclass
  ) then
    alter table public.generated_artifacts
      add constraint generated_artifacts_origin_check
      check (origin in ('generated', 'manual_edit', 'legacy'));
  end if;
end $$;

create unique index if not exists generated_artifacts_project_type_version_key
  on public.generated_artifacts(project_id, artifact_type, artifact_version);
create unique index if not exists generated_artifacts_generation_job_key
  on public.generated_artifacts(generation_job_id)
  where generation_job_id is not null;
create index if not exists generated_artifacts_current_version_idx
  on public.generated_artifacts(project_id, artifact_type, artifact_version desc);

-- Rolling back the application to the pre-versioning release must not make
-- direct generated_artifacts inserts fail. Older code omits both
-- artifact_version and origin. The column default supplies the legacy origin;
-- this trigger allocates a version while using the same project-first lock
-- order as the feature RPCs.
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

revoke execute on function public.assign_generated_artifact_insert_defaults()
  from public, anon, authenticated;
grant execute on function public.assign_generated_artifact_insert_defaults()
  to service_role;

-- Stable main edits an artifact row in place. Preserve that user-visible edit,
-- but remove generated authority that no longer describes the mutated content
-- and invalidate any evaluation that was bound to the old bytes.
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

revoke execute on function public.downgrade_legacy_artifact_content_update()
  from public, anon, authenticated;
grant execute on function public.downgrade_legacy_artifact_content_update()
  to service_role;

-- Stable main deletes artifact rows directly. Keep evaluated authorities and
-- version parents protected even when the newer serialized delete RPC is not
-- present in the rolled-back application.
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

revoke execute on function public.guard_legacy_generated_artifact_delete()
  from public, anon, authenticated;
grant execute on function public.guard_legacy_generated_artifact_delete()
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'solution_evaluations_generated_artifact_fkey'
      and conrelid = 'public.solution_evaluations'::regclass
  ) then
    alter table public.solution_evaluations
      add constraint solution_evaluations_generated_artifact_fkey
      foreign key (evaluated_generated_artifact_id)
      references public.generated_artifacts(id) on delete restrict;
  end if;
end $$;

create or replace function public.artifact_cross_type_knowledge_is_current(
  p_artifact_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select coalesce(not exists (
    select 1
    from jsonb_array_elements(artifact.knowledge_base_manifest) dependency
    where dependency ->> 'artifact_type' is distinct from artifact.artifact_type
      and not exists (
        select 1 from public.generated_artifacts current_dependency
        where current_dependency.project_id = artifact.project_id
          and current_dependency.artifact_type = dependency ->> 'artifact_type'
          and current_dependency.artifact_version = (
            select max(latest.artifact_version)
            from public.generated_artifacts latest
            where latest.project_id = artifact.project_id
              and latest.artifact_type = current_dependency.artifact_type
          )
          and current_dependency.id::text = dependency ->> 'id'
          and current_dependency.artifact_version::text = dependency ->> 'artifact_version'
          and to_char(current_dependency.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = dependency ->> 'updated_at'
          and encode(digest(current_dependency.content_markdown, 'sha256'), 'hex') = dependency ->> 'content_hash'
      )
  ), false)
  from public.generated_artifacts artifact
  where artifact.id = p_artifact_id;
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
    when tg_op = 'INSERT' then new.role <> 'primary_solution_document'
    when tg_op = 'DELETE' then old.role <> 'primary_solution_document'
    else old.role <> 'primary_solution_document'
      or new.role <> 'primary_solution_document'
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
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

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
  v_invalidates_analysis := new.role <> 'primary_solution_document';
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
begin
  if jsonb_build_object(
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
     ) then
    new.artifact_source_revision := old.artifact_source_revision + 1;
  end if;
  return new;
end;
$$;
drop trigger if exists projects_artifact_source_revision on public.projects;
create trigger projects_artifact_source_revision
before update on public.projects
for each row execute function public.bump_artifact_revision_from_project_metadata();

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
  update public.projects
  set artifact_source_revision = artifact_source_revision + 1
  where id = v_project_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists project_service_selections_artifact_source_revision on public.project_service_selections;
create trigger project_service_selections_artifact_source_revision
after insert or update or delete on public.project_service_selections
for each row execute function public.bump_artifact_revision_from_service_selection();

create or replace function public.bump_service_library_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.artifact_source_state
  set service_library_revision = service_library_revision + 1,
      updated_at = now()
  where singleton = true;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists service_descriptions_artifact_source_revision on public.service_descriptions;
create trigger service_descriptions_artifact_source_revision
after insert or update or delete on public.service_descriptions
for each row execute function public.bump_service_library_revision();
drop trigger if exists service_documents_artifact_source_revision on public.service_documents;
create trigger service_documents_artifact_source_revision
after insert or update or delete on public.service_documents
for each row execute function public.bump_service_library_revision();

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
  where project.id = p_project_id
    and source_state.singleton = true;
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
      artifact.id,
      artifact.artifact_type,
      artifact.artifact_version,
      artifact.input_artifact_source_revision,
      artifact.input_service_library_revision,
      artifact.used_solution_evaluation,
      artifact.input_solution_evaluation_id,
      artifact.input_solution_evaluation_updated_at,
      artifact.input_solution_evaluation_hash
    from public.generated_artifacts artifact
    where artifact.project_id = p_project_id
    order by artifact.artifact_type,
             artifact.artifact_version desc,
             artifact.created_at desc,
             artifact.id desc
  ), authority as (
    select project.artifact_source_revision,
           source_state.service_library_revision,
           public.raw_artifact_solution_evaluation_dependency(project.id) as evaluation_dependency
    from public.projects project
    cross join public.artifact_source_state source_state
    where project.id = p_project_id
      and source_state.singleton = true
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
          and to_char(
            latest.input_solution_evaluation_updated_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) = authority.evaluation_dependency ->> 'updated_at'
          and latest.input_solution_evaluation_hash = authority.evaluation_dependency ->> 'content_hash'
        )
      ), false
  )) order by latest.artifact_type), '[]'::jsonb)
  from latest
  cross join authority;
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
    select distinct on (artifact.artifact_type)
      artifact.*
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

-- Knowledge currentness is deliberately one hop: compare the exact persisted
-- cross-type inputs with today's base candidates. The base candidate function
-- above does not call this function, which prevents A <-> B recursion while
-- still making A stale when a new B candidate appears after A was saved.
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
      select coalesce(
        jsonb_agg(dependency.value order by dependency.ordinality),
        '[]'::jsonb
      )
      from jsonb_array_elements(artifact.knowledge_base_manifest)
        with ordinality as dependency(value, ordinality)
      where dependency.value ->> 'artifact_type'
        is distinct from artifact.artifact_type
    ) = (
      select coalesce(
        jsonb_agg(dependency.value order by dependency.ordinality),
        '[]'::jsonb
      )
      from jsonb_array_elements(
        public.artifact_base_knowledge_manifest(
          artifact.project_id,
          artifact.artifact_type
        )
      ) with ordinality as dependency(value, ordinality)
      where dependency.value ->> 'artifact_type'
        is distinct from artifact.artifact_type
    )
    from public.generated_artifacts artifact
    where artifact.id = p_artifact_id
  ), false);
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

  perform 1 from public.project_jobs
  where id = p_parent_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_parent_lease_token
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: parent project job lease is no longer authoritative';
  end if;
  insert into public.project_jobs (
    id, project_id, kind, status, message, error, input_json, result_json,
    parent_job_id, idempotency_key, created_at, updated_at
  ) values (
    (p_job ->> 'id')::uuid, p_project_id, p_job ->> 'kind', 'queued',
    p_job ->> 'message', null, p_job -> 'input_json', null,
    p_parent_job_id, p_idempotency_key,
    (p_job ->> 'created_at')::timestamptz,
    (p_job ->> 'updated_at')::timestamptz
  ) on conflict (parent_job_id, idempotency_key) do nothing;
  select * into v_job from public.project_jobs
  where parent_job_id = p_parent_job_id and idempotency_key = p_idempotency_key;
  return to_jsonb(v_job);
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
begin
  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_source_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'P0001', message = 'PROJECT_SOURCE_REVISION_REQUIRED: a non-negative integer source revision is required';
  end if;
  v_expected_source_revision := (p_payload ->> 'expected_source_revision')::bigint;
  select source_revision into v_current_source_revision
  from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  if v_current_source_revision is distinct from v_expected_source_revision then
    raise exception using errcode = 'P0001', message = 'PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the analysis was running';
  end if;
  select coalesce(array_agg(source.value::uuid order by source.ordinality), '{}'::uuid[])
  into v_source_document_ids
  from jsonb_array_elements_text(coalesce(p_payload -> 'source_document_ids', '[]'::jsonb))
    with ordinality as source(value, ordinality);
  insert into public.customer_analyses (
    project_id, source_document_ids, result_json, provenance_verified, updated_at
  ) values (
    p_project_id, v_source_document_ids, p_payload -> 'result_json', true, now()
  )
  on conflict (project_id) do update set
    source_document_ids = excluded.source_document_ids,
    result_json = excluded.result_json,
    provenance_verified = true,
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
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;

  select * into v_job from public.project_jobs
  where id = p_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_lease_token
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;
  if v_job.kind not in ('customer_analysis', 'high_level_design') then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist a customer analysis';
  end if;
  if exists (
    select 1 from public.project_jobs newer_job
    where newer_job.project_id = p_project_id
      and newer_job.kind in ('customer_analysis', 'high_level_design')
      and newer_job.submission_sequence > v_job.submission_sequence
  ) then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer customer analysis job is authoritative';
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
  from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;

  select * into v_job from public.project_jobs
  where id = p_job_id and project_id = p_project_id
    and status = 'running' and lease_token = p_lease_token
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: project job lease is no longer authoritative';
  end if;
  if v_job.kind not in ('solution_evaluation', 'perfect_system_solution') then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_KIND_MISMATCH: job cannot persist a solution evaluation';
  end if;
  if jsonb_typeof(p_payload -> 'expected_source_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_source_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'P0001', message = 'PROJECT_SOURCE_REVISION_REQUIRED: a non-negative integer source revision is required';
  end if;
  v_expected_source_revision := (p_payload ->> 'expected_source_revision')::bigint;

  if exists (
    select 1 from public.project_jobs newer_job
    where newer_job.project_id = p_project_id
      and newer_job.kind in ('solution_evaluation', 'perfect_system_solution')
      and newer_job.submission_sequence > v_job.submission_sequence
  ) then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_SUPERSEDED: a newer solution evaluation job is authoritative';
  end if;
  if v_current_source_revision is distinct from v_expected_source_revision then
    raise exception using errcode = 'P0001', message = 'PROJECT_SOURCE_REVISION_CHANGED: project inputs changed while the evaluation was running';
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
        and artifact.generation_job_id = p_job_id
        and artifact.artifact_version = (
          select max(latest.artifact_version)
          from public.generated_artifacts latest
          where latest.project_id = p_project_id
            and latest.artifact_type = 'losningsutkast'
        )
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

  select coalesce(array_agg(source.value::uuid order by source.ordinality), '{}'::uuid[])
  into v_source_document_ids
  from jsonb_array_elements_text(coalesce(p_payload -> 'source_document_ids', '[]'::jsonb))
    with ordinality as source(value, ordinality);

  insert into public.solution_evaluations (
    project_id, source_document_ids, customer_document_id,
    solution_document_id, analysis_id, result_json,
    evaluated_generated_artifact_id, evaluation_provenance_mode, updated_at
  ) values (
    p_project_id, v_source_document_ids,
    (p_payload ->> 'customer_document_id')::uuid,
    (p_payload ->> 'solution_document_id')::uuid,
    (p_payload ->> 'analysis_id')::uuid,
    p_payload -> 'result_json', v_evaluated_artifact_id,
    v_provenance_mode, now()
  )
  on conflict (project_id) do update set
    source_document_ids = excluded.source_document_ids,
    customer_document_id = excluded.customer_document_id,
    solution_document_id = excluded.solution_document_id,
    analysis_id = excluded.analysis_id,
    result_json = excluded.result_json,
    evaluated_generated_artifact_id = excluded.evaluated_generated_artifact_id,
    evaluation_provenance_mode = excluded.evaluation_provenance_mode,
    updated_at = now()
  returning * into v_evaluation;

  delete from public.executive_summaries where project_id = p_project_id;
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

create or replace function public.create_manual_artifact_version(
  p_project_id uuid,
  p_parent_artifact_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_parent public.generated_artifacts%rowtype;
  v_artifact public.generated_artifacts%rowtype;
  v_project_revision bigint;
  v_service_revision bigint;
  v_current_evaluation_dependency jsonb;
  v_next_version bigint;
  v_evaluation_current boolean;
  v_knowledge_manifest jsonb;
  v_knowledge_base_manifest jsonb;
begin
  if jsonb_typeof(p_payload -> 'expected_artifact_source_revision') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'expected_service_library_revision') is distinct from 'number'
     or coalesce(p_payload ->> 'expected_artifact_source_revision', '') !~ '^(0|[1-9][0-9]*)$'
     or coalesce(p_payload ->> 'expected_service_library_revision', '') !~ '^(0|[1-9][0-9]*)$' then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_REQUIRED: non-negative integer expected revisions are required';
  end if;
  if nullif(btrim(p_payload ->> 'generator_revision'), '') is null
     or jsonb_typeof(p_payload -> 'input_snapshot') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PROVENANCE_REQUIRED: generator revision and input snapshot are required';
  end if;
  if nullif(btrim(p_payload ->> 'title'), '') is null
     or nullif(btrim(p_payload ->> 'content_markdown'), '') is null then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_CONTENT_REQUIRED: title and content are required';
  end if;
  select artifact_source_revision into v_project_revision
  from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  select service_library_revision into v_service_revision
  from public.artifact_source_state where singleton = true for update;
  v_current_evaluation_dependency := public.raw_artifact_solution_evaluation_dependency(p_project_id);
  select * into v_parent from public.generated_artifacts
  where id = p_parent_artifact_id and project_id = p_project_id;
  if not found then raise exception 'Parent artifact does not exist'; end if;
  if v_parent.artifact_type = 'losningsutkast' and exists (
    select 1 from public.solution_evaluations evaluation
    where evaluation.project_id = p_project_id
      and evaluation.evaluation_provenance_mode = 'generated_artifact'
      and evaluation.evaluated_generated_artifact_id = v_parent.id
  ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_IS_EVALUATED: reevaluate a new generated version instead of editing the evaluated system artifact';
  end if;
  if v_project_revision is distinct from (p_payload ->> 'expected_artifact_source_revision')::bigint
     or v_service_revision is distinct from (p_payload ->> 'expected_service_library_revision')::bigint then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_SOURCE_REVISION_CHANGED: inputs changed before manual version save';
  end if;
  if v_parent.input_artifact_source_revision is distinct from v_project_revision
     or v_parent.input_service_library_revision is distinct from v_service_revision then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PARENT_STALE: regenerate before editing stale artifact content';
  end if;
  if not public.artifact_cross_type_knowledge_is_current(v_parent.id) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PARENT_STALE: knowledge artifact dependencies changed';
  end if;
  if v_parent.used_solution_evaluation
     and v_current_evaluation_dependency ->> 'evaluated_generated_artifact_id' is distinct from v_parent.id::text
     and (
       v_current_evaluation_dependency ->> 'id' is distinct from v_parent.input_solution_evaluation_id::text
       or v_current_evaluation_dependency ->> 'updated_at' is distinct from to_char(
         v_parent.input_solution_evaluation_updated_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       or v_current_evaluation_dependency ->> 'content_hash' is distinct from v_parent.input_solution_evaluation_hash
     ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PARENT_STALE: solution evaluation context changed';
  end if;
  if v_parent.artifact_version is distinct from (
    select max(current_artifact.artifact_version)
    from public.generated_artifacts current_artifact
    where current_artifact.project_id = p_project_id
      and current_artifact.artifact_type = v_parent.artifact_type
  ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_PARENT_HISTORICAL: only the current artifact version may be edited';
  end if;
  select coalesce(max(artifact_version), 0) + 1 into v_next_version
  from public.generated_artifacts
  where project_id = p_project_id and artifact_type = v_parent.artifact_type;
  select public.artifact_knowledge_manifest(p_project_id, v_parent.artifact_type),
         public.artifact_base_knowledge_manifest(p_project_id, v_parent.artifact_type)
  into v_knowledge_manifest, v_knowledge_base_manifest;
  insert into public.generated_artifacts (
    project_id, artifact_type, artifact_version, title, content_markdown,
    input_snapshot, input_artifact_source_revision,
    input_service_library_revision, used_solution_evaluation,
    input_solution_evaluation_id, input_solution_evaluation_updated_at,
    input_solution_evaluation_hash, generator_revision, origin,
    parent_artifact_id, source_snapshot_hash,
    knowledge_base_manifest, knowledge_artifact_manifest
  ) values (
    p_project_id, v_parent.artifact_type, v_next_version,
    p_payload ->> 'title', p_payload ->> 'content_markdown',
    p_payload -> 'input_snapshot', v_project_revision, v_service_revision,
    v_parent.used_solution_evaluation, v_parent.input_solution_evaluation_id,
    v_parent.input_solution_evaluation_updated_at,
    v_parent.input_solution_evaluation_hash,
    p_payload ->> 'generator_revision', 'manual_edit', p_parent_artifact_id,
    v_parent.source_snapshot_hash, v_knowledge_base_manifest,
    v_knowledge_manifest
  ) returning * into v_artifact;
  v_evaluation_current := public.solution_evaluation_is_current(p_project_id);
  update public.projects
  set last_activity_at = now(),
      solution_evaluation_generated = case
        when v_parent.artifact_type = 'losningsutkast'
          and exists (
            select 1 from public.solution_evaluations evaluation
            where evaluation.project_id = p_project_id
              and evaluation.evaluation_provenance_mode = 'generated_artifact'
          )
        then v_evaluation_current
        else solution_evaluation_generated
      end
  where id = p_project_id;
  if v_parent.artifact_type = 'losningsutkast' and not v_evaluation_current then
    delete from public.executive_summaries where project_id = p_project_id;
  end if;
  return to_jsonb(v_artifact);
end;
$$;

create or replace function public.delete_artifact_version_serialized(
  p_project_id uuid,
  p_artifact_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_artifact public.generated_artifacts%rowtype;
  v_evaluation_current boolean;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  select * into v_artifact from public.generated_artifacts
  where id = p_artifact_id and project_id = p_project_id
  for update;
  if not found then raise exception 'Artifact does not exist'; end if;
  if exists (
    select 1 from public.solution_evaluations evaluation
    where evaluation.project_id = p_project_id
      and evaluation.evaluation_provenance_mode = 'generated_artifact'
      and evaluation.evaluated_generated_artifact_id = p_artifact_id
  ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_IS_EVALUATED: reevaluate another version before deleting the evaluated system artifact';
  end if;
  if exists (
    select 1 from public.generated_artifacts child
    where child.project_id = p_project_id
      and child.parent_artifact_id = p_artifact_id
  ) then
    raise exception using errcode = 'P0001', message = 'ARTIFACT_HAS_CHILD_VERSION: delete the derived version first to preserve provenance';
  end if;
  delete from public.generated_artifacts
  where id = p_artifact_id and project_id = p_project_id;
  v_evaluation_current := public.solution_evaluation_is_current(p_project_id);
  update public.projects
  set last_activity_at = now(),
      solution_evaluation_generated = case
        when v_artifact.artifact_type = 'losningsutkast'
          and exists (
            select 1 from public.solution_evaluations evaluation
            where evaluation.project_id = p_project_id
              and evaluation.evaluation_provenance_mode = 'generated_artifact'
          )
        then v_evaluation_current
        else solution_evaluation_generated
      end
  where id = p_project_id;
  if v_artifact.artifact_type = 'losningsutkast' and not v_evaluation_current then
    delete from public.executive_summaries where project_id = p_project_id;
  end if;
end;
$$;

alter function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb)
  rename to lease_fenced_project_write_legacy_impl;
create function public.lease_fenced_project_write(
  p_job_id uuid, p_lease_token uuid, p_project_id uuid,
  p_operation text, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_operation in ('customer_analysis', 'solution_evaluation', 'generated_artifact', 'executive_summary') then
    raise exception using errcode = 'P0001', message = 'DEDICATED_FENCE_REQUIRED: operation requires its dedicated source-revision fence';
  end if;
  return public.lease_fenced_project_write_legacy_impl(
    p_job_id, p_lease_token, p_project_id, p_operation, p_payload
  );
end;
$$;

revoke execute on function public.get_artifact_source_revisions(uuid) from public, anon, authenticated;
revoke execute on function public.invalidate_document_on_readiness_loss() from public, anon, authenticated;
revoke execute on function public.solution_evaluation_is_current(uuid) from public, anon, authenticated;
revoke execute on function public.get_current_solution_evaluation_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.get_current_executive_summary(uuid) from public, anon, authenticated;
revoke execute on function public.get_solution_evaluation_currentness(uuid[]) from public, anon, authenticated;
revoke execute on function public.get_current_project_derived_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.get_artifact_authority_summary(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_solution_evaluation_dependency(uuid) from public, anon, authenticated;
revoke execute on function public.raw_artifact_solution_evaluation_dependency(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_base_knowledge_candidates(uuid, text) from public, anon, authenticated;
revoke execute on function public.artifact_base_knowledge_manifest(uuid, text) from public, anon, authenticated;
revoke execute on function public.artifact_cross_type_knowledge_is_current(uuid) from public, anon, authenticated;
revoke execute on function public.artifact_knowledge_manifest(uuid, text) from public, anon, authenticated;
revoke execute on function public.enqueue_project_job_serialized(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_generated_artifact(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_save_executive_summary(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.create_manual_artifact_version(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.delete_artifact_version_serialized(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.lease_fenced_project_write_legacy_impl(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

grant execute on function public.get_artifact_source_revisions(uuid) to service_role;
grant execute on function public.invalidate_document_on_readiness_loss() to service_role;
grant execute on function public.solution_evaluation_is_current(uuid) to service_role;
grant execute on function public.get_current_solution_evaluation_snapshot(uuid) to service_role;
grant execute on function public.get_current_executive_summary(uuid) to service_role;
grant execute on function public.get_solution_evaluation_currentness(uuid[]) to service_role;
grant execute on function public.get_current_project_derived_snapshot(uuid) to service_role;
grant execute on function public.get_artifact_authority_summary(uuid) to service_role;
grant execute on function public.artifact_solution_evaluation_dependency(uuid) to service_role;
grant execute on function public.raw_artifact_solution_evaluation_dependency(uuid) to service_role;
grant execute on function public.artifact_base_knowledge_candidates(uuid, text) to service_role;
grant execute on function public.artifact_base_knowledge_manifest(uuid, text) to service_role;
grant execute on function public.artifact_cross_type_knowledge_is_current(uuid) to service_role;
grant execute on function public.artifact_knowledge_manifest(uuid, text) to service_role;
grant execute on function public.enqueue_project_job_serialized(uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_generated_artifact(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.lease_fenced_save_executive_summary(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.create_manual_artifact_version(uuid, uuid, jsonb) to service_role;
grant execute on function public.delete_artifact_version_serialized(uuid, uuid) to service_role;
grant execute on function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb) to service_role;
