import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { getBidOrThrow, mapTask, touchBidActivity } from "@/lib/server/bids-db";
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
    .from("bid_tasks")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapTask(row as never)));
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
  const dueDate = String(payload.due_date ?? "").trim() || null;
  if (!title) {
    return NextResponse.json({ detail: "Task title is required" }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("bid_tasks")
    .insert({
      tenant_id: tenantId,
      bid_id: id,
      title,
      details,
      due_date: dueDate,
      status: "To Do"
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  await touchBidActivity(tenantId, id);
  revalidateTag("bids");
  revalidateTag(`bid:${id}`);
  return NextResponse.json(mapTask(data as never), { status: 201 });
}
