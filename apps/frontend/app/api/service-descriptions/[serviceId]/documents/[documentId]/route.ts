import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit } from "@/lib/server/api-responses";
import { deleteServiceDocument } from "@/lib/server/repositories/services";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ serviceId: string; documentId: string }> },
) {
  try {
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

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
