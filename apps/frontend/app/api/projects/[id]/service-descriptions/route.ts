import { NextResponse } from "next/server";

import {
  listProjectServiceDescriptions,
  setProjectServiceSelections,
} from "@/lib/server/projects-db";

const PROJECT_SERVICE_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
};

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const services = await listProjectServiceDescriptions(id);
    return NextResponse.json(
      { services },
      { headers: PROJECT_SERVICE_CACHE_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente prosjektets tjenester.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      selected_service_ids?: string[];
    };
    await setProjectServiceSelections(id, body.selected_service_ids ?? []);
    const services = await listProjectServiceDescriptions(id);
    return NextResponse.json({ services });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke lagre prosjektets tjenester.",
      },
      { status: 500 },
    );
  }
}
