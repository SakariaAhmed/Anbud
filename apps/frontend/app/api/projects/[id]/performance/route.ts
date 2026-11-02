import { NextResponse } from "next/server";
import { requireProjectPermission } from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { parseWorkflowRenderMetric, workflowCorpusClass } from "@/lib/workflow-render-metric";
import { listProjectDocumentSummaries } from "@/lib/server/repositories/data-store";
import { recordWorkflowPerformance } from "@/lib/server/workflow-performance";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "project.read");
    const metric = parseWorkflowRenderMetric(await request.json().catch(() => null));
    if (!metric) return NextResponse.json({ error: "Ugyldig tidsmåling." }, { status: 400 });
    const documents = await listProjectDocumentSummaries(id);
    const document = metric.documentId ? documents.find(document => document.id === metric.documentId) : undefined;
    if (metric.documentId && !document) return NextResponse.json({ error: "Fant ikke dokumentet." }, { status: 404 });
    // An older view must not attribute its timing to a revision it did not render.
    if (document && metric.sourceRevision !== undefined && metric.sourceRevision !== document.chunk_source_revision) {
      return NextResponse.json({ error: "Tidsmålingen gjelder en utdatert dokumentversjon." }, { status: 409 });
    }
    recordWorkflowPerformance({ ...metric, projectId: id, operation: "browser", documentClass: document?.file_format ?? workflowCorpusClass(documents.map(item => item.file_format)) });
    return new NextResponse(null, { status: 204 });
  } catch (error) { return routeErrorResponse(error, "Kunne ikke registrere tidsmålingen."); }
}
