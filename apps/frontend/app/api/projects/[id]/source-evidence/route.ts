import { NextResponse } from "next/server";
import { requireProjectPermission } from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { getDocumentDetail, getProjectSourceRevision, listProjectDocumentSummaries } from "@/lib/server/repositories/data-store";
import { readStableProjectSourceSnapshot } from "@/lib/server/source-revision-snapshot";
import { bindDocumentSourceEvidence } from "@/lib/server/document-source-evidence";
import { sourceQuoteLength } from "@/lib/server/source-evidence";
import { isRecord } from "@/lib/unknown-values";

// Read-only POST keeps source text out of URLs/access logs. This permission
// deliberately allows restricted viewers to inspect excerpts, never download.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await requireProjectPermission(id, "document.read");
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.documentId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(body.documentId) || typeof body.quote !== "string" || !body.quote.trim() || body.quote.length > 8000 || (body.sourceRevision !== undefined && (!Number.isSafeInteger(body.sourceRevision) || Number(body.sourceRevision) < 0))) return NextResponse.json({ error: "Kildehenvisningen mangler et gyldig originalutdrag." }, { status: 400 });
    const documentId = body.documentId, quote = body.quote;
    if (sourceQuoteLength(quote) < 12 && !access.permissions.includes("document.download")) return NextResponse.json({ error: "Utdraget er for kort til å kontrollere med din tilgang. Åpne en lagret henvisning med et fullstendig originalutdrag." }, { status: 422 });
    const snapshot = await readStableProjectSourceSnapshot({ readSourceRevision: () => getProjectSourceRevision(id), readValue: async () =>
      (await listProjectDocumentSummaries(id)).some(document => document.id === documentId)
        ? getDocumentDetail(id, documentId, { includeFileBase64: false }) : null });
    if (!snapshot.value) return NextResponse.json({ error: "Fant ikke kildehenvisningen i prosjektet." }, { status: 404 });
    if (body.sourceRevision !== undefined && body.sourceRevision !== snapshot.value.chunk_source_revision) return NextResponse.json({ error: "Kilden er endret etter at henvisningen ble lagret. Kontroller den gjeldende originalen." }, { status: 409 });
    const source = bindDocumentSourceEvidence(snapshot.value, quote);
    if (!source) return NextResponse.json({ error: "Utdraget finnes ikke ordrett i den gjeldende kilden. Kontroller originaldokumentet." }, { status: 422 });
    return NextResponse.json({ source }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return routeErrorResponse(error, "Kunne ikke kontrollere kilden. Prøv igjen."); }
}
