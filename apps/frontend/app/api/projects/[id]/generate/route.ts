import { NextResponse } from "next/server";

import { isArtifactType } from "@/lib/server/domain/project-documents";
import {
  deleteGeneratedArtifact,
  listGeneratedArtifacts,
  updateGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import { normalizeArtifactInstructions } from "@/lib/server/artifact-generation-input";
import { getProjectSnapshot } from "@/lib/server/repositories/projects";
import { prepareProjectAiJsonRoute } from "@/lib/server/project-ai-route";
import { generateAndSaveProjectArtifact } from "@/lib/server/use-cases/generate-artifact";

const READ_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const artifacts = await listGeneratedArtifacts(id);
    return NextResponse.json({ artifacts }, { headers: READ_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente generatorresultatene.",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const preflight = await prepareProjectAiJsonRoute<{
      artifact_type?: string;
      instructions?: string;
      use_solution_evaluation_context?: boolean;
    }>(
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

    if (!body.artifact_type || !isArtifactType(body.artifact_type)) {
      return NextResponse.json(
        { error: "Ugyldig artefakttype." },
        { status: 400 },
      );
    }

    const startedAt = Date.now();
    let phaseStartedAt = startedAt;
    const generationTimings: Array<{ phase: string; duration_ms: number }> = [];
    function markPhase(phase: string) {
      const now = Date.now();
      generationTimings.push({ phase, duration_ms: now - phaseStartedAt });
      phaseStartedAt = now;
    }

    const result = await generateAndSaveProjectArtifact({
      projectId: id,
      artifactType: body.artifact_type,
      instructions,
      useSolutionEvaluationContext:
        body.use_solution_evaluation_context === true,
      model,
      onPhase: markPhase,
      timings: () => generationTimings,
      totalDurationMs: () => Date.now() - startedAt,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke generere artefakt.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      artifact_id?: string;
      title?: string;
      content_markdown?: string;
    };

    if (!body.artifact_id) {
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
    });
    const snapshot = await getProjectSnapshot(id);

    return NextResponse.json({ artifact, project: snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke oppdatere kravbesvarelsen.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      artifact_id?: string;
    };

    if (!body.artifact_id) {
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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke slette artefakten.",
      },
      { status: 500 },
    );
  }
}
