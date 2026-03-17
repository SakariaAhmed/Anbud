import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { createManualRequirement } from "@/lib/server/bids-db";
import { RequirementType } from "@/lib/types";

export const runtime = "nodejs";

function isRequirementType(value: string): value is RequirementType {
  return value === "Må" || value === "Bør";
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const tenantId = request.headers.get("x-tenant-id") ?? "default";
  const { id } = await context.params;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ detail: "Ugyldig JSON" }, { status: 400 });
  }

  const code = String(payload.code ?? "").trim();
  const category = String(payload.category ?? "").trim();
  const requirementType = String(payload.requirement_type ?? "").trim();
  const scopeSummary = String(payload.scope_summary ?? "").trim();
  const sourceReference = String(payload.source_reference ?? "").trim();
  const sourceExcerpt = String(payload.source_excerpt ?? "").trim();

  if (!code || !category || !scopeSummary || !sourceReference) {
    return NextResponse.json(
      { detail: "Kravkode, kategori, kravtekst og kilde må fylles ut." },
      { status: 422 }
    );
  }

  if (!isRequirementType(requirementType)) {
    return NextResponse.json({ detail: "Kravtype må være Må eller Bør." }, { status: 422 });
  }

  try {
    const detail = await createManualRequirement(tenantId, id, {
      code,
      category,
      requirement_type: requirementType,
      scope_summary: scopeSummary,
      source_reference: sourceReference,
      source_excerpt: sourceExcerpt,
    });

    revalidateTag("bids");
    revalidateTag(`bid:${id}`);

    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kunne ikke legge til krav.";
    return NextResponse.json({ detail: message }, { status: message === "Bid not found" ? 404 : 500 });
  }
}
