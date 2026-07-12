import { NextResponse } from "next/server";

import { getProjectJob } from "@/lib/server/project-jobs";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function GET(_: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    const { id, jobId } = await context.params;
    const job = await getProjectJob(id, jobId);

    if (!job) {
      return NextResponse.json({ error: "Jobben finnes ikke." }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(
          error,
          "Kunne ikke hente jobbstatus.",
        ),
      },
      { status: 500 },
    );
  }
}
