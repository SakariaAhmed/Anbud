import { NextResponse } from "next/server";

import {
  queueArtifactGenerationJob,
  queueCustomerAnalysisJob,
  queueExecutiveSummaryJob,
  queueHighLevelDesignJob,
  queuePerfectSystemSolutionJob,
  queueSolutionEvaluationJob,
} from "@/lib/server/project-jobs";
import {
  normalizeArtifactInstructions,
  normalizeSourceDocumentIds,
} from "@/lib/server/artifact-generation-input";
import { resolveOpenAIModelOverride } from "@/lib/server/ai";
import { enforceRateLimit } from "@/lib/server/api-responses";
import { auditEvent, withTiming } from "@/lib/server/observability";
import { productionSafeErrorMessage } from "@/lib/server/safe-errors";
import type { GeneratedArtifactType, ProjectJobRecord } from "@/lib/types";

function isArtifactType(value: string): value is GeneratedArtifactType {
  return (
    value === "losningsutkast" ||
    value === "bilag1_rekonstruksjon" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  );
}

type ProjectJobRequestBody =
  | {
      kind?: "customer_analysis";
    }
  | {
      kind?: "solution_evaluation";
      solution_document_id?: string;
    }
  | {
      kind?: "high_level_design";
    }
  | {
      kind?: "perfect_system_solution";
    }
  | {
      kind?: "executive_summary";
    }
  | {
      kind?: "artifact_generation";
      artifact_type?: string;
      instructions?: string;
      source_document_ids?: string[];
      use_solution_evaluation_context?: boolean;
    };

type QueuedJobResult = {
  job: ProjectJobRecord;
  metadata?: Record<string, unknown>;
};

async function queueSimpleProjectJob(
  kind: Exclude<ProjectJobRequestBody["kind"], "artifact_generation" | undefined>,
  projectId: string,
  model: string | undefined,
  body: ProjectJobRequestBody,
): Promise<QueuedJobResult | null> {
  switch (kind) {
    case "customer_analysis":
      return {
        job: await queueCustomerAnalysisJob({ projectId, model }),
      };
    case "solution_evaluation":
      return {
        job: await queueSolutionEvaluationJob({
          projectId,
          solutionDocumentId:
            body.kind === "solution_evaluation" &&
            typeof body.solution_document_id === "string"
              ? body.solution_document_id
              : undefined,
          model,
        }),
      };
    case "high_level_design":
      return {
        job: await queueHighLevelDesignJob({ projectId, model }),
      };
    case "perfect_system_solution":
      return {
        job: await queuePerfectSystemSolutionJob({ projectId, model }),
      };
    case "executive_summary":
      return {
        job: await queueExecutiveSummaryJob({ projectId, model }),
      };
  }
}

async function queueArtifactJob(
  projectId: string,
  model: string | undefined,
  body: Extract<ProjectJobRequestBody, { kind?: "artifact_generation" }>,
): Promise<QueuedJobResult | NextResponse> {
  if (!body.artifact_type || !isArtifactType(body.artifact_type)) {
    return NextResponse.json(
      { error: "Ugyldig artefakttype." },
      { status: 400 },
    );
  }

  return {
    job: await queueArtifactGenerationJob({
      projectId,
      artifactType: body.artifact_type,
      instructions: normalizeArtifactInstructions(body.instructions),
      sourceDocumentIds: normalizeSourceDocumentIds(body.source_document_ids),
      useSolutionEvaluationContext:
        body.use_solution_evaluation_context === true,
      model,
    }),
    metadata: {
      artifact_type: body.artifact_type,
    },
  };
}

async function jobAcceptedResponse(input: {
  projectId: string;
  kind: NonNullable<ProjectJobRequestBody["kind"]>;
  queued: QueuedJobResult;
}) {
  await auditEvent({
    action: "project_job_accepted",
    projectId: input.projectId,
    entityType: "project_job",
    entityId: input.queued.job.id,
    metadata: {
      kind: input.kind,
      ...(input.queued.metadata ?? {}),
    },
  });

  return NextResponse.json({ job: input.queued.job }, { status: 202 });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const limited = await enforceRateLimit(
    request,
    "project-jobs",
    {
      limit: 20,
      windowMs: 60_000,
      fallbackLimit: 5,
    },
    "For mange jobber startet på kort tid.",
  );
  if (limited) {
    return limited;
  }

  try {
    const { id } = await context.params;
    return await withTiming(
      "POST /api/projects/[id]/jobs",
      { project_id: id },
      async () => {
        const model = await resolveOpenAIModelOverride(
          request.headers.get("x-openai-model"),
        );
        const contentType = request.headers.get("content-type") ?? "";
        if (
          contentType &&
          !contentType.toLowerCase().includes("application/json")
        ) {
          return NextResponse.json(
            { error: "Forespørselen må sendes som JSON." },
            { status: 415 },
          );
        }

        const body = (await request.json().catch(() => ({}))) as ProjectJobRequestBody;

        if (body.kind === "artifact_generation") {
          const queued = await queueArtifactJob(id, model, body);
          return queued instanceof NextResponse
            ? queued
            : jobAcceptedResponse({ projectId: id, kind: body.kind, queued });
        }

        if (body.kind) {
          const queued = await queueSimpleProjectJob(body.kind, id, model, body);
          if (queued) {
            return jobAcceptedResponse({ projectId: id, kind: body.kind, queued });
          }
        }

        return NextResponse.json({ error: "Ugyldig jobbtype." }, { status: 400 });
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: productionSafeErrorMessage(error, "Kunne ikke starte jobben."),
      },
      { status: 500 },
    );
  }
}
