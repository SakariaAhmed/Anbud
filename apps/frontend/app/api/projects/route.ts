import { NextResponse } from "next/server";

import { createProject, listProjects } from "@/lib/server/projects-db";
import type { ProjectCreateInput } from "@/lib/types";

export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json(projects);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente prosjekter." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<ProjectCreateInput>;

    const project = await createProject({
      name: body.name?.trim() || null,
      customer_name: body.customer_name?.trim() || null,
      description: body.description?.trim() || null,
      industry: body.industry?.trim() || null,
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke opprette prosjekt." },
      { status: 500 },
    );
  }
}
