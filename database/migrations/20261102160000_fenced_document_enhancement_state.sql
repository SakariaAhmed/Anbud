-- Enhancement messages may describe only the still-published basic revision.
create or replace function public.set_document_enhancement_state(
  p_project_id uuid, p_document_id uuid, p_source_revision bigint,
  p_message text, p_error text, p_job_id uuid default null, p_lease_token uuid default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.projects where id=p_project_id for no key update;
  if not found then raise exception 'Project does not exist'; end if;
  if p_job_id is not null or p_lease_token is not null then
    perform 1 from public.project_jobs where id=p_job_id and project_id=p_project_id
      and status='running' and lease_token=p_lease_token for update;
    if not found then raise exception 'PROJECT_JOB_LEASE_LOST'; end if;
  end if;
  update public.documents set processing_message=p_message, processing_error=p_error, updated_at=clock_timestamp()
    where id=p_document_id and project_id=p_project_id and chunk_source_revision=p_source_revision
      and processing_status='basic_ready' and parser_used is distinct from 'docling';
  return found;
end;
$$;
revoke execute on function public.set_document_enhancement_state(uuid,uuid,bigint,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_document_enhancement_state(uuid,uuid,bigint,text,text,uuid,uuid) to service_role;
notify pgrst, 'reload schema';
