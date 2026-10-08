export const state = { saved: [] as unknown[], reads: 0 };
export const revision = "11111111-1111-4111-8111-111111111111";
export const NextResponse = { json: (value: unknown, options?: ResponseInit) => Response.json(value, options) };
export async function requireProjectPermission() {}
export function authorizationErrorResponse() { return null; }
export async function readStableSolutionEvaluationSourceSnapshot() {
  state.reads += 1;
  return { sourceRevision: 1, customerAnalysis: { revision }, documents: [] };
}
export function splitServiceDescriptionDetails() { return { projectDocuments: [] }; }
export function selectProjectDocuments() { return { customerDocument: { id: "document" }, supportingDocuments: [] }; }
export async function saveCustomerAnalysis(_id: string, _documents: unknown, analysis: unknown) {
  state.saved.push(analysis);
  return analysis;
}
export async function recordDocumentIntelligenceEvent() {}
export async function getProjectSnapshotAfterCommit() { return { id: "project" }; }
