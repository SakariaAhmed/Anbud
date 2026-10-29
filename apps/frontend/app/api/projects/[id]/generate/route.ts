import { requireProjectPermission } from "@/lib/server/authorization";
import { NextResponse } from "next/server";

import {
  deleteGeneratedArtifact,
  listGeneratedArtifacts,
  updateGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import { normalizeArtifactInstructions } from "@/lib/server/artifact-generation-input";
import { getProjectSnapshot } from "@/lib/server/repositories/data-store";
import { prepareProjectAiJsonRoute } from "@/lib/server/project-ai-route";
import { queueArtifactGenerationJob } from "@/lib/server/project-jobs";
import { routeErrorResponse } from "@/lib/server/api-responses";
import { readJsonObject } from "@/lib/server/request-body";
import { isGeneratableArtifactType } from "@/lib/types";

const READ_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "artifact.read");
    const artifactType = new URL(request.url).searchParams.get("artifact_type");
    const artifacts =
      artifactType && isGeneratableArtifactType(artifactType)
        ? await listGeneratedArtifacts(id, { artifactType })
        : await listGeneratedArtifacts(id);
    return NextResponse.json({ artifacts }, { headers: READ_CACHE_HEADERS });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente generatorresultatene.");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const preflight = await prepareProjectAiJsonRoute(
      request,
      context,
      {
        scopePrefix: "ai-generate",
        message: "For mange genereringer på kort tid.",
        limit: 8,
        windowMs: 5 * 60_000,
      },
    );
    if (preflight.response) {
      return preflight.response;
    }

    const { id, model, body } = preflight;
    const instructions = normalizeArtifactInstructions(body.instructions);

    if (!isGeneratableArtifactType(body.artifact_type)) {
      return NextResponse.json(
        { error: "Ugyldig artefakttype." },
        { status: 400 },
      );
    }

    const job = await queueArtifactGenerationJob({
      projectId: id,
      artifactType: body.artifact_type,
      instructions,
      useSolutionEvaluationContext:
        body.use_solution_evaluation_context === true,
      model,
    });

    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke generere artefakt.");
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "artifact.write");
    const body = await readJsonObject(request);

    if (typeof body.artifact_id !== "string" || !body.artifact_id) {
      return NextResponse.json(
        { error: "Mangler kravbesvarelse som skal oppdateres." },
        { status: 400 },
      );
    }

    const artifact = await updateGeneratedArtifact({
      projectId: id,
      artifactId: body.artifact_id,
      title: typeof body.title === "string" ? body.title : "",
      contentMarkdown:
        typeof body.content_markdown === "string" ? body.content_markdown : "",
      acknowledgeDeterministicRepairs:
        body.acknowledge_deterministic_repairs === true,
    });
    const snapshot = await getProjectSnapshot(id);

    return NextResponse.json({ artifact, project: snapshot });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke oppdatere kravbesvarelsen.");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "artifact.write");
    const body = await readJsonObject(request);

    if (typeof body.artifact_id !== "string" || !body.artifact_id) {
      return NextResponse.json(
        { error: "Mangler artefakt som skal slettes." },
        { status: 400 },
      );
    }

    await deleteGeneratedArtifact({
      projectId: id,
      artifactId: body.artifact_id,
    });
    const snapshot = await getProjectSnapshot(id);

    return NextResponse.json({ project: snapshot });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke slette artefakten.");
  }
}
