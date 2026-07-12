let activeClient: unknown = null;
let removedStoredFiles: unknown[] = [];
let projectMutationCalls: Array<{
  projectId: string;
  operation: string;
  payload: unknown;
}> = [];
let solutionEvaluationMutationFenced = false;
let solutionEvaluationMutationCalls: Array<{
  projectId: string;
  payload: Record<string, unknown>;
}> = [];

export function setSupabaseStorePersistenceTestClient(client: unknown) {
  activeClient = client;
  removedStoredFiles = [];
  projectMutationCalls = [];
  solutionEvaluationMutationFenced = false;
  solutionEvaluationMutationCalls = [];
}

export function getRemovedStoredFilesForPersistenceTest() {
  return structuredClone(removedStoredFiles);
}

export function getProjectMutationCallsForPersistenceTest() {
  return structuredClone(projectMutationCalls);
}

export function setSolutionEvaluationMutationFencedForPersistenceTest(
  fenced: boolean,
) {
  solutionEvaluationMutationFenced = fenced;
}

export function getSolutionEvaluationMutationCallsForPersistenceTest() {
  return structuredClone(solutionEvaluationMutationCalls);
}

export function createServiceClient() {
  if (!activeClient) {
    throw new Error("Supabase persistence test client is not configured.");
  }
  return activeClient;
}

export function unstable_cache<T>(callback: () => T) {
  return callback;
}

export function revalidatePath() {}

export function revalidateTag() {}

export function buildStoredFilePath(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId: string;
  fileName: string;
}) {
  return `${input.scope}/${input.ownerId}/${input.fileId}/${input.fileName}`;
}

export function buildStoredFilePrefix(input: {
  scope: "projects" | "services";
  ownerId: string;
  fileId?: string | null;
}) {
  return [input.scope, input.ownerId, input.fileId].filter(Boolean).join("/");
}

export async function uploadEncryptedBase64File(input: { path: string }) {
  return { bucket: "test-documents", path: input.path };
}

export async function downloadEncryptedBase64File() {
  return "";
}

export async function removeStoredFiles(files: unknown[]) {
  removedStoredFiles.push(...structuredClone(files));
}

export async function removeStoredFilePrefixes() {}

export async function deleteDocumentChunks() {}

export async function replaceProjectDocumentChunks() {}

export async function replaceServiceDocumentChunks() {}

export async function runLeaseFencedProjectMutation(
  projectId: string,
  operation: string,
  payload: unknown,
) {
  projectMutationCalls.push({ projectId, operation, payload });
  return { fenced: false as const, data: null };
}

export async function runLeaseFencedCustomerAnalysisMutation() {
  return { fenced: false as const, data: null };
}

export async function runLeaseFencedSolutionEvaluationMutation(
  projectId: string,
  payload: Record<string, unknown>,
) {
  solutionEvaluationMutationCalls.push({
    projectId,
    payload: structuredClone(payload),
  });
  if (!solutionEvaluationMutationFenced) {
    return { fenced: false as const, data: null };
  }
  return {
    fenced: true as const,
    data: {
      id: "evaluation-fenced-test",
      project_id: projectId,
      source_document_ids: structuredClone(payload.source_document_ids ?? []),
      customer_document_id: payload.customer_document_id ?? null,
      solution_document_id: payload.solution_document_id ?? null,
      analysis_id: payload.analysis_id ?? null,
      evaluated_generated_artifact_id:
        payload.evaluated_generated_artifact_id ?? null,
      evaluation_provenance_mode: "document_only",
      result_json: structuredClone(payload.result_json),
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
    },
  };
}

export async function runLeaseFencedGeneratedArtifactMutation() {
  return { fenced: false as const, data: null };
}

export function rethrowAuthoritativeLeaseLoss() {}

export function assertProjectWorkflowActive() {}
