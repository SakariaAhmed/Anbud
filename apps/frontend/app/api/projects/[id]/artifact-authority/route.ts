import { requireProjectPermission } from "@/lib/server/authorization";
import { NextResponse } from "next/server";

import { currentArtifactTypesFromAuthority, getArtifactAuthoritySummary } from "@/lib/server/repositories/artifacts";
import { routeErrorResponse } from "@/lib/server/api-responses";

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "artifact.read");
    const artifactAuthority = await getArtifactAuthoritySummary(id);
    return NextResponse.json(
      {
        artifact_authority: artifactAuthority,
        current_artifact_types:
          currentArtifactTypesFromAuthority(artifactAuthority),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente artefaktstatus.");
  }
}
