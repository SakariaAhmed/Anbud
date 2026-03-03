import { NextRequest, NextResponse } from "next/server";

import { getBidOrThrow, mapEvent } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    await getBidOrThrow(tenantId, id);
  } catch {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("bid_events")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("timestamp", { ascending: true });

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapEvent(row as never)));
}
