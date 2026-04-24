import { NextResponse } from "next/server";

import { deleteDocument, getDocumentDetail, getProjectSnapshot } from "@/lib/server/projects-db";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await context.params;
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
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente dokumentet." },
      { status: 404 },
    );
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string; documentId: string }> }) {
  try {
    const { id, documentId } = await context.params;
    await deleteDocument(id, documentId);
    const project = await getProjectSnapshot(id);
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke slette dokumentet." },
      { status: 500 },
    );
  }
}
