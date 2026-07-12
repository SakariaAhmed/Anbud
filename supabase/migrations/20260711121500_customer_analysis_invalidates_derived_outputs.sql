create or replace function public.invalidate_customer_analysis_dependents()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.projects
  set solution_evaluation_generated = false
  where id = new.project_id;
  delete from public.solution_evaluations where project_id = new.project_id;
  delete from public.executive_summaries where project_id = new.project_id;
  return new;
end;
$$;

drop trigger if exists customer_analysis_invalidates_dependents
  on public.customer_analyses;
create trigger customer_analysis_invalidates_dependents
after insert or update on public.customer_analyses
for each row execute function public.invalidate_customer_analysis_dependents();

revoke execute on function public.invalidate_customer_analysis_dependents()
  from public, anon, authenticated;
grant execute on function public.invalidate_customer_analysis_dependents()
  to service_role;
