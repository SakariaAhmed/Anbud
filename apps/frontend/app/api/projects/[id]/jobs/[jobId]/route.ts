import { NextResponse } from "next/server";

import { getProjectJob } from "@/lib/server/project-jobs";

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
      { error: error instanceof Error ? error.message : "Kunne ikke hente jobbstatus." },
      { status: 500 },
    );
  }
}
