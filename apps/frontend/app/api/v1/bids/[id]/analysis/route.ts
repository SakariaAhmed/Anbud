import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import {
  createCustomerAnalysis,
  extractRequirementsFromBilag1,
  matchBilag2AgainstRequirements,
} from "@/lib/server/ai";
import { getLatestDocumentByRole, replaceBidAnalysis } from "@/lib/server/bids-db";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;

  const bilag1 = await getLatestDocumentByRole(tenantId, id, "bilag1");
  const bilag2 = await getLatestDocumentByRole(tenantId, id, "bilag2");

  if (!bilag1) {
    return NextResponse.json({ detail: "Last opp Bilag 1 før du genererer analysen." }, { status: 422 });
  }

  try {
    const [requirements, customerAnalysis] = await Promise.all([
      extractRequirementsFromBilag1(bilag1.raw_text),
      createCustomerAnalysis(bilag1.raw_text),
    ]);

    const complianceMatrix = await matchBilag2AgainstRequirements(requirements, bilag2?.raw_text ?? "");

    const detail = await replaceBidAnalysis(tenantId, id, requirements, customerAnalysis, complianceMatrix);

    revalidateTag("bids");
    revalidateTag(`bid:${id}`);

    return NextResponse.json({
      requirements: detail.requirements,
      customer_analysis: detail.customer_analysis,
      compliance_matrix: detail.compliance_matrix,
      summary: detail.summary,
    });
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "Kunne ikke generere analyse" },
      { status: 500 }
    );
  }
}
