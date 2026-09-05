-- Project-level removal is allowed to remove the complete provenance tree.
-- Individual artifact deletion retains its existing dependency guards.
create or replace function public.delete_project_artifact_tree()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  removed integer;
begin
  delete from public.solution_evaluations where project_id = old.id;
  loop
    delete from public.generated_artifacts artifact
    where artifact.project_id = old.id
      and not exists (
        select 1 from public.generated_artifacts child
        where child.parent_artifact_id = artifact.id
      );
    get diagnostics removed = row_count;
    exit when removed = 0;
  end loop;
  if exists (select 1 from public.generated_artifacts where project_id = old.id) then
    raise exception 'ARTIFACT_PROVENANCE_CYCLE: cannot delete project';
  end if;
  return old;
end;
$$;
revoke all on function public.delete_project_artifact_tree() from public, anon, authenticated;
grant execute on function public.delete_project_artifact_tree() to service_role;
drop trigger if exists projects_delete_artifact_tree on public.projects;
create trigger projects_delete_artifact_tree
before delete on public.projects
for each row execute function public.delete_project_artifact_tree();
