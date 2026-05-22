import { NextResponse } from "next/server";

import { deleteServiceDocument } from "@/lib/server/repositories/services";
import { checkRateLimit } from "@/lib/server/observability";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ serviceId: string; documentId: string }> },
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
