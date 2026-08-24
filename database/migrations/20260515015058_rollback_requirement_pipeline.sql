delete from project_jobs where kind = 'requirement_pipeline';

drop table if exists requirement_answers cascade;
drop table if exists requirements cascade;
drop table if exists requirement_candidates cascade;
drop table if exists document_blocks cascade;

alter table project_jobs drop constraint if exists project_jobs_kind_check;
alter table project_jobs
  add constraint project_jobs_kind_check check (
    kind in (
      'customer_analysis',
      'solution_evaluation',
      'artifact_generation',
      'high_level_design',
      'perfect_system_solution',
      'executive_summary'
    )
  );;
