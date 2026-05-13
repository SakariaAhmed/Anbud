import { NextResponse } from "next/server";

import { generateExecutiveSummary, resolveOpenAIModelOverride } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getExecutiveSummary,
  getProjectDetail,
  getProjectSnapshot,
  getSolutionEvaluation,
  saveExecutiveSummary,
} from "@/lib/server/projects-db";

const READ_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
};

export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const executiveSummary = await getExecutiveSummary(id);
    return NextResponse.json(
      { executive_summary: executiveSummary },
      { headers: READ_CACHE_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke hente lederoppsummeringen.",
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
    const { id } = await context.params;
    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const [project, customerAnalysis, solutionEvaluation] = await Promise.all([
      getProjectDetail(id),
      getCustomerAnalysis(id),
      getSolutionEvaluation(id),
    ]);

    if (!solutionEvaluation) {
      return NextResponse.json(
        { error: "Generer vurdering før lederoppsummering." },
        { status: 400 },
      );
    }

    const generated = await generateExecutiveSummary({
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation,
      model,
    });
    const executiveSummary = await saveExecutiveSummary(id, generated, {
      source: "solution_evaluation",
      solution_evaluation_present: true,
      solution_evaluation_snapshot: {
        fit_to_customer_needs: solutionEvaluation.fit_to_customer_needs,
        likely_score_assessment: solutionEvaluation.likely_score_assessment,
        architecture_comparison: solutionEvaluation.architecture_comparison,
      },
    });
    const snapshot = await getProjectSnapshot(id);

    return NextResponse.json({
      executive_summary: executiveSummary,
      project: snapshot,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke generere lederoppsummering.",
      },
      { status: 500 },
    );
  }
}
