-- Suggested upload roles fill a vacant primary document role only.

-- An automatically suggested upload role must never demote a primary document
-- that another upload or user set meanwhile. Under the same project lock the
-- existing insert uses, insert as primary only while the role is vacant;
-- otherwise return null so the caller stores the upload as supporting.
create or replace function public.insert_vacant_primary_project_document(
  p_project_id uuid,
  p_primary_role text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'Project does not exist';
  end if;
  if exists (
    select 1
    from public.documents document
    where document.project_id = p_project_id
      and document.role = p_primary_role
  ) then
    return null;
  end if;
  return to_jsonb(public.insert_primary_project_document(
    p_project_id,
    p_primary_role,
    p_payload
  ));
end;
$$;
revoke all on function public.insert_vacant_primary_project_document(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_vacant_primary_project_document(uuid, text, jsonb) to service_role;
notify pgrst, 'reload schema';
