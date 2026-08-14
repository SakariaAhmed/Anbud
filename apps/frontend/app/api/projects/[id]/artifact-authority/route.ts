import { NextResponse } from "next/server";

import {
  currentArtifactTypesFromAuthority,
  getArtifactAuthoritySummary,
} from "@/lib/server/repositories/projects";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
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
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(error, "Kunne ikke hente artefaktstatus."),
      },
      { status: 500 },
    );
  }
}
