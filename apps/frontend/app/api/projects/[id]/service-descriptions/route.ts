import { NextResponse } from "next/server";

import {
  listProjectServiceDescriptions,
  setProjectServiceSelections,
} from "@/lib/server/repositories/services";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

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
        error: productionSafeErrorMessage(error, "Kunne ikke hente prosjektets tjenester."),
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
      selected_service_ids?: unknown;
    };
    if (
      !Array.isArray(body.selected_service_ids) ||
      !body.selected_service_ids.every((value) => typeof value === "string")
    ) {
      return NextResponse.json(
        { error: "Tjenestevalgene må sendes som en liste med ID-er." },
        { status: 400 },
      );
    }
    const selectedServiceIds = Array.from(
      new Set(
        body.selected_service_ids
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    await setProjectServiceSelections(id, selectedServiceIds);
    return NextResponse.json({ selected_service_ids: selectedServiceIds });
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(error, "Kunne ikke lagre prosjektets tjenester."),
      },
      { status: 500 },
    );
  }
}
