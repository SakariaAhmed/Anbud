import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { deleteRequirement } from "@/lib/server/bids-db";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; requirementId: string }> }
) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id, requirementId } = await context.params;

  try {
    const detail = await deleteRequirement(tenantId, id, requirementId);

    revalidateTag("bids");
    revalidateTag(`bid:${id}`);

    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunne ikke slette krav.";
    const status = message === "Bid not found" || message === "Requirement not found" ? 404 : 500;
    return NextResponse.json({ detail: message }, { status });
  }
}
