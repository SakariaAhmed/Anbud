import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit, routeErrorResponse } from "@/lib/server/api-responses";
import {
  requireAdmin,
} from "@/lib/server/authorization";
import { deleteServiceDocument } from "@/lib/server/repositories/data-store";

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
    return routeErrorResponse(error, "Kunne ikke slette tjenestedokumentet.");
  }
}
