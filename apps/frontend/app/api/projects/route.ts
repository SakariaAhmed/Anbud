import { NextResponse } from "next/server";

import { createProject, listProjects } from "@/lib/server/repositories/data-store";
import {
  requireRequestPrincipal,
} from "@/lib/server/authorization";
import { recordActivity } from "@/lib/server/activity";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import {
  optionalTextField,
  readJsonObject,
  stringListField,
} from "@/lib/server/request-body";
import { routeErrorResponse } from "@/lib/server/api-responses";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export async function GET() {
  try {
    return await withTiming("GET /api/projects", {}, async () => {
      const principal = await requireRequestPrincipal();
      const projects = await listProjects(principal.id, {
        admin: principal.isAdmin,
      });
      return NextResponse.json(projects, { headers: READ_CACHE_HEADERS });
    });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente prosjekter.");
  }
}

export async function POST(request: Request) {
  const rateLimit = await checkRateLimit(request, "projects-create", {
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
      const principal = await requireRequestPrincipal();
      const body = await readJsonObject(request);

      const project = await createProject({
        owner_id: principal.id,
        name: optionalTextField(body, "name"),
        customer_name: optionalTextField(body, "customer_name"),
        description: optionalTextField(body, "description"),
        industry: optionalTextField(body, "industry"),
        selected_service_ids: stringListField(body, "selected_service_ids"),
      });

      await auditEvent({
        action: "project_created",
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
      });
      await recordActivity({
        principal,
        action: "project.create",
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
      });
      return NextResponse.json(project, { status: 201 });
    });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke opprette prosjekt.");
  }
}
