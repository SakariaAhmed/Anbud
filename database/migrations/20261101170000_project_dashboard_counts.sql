begin;

-- The application supplies only the IDs in the authorized project page.
-- Independent aggregates avoid both global row limits and join multiplication.
create or replace function public.get_project_dashboard_counts(p_project_ids uuid[])
returns table (
  project_id uuid,
  document_count bigint,
  supporting_document_count bigint,
  artifact_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_project_ids is null or pg_catalog.cardinality(p_project_ids) > 500
     or pg_catalog.array_position(p_project_ids, null) is not null then
    raise exception 'Invalid project dashboard page' using errcode = '22023';
  end if;
  return query
    select p.id, d.document_count, d.supporting_document_count,
      (select pg_catalog.count(*) from public.generated_artifacts a where a.project_id = p.id)
    from public.projects p
    cross join lateral (
      select pg_catalog.count(*) as document_count,
        pg_catalog.count(*) filter (where doc.role = 'supporting_document') as supporting_document_count
      from public.documents doc where doc.project_id = p.id
    ) d
    where p.id = any(p_project_ids);
end;
$$;

revoke all on function public.get_project_dashboard_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.get_project_dashboard_counts(uuid[]) to service_role;
notify pgrst, 'reload schema';

commit;
