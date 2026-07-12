import { NextResponse } from "next/server";

import {
  getFreshExecutiveSummary,
} from "@/lib/server/repositories/analyses";
import { prepareProjectAiRoute } from "@/lib/server/project-ai-route";
import { queueExecutiveSummaryJob } from "@/lib/server/project-jobs";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const executiveSummary = await getFreshExecutiveSummary(id);
    return NextResponse.json(
      { executive_summary: executiveSummary },
      { headers: READ_CACHE_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente lederoppsummeringen.",
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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke generere lederoppsummering.",
      },
      { status: 500 },
    );
  }
}
