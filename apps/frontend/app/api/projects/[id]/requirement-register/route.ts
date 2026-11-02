import { NextResponse } from "next/server";
import { requireProjectPermission } from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { readDocumentRequirementRegister } from "@/lib/server/document-intelligence/repository";
import { getProjectSourceRevision, listProjectDocumentSummaries } from "@/lib/server/repositories/data-store";
import { readStableProjectSourceSnapshot } from "@/lib/server/source-revision-snapshot";
import { isDocumentReadyForEvaluation, isRequirementDocument } from "@/lib/document-processing";
import type { ProjectRequirementRegister } from "@/lib/types";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "document.read");
    const snapshot = await readStableProjectSourceSnapshot({
      readSourceRevision: () => getProjectSourceRevision(id),
      readValue: async () => Promise.all((await listProjectDocumentSummaries(id)).filter(isRequirementDocument).map(async document => {
        const revision = document.chunk_source_revision ?? 0;
        const rows = await readDocumentRequirementRegister({ projectId: id, documentId: document.id, sourceRevision: revision });
        return { id: document.id, title: document.title, source_revision: revision,
          document_ready: isDocumentReadyForEvaluation(document), register_available: rows !== null,
          rows: (rows ?? []).map(row => ({ id: row.id, text: row.text, heading: row.heading, pages: row.pages,
            text_origin: row.textOrigin ?? "unknown", ...(row.textEvidence ? { original_text: row.textEvidence.originalText } : {}),
            id_origin: row.idOrigin ?? "source", ...(row.originalId ? { original_id: row.originalId } : {}) })),
        };
      })),
    });
    const response: ProjectRequirementRegister = { source_revision: snapshot.sourceRevision, documents: snapshot.value };
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeErrorResponse(error, "Kunne ikke hente kravregisteret. Prøv igjen."); }
}
