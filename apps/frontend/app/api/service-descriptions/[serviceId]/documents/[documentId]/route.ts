import { NextResponse } from "next/server";

import { deleteServiceDocument } from "@/lib/server/projects-db";

export async function DELETE(
  _: Request,
  context: { params: Promise<{ serviceId: string; documentId: string }> },
) {
  try {
    const { serviceId, documentId } = await context.params;
    await deleteServiceDocument(serviceId, documentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke slette tjenestedokumentet.",
      },
      { status: 500 },
    );
  }
}
