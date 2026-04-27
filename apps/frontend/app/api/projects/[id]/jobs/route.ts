import { NextResponse } from "next/server";

import {
  queueArtifactGenerationJob,
  queueHighLevelDesignJob,
  queuePerfectSystemSolutionJob,
  queueSolutionEvaluationJob,
} from "@/lib/server/project-jobs";
import type { GeneratedArtifactType } from "@/lib/types";

function isArtifactType(value: string): value is GeneratedArtifactType {
  return value === "losningsutkast" || value === "gjennomforing_og_risiko";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as
      | {
          kind?: "solution_evaluation";
          allow_generated_solution?: boolean;
        }
      | {
          kind?: "high_level_design";
        }
      | {
          kind?: "perfect_system_solution";
        }
      | {
          kind?: "artifact_generation";
          artifact_type?: string;
          instructions?: string;
        };

    if (body.kind === "solution_evaluation") {
      const job = queueSolutionEvaluationJob({
        projectId: id,
        allowGeneratedSolution: Boolean(body.allow_generated_solution),
      });

      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "high_level_design") {
      const job = queueHighLevelDesignJob({
        projectId: id,
      });

      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "perfect_system_solution") {
      const job = queuePerfectSystemSolutionJob({
        projectId: id,
      });

      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "artifact_generation") {
      if (!body.artifact_type || !isArtifactType(body.artifact_type)) {
        return NextResponse.json(
          { error: "Ugyldig artefakttype." },
          { status: 400 },
        );
      }

      const job = queueArtifactGenerationJob({
        projectId: id,
        artifactType: body.artifact_type,
        instructions:
          typeof body.instructions === "string" ? body.instructions : "",
      });

      return NextResponse.json({ job }, { status: 202 });
    }

    return NextResponse.json({ error: "Ugyldig jobbtype." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Kunne ikke starte jobben.",
      },
      { status: 500 },
    );
  }
}
