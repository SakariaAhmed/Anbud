import { NextResponse } from "next/server";

import { contentTypeForUploadFormat } from "@/lib/server/documents";
import {
  deleteDocument,
  getDocumentDetail,
  markDocumentAsPrimarySolution,
} from "@/lib/server/repositories/documents";
import { getProjectSnapshot } from "@/lib/server/repositories/projects";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import {
  authorizationErrorResponse,
  requireProjectPermission,
} from "@/lib/server/authorization";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function GET(
  _request: Request,
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
        const buffer = Buffer.from(document.file_base64, "base64");
        const encodedFileName = encodeURIComponent(document.file_name);
        const contentDisposition =
          `attachment; filename="download"; filename*=UTF-8''${encodedFileName}`;

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
    return authorizationErrorResponse(error) ?? NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke hente dokumentet.") },
      { status: 404 },
    );
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
    return authorizationErrorResponse(error) ?? NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke slette dokumentet.") },
      { status: 500 },
    );
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
    };

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
    return authorizationErrorResponse(error) ?? NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke oppdatere dokumentet.") },
      { status: 500 },
    );
  }
}
