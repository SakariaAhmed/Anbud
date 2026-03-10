import { NextRequest, NextResponse } from "next/server";

import { getBidOrThrow, mapBid, mapDecision, mapDocument, mapEvent, mapNote, mapRequirement, mapTask } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

function isMissingTableError(message: string) {
  return message.includes("Could not find the table");
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id } = await context.params;
  const supabase = createServiceClient();

  try {
    const bid = await getBidOrThrow(tenantId, id);

    const [documentsResult, eventsResult, notesResult, requirementsResult, decisionsResult, tasksResult] = await Promise.all([
      supabase
        .from("bid_documents")
        .select("id, file_name, content_type, status, created_at, raw_text")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("bid_events")
        .select("id, timestamp, user_name, type, payload")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("timestamp", { ascending: false })
        .limit(50),
      supabase
        .from("bid_notes")
        .select("id, content, user_name, created_at")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("bid_requirements")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("updated_at", { ascending: false })
        .limit(100),
      supabase
        .from("bid_decisions")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("decided_at", { ascending: false })
        .limit(50),
      supabase
        .from("bid_tasks")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("bid_id", id)
        .order("updated_at", { ascending: false })
        .limit(50)
    ]);

    const requiredResults = [documentsResult, eventsResult, notesResult];
    const failingResult = requiredResults.find((result) => result.error);
    if (failingResult?.error) {
      return NextResponse.json({ detail: failingResult.error.message }, { status: 500 });
    }

    const requirementsError = requirementsResult.error;
    if (requirementsError && !isMissingTableError(requirementsError.message)) {
      return NextResponse.json({ detail: requirementsError.message }, { status: 500 });
    }

    const decisionsError = decisionsResult.error;
    if (decisionsError && !isMissingTableError(decisionsError.message)) {
      return NextResponse.json({ detail: decisionsError.message }, { status: 500 });
    }

    const tasksError = tasksResult.error;
    if (tasksError && !isMissingTableError(tasksError.message)) {
      return NextResponse.json({ detail: tasksError.message }, { status: 500 });
    }

    return NextResponse.json({
      bid: mapBid(bid),
      documents: (documentsResult.data ?? []).map((row) => mapDocument(row as never)),
      events: (eventsResult.data ?? []).slice().reverse().map((row) => mapEvent(row as never)),
      notes: (notesResult.data ?? []).map((row) => mapNote(row as never)),
      requirements: requirementsError ? [] : (requirementsResult.data ?? []).map((row) => mapRequirement(row as never)),
      decisions: decisionsError ? [] : (decisionsResult.data ?? []).map((row) => mapDecision(row as never)),
      tasks: tasksError ? [] : (tasksResult.data ?? []).map((row) => mapTask(row as never))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bid not found";
    const status = message === "Bid not found" ? 404 : 500;
    return NextResponse.json({ detail: message }, { status });
  }
}
