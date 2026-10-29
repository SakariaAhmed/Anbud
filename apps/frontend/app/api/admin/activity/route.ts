import { NextResponse } from "next/server";

import { listActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireAdmin,
} from "@/lib/server/authorization";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const search = new URL(request.url).searchParams;
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? Number.NaN : Number(rawLimit);
    const activity = await listActivity({
      projectId: search.get("projectId"),
      principalId: search.get("principalId"),
      action: search.get("action"),
      from: search.get("from"),
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return NextResponse.json(activity, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke hente aktivitet." }, { status: 500 })
    );
  }
}
