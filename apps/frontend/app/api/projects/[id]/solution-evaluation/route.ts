import { NextResponse } from "next/server";

import {
  getFreshCustomerAnalysis,
  getSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import { auditEvent } from "@/lib/server/observability";
import { prepareProjectAiJsonRoute } from "@/lib/server/project-ai-route";
import { runSolutionEvaluationWorkflow } from "@/lib/server/use-cases/project-workflows";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
};

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const evaluation = await getSolutionEvaluation(id);

    return NextResponse.json({ evaluation }, { headers: READ_CACHE_HEADERS });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke hente løsningsvurderingen." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const preflight = await prepareProjectAiJsonRoute<{
      solution_document_id?: string;
    }>(
      request,
      context,
      {
        scopePrefix: "solution-evaluation",
        message: "For mange løsningsvurderinger på kort tid.",
        limit: 8,
        windowMs: 5 * 60_000,
        fallbackBody: {},
      },
    );
    if (preflight.response) {
      return preflight.response;
    }

    const { id, model, body } = preflight;

    if (!(await getFreshCustomerAnalysis(id))) {
      return NextResponse.json({ error: "Generer kundeanalyse før løsningsvurdering." }, { status: 400 });
    }

    const result = await runSolutionEvaluationWorkflow({
      kind: "solution_evaluation",
      projectId: id,
      solutionDocumentId:
        typeof body.solution_document_id === "string"
          ? body.solution_document_id
          : undefined,
      model,
    }, {
      setProgress: () => undefined,
    });
    await auditEvent({
      action: "solution_evaluation_generated",
      projectId: id,
      entityType: "solution_evaluation",
      entityId: result.evaluation.solution_document_id ?? null,
      metadata: {
        route: "direct",
        solution_document_id: result.evaluation.solution_document_id ?? null,
        customer_document_id: result.evaluation.customer_document_id ?? null,
        requirement_count:
          result.evaluation.requirement_coverage?.total_requirements ?? 0,
        coverage_confidence:
          result.evaluation.requirement_coverage?.confidence ?? null,
        model: model ?? null,
      },
    });

    return NextResponse.json({
      evaluation: result.evaluation,
      project: result.project,
      artifact: result.artifact,
      used_generated_solution: result.used_generated_solution,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke generere løsningsvurdering." },
      { status: 500 },
    );
  }
}
