import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getBidAnalysisData, getBidOrThrow } from "@/lib/server/bids-db";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;

  try {
    const bid = await getBidAnalysisData(tenantId, id);
    return NextResponse.json(bid);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sak ikke funnet";
    return NextResponse.json({ detail: message }, { status: message === "Bid not found" ? 404 : 500 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Sak ikke funnet" }, { status: 404 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Ugyldig JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (payload.customer_name !== undefined) {
    const value = String(payload.customer_name ?? "").trim();
    if (!value) {
      return NextResponse.json({ detail: "Kundenavn kan ikke være tomt" }, { status: 422 });
    }
    updates.customer_name = value;
  }

  if (payload.title !== undefined) {
    updates.title = String(payload.title ?? "").trim() || "Ny analyse";
  }

  const { error } = await supabase.from("bids").update(updates).eq("tenant_id", tenantId).eq("id", id);

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json(await getBidAnalysisData(tenantId, id));
}
