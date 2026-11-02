import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/server/data-api";
import { encryptJson, decryptJson } from "@/lib/server/crypto";
import { authoritativeLeaseError } from "@/lib/server/repositories/lease-fenced-persistence";
import { assertProjectWorkflowActive, getProjectWorkflowLease } from "@/lib/server/project-workflow-cancellation";
import { AnalysisPartialValidationError, isAnalysisPartialFieldShape, validateAnalysisPartialField } from "@/lib/server/analysis-partial-fields";
import { OutputEvidenceValidationError } from "@/lib/server/output-source-evidence";
import { isRecord } from "@/lib/unknown-values";
import type { CustomerAnalysisPartial, ProjectDocumentDetail, ProjectServiceDescription } from "@/lib/types";

type Runtime = { client?: ReturnType<typeof createServiceClient> };

/** Includes unverified old rows: manual CAS must fence the actual persisted row. */
export async function readCustomerAnalysisRevision(projectId: string, runtime: Runtime = {}): Promise<string | null> {
  const { data, error } = await (runtime.client ?? createServiceClient()).from("customer_analyses")
    .select("revision").eq("project_id", projectId).limit(1);
  if (error) throw new Error(error.message);
  const revision: unknown = data?.[0]?.revision;
  if (revision !== undefined && typeof revision !== "string") throw new Error("Invalid analysis revision.");
  return revision ?? null;
}

/** Owns validation, normalization, encryption and one immutable stream identity. */
export function createCustomerAnalysisPartialPublisher(input: {
  projectId: string;
  sourceRevision: number;
  expectedAnalysisRevision: string | null;
  documents: ProjectDocumentDetail[];
  serviceCandidates: ProjectServiceDescription[];
  automaticRequestId?: string;
  assertActive?: () => void;
}, runtime: Runtime = {}) {
  const lease = getProjectWorkflowLease();
  // Synchronous generation has no durable lease; it still uses final atomic CAS.
  if (!lease) return undefined;
  if (lease.projectId !== input.projectId) throw new Error("Analysis preview project mismatch.");
  const generationId = randomUUID();
  const seen = new Set<string>();
  return async (key: string, value: unknown) => {
    assertProjectWorkflowActive();
    input.assertActive?.();
    // Diagram syntax and label claims need their own validator. Withholding this
    // preview must not abort the remaining fields or final analysis generation.
    if (key === "high_level_architecture_mermaid") return;
    if (seen.has(key)) throw new Error("Duplicate analysis preview field.");
    let fields: CustomerAnalysisPartial["fields"];
    try {
      fields = validateAnalysisPartialField({ key, value, documents: input.documents, serviceCandidates: input.serviceCandidates });
    } catch (error) {
      if (!(error instanceof AnalysisPartialValidationError) && !(error instanceof OutputEvidenceValidationError)) throw error;
      // A rejected preview is not a failed generation. Never include model text,
      // excerpts, unknown field names or raw exception messages in this event.
      console.warn(JSON.stringify({ event: "analysis_preview_withheld", project_id: input.projectId,
        job_id: lease.jobId, code: error instanceof OutputEvidenceValidationError ? error.code : "invalid_preview_field" }));
      seen.add(key);
      return;
    }
    const normalized: unknown = fields[key as keyof typeof fields];
    if (normalized === undefined) throw new Error("Missing analysis preview field.");
    const { error } = await (runtime.client ?? createServiceClient()).rpc("save_customer_analysis_partial", {
      p_project_id: input.projectId,
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_payload: {
        generation_id: generationId,
        expected_source_revision: input.sourceRevision,
        expected_analysis_revision: input.expectedAnalysisRevision,
        source_document_ids: input.documents.map((document) => document.id),
        ...(input.automaticRequestId ? { automatic_request_id: input.automaticRequestId } : {}),
        field: key,
        value: encryptJson(normalized),
        digest: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      },
    });
    if (error) throw authoritativeLeaseError(lease.jobId, error);
    seen.add(key);
    assertProjectWorkflowActive();
    input.assertActive?.();
  };
}

export async function readCustomerAnalysisPartial(projectId: string, runtime: Runtime = {}): Promise<CustomerAnalysisPartial | null> {
  const { data, error } = await (runtime.client ?? createServiceClient()).rpc("read_customer_analysis_partial", { p_project_id: projectId });
  if (error) throw new Error(error.message);
  if (data === null) return null;
  if (!isRecord(data) || data.status !== "incomplete" || typeof data.job_id !== "string" ||
    !Number.isSafeInteger(data.source_revision) || typeof data.updated_at !== "string" ||
    !["running", "failed"].includes(String(data.job_status)) || !isRecord(data.fields)) throw new Error("Invalid analysis preview snapshot.");
  const fields: Record<string, unknown> = {};
  for (const [key, envelope] of Object.entries(data.fields)) {
    if (key === "high_level_architecture_mermaid") continue;
    if (!isRecord(envelope) || envelope.encrypted !== true || typeof envelope.payload !== "string") throw new Error("Unencrypted analysis preview.");
    const value: unknown = decryptJson(envelope, undefined);
    if (value === undefined) throw new Error("Unreadable analysis preview.");
    if (!isAnalysisPartialFieldShape(key, value)) throw new Error("Invalid stored analysis preview field.");
    fields[key] = value;
  }
  return { status: "incomplete", job_id: data.job_id, source_revision: data.source_revision as number,
    job_status: data.job_status as "running" | "failed", updated_at: data.updated_at,
    fields: fields as CustomerAnalysisPartial["fields"] };
}
