import { NextResponse } from "next/server";

import {
  queueArtifactGenerationJob,
  queueCustomerAnalysisJob,
  queueExecutiveSummaryJob,
  queueHighLevelDesignJob,
  queuePerfectSystemSolutionJob,
  queueSolutionEvaluationJob,
} from "@/lib/server/project-jobs";
import { resolveOpenAIModelOverride } from "@/lib/server/ai";
import { auditEvent, checkRateLimit, withTiming } from "@/lib/server/observability";
import type { GeneratedArtifactType } from "@/lib/types";

function isArtifactType(value: string): value is GeneratedArtifactType {
  return (
    value === "losningsutkast" ||
    value === "bilag1_rekonstruksjon" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimit = await checkRateLimit(request, "project-jobs", {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "For mange jobber startet på kort tid." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
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
        const body = (await request.json().catch(() => ({}))) as
      | {
          kind?: "customer_analysis";
        }
      | {
          kind?: "solution_evaluation";
          allow_generated_solution?: boolean;
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
        };

    if (body.kind === "customer_analysis") {
      const job = await queueCustomerAnalysisJob({
        projectId: id,
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: { kind: body.kind },
      });
      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "solution_evaluation") {
      const job = await queueSolutionEvaluationJob({
        projectId: id,
        allowGeneratedSolution: Boolean(body.allow_generated_solution),
        solutionDocumentId:
          typeof body.solution_document_id === "string"
            ? body.solution_document_id
            : undefined,
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: { kind: body.kind },
      });
      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "high_level_design") {
      const job = await queueHighLevelDesignJob({
        projectId: id,
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: { kind: body.kind },
      });
      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "perfect_system_solution") {
      const job = await queuePerfectSystemSolutionJob({
        projectId: id,
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: { kind: body.kind },
      });
      return NextResponse.json({ job }, { status: 202 });
    }

    if (body.kind === "executive_summary") {
      const job = await queueExecutiveSummaryJob({
        projectId: id,
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: { kind: body.kind },
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

      const job = await queueArtifactGenerationJob({
        projectId: id,
        artifactType: body.artifact_type,
        instructions:
          typeof body.instructions === "string" ? body.instructions : "",
        sourceDocumentIds: Array.isArray(body.source_document_ids)
          ? body.source_document_ids.filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            )
          : [],
        model,
      });

      await auditEvent({
        action: "project_job_started",
        projectId: id,
        entityType: "project_job",
        entityId: job.id,
        metadata: {
          kind: body.kind,
          artifact_type: body.artifact_type,
        },
      });
      return NextResponse.json({ job }, { status: 202 });
    }

        return NextResponse.json({ error: "Ugyldig jobbtype." }, { status: 400 });
      },
    );
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
