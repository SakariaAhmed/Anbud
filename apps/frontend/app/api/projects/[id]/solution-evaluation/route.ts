import { NextResponse } from "next/server";

import { resolveOpenAIModelOverride } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import { checkRateLimit } from "@/lib/server/observability";
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
    const { id } = await context.params;
    const rateLimit = await checkRateLimit(request, `solution-evaluation:${id}`, {
      limit: 8,
      windowMs: 5 * 60_000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "For mange løsningsvurderinger på kort tid." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }

    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const body = (await request.json().catch(() => ({}))) as {
      allow_generated_solution?: boolean;
      solution_document_id?: string;
    };

    if (!(await getCustomerAnalysis(id))) {
      return NextResponse.json({ error: "Generer kundeanalyse før løsningsvurdering." }, { status: 400 });
    }

    const result = await runSolutionEvaluationWorkflow({
      kind: "solution_evaluation",
      projectId: id,
      allowGeneratedSolution: Boolean(body.allow_generated_solution),
      solutionDocumentId:
        typeof body.solution_document_id === "string"
          ? body.solution_document_id
          : undefined,
      model,
    }, {
      setProgress: () => undefined,
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
