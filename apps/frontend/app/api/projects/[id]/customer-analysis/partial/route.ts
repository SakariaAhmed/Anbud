import { NextResponse } from "next/server";
import { requireProjectPermission } from "@/lib/server/authorization";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { readCustomerAnalysisPartial } from "@/lib/server/repositories/analysis-partials";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "project.read");
    return NextResponse.json({ partial: await readCustomerAnalysisPartial(id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente den ufullstendige forhåndsvisningen.");
  }
}
