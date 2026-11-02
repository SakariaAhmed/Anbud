import { NextResponse } from "next/server";
import { requireProjectPermission } from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { parseWorkflowRenderMetric } from "@/lib/workflow-render-metric";
import { listProjectDocumentSummaries } from "@/lib/server/repositories/data-store";
import { recordWorkflowPerformance } from "@/lib/server/workflow-performance";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "project.read");
    const metric = parseWorkflowRenderMetric(await request.json().catch(() => null));
    if (!metric) return NextResponse.json({ error: "Ugyldig tidsmåling." }, { status: 400 });
    const document = metric.documentId ? (await listProjectDocumentSummaries(id)).find(document => document.id === metric.documentId) : undefined;
    if (metric.documentId && !document) return NextResponse.json({ error: "Fant ikke dokumentet." }, { status: 404 });
    recordWorkflowPerformance({ ...metric, projectId: id, operation: "browser", documentClass: document?.file_format });
    return new NextResponse(null, { status: 204 });
  } catch (error) { return routeErrorResponse(error, "Kunne ikke registrere tidsmålingen."); }
}
