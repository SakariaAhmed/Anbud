import "server-only";

import {
  repairGeneratedArtifactContent,
  validateGeneratedArtifact,
} from "@/lib/server/artifact-validation";
import {
  ensureProjectDocumentChunks,
  ensureServiceDocumentChunks,
} from "@/lib/server/document-chunks";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
  summarizeDocumentLedgers,
  type DocumentLedger,
} from "@/lib/server/document-ledger";
import {
  selectProjectDocuments,
  selectRelevantServiceDocumentIds,
} from "@/lib/server/domain/project-documents";
import { generateProjectArtifact } from "@/lib/server/ai";
import {
  getFreshCustomerAnalysis,
} from "@/lib/server/repositories/analyses";
import {
  listGeneratedArtifacts,
  saveGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import {
  getDocumentDetail,
  listProjectDocumentsForAnalysis,
} from "@/lib/server/repositories/documents";
import {
  getProjectDetail,
  getProjectSnapshot,
} from "@/lib/server/repositories/projects";
import {
  listServiceDocumentDetailsForProject,
  listServiceDocumentSummariesForProject,
} from "@/lib/server/repositories/services";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectSnapshotResult,
  GeneratedArtifact,
} from "@/lib/types";

export type ArtifactGenerationPhase =
  | "dokumenthenting"
  | "ledgerbygging"
  | "tjenestedokumenthenting"
  | "dokumentindeksering"
  | "ai_batcher"
  | "validering"
  | "lagring";

export interface ArtifactGenerationTiming {
  phase: string;
  duration_ms: number;
}

export interface GenerateAndSaveArtifactInput {
  projectId: string;
  artifactType: GeneratedArtifactType;
  instructions?: string;
  sourceDocumentIds?: string[];
  model?: string;
  inputSnapshotExtra?: Record<string, unknown>;
  ensureSemanticChunks?: boolean;
  onProgress?: (message: string) => void;
  onPhase?: (phase: ArtifactGenerationPhase) => void;
  timings?: () => ArtifactGenerationTiming[];
  totalDurationMs?: () => number;
}

export interface GenerateAndSaveArtifactResult {
  artifact: GeneratedArtifact;
  project: ProjectSnapshotResult;
}

const ARTIFACT_FILE_LEDGER_FORMATS = new Set(["pdf", "docx", "xlsx", "xls"]);

function isLikelyRequirementDocument(document: ProjectDocumentDetail) {
  const text = `${document.title} ${document.file_name}`.toLowerCase();
  return (
    text.includes("krav") ||
    text.includes("requirement") ||
    text.includes("requirements")
  );
}

async function hydrateArtifactFileDocument(
  projectId: string,
  document: ProjectDocumentDetail,
) {
  if (
    document.file_base64 ||
    !ARTIFACT_FILE_LEDGER_FORMATS.has(document.file_format)
  ) {
    return document;
  }

  try {
    return await getDocumentDetail(projectId, document.id);
  } catch {
    return document;
  }
}

const DOCUMENT_LEDGER_CACHE_TTL_MS = 5 * 60_000;
const DOCUMENT_LEDGER_CACHE_MAX = 50;
const documentLedgerCache = new Map<
  string,
  {
    expiresAt: number;
    ledgers: DocumentLedger[];
    context: string;
  }
>();

function documentLedgerCacheKey(input: {
  artifactType: GeneratedArtifactType;
  documents: ProjectDocumentDetail[];
}) {
  return [
    input.artifactType,
    ...input.documents.map((document) =>
      [
        document.id,
        document.updated_at,
        document.raw_text.length,
        document.title,
      ].join(":"),
    ),
  ].join("|");
}

function getDocumentLedgerBundle(input: {
  artifactType: GeneratedArtifactType;
  documents: ProjectDocumentDetail[];
}) {
  const key = documentLedgerCacheKey(input);
  const cached = documentLedgerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      documentLedgers: cached.ledgers,
      documentLedgerContext: cached.context,
      cacheHit: true,
    };
  }

  documentLedgerCache.delete(key);
  if (documentLedgerCache.size >= DOCUMENT_LEDGER_CACHE_MAX) {
    const firstKey = documentLedgerCache.keys().next().value;
    if (firstKey) {
      documentLedgerCache.delete(firstKey);
    }
  }

  const ledgers = input.documents.slice(0, 8).map(buildDocumentLedger);
  const context = buildDocumentLedgerContext({
    artifactType: input.artifactType,
    ledgers,
  });
  documentLedgerCache.set(key, {
    expiresAt: Date.now() + DOCUMENT_LEDGER_CACHE_TTL_MS,
    ledgers,
    context,
  });

  return {
    documentLedgers: ledgers,
    documentLedgerContext: context,
    cacheHit: false,
  };
}

