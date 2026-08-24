create index if not exists generated_artifacts_parent_artifact_id_idx
  on public.generated_artifacts(parent_artifact_id);

create index if not exists solution_evaluations_evaluated_generated_artifact_id_idx
  on public.solution_evaluations(evaluated_generated_artifact_id);
