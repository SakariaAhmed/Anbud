import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { mapRequirement } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

function mapRequirementsError(message: string) {
  if (message.includes("public.bid_requirements")) {
    return NextResponse.json(
      {
        detail:
          "Requirements storage is not enabled in the database yet. Apply the latest Supabase schema so the bid_requirements table exists."
      },
      { status: 503 }
    );
  }

  return null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; requirementId: string }> }
) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id, requirementId } = await context.params;
  const supabase = createServiceClient();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON payload" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (payload.status !== undefined) {
    const status = String(payload.status ?? "").trim();
    if (!["Open", "In Progress", "Covered"].includes(status)) {
      return NextResponse.json({ detail: "status must be Open, In Progress, or Covered" }, { status: 422 });
    }
    updates.status = status;
  }

  if (payload.completion_notes !== undefined) {
    updates.completion_notes = String(payload.completion_notes ?? "").trim();
  }

  const { data, error } = await supabase
    .from("bid_requirements")
    .update(updates)
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .eq("id", requirementId)
    .select("*")
    .single();

  if (error) {
    const mapped = mapRequirementsError(error.message);
    if (mapped) {
      return mapped;
    }
    const status = error.code === "PGRST116" ? 404 : 500;
    return NextResponse.json({ detail: error.message }, { status });
  }

  revalidateTag("bids");
  revalidateTag(`bid:${id}`);

  return NextResponse.json(mapRequirement(data as never));
}
