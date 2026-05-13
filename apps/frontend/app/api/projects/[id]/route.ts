import { NextResponse } from "next/server";

import { deleteProject, getProjectDetail } from "@/lib/server/projects-db";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return await withTiming(
      "GET /api/projects/[id]",
      { project_id: id },
      async () => {
        const project = await getProjectDetail(id);
        return NextResponse.json(project);
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente prosjektet." },
      { status: 404 },
    );
  }
}

export async function DELETE(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimit = checkRateLimit(_, "projects-delete", {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange sletteoperasjoner på kort tid." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  try {
    const { id } = await context.params;
    return await withTiming(
      "DELETE /api/projects/[id]",
      { project_id: id },
      async () => {
        await deleteProject(id);
        await auditEvent({
          action: "project_deleted",
          projectId: id,
          entityType: "project",
          entityId: id,
        });
        return new NextResponse(null, { status: 204 });
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Kunne ikke slette prosjektet.",
      },
      { status: 500 },
    );
  }
}
