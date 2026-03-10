import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getBidOrThrow, mapBid } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;

  try {
    const bid = await getBidOrThrow(tenantId, id);
    return NextResponse.json(mapBid(bid));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bid not found";
    const status = message === "Bid not found" ? 404 : 500;
    return NextResponse.json({ detail: message }, { status });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (payload.customer_name !== undefined) {
    const value = String(payload.customer_name ?? "").trim();
    if (!value) {
      return NextResponse.json({ detail: "customer_name cannot be empty" }, { status: 422 });
    }
    updates.customer_name = value;
  }

  if (payload.title !== undefined) {
    updates.title = String(payload.title ?? "").trim() || "Untitled Bid";
  }

  if (payload.estimated_value !== undefined) {
    updates.estimated_value =
      payload.estimated_value === null || payload.estimated_value === "" ? null : Number(payload.estimated_value);
  }

  if (payload.deadline !== undefined && payload.deadline !== null && String(payload.deadline).trim()) {
    updates.deadline = String(payload.deadline);
  }

  if (payload.owner !== undefined) {
    updates.owner = String(payload.owner ?? "").trim() || "Unassigned";
  }

  if (payload.custom_fields !== undefined) {
    updates.custom_fields = (payload.custom_fields as Record<string, string>) ?? {};
  }

  const { data, error } = await supabase
    .from("bids")
    .update(updates)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    const status = error.code === "PGRST116" ? 404 : 500;
    return NextResponse.json({ detail: error.message }, { status });
  }

  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json(mapBid(data as never));
}
