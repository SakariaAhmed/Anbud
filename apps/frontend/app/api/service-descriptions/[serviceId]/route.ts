import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit, routeErrorResponse } from "@/lib/server/api-responses";
import {
  requireAdmin,
} from "@/lib/server/authorization";
import { deleteServiceDescription, getServiceDescriptionMetadata, upsertServiceDescription } from "@/lib/server/repositories/data-store";
import { optionalTextField, readJsonObject, RequestBodyError } from "@/lib/server/request-body";

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
    const body = await readJsonObject(request);
    const description = body.description;
    if (description !== undefined && typeof description !== "string") {
      throw new RequestBodyError("Feltet description må være tekst.");
    }
    const service = await upsertServiceDescription({
      serviceId,
      name: optionalTextField(body, "name") || current.name,
      description: description ?? current.description,
    });
    return NextResponse.json({ service });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke oppdatere tjenesten.");
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
    return routeErrorResponse(error, "Kunne ikke slette tjenesten.");
  }
}
