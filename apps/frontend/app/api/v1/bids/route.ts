import { NextRequest, NextResponse } from "next/server";

import { actorFromHeaders, tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";
import { logBidEvent, mapBid } from "@/lib/server/bids-db";

export const runtime = "nodejs";

function defaultDeadlineIso(): string {
  const value = new Date();
  value.setDate(value.getDate() + 30);
  return value.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const supabase = createServiceClient();
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : null;

  let query = supabase
    .from("bids")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });
  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapBid(row as never)));
}

export async function POST(request: NextRequest) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const actor = actorFromHeaders(request.headers);
  const supabase = createServiceClient();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON payload" }, { status: 400 });
  }

  const customerName = String(payload.customer_name ?? "").trim();
  if (!customerName) {
    return NextResponse.json({ detail: "customer_name is required" }, { status: 422 });
  }

  const row = {
    tenant_id: tenantId,
    customer_name: customerName,
    title: String(payload.title ?? "").trim() || "Untitled Bid",
    estimated_value:
      payload.estimated_value === null || payload.estimated_value === undefined || payload.estimated_value === ""
        ? null
        : Number(payload.estimated_value),
    deadline: String(payload.deadline ?? "").trim() || defaultDeadlineIso(),
    owner: String(payload.owner ?? "").trim() || "Unassigned",
    custom_fields: (payload.custom_fields as Record<string, string> | undefined) ?? {}
  };

  const { data, error } = await supabase.from("bids").insert(row).select("*").single();
  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  await logBidEvent({
    tenantId,
    bidId: data.id,
    actor,
    type: "bid_created",
    payload: { message: "Bid created" }
  });

  return NextResponse.json(mapBid(data as never), { status: 201 });
}
