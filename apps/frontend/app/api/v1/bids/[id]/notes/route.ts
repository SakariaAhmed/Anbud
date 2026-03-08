import { NextRequest, NextResponse } from "next/server";

import { getBidOrThrow, mapNote, touchBidActivity } from "@/lib/server/bids-db";
import { actorFromHeaders, tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("bid_notes")
    .select("id, content, user_name, created_at")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapNote(row as never)));
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const actor = actorFromHeaders(request.headers);
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

  const content = String(payload.content ?? "").trim();
  if (!content) {
    return NextResponse.json({ detail: "Note content cannot be empty" }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("bid_notes")
    .insert({
      tenant_id: tenantId,
      bid_id: id,
      content,
      user_name: actor
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  await touchBidActivity(tenantId, id);
  return NextResponse.json(mapNote(data as never), { status: 201 });
}
