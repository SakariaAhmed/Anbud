import { NextResponse } from "next/server";

import { getProjectDetail } from "@/lib/server/projects-db";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const project = await getProjectDetail(id);
    return NextResponse.json(project);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente prosjektet." },
      { status: 404 },
    );
  }
}
