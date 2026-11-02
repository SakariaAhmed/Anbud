import { fetchProjectState, watchProjectJob } from "@/lib/client/project-api";
import type { ProjectDetail, ProjectDocument, ProjectJobRecord } from "@/lib/types";

export class DocumentProcessingFailure extends Error {
  constructor(readonly kind: "server" | "connection", readonly phase: "ingestion" | "enhancement" = "ingestion") {
    super(kind === "server"
      ? phase === "enhancement"
        ? "Dokumentforbedringen feilet. Grunnversjonen er lagret. Åpne dokumentstatus og prøv forbedringen på nytt."
        : "Dokumentbehandlingen feilet. Prøv å behandle dokumentet på nytt."
      : "Mistet kontakt med dokumentbehandlingen. Status oppdateres når forbindelsen er tilbake.");
    this.name = "DocumentProcessingFailure";
  }
}

function documentFromJobResult(result: ProjectJobRecord["result"]): ProjectDocument | null {
  if (!result || typeof result !== "object" || !("document" in result)) return null;
  const document = result.document;
  return document && typeof document === "object" && "id" in document && typeof document.id === "string"
    ? document as ProjectDocument
    : null;
}

/** Tracks both persisted ingestion phases with the same failure and cancellation rules. */
export async function trackDocumentProcessing(input: {
  projectId: string;
  job: ProjectJobRecord;
  signal: AbortSignal;
  onStatus: (job: ProjectJobRecord) => void;
  onEnhancement: () => void;
  onProject: (project: ProjectDetail) => void;
  /** After the first usable version is refreshed, whether or not enhancement follows. */
  onDocumentReady?: (document: ProjectDocument) => void;
  onIngestionFailed?: () => void;
  /** Enhancement failed but the usable basic version remains; the work may continue. */
  onEnhancementFailed?: () => void;
}): Promise<ProjectDocument | null> {
  let serverFailure = false;
  let phase: "ingestion" | "enhancement" = input.job.kind === "document_docling_enhancement" ? "enhancement" : "ingestion";
  const assertActive = () => input.signal.throwIfAborted();
  const refreshProject = async () => {
    const project = await fetchProjectState(input.projectId, input.signal);
    assertActive();
    input.onProject(project);
  };
  const watch = async (jobId: string) => {
    const job = await watchProjectJob({
      projectId: input.projectId,
      jobId,
      signal: input.signal,
      onStatus(status) {
        assertActive();
        serverFailure ||= status.status === "failed";
        input.onStatus(status);
      },
    });
    assertActive();
    if (job.status === "failed") {
      serverFailure = true;
      throw new DocumentProcessingFailure("server", phase);
    }
    return job;
  };

  try {
    assertActive();
    let completed = await watch(input.job.id);
    const ingested = phase === "ingestion" ? documentFromJobResult(completed.result) : null;
    const enhancementId = completed.result && "docling_enhancement_job_id" in completed.result
      ? completed.result.docling_enhancement_job_id : null;
    if (typeof enhancementId === "string") {
      // Publish the persisted basic result before waiting for enhancement.
      try { await refreshProject(); } catch { assertActive(); }
      if (ingested) input.onDocumentReady?.(ingested);
      phase = "enhancement";
      input.onEnhancement();
      completed = await watch(enhancementId);
    }
    const document = documentFromJobResult(completed.result);
    if (!document) return null;
    await refreshProject();
    if (ingested && typeof enhancementId !== "string") input.onDocumentReady?.(ingested);
    if (phase === "enhancement" && document.processing_error) input.onEnhancementFailed?.();
    return document;
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (serverFailure) {
      // Refresh persisted status even when the enhancement failed after ingestion
      // succeeded. A refresh error must not relabel that terminal failure.
      try { await refreshProject(); } catch { /* The activity loop retries reads. */ }
      assertActive();
      if (phase === "ingestion") input.onIngestionFailed?.();
    }
    throw new DocumentProcessingFailure(serverFailure ? "server" : "connection", phase);
  }
}
