-- Retry eligibility, job coalescing and visible state share the publication lock.
create or replace function public.enqueue_document_enhancement_retry(
  p_project_id uuid, p_job jsonb, p_source_revision bigint
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_document public.documents%rowtype;
  v_job public.project_jobs%rowtype;
  v_result jsonb;
begin
  perform 1 from public.projects where id = p_project_id for update;
  if not found then raise exception 'Project does not exist'; end if;
  if (p_job->>'project_id')::uuid is distinct from p_project_id
    or p_job->>'kind' is distinct from 'document_docling_enhancement'
    or p_job->>'status' is distinct from 'queued'
    or (p_job->'input_json'->>'projectId')::uuid is distinct from p_project_id
    or p_job->'input_json'->>'kind' is distinct from 'document_docling_enhancement' then
    raise exception 'Invalid enhancement retry job';
  end if;
  select * into v_document from public.documents
    where project_id = p_project_id and id = (p_job->'input_json'->>'documentId')::uuid for update;
  if not found or p_source_revision is null or v_document.chunk_source_revision is distinct from p_source_revision then
    raise exception 'DOCUMENT_ENHANCEMENT_RETRY_STALE';
  end if;
  if v_document.processing_status is distinct from 'basic_ready' or v_document.parser_used = 'docling' then
    raise exception 'DOCUMENT_ENHANCEMENT_RETRY_NOT_ELIGIBLE';
  end if;
  select * into v_job from public.project_jobs
    where project_id = p_project_id and kind = 'document_docling_enhancement'
      and input_json = p_job->'input_json' and status in ('queued','running')
    order by submission_sequence desc limit 1;
  if found then return to_jsonb(v_job); end if;
  if nullif(btrim(v_document.processing_error), '') is null then
    raise exception 'DOCUMENT_ENHANCEMENT_RETRY_NOT_ELIGIBLE';
  end if;
  v_result := public.enqueue_project_job_serialized(p_project_id, p_job);
  update public.documents set processing_error = null,
    processing_message = 'Dokumentforbedringen er satt i kø. Grunnversjonen kan brukes imens.',
    updated_at = clock_timestamp()
    where id = v_document.id and project_id = p_project_id;
  return v_result;
end;
$$;
revoke execute on function public.enqueue_document_enhancement_retry(uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.enqueue_document_enhancement_retry(uuid,jsonb,bigint) to service_role;
notify pgrst, 'reload schema';
