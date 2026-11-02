import { NextResponse } from "next/server";

import { contentTypeForUploadFormat } from "@/lib/server/documents";
import { deleteDocument, getDocumentDetail, listProjectDocumentSummaries, markDocumentAsPrimarySolution, updateDocumentProcessingState } from "@/lib/server/repositories/data-store";
import { getProjectSnapshot } from "@/lib/server/repositories/data-store";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import {
  requireProjectPermission,
} from "@/lib/server/authorization";
import { enforceRateLimit, routeErrorResponse } from "@/lib/server/api-responses";
import { documentEnhancementRetryDecision } from "@/lib/document-processing";
import { queueDocumentEnhancementRetryJob } from "@/lib/server/project-jobs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await context.params;
    await requireProjectPermission(id, "document.download");
    return await withTiming(
      "GET /api/projects/[id]/documents/[documentId]",
      { project_id: id, document_id: documentId },
      async () => {
        const document = await getDocumentDetail(id, documentId);
        const sourceRevision = new URL(request.url).searchParams.get("source_revision");
        if (sourceRevision !== null) {
          if (!/^\d+$/u.test(sourceRevision) || !Number.isSafeInteger(Number(sourceRevision))) return NextResponse.json({ error: "Ugyldig kildeversjon." }, { status: 400 });
          if (Number(sourceRevision) !== (document.chunk_source_revision ?? 0)) return NextResponse.json({ error: "Kilden er endret. Oppdater resultatet og kontroller henvisningen på nytt." }, { status: 409 });
        }
        const buffer = Buffer.from(document.file_base64, "base64");
        const encodedFileName = encodeURIComponent(document.file_name);
        const disposition = new URL(request.url).searchParams.get("disposition") === "inline" ? "inline" : "attachment";
        const contentDisposition =
          `${disposition}; filename="download"; filename*=UTF-8''${encodedFileName}`;

        return new NextResponse(buffer, {
          headers: {
            "Content-Type": contentTypeForUploadFormat(document.file_format),
            "Content-Disposition": contentDisposition,
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    );
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente dokumentet.", { status: 404 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  const rateLimit = await checkRateLimit(_, "document-delete", {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange sletteoperasjoner på kort tid." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  try {
    const { id, documentId } = await context.params;
    await requireProjectPermission(id, "document.delete");
    return await withTiming(
      "DELETE /api/projects/[id]/documents/[documentId]",
      { project_id: id, document_id: documentId },
      async () => {
        await deleteDocument(id, documentId);
        await auditEvent({
          action: "document_deleted",
          projectId: id,
          entityType: "document",
          entityId: documentId,
        });
        const project = await getProjectSnapshot(id);
        return NextResponse.json({ ok: true, project });
      },
    );
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke slette dokumentet.");
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await context.params;
    await requireProjectPermission(id, "document.upload");
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      source_revision?: unknown;
    };

    if (body.action === "retry_enhancement") {
      const limited = await enforceRateLimit(request, "document-enhancement-retry", { limit: 12, windowMs: 60_000 }, "For mange forsøk på kort tid. Vent litt og prøv igjen.");
      if (limited) return limited;
      const document = (await listProjectDocumentSummaries(id)).find(item => item.id === documentId);
      if (!document) return NextResponse.json({ error: "Fant ikke dokumentet." }, { status: 404 });
      const decision = documentEnhancementRetryDecision(document, body.source_revision);
      if (decision === "stale") return NextResponse.json({ error: "Dokumentet er endret siden siden ble åpnet. Last siden på nytt og prøv igjen." }, { status: 409 });
      if (decision === "not_eligible") return NextResponse.json({ error: "Dokumentet har ingen mislykket forbedring å prøve på nytt." }, { status: 409 });
      // Cleared before queueing, so a worker that finishes first cannot have its
      // new outcome overwritten. Every reader then sees the retry instead of the old failure.
      const clearFailure = (message: string | null | undefined, error: string | null | undefined) => updateDocumentProcessingState({ projectId: id, documentId, status: document.processing_status, message, error });
      await clearFailure("Dokumentforbedringen er satt i kø. Grunnversjonen kan brukes imens.", null);
      const job = await queueDocumentEnhancementRetryJob({ projectId: id, documentId }).catch(async (error: unknown) => {
        await clearFailure(document.processing_message, document.processing_error);
        throw error;
      });
      await auditEvent({ action: "document_enhancement_retry_requested", projectId: id, entityType: "document", entityId: documentId, metadata: { job_id: job.id, source_revision: document.chunk_source_revision } });
      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.action !== "use_as_architecture_solution") {
      return NextResponse.json({ error: "Ugyldig dokumenthandling." }, { status: 400 });
    }

    return await withTiming(
      "PATCH /api/projects/[id]/documents/[documentId]",
      { project_id: id, document_id: documentId },
      async () => {
        const document = await markDocumentAsPrimarySolution(id, documentId);
        await auditEvent({
          action: "document_marked_primary_solution",
          projectId: id,
          entityType: "document",
          entityId: documentId,
        });
        const project = await getProjectSnapshot(id);

        return NextResponse.json({ document, project });
      },
    );
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke oppdatere dokumentet.");
  }
}
