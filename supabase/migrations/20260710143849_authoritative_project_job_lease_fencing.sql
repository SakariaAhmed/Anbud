alter table public.project_jobs
  add column if not exists parent_job_id uuid,
  add column if not exists idempotency_key text;

alter table public.solution_evaluations
  add column if not exists customer_document_id uuid,
  add column if not exists solution_document_id uuid,
  add column if not exists analysis_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_jobs_parent_job_id_fkey'
      and conrelid = 'public.project_jobs'::regclass
  ) then
    alter table public.project_jobs
      add constraint project_jobs_parent_job_id_fkey
      foreign key (parent_job_id) references public.project_jobs(id) on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'project_jobs_parent_idempotency_key_key'
      and conrelid = 'public.project_jobs'::regclass
  ) then
    alter table public.project_jobs
      add constraint project_jobs_parent_idempotency_key_key
      unique (parent_job_id, idempotency_key);
  end if;
end $$;

create index if not exists project_jobs_parent_job_idx
  on public.project_jobs(parent_job_id)
  where parent_job_id is not null;

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
    select coalesce(array_agg(value::uuid), '{}'::uuid[])
      into v_source_document_ids
    from jsonb_array_elements_text(coalesce(p_payload -> 'source_document_ids', '[]'::jsonb));

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
        last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz,
        context_keywords = array(
          select jsonb_array_elements_text(p_payload -> 'context_keywords')
        )
    where id = p_project_id;
    return to_jsonb(v_analysis);
  elsif p_operation = 'solution_evaluation' then
    select coalesce(array_agg(value::uuid), '{}'::uuid[])
      into v_source_document_ids
    from jsonb_array_elements_text(coalesce(p_payload -> 'source_document_ids', '[]'::jsonb));

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

    delete from public.executive_summaries where project_id = p_project_id;
    update public.projects
    set solution_evaluation_generated = true,
        last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
    where id = p_project_id;
    return to_jsonb(v_evaluation);
  elsif p_operation = 'executive_summary' then
    insert into public.executive_summaries (
      project_id,
      result_json,
      input_snapshot,
      updated_at
    ) values (
      p_project_id,
      p_payload -> 'result_json',
      p_payload -> 'input_snapshot',
      now()
    )
    on conflict (project_id) do update
      set result_json = excluded.result_json,
          input_snapshot = excluded.input_snapshot,
          updated_at = now()
    returning * into v_summary;

    update public.projects
    set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
    where id = p_project_id;
    return to_jsonb(v_summary);
  elsif p_operation = 'generated_artifact' then
    insert into public.generated_artifacts (
      project_id,
      artifact_type,
      title,
      content_markdown,
      input_snapshot
    ) values (
      p_project_id,
      p_payload ->> 'artifact_type',
      p_payload ->> 'title',
      p_payload ->> 'content_markdown',
      p_payload -> 'input_snapshot'
    )
    returning * into v_artifact;

    update public.projects
    set last_activity_at = (p_payload ->> 'last_activity_at')::timestamptz
    where id = p_project_id;
    return to_jsonb(v_artifact);
  elsif p_operation = 'replace_document_chunks' then
    delete from public.document_chunks
    where source_type = p_payload ->> 'source_type'
      and source_id = (p_payload ->> 'source_id')::uuid;

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
      to_tsvector('simple', coalesce(chunk.search_text, '')),
      chunk.content_hash,
      chunk.metadata,
      case when chunk.embedding is null then null else chunk.embedding::extensions.vector end,
      chunk.embedding_model,
      chunk.embedding_created_at
    from jsonb_to_recordset(coalesce(p_payload -> 'rows', '[]'::jsonb)) as chunk(
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
    )
    where chunk.source_type = p_payload ->> 'source_type'
      and chunk.source_id = (p_payload ->> 'source_id')::uuid
      and (
        (chunk.source_type = 'project_document' and chunk.project_id = p_project_id)
        or (chunk.source_type = 'service_document' and chunk.project_id is null)
      );

    return jsonb_build_object('count', jsonb_array_length(coalesce(p_payload -> 'rows', '[]'::jsonb)));
  end if;

  raise exception 'Unsupported lease-fenced project write operation: %', p_operation;
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
revoke execute on function public.lease_fenced_enqueue_project_job(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public.project_job_fencing_preflight() from public, anon, authenticated;

grant execute on function public.lease_fenced_project_write(uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.lease_fenced_enqueue_project_job(uuid, uuid, uuid, jsonb, text) to service_role;
grant execute on function public.project_job_fencing_preflight() to service_role;
