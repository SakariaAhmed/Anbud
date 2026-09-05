import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit } from "@/lib/server/api-responses";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";
import { deleteServiceDescription, getServiceDescriptionMetadata, upsertServiceDescription } from "@/lib/server/repositories/data-store";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
    await requireAdmin();
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const { serviceId } = await context.params;
    const current = await getServiceDescriptionMetadata(serviceId);
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
    };
    const service = await upsertServiceDescription({
      serviceId,
      name: body.name?.trim() || current.name,
      description: body.description ?? current.description,
    });
    return NextResponse.json({ service });
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    return NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke oppdatere tjenesten.") },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
    await requireAdmin();
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const { serviceId } = await context.params;
    await deleteServiceDescription(serviceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    return NextResponse.json(
      { error: productionSafeErrorMessage(error, "Kunne ikke slette tjenesten.") },
      { status: 500 },
    );
  }
}
