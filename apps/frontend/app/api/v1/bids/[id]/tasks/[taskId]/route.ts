import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { mapTask } from "@/lib/server/bids-db";
import { tenantIdFromHeaders } from "@/lib/server/headers";
import { createServiceClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string; taskId: string }> }) {
  const tenantId = tenantIdFromHeaders(request.headers);
  const { id, taskId } = await context.params;
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

  if (payload.title !== undefined) {
    const title = String(payload.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ detail: "Task title cannot be empty" }, { status: 422 });
    }
    updates.title = title;
  }

  if (payload.details !== undefined) {
    updates.details = String(payload.details ?? "").trim();
  }

  if (payload.due_date !== undefined) {
    updates.due_date = String(payload.due_date ?? "").trim() || null;
  }

  if (payload.status !== undefined) {
    const status = String(payload.status ?? "").trim();
    if (!["To Do", "In Progress", "Done"].includes(status)) {
      return NextResponse.json({ detail: "status must be To Do, In Progress, or Done" }, { status: 422 });
    }
    updates.status = status;
  }

  const { data, error } = await supabase
    .from("bid_tasks")
    .update(updates)
    .eq("tenant_id", tenantId)
    .eq("bid_id", id)
    .eq("id", taskId)
    .select("*")
    .single();

  if (error) {
    const status = error.code === "PGRST116" ? 404 : 500;
    return NextResponse.json({ detail: error.message }, { status });
  }

  revalidateTag("bids");
  revalidateTag(`bid:${id}`);
  return NextResponse.json(mapTask(data as never));
}
