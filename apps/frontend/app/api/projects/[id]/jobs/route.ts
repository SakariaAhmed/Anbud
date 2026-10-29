import { listRecentProjectJobs } from "@/lib/server/repositories/jobs";
import { requireProjectPermission } from "@/lib/server/authorization";
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
import { resolveOpenAIModelOverride } from "@/lib/server/ai/model-config";
import { enforceRateLimit, routeErrorResponse } from "@/lib/server/api-responses";
import { auditEvent, withTiming } from "@/lib/server/observability";
import { RequestBodyError, readJsonObject } from "@/lib/server/request-body";
import { isGeneratableArtifactType, type ProjectJobRecord } from "@/lib/types";

const REQUESTABLE_JOB_KINDS = [
  "customer_analysis",
  "solution_evaluation",
  "high_level_design",
  "perfect_system_solution",
  "executive_summary",
  "artifact_generation",
] as const;
type RequestableJobKind = (typeof REQUESTABLE_JOB_KINDS)[number];

function isRequestableJobKind(value: unknown): value is RequestableJobKind {
  return REQUESTABLE_JOB_KINDS.some((kind) => kind === value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QueuedJobResult = {
  job: ProjectJobRecord;
  metadata?: Record<string, unknown>;
};

async function queueSimpleProjectJob(
  kind: Exclude<RequestableJobKind, "artifact_generation">,
  projectId: string,
  model: string | undefined,
  body: Record<string, unknown>,
): Promise<QueuedJobResult> {
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
    case "perfect_system_solution": {
      const resumeArtifactId = body.resume_artifact_id;
      if (
        resumeArtifactId !== undefined &&
        (typeof resumeArtifactId !== "string" || !UUID_PATTERN.test(resumeArtifactId))
      ) {
        throw new RequestBodyError("Ugyldig løsningsutkast-ID.");
      }
      return {
        job: await queuePerfectSystemSolutionJob({ projectId, model, resumeArtifactId }),
      };
    }
    case "executive_summary":
      return {
        job: await queueExecutiveSummaryJob({ projectId, model }),
      };
  }
}

async function queueArtifactJob(
  projectId: string,
  model: string | undefined,
  body: Record<string, unknown>,
): Promise<QueuedJobResult | NextResponse> {
  if (!isGeneratableArtifactType(body.artifact_type)) {
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
  kind: RequestableJobKind;
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
    await requireProjectPermission(id, "job.run");
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

        const body = await readJsonObject(request);
        const kind = body.kind;
        if (!isRequestableJobKind(kind)) {
          return NextResponse.json({ error: "Ugyldig jobbtype." }, { status: 400 });
        }

        if (kind === "artifact_generation") {
          const queued = await queueArtifactJob(id, model, body);
          return queued instanceof NextResponse
            ? queued
            : jobAcceptedResponse({ projectId: id, kind, queued });
        }

        const queued = await queueSimpleProjectJob(kind, id, model, body);
        return jobAcceptedResponse({ projectId: id, kind, queued });
      },
    );
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke starte jobben.");
  }
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await requireProjectPermission(id, "project.read");
    return NextResponse.json({ jobs: await listRecentProjectJobs(id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return routeErrorResponse(error, "Kunne ikke hente jobbstatus.");
  }
}
