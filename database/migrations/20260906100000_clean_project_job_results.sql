-- Operator maintenance uses a POST body, never source-bearing URL filters.
create or replace function public.clean_project_job_result(
  p_job_id uuid,
  p_expected_status text,
  p_expected_updated_at timestamptz,
  p_expected_result jsonb,
  p_result jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows bigint;
begin
  if p_expected_status not in ('completed', 'failed')
    or p_expected_result is null
    or p_result is null
    or p_result ->> 'encrypted' is distinct from 'true'
    or coalesce(p_result ->> 'payload', '') not like 'enc:v1:%'
  then
    raise exception 'Invalid terminal job result cleanup';
  end if;

  update public.project_jobs
  set result_json = p_result
  where id = p_job_id
    and status = p_expected_status
    and status in ('completed', 'failed')
    and updated_at = p_expected_updated_at
    and result_json = p_expected_result;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;
revoke all on function public.clean_project_job_result(uuid, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.clean_project_job_result(uuid, text, timestamptz, jsonb, jsonb) to service_role;
