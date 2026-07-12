import { NextResponse } from "next/server";

import {
  currentArtifactTypesFromAuthority,
  getArtifactAuthoritySummary,
} from "@/lib/server/repositories/projects";

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
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente artefaktstatus.",
      },
      { status: 500 },
    );
  }
}
