import { NextResponse } from "next/server";

import {
  deleteDocument,
  getDocumentDetail,
  getProjectSnapshot,
  markDocumentAsPrimarySolution,
} from "@/lib/server/projects-db";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await context.params;
    return await withTiming(
      "GET /api/projects/[id]/documents/[documentId]",
      { project_id: id, document_id: documentId },
      async () => {
        const document = await getDocumentDetail(id, documentId);
        const buffer = Buffer.from(document.file_base64, "base64");
        const requestUrl = new URL(request.url);
        const disposition = requestUrl.searchParams.get("disposition");
        const contentDisposition =
          disposition === "inline"
            ? `inline; filename="${encodeURIComponent(document.file_name)}"`
            : `attachment; filename="${encodeURIComponent(document.file_name)}"`;

        return new NextResponse(buffer, {
          headers: {
            "Content-Type": document.content_type,
            "Content-Disposition": contentDisposition,
          },
        });
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente dokumentet." },
      { status: 404 },
    );
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  const rateLimit = checkRateLimit(_, "document-delete", {
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke slette dokumentet." },
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke oppdatere dokumentet." },
      { status: 500 },
    );
  }
}
