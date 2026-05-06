import { NextResponse } from "next/server";

import { generateProjectArtifact } from "@/lib/server/ai";
import {
  getCustomerAnalysis,
  getProjectDetail,
  getProjectSnapshot,
  listGeneratedArtifacts,
  listProjectDocuments,
  listServiceDocumentDetailsForProject,
  saveGeneratedArtifact,
  updateGeneratedArtifact,
} from "@/lib/server/projects-db";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type { GeneratedArtifactType } from "@/lib/types";

const READ_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

function isArtifactType(value: string): value is GeneratedArtifactType {
  return (
    value === "losningsutkast" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  );
}

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
    const { id } = await context.params;
    const body = (await request.json()) as {
      artifact_type?: string;
      instructions?: string;
    };

    if (!body.artifact_type || !isArtifactType(body.artifact_type)) {
      return NextResponse.json(
        { error: "Ugyldig artefakttype." },
        { status: 400 },
      );
    }

    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      serviceDescriptionDocuments,
    ] = await Promise.all([
      getProjectDetail(id),
      getCustomerAnalysis(id),
      listProjectDocuments(id),
      listGeneratedArtifacts(id),
      listServiceDocumentDetailsForProject(id),
    ]);
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const customerDocument = projectDocuments[0] ?? null;
    const solutionDocument = projectDocuments[1] ?? null;
    const supportingDocuments = projectDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id &&
        document.id !== solutionDocument?.id,
    );

    const generated = await generateProjectArtifact({
      artifactType: body.artifact_type,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
      supportingDocuments,
      knowledgeArtifacts: generatedArtifacts,
      instructions: body.instructions?.trim(),
    });

    const artifact = await saveGeneratedArtifact(
      id,
      body.artifact_type,
      generated.title,
      generated.content_markdown,
      {
        instructions: body.instructions?.trim() || "",
        customer_analysis_present: Boolean(customerAnalysis),
        solution_evaluation_present: Boolean(project.solution_evaluation),
      },
    );

    const snapshot = await getProjectSnapshot(id);
    return NextResponse.json({ artifact, project: snapshot });
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
