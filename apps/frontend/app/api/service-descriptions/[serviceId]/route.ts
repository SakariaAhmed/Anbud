import { NextResponse } from "next/server";

import { enforceServiceDescriptionWriteRateLimit } from "@/lib/server/api-responses";
import {
  deleteServiceDescription,
  getServiceDescription,
  upsertServiceDescription,
} from "@/lib/server/repositories/services";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const { serviceId } = await context.params;
    const current = await getServiceDescription(serviceId);
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke oppdatere tjenesten." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
    const limited = await enforceServiceDescriptionWriteRateLimit(request);
    if (limited) {
      return limited;
    }

    const { serviceId } = await context.params;
    await deleteServiceDescription(serviceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke slette tjenesten." },
      { status: 500 },
    );
  }
}
