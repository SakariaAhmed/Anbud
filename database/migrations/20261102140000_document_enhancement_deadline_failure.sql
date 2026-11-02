-- A deadline abandons a running enhancement workflow, which may no longer write.
-- Its terminal transition records the failure on the document version that
-- workflow read, in one transaction: a stale lease changes nothing, and a newer
-- source keeps its own state. Only the visible outcome changes, never the
-- status, parser, revision, chunks or register of the usable version.
create or replace function public.fail_document_enhancement_job(
  p_job_id uuid, p_lease_token uuid, p_project_id uuid, p_document_id uuid, p_source_revision bigint,
  p_job_message text, p_job_error text, p_document_message text, p_document_error text, p_terminal_metadata jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_job public.project_jobs%rowtype;
  v_recorded boolean;
begin
  perform 1 from public.projects where id = p_project_id for no key update;
  select * into v_job from public.project_jobs where id = p_job_id and project_id = p_project_id for update;
  if not found or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease_token then
    raise exception using errcode = 'P0001', message = 'PROJECT_JOB_LEASE_LOST: enhancement job lease is no longer authoritative';
  end if;
  if v_job.kind <> 'document_docling_enhancement' then
    raise exception 'Only a document enhancement job can record an enhancement failure';
  end if;
  update public.documents
  set processing_message = p_document_message, processing_error = p_document_error, updated_at = clock_timestamp()
  where id = p_document_id and project_id = p_project_id and chunk_source_revision = p_source_revision
    and processing_status in ('basic_ready', 'enhanced_ready') and parser_used is distinct from 'docling';
  v_recorded := found;
  update public.project_jobs
  set status = 'failed', message = p_job_message, error = p_job_error, result_json = null,
      terminal_metadata = coalesce(p_terminal_metadata, '{}'::jsonb),
      completed_at = clock_timestamp(), locked_at = null, lease_token = null, updated_at = clock_timestamp()
  where id = p_job_id;
  return jsonb_build_object('document_failure_recorded', v_recorded);
end;
$$;
revoke execute on function public.fail_document_enhancement_job(uuid,uuid,uuid,uuid,bigint,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.fail_document_enhancement_job(uuid,uuid,uuid,uuid,bigint,text,text,text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
