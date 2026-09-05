import "server-only";
import { createServiceClient } from "@/lib/server/data-api";
import { decryptJson } from "@/lib/server/crypto";
import { listGeneratedArtifactsFresh } from "@/lib/server/repositories/artifacts";
import { getProjectSnapshotAfterCommit } from "@/lib/server/repositories/projects";
import type { GeneratedArtifact, ProjectJobResult } from "@/lib/types";

export async function findWorkflowArtifact(projectId: string, jobId?: string, artifactId?: string): Promise<GeneratedArtifact | null> {
  if (!jobId && !artifactId) return null;
  const artifacts = await listGeneratedArtifactsFresh(projectId, { artifactType: "losningsutkast" });
  return artifacts.find(artifact => artifactId ? artifact.id === artifactId : artifact.generation_job_id === jobId) ?? null;
}

export function pendingEvaluationResult(artifact: GeneratedArtifact, detail: string) {
  return {
    artifact, project: null, completion_status: "evaluation_pending",
    message: "Løsningsutkastet er lagret. Revurdering gjenstår. Du kan fortsette med samme utkast.",
    detail, resume_request: { kind: "perfect_system_solution", resume_artifact_id: artifact.id },
  };
}

export async function recoverCommittedProjectJobResult(projectId: string, jobId: string): Promise<ProjectJobResult | null> {
  const client = createServiceClient();
  const { data: job, error } = await client.from("project_jobs").select("kind,result_checkpoint")
    .eq("project_id", projectId).eq("id", jobId).maybeSingle<{ kind: string; result_checkpoint: { kind: string; id: string; revision?: string; updated_at?: string } | null }>();
  if (error) throw new Error(error.message);
  const checkpoint = job?.result_checkpoint;
  if (!checkpoint) return null;
  if (checkpoint.kind === "artifact_generation") {
    const artifact = (await listGeneratedArtifactsFresh(projectId)).find(item => item.id === checkpoint.id);
    if (!artifact) return null;
    if (job?.kind === "perfect_system_solution") return pendingEvaluationResult(artifact, "Revurderingen ble avbrutt etter at utkastet ble lagret.");
    if (!artifact.source_is_current || !artifact.is_current) return null;
    return { artifact, project: await getProjectSnapshotAfterCommit(projectId) };
  }
  const tables: Record<string, { table: string; field: string }> = {
    customer_analysis: { table: "customer_analyses", field: "analysis" },
    solution_evaluation: { table: "solution_evaluations", field: "evaluation" },
    executive_summary: { table: "executive_summaries", field: "executive_summary" },
  };
  const target = tables[checkpoint.kind];
  if (!target) return null;
  const { data: row, error: readError } = await client.from(target.table).select("*").eq("project_id", projectId).eq("id", checkpoint.id)
    .maybeSingle<{ revision?: string; updated_at: string; result_json: unknown; evaluated_generated_artifact_id?: string | null }>();
  if (readError) throw new Error(readError.message);
  if (!row || (checkpoint.revision ? row.revision !== checkpoint.revision : row.updated_at !== checkpoint.updated_at)) return null;
  const content = decryptJson<Record<string, unknown>>(row.result_json, {});
  const artifact = job?.kind === "perfect_system_solution" && checkpoint.kind === "solution_evaluation"
    ? (await listGeneratedArtifactsFresh(projectId)).find(item => item.id === row.evaluated_generated_artifact_id) : null;
  if (job?.kind === "perfect_system_solution" && checkpoint.kind === "solution_evaluation" && !artifact) return null;
  return { ...(artifact ? { artifact } : checkpoint.kind === "solution_evaluation" ? { artifact: null, used_generated_solution: false } : {}), [target.field]: { ...content, ...(row.revision ? { revision: row.revision } : {}) }, project: await getProjectSnapshotAfterCommit(projectId) };
}
