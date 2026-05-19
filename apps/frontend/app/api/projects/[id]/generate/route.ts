import { NextResponse } from "next/server";

import { generateProjectArtifact, resolveOpenAIModelOverride } from "@/lib/server/ai";
import {
  repairGeneratedArtifactContent,
  validateGeneratedArtifact,
} from "@/lib/server/artifact-validation";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
  summarizeDocumentLedgers,
} from "@/lib/server/document-ledger";
import {
  getCustomerAnalysis,
  getProjectDetail,
  getProjectSnapshot,
  deleteGeneratedArtifact,
  listGeneratedArtifacts,
  listProjectDocuments,
  listServiceDocumentDetailsForProject,
  listServiceDocumentSummariesForProject,
  saveGeneratedArtifact,
  updateGeneratedArtifact,
} from "@/lib/server/projects-db";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ServiceDocument,
} from "@/lib/types";

const READ_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};

function isArtifactType(value: string): value is GeneratedArtifactType {
  return (
    value === "losningsutkast" ||
    value === "bilag1_rekonstruksjon" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  );
}

function serviceDocumentLimitForArtifact(artifactType: GeneratedArtifactType) {
  if (artifactType === "bilag1_rekonstruksjon") {
    return 0;
  }

  if (artifactType === "forbedret_kravsvar") {
    return 5;
  }

  return 3;
}

function tokenizeForRelevance(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9æøå]+/gi, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 4)
        .slice(0, 80),
    ),
  );
}

function selectRelevantServiceDocumentIds(input: {
  artifactType: GeneratedArtifactType;
  projectName: string;
  customerAnalysis: unknown;
  instructions?: string;
  serviceDocumentSummaries: ServiceDocument[];
}) {
  const limit = serviceDocumentLimitForArtifact(input.artifactType);
  if (!limit) {
    return [];
  }

  const queryTokens = tokenizeForRelevance(
    [
      input.artifactType,
      input.projectName,
      input.instructions ?? "",
      JSON.stringify(input.customerAnalysis ?? {}),
    ].join(" "),
  );

  return [...input.serviceDocumentSummaries]
    .map((document, index) => {
      const haystack = `${document.title} ${document.file_name} ${
        document.ai_summary ?? ""
      }`.toLowerCase();
      const score = queryTokens.reduce(
        (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
        0,
      );
      return { document, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ document }) => document.id);
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
    const model = await resolveOpenAIModelOverride(
      request.headers.get("x-openai-model"),
    );
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

    const totalStartedAt = Date.now();
    let phaseStartedAt = totalStartedAt;
    const generationTimings: Array<{ phase: string; duration_ms: number }> = [];
    function markPhase(phase: string) {
      const now = Date.now();
      generationTimings.push({ phase, duration_ms: now - phaseStartedAt });
      phaseStartedAt = now;
    }

    const [
      project,
      customerAnalysis,
      documents,
      generatedArtifacts,
      serviceDocumentSummaries,
    ] = await Promise.all([
      getProjectDetail(id),
      getCustomerAnalysis(id),
      listProjectDocuments(id),
      listGeneratedArtifacts(id),
      listServiceDocumentSummariesForProject(id),
    ]);
    markPhase("dokumenthenting");
    const { projectDocuments, serviceDescriptionDocument } =
      splitServiceDescriptionDetails(documents);
    const customerDocument = projectDocuments[0] ?? null;
    const solutionDocument = projectDocuments[1] ?? null;
    const supportingDocuments = projectDocuments.filter(
      (document) =>
        document.id !== customerDocument?.id &&
        document.id !== solutionDocument?.id,
    );
    const documentLedgers = [
      customerDocument,
      solutionDocument,
      ...supportingDocuments,
    ]
      .filter(
        (document): document is ProjectDocumentDetail =>
          document !== null && Boolean(document.raw_text.trim()),
      )
      .slice(0, 8)
      .map(buildDocumentLedger);
    const documentLedgerContext = buildDocumentLedgerContext({
      artifactType: body.artifact_type,
      ledgers: documentLedgers,
    });
    markPhase("ledgerbygging");

    const serviceDescriptionDocuments =
      body.artifact_type === "bilag1_rekonstruksjon"
        ? []
        : serviceDocumentSummaries.length
          ? await listServiceDocumentDetailsForProject(id, {
              documentIds: selectRelevantServiceDocumentIds({
                artifactType: body.artifact_type,
                projectName: project.name,
                customerAnalysis,
                instructions: body.instructions,
                serviceDocumentSummaries,
              }),
            })
          : await listServiceDocumentDetailsForProject(id);
    markPhase("tjenestedokumenthenting");

    const generated = await generateProjectArtifact({
      artifactType: body.artifact_type,
      projectName: project.name,
      customerAnalysis,
      solutionEvaluation: project.solution_evaluation,
      customerDocument,
      solutionDocument,
      serviceDescriptionDocument,
      serviceDescriptionDocuments,
      serviceDocumentSummaries,
      supportingDocuments,
      knowledgeArtifacts: generatedArtifacts,
      instructions: body.instructions?.trim(),
      model,
      documentLedgerContext,
    });
    markPhase("ai_batcher");

    const repaired = repairGeneratedArtifactContent({
      artifactType: body.artifact_type,
      contentMarkdown: generated.content_markdown,
    });
    if (repaired.repairedRows > 10) {
      throw new Error(
        `Generatorresultatet inneholdt ${repaired.repairedRows} rader fra innholdsfortegnelse. Jobben stoppes i stedet for å lagre feiloutput.`,
      );
    }
    const qualityReport = validateGeneratedArtifact({
      artifactType: body.artifact_type,
      title: generated.title,
      contentMarkdown: repaired.contentMarkdown,
    });
    if (qualityReport.status === "fail") {
      throw new Error(
        `Generatorresultatet stoppet i kvalitetskontroll: ${qualityReport.issues.join(" ")}`,
      );
    }
    markPhase("validering");

    const artifact = await saveGeneratedArtifact(
      id,
      body.artifact_type,
      generated.title,
      repaired.contentMarkdown,
      {
        instructions: body.instructions?.trim() || "",
        customer_analysis_present: Boolean(customerAnalysis),
        solution_evaluation_present: Boolean(project.solution_evaluation),
        document_ledgers: summarizeDocumentLedgers(documentLedgers),
        artifact_quality_report: qualityReport,
        artifact_repair: {
          repaired_rows: repaired.repairedRows,
        },
        generation_timings: [
          ...generationTimings,
          { phase: "total", duration_ms: Date.now() - totalStartedAt },
        ],
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

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      artifact_id?: string;
    };

    if (!body.artifact_id) {
      return NextResponse.json(
        { error: "Mangler artefakt som skal slettes." },
        { status: 400 },
      );
    }

    await deleteGeneratedArtifact({
      projectId: id,
      artifactId: body.artifact_id,
    });
    const snapshot = await getProjectSnapshot(id);

    return NextResponse.json({ project: snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kunne ikke slette artefakten.",
      },
      { status: 500 },
    );
  }
}
