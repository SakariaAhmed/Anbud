-- Suggested upload roles fill a vacant primary document role only.
-- Create, revoke and grant together so the function is never callable by
-- the API roles in between.
begin;

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

-- Release preflight: the rollout calls this through PostgREST before
-- promotion, so an unmigrated database or a stale PostgREST schema cache
-- (HTTP 404) stops the release instead of reaching suggested uploads.
create or replace function public.vacant_primary_document_insert_preflight()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.insert_vacant_primary_project_document(uuid,text,jsonb)'
  );
begin
  if v_function is null then
    raise exception 'insert_vacant_primary_project_document is missing';
  end if;
  if not pg_catalog.has_function_privilege('service_role', v_function, 'execute')
     or pg_catalog.has_function_privilege('anon', v_function, 'execute')
     or pg_catalog.has_function_privilege('authenticated', v_function, 'execute') then
    raise exception 'insert_vacant_primary_project_document has unexpected grants';
  end if;
  return 'vacant-primary-document-insert-v1';
end;
$$;
revoke all on function public.vacant_primary_document_insert_preflight() from public, anon, authenticated;
grant execute on function public.vacant_primary_document_insert_preflight() to service_role;
notify pgrst, 'reload schema';
commit;
