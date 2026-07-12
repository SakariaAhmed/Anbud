import "server-only";

import { createHash } from "node:crypto";

import {
  repairGeneratedArtifactContent,
  requirementQualityExpectations,
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
import {
  artifactGenerationModel,
  generateProjectArtifact,
  selectKnowledgeArtifactsForArtifact,
} from "@/lib/server/ai";
import { DOCUMENT_EMBEDDING_MODEL } from "@/lib/server/document-chunks";
import {
  getFreshCustomerAnalysis,
  getFreshSolutionEvaluationSnapshot,
} from "@/lib/server/repositories/analyses";
import {
  getArtifactSourceRevisions,
  listArtifactKnowledgeCandidatesFresh,
  saveGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import {
  getDocumentDetail,
  listProjectDocumentsForAnalysis,
} from "@/lib/server/repositories/documents";
import {
  getProjectSnapshot,
} from "@/lib/server/repositories/projects";
import {
  listServiceDocumentDetailsForProject,
  listServiceDocumentSummariesForProject,
} from "@/lib/server/repositories/services";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import {
  hasReadableRequirementDocumentContent,
  isFormalRequirementDocument,
} from "@/lib/document-processing";
import { canonicalRequirementSourceDocuments } from "@/lib/server/use-cases/solution-evaluation-readiness";
import {
  shouldUseSolutionEvaluationForArtifact,
  solutionEvaluationContextModeForArtifact,
} from "@/lib/server/workflow-boundaries";
import { rethrowAuthoritativeLeaseLoss } from "@/lib/server/repositories/lease-fenced-persistence";
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
  useSolutionEvaluationContext?: boolean;
  model?: string;
  inputSnapshotExtra?: Record<string, unknown>;
  ensureSemanticChunks?: boolean;
  onProgress?: (message: string) => void;
  onPhase?: (phase: ArtifactGenerationPhase) => void;
  timings?: () => ArtifactGenerationTiming[];
  totalDurationMs?: () => number;
  assertActive?: () => void;
}

export interface GenerateAndSaveArtifactResult {
  artifact: GeneratedArtifact;
  project: ProjectSnapshotResult;
}

const ARTIFACT_FILE_LEDGER_FORMATS = new Set(["pdf", "docx", "xlsx", "xls"]);
const ARTIFACT_INDEXING_CONCURRENCY = 3;
const ARTIFACT_FILE_HYDRATION_CONCURRENCY = 3;
const ARTIFACT_GENERATOR_REVISION =
  process.env.ARTIFACT_GENERATOR_REVISION?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  process.env.GIT_COMMIT_SHA?.trim() ||
  "artifact-source-fence-v1";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactDocumentManifest(document: ProjectDocumentDetail) {
  const originalFileSha256 = document.file_base64
    ? sha256(Buffer.from(document.file_base64, "base64"))
    : null;

  return {
    id: document.id,
    updated_at: document.updated_at,
    role: document.role,
    subtype: document.supporting_subtype,
    original_file_sha256: originalFileSha256,
    content_hash: sha256(
      [
        document.title,
        document.file_name,
        document.file_format,
        document.raw_text,
        JSON.stringify(document.structure_map),
        originalFileSha256 || "",
      ].join("\u0000"),
    ),
  };
}

export function buildArtifactProjectDocumentManifests(input: {
  documents: ProjectDocumentDetail[];
  hydratedRequirementDocuments?: ReadonlyMap<string, ProjectDocumentDetail>;
}) {
  return input.documents.map((document) =>
    artifactDocumentManifest(
      input.hydratedRequirementDocuments?.get(document.id) ?? document,
    ),
  );
}

export function artifactSourceSnapshotHash(sourceSnapshot: unknown) {
  return sha256(JSON.stringify(sourceSnapshot));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function selectRequirementDocumentsForArtifact(input: {
  selectedDocumentIds: Set<string>;
  selectedRequirementDocuments: ProjectDocumentDetail[];
  projectDocuments: ProjectDocumentDetail[];
  customerDocument: ProjectDocumentDetail | null;
  solutionDocument: ProjectDocumentDetail | null;
  supportingDocuments: ProjectDocumentDetail[];
}) {
  if (input.selectedDocumentIds.size) {
    return input.selectedRequirementDocuments;
  }

  return input.projectDocuments.filter(isFormalRequirementDocument);
}

export function resolveRequestedSourceDocuments(input: {
  requestedDocumentIds: string[];
  projectDocuments: ProjectDocumentDetail[];
}) {
  const documentsById = new Map(
    input.projectDocuments.map((document) => [document.id, document]),
  );
  const missingIds = input.requestedDocumentIds.filter(
    (documentId) => !documentsById.has(documentId),
  );
  if (missingIds.length) {
    throw new Error(
      `Forespørselen inneholder ukjente eller utilgjengelige kildedokumenter: ${missingIds.join(", ")}.`,
    );
  }
  return input.requestedDocumentIds.map(
    (documentId) => documentsById.get(documentId)!,
  );
}

export function assertCompleteRequirementDocumentScope(input: {
  requestedDocumentIds: string[];
  requiredFormalDocuments: ProjectDocumentDetail[];
}) {
  if (!input.requestedDocumentIds.length) {
    return;
  }
  const requestedIds = new Set(input.requestedDocumentIds);
  const requiredIds = new Set(
    input.requiredFormalDocuments.map((document) => document.id),
  );
  const missingIds = [...requiredIds].filter((id) => !requestedIds.has(id));
  const unexpectedIds = [...requestedIds].filter((id) => !requiredIds.has(id));
  if (missingIds.length || unexpectedIds.length) {
    throw new Error(
      [
        "Kravbesvarelsen må bruke alle klassifiserte kravdokumenter i prosjektet. Vent til alle er ferdigbehandlet før generering.",
        missingIds.length ? `Mangler: ${missingIds.join(", ")}.` : "",
        unexpectedIds.length
          ? `Ikke godkjent som klart kravdokument: ${unexpectedIds.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export function assertRequirementDocumentsReadyForGeneration(
  documents: ProjectDocumentDetail[],
) {
  if (!documents.length) {
    throw new Error(
      "Kravbesvarelsen kan ikke genereres fordi ingen valgte kravdokumenter ble funnet.",
    );
  }

  for (const document of documents) {
    if (document.processing_status === "failed") {
      throw new Error(
        `Kravdokumentet "${document.title}" kunne ikke indekseres og kan ikke brukes til kravbesvarelse${
          document.processing_error ? `: ${document.processing_error}` : "."
        }`,
      );
    }
    if (
      document.processing_status !== "basic_ready" &&
      document.processing_status !== "enhanced_ready"
    ) {
      throw new Error(
        `Kravdokumentet "${document.title}" er ikke ferdig indeksert. Vent til dokumentbehandlingen er fullført før kravbesvarelsen startes.`,
      );
    }
    if (!hasReadableRequirementDocumentContent(document)) {
      throw new Error(
        `Kravdokumentet "${document.title}" er markert som ferdig, men mangler lesbar tekst eller struktur. Last dokumentet opp på nytt før kravbesvarelsen startes.`,
      );
    }
  }
}

async function hydrateArtifactFileDocument(
  projectId: string,
  document: ProjectDocumentDetail,
  loadDocument: (
    projectId: string,
    documentId: string,
  ) => Promise<ProjectDocumentDetail>,
) {
  if (
    document.file_base64 ||
    !ARTIFACT_FILE_LEDGER_FORMATS.has(document.file_format)
  ) {
    return document;
  }

  let hydrated: ProjectDocumentDetail;
  try {
    hydrated = await loadDocument(projectId, document.id);
  } catch (error) {
    throw new Error(
      `Kravfilen "${document.title}" (${document.id}) kunne ikke hydreres: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!hydrated.file_base64) {
    throw new Error(
      `Kravfilen "${document.title}" (${document.id}) mangler originalt filinnhold etter hydrering.`,
    );
  }

  return hydrated;
}

export async function hydrateRequirementFileDocuments(input: {
  projectId: string;
  documents: ProjectDocumentDetail[];
  loadDocument?: (
    projectId: string,
    documentId: string,
  ) => Promise<ProjectDocumentDetail>;
}) {
  const loadDocument = input.loadDocument ?? getDocumentDetail;
  return mapWithConcurrency(
    input.documents,
    ARTIFACT_FILE_HYDRATION_CONCURRENCY,
    (document) =>
      hydrateArtifactFileDocument(input.projectId, document, loadDocument),
  );
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

function canonicalizeDocumentLedgerFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeDocumentLedgerFingerprintValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, nestedValue]) => [
          key,
          canonicalizeDocumentLedgerFingerprintValue(nestedValue),
        ]),
    );
  }
  return value;
}

