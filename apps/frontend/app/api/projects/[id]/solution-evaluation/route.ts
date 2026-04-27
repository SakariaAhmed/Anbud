import { NextResponse } from "next/server";

import { evaluateSolutionDocument, synthesizeAndEvaluateSolution } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getPrimaryDocument,
  getProjectSnapshot,
  getSolutionEvaluation,
  listSupportingDocuments,
  saveGeneratedArtifact,
  saveSolutionEvaluation,
} from "@/lib/server/projects-db";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const evaluation = await getSolutionEvaluation(id);

    return NextResponse.json({ evaluation });
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
    const body = (await request.json().catch(() => ({}))) as { allow_generated_solution?: boolean };

    const [customerDocument, solutionDocument, supportingDocuments, customerAnalysis] = await Promise.all([
      getPrimaryDocument(id, "primary_customer_document"),
      getPrimaryDocument(id, "primary_solution_document"),
      listSupportingDocuments(id),
      getCustomerAnalysis(id),
    ]);

    if (!customerDocument) {
      return NextResponse.json({ error: "Last opp et primært kundedokument først." }, { status: 400 });
    }

    if (!customerAnalysis) {
      return NextResponse.json({ error: "Generer kundeanalyse før løsningsvurdering." }, { status: 400 });
    }

    let evaluationDocument = solutionDocument;
    let generatedArtifact = null;

    if (!evaluationDocument) {
      if (!body.allow_generated_solution) {
        return NextResponse.json(
          { error: "Last opp et primært løsningsdokument først, eller godkjenn at systemet genererer et internt utkast." },
          { status: 400 },
        );
      }

      const generated = await synthesizeAndEvaluateSolution({
        projectName: customerDocument.title,
        customerAnalysis,
        customerDocument,
        supportingDocuments,
      });

      generatedArtifact = await saveGeneratedArtifact(
        id,
        "losningsutkast",
        generated.synthetic_solution.title,
        generated.synthetic_solution.content_markdown,
        {
          generated_for: "solution_evaluation_fallback",
          source: "system_generated_when_solution_document_missing",
        },
      );

      const saved = await saveSolutionEvaluation(id, {
        customerDocumentId: customerDocument.id,
        solutionDocumentId: null,
        result: generated.evaluation,
      });

      const project = await getProjectSnapshot(id);
      return NextResponse.json({
        evaluation: saved,
        project,
        artifact: generatedArtifact,
        used_generated_solution: true,
      });
    }

    const result = await evaluateSolutionDocument({
      projectName: customerDocument.title,
      customerDocument,
      solutionDocument: evaluationDocument,
      supportingDocuments,
      customerAnalysis,
    });

    const saved = await saveSolutionEvaluation(id, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: solutionDocument?.id ?? null,
      result,
    });

    const project = await getProjectSnapshot(id);
    return NextResponse.json({
      evaluation: saved,
      project,
      artifact: generatedArtifact,
      used_generated_solution: false,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Kunne ikke generere løsningsvurdering." },
      { status: 500 },
    );
  }
}
