import { requireProjectPermission } from "@/lib/server/authorization";
import { NextResponse } from "next/server";

import { getProjectJob } from "@/lib/server/project-jobs";
import { routeErrorResponse } from "@/lib/server/api-responses";

export async function GET(_: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    const { id, jobId } = await context.params;
    await requireProjectPermission(id, "job.read");
    const job = await getProjectJob(id, jobId);

    if (!job) {
      return NextResponse.json({ error: "Jobben finnes ikke." }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente jobbstatus.");
  }
}