function documentLedgerSourceFingerprint(document: ProjectDocumentDetail) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: document.id,
        title: document.title,
        file_name: document.file_name,
        file_format: document.file_format,
        role: document.role,
        supporting_subtype: document.supporting_subtype,
        raw_text: document.raw_text,
        structure_map: canonicalizeDocumentLedgerFingerprintValue(
          document.structure_map,
        ),
      }),
    )
    .digest("hex");
}

export function documentLedgerCacheKey(input: {
  artifactType: GeneratedArtifactType;
  documents: ProjectDocumentDetail[];
}) {
  return [
    input.artifactType,
    ...input.documents.map(documentLedgerSourceFingerprint),
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

  const ledgers = input.documents.map(buildDocumentLedger);
  const context = buildDocumentLedgerContext({
    artifactType: input.artifactType,
    ledgers,
    maxRequirementsPerLedger: Math.max(
      2,
      Math.floor(120 / Math.max(1, ledgers.length)),
    ),
    maxSectionsPerLedger: Math.max(
      2,
      Math.floor(80 / Math.max(1, ledgers.length)),
    ),
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
  input.assertActive?.();
  input.onProgress?.("[12%] Laster prosjektkontekst og relevante dokumenter ...");
  const sourceRevisions = await getArtifactSourceRevisions(input.projectId);
  const usesSolutionEvaluation = shouldUseSolutionEvaluationForArtifact({
    artifactType: input.artifactType,
    useSolutionEvaluationContext: input.useSolutionEvaluationContext,
  });
  const [
    project,
    customerAnalysis,
    documents,
    generatedArtifacts,
    serviceDocumentSummaries,
    freshSolutionEvaluationSnapshot,
  ] = await Promise.all([
    getProjectSnapshot(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
    listProjectDocumentsForAnalysis(input.projectId),
    listArtifactKnowledgeCandidatesFresh(input.projectId, input.artifactType),
    listServiceDocumentSummariesForProject(input.projectId),
    usesSolutionEvaluation
      ? getFreshSolutionEvaluationSnapshot(input.projectId)
      : Promise.resolve(null),
  ]);
  if (
    usesSolutionEvaluation &&
    JSON.stringify(freshSolutionEvaluationSnapshot?.dependency ?? null) !==
      JSON.stringify(sourceRevisions.solutionEvaluationDependency)
  ) {
    throw new Error(
      "Løsningsvurderingen ble endret under innlesing. Start genereringen på nytt.",
    );
  }
  input.assertActive?.();
  input.onPhase?.("dokumenthenting");

  const { projectDocuments, serviceDescriptionDocument } =
    splitServiceDescriptionDetails(documents);
  const selectedDocumentIds = new Set(input.sourceDocumentIds ?? []);
  const requestedSourceDocuments = selectedDocumentIds.size
    ? resolveRequestedSourceDocuments({
        requestedDocumentIds: [...selectedDocumentIds],
        projectDocuments,
      })
    : [];
  const { customerDocument, solutionDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  const allFormalRequirementDocuments =
    input.artifactType === "forbedret_kravsvar"
      ? selectRequirementDocumentsForArtifact({
          selectedDocumentIds: new Set(),
          selectedRequirementDocuments: [],
          projectDocuments,
          customerDocument,
          solutionDocument,
          supportingDocuments,
        })
      : [];
  const requirementDocumentsForArtifact =
    input.artifactType === "forbedret_kravsvar"
      ? canonicalRequirementSourceDocuments({
          customerDocument,
          documents: projectDocuments,
        })
      : [];
  if (input.artifactType === "forbedret_kravsvar") {
    assertCompleteRequirementDocumentScope({
      requestedDocumentIds: [...selectedDocumentIds],
      requiredFormalDocuments: allFormalRequirementDocuments,
    });
    assertRequirementDocumentsReadyForGeneration(
      requirementDocumentsForArtifact,
    );
  }
  const requirementFileCandidates =
    input.artifactType === "forbedret_kravsvar"
      ? requirementDocumentsForArtifact
      : [];
  const hydratedRequirementFiles = new Map(
    (
      await hydrateRequirementFileDocuments({
        projectId: input.projectId,
        documents: requirementFileCandidates,
      })
    ).map((document) => [document.id, document] as const),
  );
  input.assertActive?.();
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
  const generationRequirementDocuments = requirementDocumentsForArtifact.map(
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
    input.artifactType === "forbedret_kravsvar" &&
    requirementDocumentsForArtifact.length
      ? generationRequirementDocuments
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
    input.assertActive?.();
    const indexingTasks = [
      ...projectDocuments
        .filter((document) => document.raw_text.trim())
        .map(
          (document) => () =>
            ensureProjectDocumentChunks({ document }).catch((error) => {
              rethrowAuthoritativeLeaseLoss(error);
              return undefined;
            }),
        ),
      ...serviceDescriptionDocuments
        .filter((document) => document.raw_text.trim())
        .map(
          (document) => () =>
            ensureServiceDocumentChunks({ document }).catch((error) => {
              rethrowAuthoritativeLeaseLoss(error);
              return undefined;
            }),
        ),
    ];
    await mapWithConcurrency(
      indexingTasks,
      ARTIFACT_INDEXING_CONCURRENCY,
      (run) => run(),
    );
    input.assertActive?.();
    input.onPhase?.("dokumentindeksering");
  }

  const revisionsBeforeAi = await getArtifactSourceRevisions(input.projectId);
  if (
    revisionsBeforeAi.artifactSourceRevision !==
      sourceRevisions.artifactSourceRevision ||
    revisionsBeforeAi.serviceLibraryRevision !==
      sourceRevisions.serviceLibraryRevision ||
    (usesSolutionEvaluation &&
      JSON.stringify(revisionsBeforeAi.solutionEvaluationDependency) !==
        JSON.stringify(sourceRevisions.solutionEvaluationDependency))
  ) {
    throw new Error(
      "Prosjekt- eller tjenestegrunnlaget ble endret under innlesing. Start genereringen på nytt.",
    );
  }

  input.onProgress?.(
    input.artifactType === "forbedret_kravsvar"
      ? "[42%] Genererer kravbesvarelse med AI ..."
      : "[42%] Genererer nytt utkast med AI ...",
  );
  const solutionEvaluationContextMode = solutionEvaluationContextModeForArtifact({
    artifactType: input.artifactType,
    useSolutionEvaluationContext: input.useSolutionEvaluationContext,
  });
  const solutionEvaluationForGeneration = usesSolutionEvaluation
    ? freshSolutionEvaluationSnapshot?.evaluation ?? null
    : null;
  const initialKnowledgeArtifacts = selectKnowledgeArtifactsForArtifact(
    input.artifactType,
    generatedArtifacts,
  );
  const knowledgeManifestFor = (artifacts: GeneratedArtifact[]) =>
    artifacts.map((artifact) => {
      if (
        !Number.isSafeInteger(artifact.artifact_version) ||
        (artifact.artifact_version ?? 0) <= 0
      ) {
        throw new Error(
          `Kunnskapsartefakten ${artifact.id} mangler en autoritativ versjon. Start genereringen på nytt.`,
        );
      }
      return {
        id: artifact.id,
        artifact_type: artifact.artifact_type,
        artifact_version: artifact.artifact_version as number,
        updated_at: new Date(
          artifact.updated_at ?? artifact.created_at,
        ).toISOString(),
        content_hash: sha256(artifact.content_markdown),
      };
    });
  const refreshedKnowledgeArtifacts = selectKnowledgeArtifactsForArtifact(
    input.artifactType,
    await listArtifactKnowledgeCandidatesFresh(input.projectId, input.artifactType),
  );
  if (
    JSON.stringify(knowledgeManifestFor(initialKnowledgeArtifacts)) !==
    JSON.stringify(knowledgeManifestFor(refreshedKnowledgeArtifacts))
  ) {
    throw new Error(
      "Tidligere generatorarbeid ble endret under klargjøringen. Start genereringen på nytt.",
    );
  }
  const knowledgeArtifacts = refreshedKnowledgeArtifacts;
  const generated = await generateProjectArtifact({
    artifactType: input.artifactType,
    projectName: project.name,
    customerAnalysis,
    solutionEvaluation: solutionEvaluationForGeneration,
    customerDocument: generationCustomerDocument,
    solutionDocument: generationSolutionDocument,
    serviceDescriptionDocument,
    serviceDescriptionDocuments,
    serviceDocumentSummaries,
    supportingDocuments: generationSupportingDocuments,
    requirementDocuments:
      input.artifactType === "forbedret_kravsvar" &&
      generationRequirementDocuments.length
        ? generationRequirementDocuments
        : undefined,
    knowledgeArtifacts,
    instructions: input.instructions?.trim(),
    model: input.model,
    onProgress:
      input.artifactType === "forbedret_kravsvar" ? input.onProgress : undefined,
    documentLedgerContext,
  });
  input.assertActive?.();
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
    ...requirementQualityExpectations(generationMetadata),
  });
  if (qualityReport.status === "fail") {
    throw new Error(
      `Generatorresultatet stoppet i kvalitetskontroll: ${qualityReport.issues.join(" ")}`,
    );
  }
  input.onPhase?.("validering");

  input.onProgress?.("[90%] Lagrer validert generatorresultat i prosjektet ...");
  const sourceDocuments =
    input.artifactType === "forbedret_kravsvar" &&
    requirementDocumentsForArtifact.length
      ? requirementDocumentsForArtifact
      : selectedDocumentIds.size
        ? requestedSourceDocuments
        : projectDocuments;
  const actualModel = artifactGenerationModel(input.artifactType, input.model);
  const knowledgeArtifactManifest = knowledgeManifestFor(knowledgeArtifacts);
  const sourceSnapshot = {
    artifact_source_revision: sourceRevisions.artifactSourceRevision,
    service_library_revision: sourceRevisions.serviceLibraryRevision,
    project: {
      id: input.projectId,
      name: project.name,
    },
    project_documents: buildArtifactProjectDocumentManifests({
      documents,
      hydratedRequirementDocuments: hydratedRequirementFiles,
    }),
    requested_source_document_ids: requestedSourceDocuments.map(
      (document) => document.id,
    ),
    declared_source_document_ids: sourceDocuments.map((document) => document.id),
    service_document_summaries: serviceDocumentSummaries.map((document) => ({
      id: document.id,
      service_id: document.service_id,
      updated_at: document.updated_at,
      ai_summary_updated_at: document.ai_summary_updated_at ?? null,
      summary_hash: sha256(document.ai_summary ?? ""),
    })),
    service_documents: serviceDescriptionDocuments.map((document) => ({
      ...artifactDocumentManifest({
        ...document,
        project_id: input.projectId,
        role: "supporting_document",
        supporting_subtype: null,
        processing_status: "enhanced_ready",
        processing_message: null,
        processing_error: null,
        parser_used: null,
        indexed_at: null,
      }),
      service_id: document.service_id,
    })),
    knowledge_artifacts: knowledgeArtifactManifest,
    customer_analysis_hash: customerAnalysis
      ? sha256(JSON.stringify(customerAnalysis))
      : null,
    solution_evaluation_hash: solutionEvaluationForGeneration
      ? sha256(JSON.stringify(solutionEvaluationForGeneration))
      : null,
    solution_evaluation_used: Boolean(solutionEvaluationForGeneration),
    solution_evaluation_dependency: solutionEvaluationForGeneration
      ? sourceRevisions.solutionEvaluationDependency
      : null,
    model: actualModel,
    embedding_model: DOCUMENT_EMBEDDING_MODEL,
    generator_revision: ARTIFACT_GENERATOR_REVISION,
  };
  const sourceSnapshotHash = artifactSourceSnapshotHash(sourceSnapshot);
  input.assertActive?.();
  const artifact = await saveGeneratedArtifact(
    input.projectId,
    input.artifactType,
    generated.title,
    repaired.contentMarkdown,
    {
      instructions: input.instructions?.trim() || "",
      ...(input.inputSnapshotExtra ?? {}),
      customer_analysis_present: Boolean(customerAnalysis),
      solution_evaluation_present: Boolean(freshSolutionEvaluationSnapshot),
      solution_evaluation_used_as_context: Boolean(
        solutionEvaluationForGeneration,
      ),
      solution_evaluation_context_mode: solutionEvaluationContextMode,
      requested_source_document_ids: requestedSourceDocuments.map(
        (document) => document.id,
      ),
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
      generation_timings: [
        ...(input.timings?.() ?? []),
        ...(input.totalDurationMs
          ? [{ phase: "total", duration_ms: input.totalDurationMs() }]
          : []),
      ],
      source_snapshot: sourceSnapshot,
    },
    {
      expectedArtifactSourceRevision:
        sourceRevisions.artifactSourceRevision,
      expectedServiceLibraryRevision:
        sourceRevisions.serviceLibraryRevision,
      knowledgeArtifactManifest,
      generatorRevision: ARTIFACT_GENERATOR_REVISION,
      sourceSnapshotHash,
      usedSolutionEvaluation: Boolean(solutionEvaluationForGeneration),
      solutionEvaluationDependency: solutionEvaluationForGeneration
        ? sourceRevisions.solutionEvaluationDependency
        : null,
    },
  );
  input.assertActive?.();
  input.onPhase?.("lagring");

  return {
    artifact,
    project: await getProjectSnapshot(input.projectId),
  };
}
