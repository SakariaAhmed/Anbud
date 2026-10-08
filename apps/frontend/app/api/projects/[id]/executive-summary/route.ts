import { requireProjectPermission, authorizationErrorResponse } from "@/lib/server/authorization";
import { NextResponse } from "next/server";

import {
  getFreshExecutiveSummary,
} from "@/lib/server/repositories/analyses";
import { prepareProjectAiRoute } from "@/lib/server/project-ai-route";
import { queueExecutiveSummaryJob } from "@/lib/server/project-jobs";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "analysis.read");
    const executiveSummary = await getFreshExecutiveSummary(id);
    return NextResponse.json(
      { executive_summary: executiveSummary },
      { headers: READ_CACHE_HEADERS },
    );
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(error, "Kunne ikke hente lederoppsummeringen."),
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const preflight = await prepareProjectAiRoute(
      request,
      context,
      {
        scopePrefix: "executive-summary",
        message: "For mange lederoppsummeringer på kort tid.",
        limit: 10,
        windowMs: 5 * 60_000,
      },
    );
    if (preflight.response) {
      return preflight.response;
    }

    const { id, model } = preflight;
    const job = await queueExecutiveSummaryJob({ projectId: id, model });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const authorizationResponse = authorizationErrorResponse(error);
    if (authorizationResponse) return authorizationResponse;
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(error, "Kunne ikke generere lederoppsummering."),
      },
      { status: 500 },
    );
  }
}
