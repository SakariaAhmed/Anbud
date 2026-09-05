import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit } from "@/lib/server/api-responses";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { deleteServiceDocument } from "@/lib/server/repositories/data-store";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ serviceId: string; documentId: string }> },
) {
  try {
    await requireAdmin();
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const { serviceId, documentId } = await context.params;
    await deleteServiceDocument(serviceId, documentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke slette tjenestedokumentet.",
        ),
      },
      { status: 500 },
    );
  }
}
