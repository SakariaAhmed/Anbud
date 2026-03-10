import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getBidOrThrow, mapDecision, touchBidActivity } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();
  const limitParam = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 50;

  const { data, error } = await supabase
    .from("bid_decisions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("decided_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapDecision(row as never)));
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON payload" }, { status: 400 });
  }

  const title = String(payload.title ?? "").trim();
  const details = String(payload.details ?? "").trim();
  if (!title) {
    return NextResponse.json({ detail: "Decision title is required" }, { status: 422 });
  }

  const decidedAt = String(payload.decided_at ?? "").trim() || new Date().toISOString();

  const { data, error } = await supabase
    .from("bid_decisions")
    .insert({
      tenant_id: tenantId,
      bid_id: id,
      title,
      details,
      decided_at: decidedAt
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  await touchBidActivity(tenantId, id);
  revalidateTag("bids");
  revalidateTag(`bid:${id}`);
  return NextResponse.json(mapDecision(data as never), { status: 201 });
}
