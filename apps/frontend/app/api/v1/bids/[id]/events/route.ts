import { NextRequest, NextResponse } from "next/server";

import { mapEvent } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("bid_events")
    .select("id, timestamp, user_name, type, payload")
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .order("timestamp", { ascending: true });

  if (error) {
    return NextResponse.json({ detail: error.message }, { status: 500 });
  }

  return NextResponse.json((data ?? []).map((row) => mapEvent(row as never)));
}
