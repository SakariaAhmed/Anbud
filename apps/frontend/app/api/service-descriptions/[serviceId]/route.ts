import { NextResponse } from "next/server";

import {
  deleteServiceDescription,
  getServiceDescription,
  upsertServiceDescription,
} from "@/lib/server/projects-db";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
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
  _: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
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
