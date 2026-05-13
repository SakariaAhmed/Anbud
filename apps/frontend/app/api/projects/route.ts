import { NextResponse } from "next/server";

import { createProject, listProjects } from "@/lib/server/projects-db";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import type { ProjectCreateInput } from "@/lib/types";

export async function GET() {
  try {
    return await withTiming("GET /api/projects", {}, async () => {
      const projects = await listProjects();
      return NextResponse.json(projects);
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente prosjekter." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, "projects-create", {
    limit: 12,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange prosjekter opprettet på kort tid." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  try {
    return await withTiming("POST /api/projects", {}, async () => {
      const body = (await request.json()) as Partial<ProjectCreateInput>;

      const project = await createProject({
        name: body.name?.trim() || null,
        customer_name: body.customer_name?.trim() || null,
        description: body.description?.trim() || null,
        industry: body.industry?.trim() || null,
        selected_service_ids: Array.isArray(body.selected_service_ids)
          ? body.selected_service_ids
          : [],
      });

      await auditEvent({
        action: "project_created",
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
      });
      return NextResponse.json(project, { status: 201 });
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke opprette prosjekt." },
      { status: 500 },
    );
  }
}
