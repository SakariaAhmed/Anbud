-- Persist terminal job audit events transactionally without taking a reverse
-- audit_events.project_id FK lock. Immutable terminal_metadata is written by
-- the job runner before status becomes terminal.

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
