import { NextResponse } from "next/server";

import {
  deleteServiceDescription,
  getServiceDescription,
  upsertServiceDescription,
} from "@/lib/server/projects-db";
import type { ServiceInclusionMode } from "@/lib/types";

function isInclusionMode(value: unknown): value is ServiceInclusionMode {
  return value === "fixed" || value === "selected";
}

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
      inclusion_mode?: ServiceInclusionMode;
    };
    const service = await upsertServiceDescription({
      serviceId,
      name: body.name?.trim() || current.name,
      description: body.description ?? current.description,
      inclusionMode: isInclusionMode(body.inclusion_mode)
        ? body.inclusion_mode
        : current.inclusion_mode,
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
