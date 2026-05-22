import { NextResponse } from "next/server";

import {
  deleteServiceDescription,
  getServiceDescription,
  upsertServiceDescription,
} from "@/lib/server/repositories/services";
import { checkRateLimit } from "@/lib/server/observability";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ serviceId: string }> },
) {
  try {
    const rateLimit = await checkRateLimit(request, "service-descriptions-write", {
      limit: 16,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange tjenesteendringer på kort tid." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
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
    const rateLimit = await checkRateLimit(request, "service-descriptions-write", {
      limit: 16,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange tjenesteendringer på kort tid." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
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
