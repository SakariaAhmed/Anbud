import { NextRequest, NextResponse } from "next/server";

import { mapBid, mapDocument, mapEvent, mapNote } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  const { data: bidRow, error: bidError } = await supabase
    .from("bids")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();

  if (bidError) {
    return NextResponse.json({ detail: bidError.message }, { status: 500 });
  }
  if (!bidRow) {
    return NextResponse.json({ detail: "Bid not found" }, { status: 404 });
  }

  const [documentsResult, eventsResult, notesResult] = await Promise.all([
    supabase
      .from("bid_documents")
      .select("id, file_name, content_type, status, created_at")
      .eq("tenant_id", tenantId)
      .eq("bid_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("bid_events")
      .select("id, timestamp, user_name, type, payload")
      .eq("tenant_id", tenantId)
      .eq("bid_id", id)
      .order("timestamp", { ascending: true }),
    supabase
      .from("bid_notes")
      .select("id, content, user_name, created_at")
      .eq("tenant_id", tenantId)
      .eq("bid_id", id)
      .order("created_at", { ascending: false })
  ]);

  if (documentsResult.error) {
    return NextResponse.json({ detail: documentsResult.error.message }, { status: 500 });
  }
  if (eventsResult.error) {
    return NextResponse.json({ detail: eventsResult.error.message }, { status: 500 });
  }
  if (notesResult.error) {
    return NextResponse.json({ detail: notesResult.error.message }, { status: 500 });
  }

  return NextResponse.json({
    bid: mapBid(bidRow as never),
    documents: (documentsResult.data ?? []).map((row) => mapDocument(row as never)),
    events: (eventsResult.data ?? []).map((row) => mapEvent(row as never)),
    notes: (notesResult.data ?? []).map((row) => mapNote(row as never))
  });
}
