import { NextResponse } from "next/server";

import {
  isProjectPageKey,
  PROJECT_PAGE_LABELS,
} from "@/lib/project-page-activity";
import { recordActivity } from "@/lib/server/activity";
import {
  authorizationErrorResponse,
  requireProjectPermission,
} from "@/lib/server/authorization";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = await requireProjectPermission(id, "project.read");
    const body = (await request.json().catch(() => null)) as {
      page?: unknown;
    } | null;
    if (!body || !isProjectPageKey(body.page)) {
      return NextResponse.json({ error: "Ugyldig side." }, { status: 400 });
    }
    await recordActivity({
      context: authorization,
      action: "page.view",
      projectId: id,
      entityType: "page",
      entityId: body.page,
      metadata: {
        page: body.page,
        pageLabel: PROJECT_PAGE_LABELS[body.page],
      },
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return (
      authorizationErrorResponse(error) ??
      NextResponse.json({ error: "Kunne ikke registrere sidevisning." }, { status: 500 })
    );
  }
}
