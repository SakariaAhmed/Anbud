import { NextResponse } from "next/server";

import {
  evaluateSolutionDocument,
  resolveOpenAIModelOverride,
  synthesizeAndEvaluateSolution,
} from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getSolutionEvaluation,
  saveSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import {
  getDocumentDetail,
  listProjectDocuments,
} from "@/lib/server/repositories/documents";
import { getProjectSnapshot } from "@/lib/server/repositories/projects";
import {
  saveGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import { splitServiceDescriptionDetails } from "@/lib/service-description";

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
    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
    const body = (await request.json().catch(() => ({}))) as {
      allow_generated_solution?: boolean;
      solution_document_id?: string;
    };

    const [documents, selectedSolutionDocument, customerAnalysis] = await Promise.all([
      listProjectDocuments(id),
      body.solution_document_id
        ? getDocumentDetail(id, body.solution_document_id)
        : Promise.resolve(null),
      getCustomerAnalysis(id),
    ]);
    const { projectDocuments } = splitServiceDescriptionDetails(documents);
    const customerDocument =
      projectDocuments.find((document) => document.id !== body.solution_document_id) ??
      projectDocuments[0] ??
      null;
    const solutionDocument = selectedSolutionDocument;
    const supportingDocuments = projectDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id &&
        document.id !== solutionDocument?.id,
    );

    if (!customerDocument) {
      return NextResponse.json({ error: "Last opp minst ett dokument først." }, { status: 400 });
    }

    if (!customerAnalysis) {
      return NextResponse.json({ error: "Generer kundeanalyse før løsningsvurdering." }, { status: 400 });
    }

    let evaluationDocument = solutionDocument;
    let generatedArtifact = null;

    if (!evaluationDocument) {
      if (!body.allow_generated_solution) {
        return NextResponse.json(
          { error: "Velg dokumentet som skal vurderes som arkitektløsning." },
          { status: 400 },
        );
      }

      const generated = await synthesizeAndEvaluateSolution({
        projectName: customerDocument.title,
        customerAnalysis,
        customerDocument,
        supportingDocuments,
        model,
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
      model,
    });

    const saved = await saveSolutionEvaluation(id, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: evaluationDocument.id,
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