export async function generateAndSaveProjectArtifact(
  input: GenerateAndSaveArtifactInput,
): Promise<GenerateAndSaveArtifactResult> {
  input.onProgress?.("[12%] Laster prosjektkontekst og relevante dokumenter ...");
  const [
    project,
    customerAnalysis,
    documents,
    generatedArtifacts,
    serviceDocumentSummaries,
  ] = await Promise.all([
    getProjectDetail(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
    listProjectDocumentsForAnalysis(input.projectId),
    listGeneratedArtifacts(input.projectId),
    listServiceDocumentSummariesForProject(input.projectId),
  ]);
  input.onPhase?.("dokumenthenting");

  const { projectDocuments, serviceDescriptionDocument } =
    splitServiceDescriptionDetails(documents);
  const selectedDocumentIds = new Set(input.sourceDocumentIds ?? []);
  const selectedRequirementDocuments = selectedDocumentIds.size
    ? projectDocuments.filter((document) => selectedDocumentIds.has(document.id))
    : [];
  const { customerDocument, solutionDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  const requirementFileCandidates =
    input.artifactType === "forbedret_kravsvar"
      ? (selectedDocumentIds.size
          ? selectedRequirementDocuments
          : [
              customerDocument,
              solutionDocument,
              ...supportingDocuments,
            ].filter(
              (document): document is ProjectDocumentDetail =>
                document !== null && isLikelyRequirementDocument(document),
            )
        ).slice(0, 3)
      : [];
  const hydratedRequirementFiles = new Map(
    (
      await Promise.all(
        requirementFileCandidates.map(async (document) => [
          document.id,
          await hydrateArtifactFileDocument(input.projectId, document),
        ] as const),
      )
    ),
  );
  const getHydratedRequirementFile = (
    document: ProjectDocumentDetail | null,
  ) => (document ? hydratedRequirementFiles.get(document.id) ?? document : null);
  const generationCustomerDocument =
    getHydratedRequirementFile(customerDocument);
  const generationSolutionDocument =
    getHydratedRequirementFile(solutionDocument);
  const generationSupportingDocuments = supportingDocuments.map(
    (document) => getHydratedRequirementFile(document) ?? document,
  );
  const generationRequirementDocuments = selectedRequirementDocuments.map(
    (document) => getHydratedRequirementFile(document) ?? document,
  );

  if (
    input.artifactType === "bilag1_rekonstruksjon" &&
    !projectDocuments.some((document) => document.raw_text.trim())
  ) {
    throw new Error(
      "Bilag 1 kan ikke genereres fordi dokumentgrunnlaget mangler lesbar tekst.",
    );
  }

  input.onProgress?.(
    input.artifactType === "forbedret_kravsvar"
      ? "[16%] Bygger kravledger fra valgt dokumentgrunnlag ..."
      : "[16%] Bygger dokumentledger for struktur, krav og kildegrunnlag ...",
  );
  const ledgerDocuments =
    input.artifactType === "forbedret_kravsvar" && selectedDocumentIds.size
      ? selectedRequirementDocuments
      : [
          customerDocument,
          solutionDocument,
          ...supportingDocuments,
        ].filter(
          (document): document is ProjectDocumentDetail =>
            document !== null && Boolean(document.raw_text.trim()),
        );
  const {
    documentLedgers,
    documentLedgerContext,
    cacheHit: ledgerCacheHit,
  } = getDocumentLedgerBundle({
    artifactType: input.artifactType,
    documents: ledgerDocuments,
  });
  if (ledgerCacheHit) {
    input.onProgress?.("[18%] Gjenbruker dokumentledger fra hurtigbuffer ...");
  }
  input.onPhase?.("ledgerbygging");

  input.onProgress?.(
    input.artifactType === "forbedret_kravsvar"
      ? "[18%] Kartlegger kravdokumenter og forbereder kravbesvarelse ..."
      : "[38%] Henter relevante tjenestedokumenter ...",
  );
  const serviceDescriptionDocuments =
    input.artifactType === "bilag1_rekonstruksjon"
      ? []
      : serviceDocumentSummaries.length
        ? await listServiceDocumentDetailsForProject(input.projectId, {
            documentIds: selectRelevantServiceDocumentIds({
              artifactType: input.artifactType,
              projectName: project.name,
              customerAnalysis,
              instructions: input.instructions,
              serviceDocumentSummaries,
            }),
          })
        : await listServiceDocumentDetailsForProject(input.projectId);
  input.onPhase?.("tjenestedokumenthenting");

  if (input.ensureSemanticChunks) {
    input.onProgress?.(
      input.artifactType === "forbedret_kravsvar"
        ? "[22%] Klargjør semantiske dokumentutdrag ..."
        : "[40%] Klargjør semantiske dokumentutdrag ...",
    );
    await Promise.all([
      ...projectDocuments
        .filter((document) => document.raw_text.trim())
        .map((document) =>
          ensureProjectDocumentChunks({ document }).catch(() => undefined),
        ),
      ...serviceDescriptionDocuments
        .filter((document) => document.raw_text.trim())
        .map((document) =>
          ensureServiceDocumentChunks({ document }).catch(() => undefined),
        ),
    ]);
    input.onPhase?.("dokumentindeksering");
  }

  input.onProgress?.(
    input.artifactType === "forbedret_kravsvar"
      ? "[42%] Genererer kravbesvarelse med AI ..."
      : "[42%] Genererer nytt utkast med AI ...",
  );
  const generated = await generateProjectArtifact({
    artifactType: input.artifactType,
    projectName: project.name,
    customerAnalysis,
    solutionEvaluation: project.solution_evaluation,
    customerDocument: generationCustomerDocument,
    solutionDocument: generationSolutionDocument,
    serviceDescriptionDocument,
    serviceDescriptionDocuments,
    serviceDocumentSummaries,
    supportingDocuments: generationSupportingDocuments,
    requirementDocuments:
      input.artifactType === "forbedret_kravsvar" && selectedDocumentIds.size
        ? generationRequirementDocuments
        : undefined,
    knowledgeArtifacts: generatedArtifacts,
    instructions: input.instructions?.trim(),
    model: input.model,
    onProgress:
      input.artifactType === "forbedret_kravsvar" ? input.onProgress : undefined,
    documentLedgerContext,
  });
  const generationMetadata =
    generated && typeof generated === "object" && "generation_metadata" in generated
      ? generated.generation_metadata
      : undefined;
  input.onPhase?.("ai_batcher");

  input.onProgress?.("[86%] Validerer og reparerer generatorresultatet ...");
  const repaired = repairGeneratedArtifactContent({
    artifactType: input.artifactType,
    contentMarkdown: generated.content_markdown,
  });
  if (repaired.repairedRows > 10) {
    throw new Error(
      `Generatorresultatet inneholdt ${repaired.repairedRows} rader fra innholdsfortegnelse. Jobben stoppes i stedet for å lagre feiloutput.`,
    );
  }
  const qualityReport = validateGeneratedArtifact({
    artifactType: input.artifactType,
    title: generated.title,
    contentMarkdown: repaired.contentMarkdown,
  });
  if (qualityReport.status === "fail") {
    throw new Error(
      `Generatorresultatet stoppet i kvalitetskontroll: ${qualityReport.issues.join(" ")}`,
    );
  }
  input.onPhase?.("validering");

  input.onProgress?.("[90%] Lagrer validert generatorresultat i prosjektet ...");
  const sourceDocuments = selectedDocumentIds.size
    ? selectedRequirementDocuments
    : projectDocuments;
  const artifact = await saveGeneratedArtifact(
    input.projectId,
    input.artifactType,
    generated.title,
    repaired.contentMarkdown,
    {
      instructions: input.instructions?.trim() || "",
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(project.solution_evaluation),
      source_document_ids: sourceDocuments.map((document) => document.id),
      source_document_roles: sourceDocuments.map((document) => ({
        id: document.id,
        title: document.title,
        role: document.role,
        subtype: document.supporting_subtype,
      })),
      document_ledgers: summarizeDocumentLedgers(documentLedgers),
      artifact_quality_report: qualityReport,
      artifact_repair: {
        repaired_rows: repaired.repairedRows,
      },
      generation_metadata: generationMetadata ?? null,
      ...(input.inputSnapshotExtra ?? {}),
      generation_timings: [
        ...(input.timings?.() ?? []),
        ...(input.totalDurationMs
          ? [{ phase: "total", duration_ms: input.totalDurationMs() }]
          : []),
      ],
    },
  );
  input.onPhase?.("lagring");

  return {
    artifact,
    project: await getProjectSnapshot(input.projectId),
  };
}
