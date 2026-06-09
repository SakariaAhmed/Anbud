import "server-only";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
} from "@/lib/server/document-ledger";
import { selectProjectDocuments } from "@/lib/server/domain/project-documents";
import {
  analyzeCustomerDocuments,
  evaluateSolutionDocument,
  generateExecutiveSummary,
  generateHighLevelDesign,
  inferProjectMetadataFromCustomerDocument,
  synthesizeAndEvaluateSolution,
} from "@/lib/server/ai";
import {
  canUseDoclingForFormat,
  extractTextFromBuffer,
  isDoclingEnabled,
  type ParsedUpload,
} from "@/lib/server/documents";
import {
  getFreshCustomerAnalysis,
  getSolutionEvaluation,
  saveCustomerAnalysis,
  saveExecutiveSummary,
  saveSolutionEvaluation,
} from "@/lib/server/repositories/analyses";
import {
  listGeneratedArtifacts,
  saveGeneratedArtifact,
} from "@/lib/server/repositories/artifacts";
import {
  getDocumentDetail,
  listProjectDocumentsForAnalysis,
  saveDocumentIngestionResult,
  updateDocumentProcessingState,
} from "@/lib/server/repositories/documents";
import {
  getProjectDetail,
  getProjectSnapshot,
  updateProjectMetadataFromInference,
} from "@/lib/server/repositories/projects";
import {
  listProjectServiceDescriptions,
} from "@/lib/server/repositories/services";
import { splitServiceDescriptionDetails } from "@/lib/service-description";
import type {
  GeneratedArtifact,
  GeneratedArtifactType,
  ProjectDocumentDetail,
  ProjectJobKind,
  ProjectJobResult,
} from "@/lib/types";
import {
  type ArtifactGenerationTiming,
  generateAndSaveProjectArtifact,
} from "@/lib/server/use-cases/generate-artifact";

export type ProjectWorkflowInput =
  | { kind: "document_ingestion"; projectId: string; documentId: string }
  | {
      kind: "document_docling_enhancement";
      projectId: string;
      documentId: string;
    }
  | { kind: "customer_analysis"; projectId: string; model?: string }
  | {
      kind: "solution_evaluation";
      projectId: string;
      allowGeneratedSolution: boolean;
      solutionDocumentId?: string;
      model?: string;
    }
  | {
      kind: "artifact_generation";
      projectId: string;
      artifactType: GeneratedArtifactType;
      instructions?: string;
      sourceDocumentIds?: string[];
      model?: string;
    }
  | { kind: "high_level_design"; projectId: string; model?: string }
  | { kind: "perfect_system_solution"; projectId: string; model?: string }
  | { kind: "executive_summary"; projectId: string; model?: string };

export type ProjectWorkflowPhaseHandler = (phase: string) => void;

export interface ProjectWorkflowHandlers {
  setProgress: (message: string) => void;
  onPhase?: ProjectWorkflowPhaseHandler;
  timings?: () => ArtifactGenerationTiming[];
  totalDurationMs?: () => number;
}

function getLatestSolutionDraft(
  artifacts: GeneratedArtifact[],
): GeneratedArtifact | null {
  return (
    artifacts.find((artifact) => artifact.artifact_type === "losningsutkast") ??
    null
  );
}

function readableDocument(
  document: ProjectDocumentDetail | null,
): document is ProjectDocumentDetail {
  return Boolean(document?.raw_text.trim());
}

async function hydratePdfFileForLayout(
  projectId: string,
  document: ProjectDocumentDetail,
) {
  if (document.file_format !== "pdf" || document.file_base64) {
    return document;
  }

  return getDocumentDetail(projectId, document.id);
}

function assertWorkflowKind(
  value: unknown,
): asserts value is ProjectWorkflowInput {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new Error("Prosjektjobben mangler gyldig kjøredata.");
  }
}

export function workflowKind(input: ProjectWorkflowInput): ProjectJobKind {
  return input.kind;
}

export function parseProjectWorkflowInput(value: unknown): ProjectWorkflowInput {
  assertWorkflowKind(value);
  return value;
}

const DEFAULT_DOCLING_COMPLEXITY_MIN_CHARS = 60_000;
const DEFAULT_DOCLING_COMPLEXITY_MIN_SECTIONS = 80;
const DEFAULT_DOCLING_POOR_EXTRACTION_MAX_CHARS = 2_000;
type DoclingEnhancementMode = "async" | "inline" | "off";

function optionalPositiveNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function doclingEnhancementMode(): DoclingEnhancementMode {
  const configured = process.env.DOCLING_ENHANCEMENT_MODE?.trim().toLowerCase();
  if (configured === "off" || configured === "inline") {
    return configured;
  }

  return "async";
}

function alphaRatio(value: string) {
  if (!value.trim()) {
    return 0;
  }

  const letters = value.match(/[A-Za-zÆØÅæøå]/g)?.length ?? 0;
  return letters / value.length;
}

function looksLikePoorPdfExtraction(input: {
  rawText: string;
  fileSizeBytes: number;
}) {
  const text = input.rawText.trim();
  if (!text) {
    return true;
  }

  const maxChars = optionalPositiveNumberEnv(
    "DOCLING_POOR_EXTRACTION_MAX_CHARS",
    DEFAULT_DOCLING_POOR_EXTRACTION_MAX_CHARS,
  );
  if (input.fileSizeBytes >= 250_000 && text.length < maxChars) {
    return true;
  }

  return text.length >= 400 && alphaRatio(text) < 0.35;
}

function looksLikePdfWithTablesOrRequirements(rawText: string) {
  const lines = rawText.split("\n");
  const tableLineCount = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      (trimmed.includes("|") && trimmed.split("|").length >= 3) ||
      /\S+\s{2,}\S+\s{2,}\S+/.test(trimmed)
    );
  }).length;
  const requirementTermCount =
    rawText.match(
      /\b(?:krav|kravspesifikasjon|skal|må|shall|must|requirement|requirements)\b/gi,
    )?.length ?? 0;
  const requirementIdCount =
    rawText.match(/\b[A-ZÆØÅ]{1,8}-?\d{1,5}(?:\.\d+)*\b/g)?.length ?? 0;

  return (
    tableLineCount >= 3 ||
    requirementTermCount >= 8 ||
    requirementIdCount >= 3 ||
    /\b(?:evalueringskriter|tildelingskriter|award criteria|evaluation criteria)\b/i.test(
      rawText,
    )
  );
}

function looksLikeComplexDocument(input: {
  rawText: string;
  sourceMapLength: number;
}) {
  const minChars = optionalPositiveNumberEnv(
    "DOCLING_COMPLEXITY_MIN_CHARS",
    DEFAULT_DOCLING_COMPLEXITY_MIN_CHARS,
  );
  const minSections = optionalPositiveNumberEnv(
    "DOCLING_COMPLEXITY_MIN_SECTIONS",
    DEFAULT_DOCLING_COMPLEXITY_MIN_SECTIONS,
  );

  return input.rawText.length >= minChars || input.sourceMapLength >= minSections;
}

function shouldRunDoclingEnhancement(input: {
  fileFormat: ProjectDocumentDetail["file_format"];
  parserUsed: string;
  role: ProjectDocumentDetail["role"];
  rawText: string;
  sourceMapLength: number;
  fileSizeBytes: number;
}) {
  if (
    !isDoclingEnabled() ||
    input.parserUsed === "docling" ||
    !canUseDoclingForFormat(input.fileFormat)
  ) {
    return false;
  }

  if (input.fileFormat !== "pdf" && input.fileFormat !== "docx") {
    return false;
  }

  return (
    input.role === "primary_customer_document" ||
    (input.fileFormat === "pdf" && looksLikePoorPdfExtraction(input)) ||
    looksLikePdfWithTablesOrRequirements(input.rawText) ||
    looksLikeComplexDocument(input)
  );
}

function isUsableDoclingResult(
  parsed: ParsedUpload | null,
): parsed is ParsedUpload {
  return parsed?.parserUsed === "docling" && Boolean(parsed.rawText.trim());
}

function isDoclingResultWorthReplacing(input: {
  currentRawText: string;
  enhancedRawText: string;
}) {
  const currentLength = input.currentRawText.trim().length;
  const enhancedLength = input.enhancedRawText.trim().length;
  if (currentLength < 2_000) {
    return enhancedLength > 0;
  }

  return enhancedLength >= currentLength * 0.5;
}

export async function runDocumentIngestionWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "document_ingestion" }>,
  handlers: ProjectWorkflowHandlers,
) {
  try {
    handlers.setProgress("[8%] Henter dokumentfil ...");
    await updateDocumentProcessingState({
      projectId: input.projectId,
      documentId: input.documentId,
      status: "processing",
      message: "Henter dokumentfil ...",
      error: null,
    });
    const document = await getDocumentDetail(input.projectId, input.documentId);
    handlers.onPhase?.("filhenting");

    if (!document.file_base64) {
      throw new Error("Dokumentfilen mangler i lagring.");
    }

    const buffer = Buffer.from(document.file_base64, "base64");

    handlers.setProgress("[22%] Leser dokumentet med rask parser ...");
    await updateDocumentProcessingState({
      projectId: input.projectId,
      documentId: input.documentId,
      status: "processing",
      message: "Leser dokumentet med rask parser ...",
      error: null,
    });
    const parsed = await extractTextFromBuffer({
      buffer,
      fileName: document.file_name,
      contentType: document.content_type,
      role: document.role,
      useDocling: false,
    });
    handlers.onPhase?.("rask_parser");

    if (!parsed.rawText.trim()) {
      const shouldAttemptDocling = shouldRunDoclingEnhancement({
        fileFormat: parsed.fileFormat,
        parserUsed: parsed.parserUsed,
        role: document.role,
        rawText: parsed.rawText,
        sourceMapLength: parsed.sourceMap.length,
        fileSizeBytes: document.file_size_bytes,
      });
      if (shouldAttemptDocling) {
        handlers.setProgress("[48%] Prøver Docling for tekstuttrekk ...");
        await updateDocumentProcessingState({
          projectId: input.projectId,
          documentId: input.documentId,
          status: "processing",
          message: "Prøver Docling for tekstuttrekk ...",
          error: null,
          parserUsed: parsed.parserUsed,
        });

        const enhanced = await extractTextFromBuffer({
          buffer,
          fileName: document.file_name,
          contentType: document.content_type,
          role: document.role,
          useDocling: true,
        }).catch(() => null);

        if (isUsableDoclingResult(enhanced)) {
          handlers.setProgress("[90%] Bygger Docling-baserte chunks ...");
          const enhancedDocument = await saveDocumentIngestionResult({
            projectId: input.projectId,
            documentId: input.documentId,
            role: document.role,
            supportingSubtype: document.supporting_subtype,
            title: document.title,
            fileName: enhanced.fileName,
            fileFormat: enhanced.fileFormat,
            contentType: enhanced.contentType,
            rawText: enhanced.rawText,
            structureMap: enhanced.sourceMap,
            parserUsed: enhanced.parserUsed,
            status: "enhanced_ready",
            message: "Dokumentet er forbedret og klart for RAG.",
          });
          handlers.onPhase?.("docling_indeksering");

          return {
            document: enhancedDocument,
            document_id: input.documentId,
            status: enhancedDocument.processing_status,
            parser_used: enhancedDocument.parser_used ?? enhanced.parserUsed,
            project: await getProjectSnapshot(input.projectId),
          };
        }
      }

      throw new Error(
        "Dokumentet har ingen lesbar tekst. Last opp en tekstbasert PDF/DOCX/Excel-fil, eller bruk OCR før opplasting.",
      );
    }

    const doclingMode = doclingEnhancementMode();
    const hasDoclingEnhancement = shouldRunDoclingEnhancement({
      fileFormat: parsed.fileFormat,
      parserUsed: parsed.parserUsed,
      role: document.role,
      rawText: parsed.rawText,
      sourceMapLength: parsed.sourceMap.length,
      fileSizeBytes: document.file_size_bytes,
    }) && doclingMode !== "off";
    const shouldRunInlineDocling =
      hasDoclingEnhancement && doclingMode === "inline";
    const shouldQueueDoclingEnhancement =
      hasDoclingEnhancement && doclingMode === "async";
    handlers.setProgress(
      shouldRunInlineDocling
        ? "[48%] Lagrer raskt tekstgrunnlag ..."
        : "[48%] Bygger chunks og embeddings ...",
    );
    const basicDocument = await saveDocumentIngestionResult({
      projectId: input.projectId,
      documentId: input.documentId,
      role: document.role,
      supportingSubtype: document.supporting_subtype,
      title: document.title,
      fileName: parsed.fileName,
      fileFormat: parsed.fileFormat,
      contentType: parsed.contentType,
      rawText: parsed.rawText,
      structureMap: parsed.sourceMap,
      parserUsed: parsed.parserUsed,
      status: shouldRunInlineDocling
        ? "processing"
        : shouldQueueDoclingEnhancement
          ? "basic_ready"
          : "enhanced_ready",
      message: shouldRunInlineDocling
        ? "Rask parser er ferdig. Forbedrer struktur med Docling ..."
        : shouldQueueDoclingEnhancement
          ? "Dokumentet er RAG-klart. Docling-forbedring er køet."
        : "Dokumentet er klart for RAG.",
      indexChunks: !shouldRunInlineDocling,
    });
    handlers.onPhase?.(
      shouldRunInlineDocling ? "rask_parser_lagring" : "basic_indeksering",
    );

    if (document.role === "primary_customer_document") {
      handlers.setProgress("[62%] Oppdaterer prosjektmetadata ...");
      try {
        const inferredMetadata = await inferProjectMetadataFromCustomerDocument({
          fileName: parsed.fileName,
          title: document.title,
          rawText: parsed.rawText,
        });
        await updateProjectMetadataFromInference(
          input.projectId,
          inferredMetadata,
        );
      } catch {
        // Metadata inference should not block RAG readiness.
      }
      handlers.onPhase?.("metadata");
    }

    if (!shouldRunInlineDocling) {
      return {
        document: basicDocument,
        document_id: input.documentId,
        status: basicDocument.processing_status,
        parser_used: basicDocument.parser_used ?? parsed.parserUsed,
        project: await getProjectSnapshot(input.projectId),
        docling_enhancement_requested: shouldQueueDoclingEnhancement,
      };
    }

    handlers.setProgress("[78%] Forbedrer struktur med Docling ...");
    await updateDocumentProcessingState({
      projectId: input.projectId,
      documentId: input.documentId,
      status: "processing",
      message: "Forbedrer struktur med Docling ...",
      error: null,
      parserUsed: parsed.parserUsed,
    });
    const enhanced = await extractTextFromBuffer({
      buffer,
      fileName: document.file_name,
      contentType: document.content_type,
      role: document.role,
      useDocling: true,
    });

    if (isUsableDoclingResult(enhanced)) {
      handlers.setProgress("[90%] Oppdaterer forbedrede chunks ...");
      const enhancedDocument = await saveDocumentIngestionResult({
        projectId: input.projectId,
        documentId: input.documentId,
        role: document.role,
        supportingSubtype: document.supporting_subtype,
        title: document.title,
        fileName: enhanced.fileName,
        fileFormat: enhanced.fileFormat,
        contentType: enhanced.contentType,
        rawText: enhanced.rawText,
        structureMap: enhanced.sourceMap,
        parserUsed: enhanced.parserUsed,
        pageCountFallback: basicDocument.page_count,
        status: "enhanced_ready",
        message: "Dokumentet er forbedret og klart for RAG.",
      });
      handlers.onPhase?.("docling_indeksering");

      return {
        document: enhancedDocument,
        document_id: input.documentId,
        status: enhancedDocument.processing_status,
        parser_used: enhancedDocument.parser_used ?? enhanced.parserUsed,
        project: await getProjectSnapshot(input.projectId),
      };
    }

    const fallbackDocument = await saveDocumentIngestionResult({
      projectId: input.projectId,
      documentId: input.documentId,
      role: document.role,
      supportingSubtype: document.supporting_subtype,
      title: document.title,
      fileName: parsed.fileName,
      fileFormat: parsed.fileFormat,
      contentType: parsed.contentType,
      rawText: parsed.rawText,
      structureMap: parsed.sourceMap,
      parserUsed: parsed.parserUsed,
      pageCountFallback: basicDocument.page_count,
      status: "basic_ready",
      message: "Dokumentet er klart for RAG. Docling-forbedring ble hoppet over.",
    });
    handlers.onPhase?.("docling_hoppet_over");

    return {
      document: fallbackDocument,
      document_id: input.documentId,
      status: "basic_ready",
      parser_used: parsed.parserUsed,
      project: await getProjectSnapshot(input.projectId),
    };
  } catch (error) {
    await updateDocumentProcessingState({
      projectId: input.projectId,
      documentId: input.documentId,
      status: "failed",
      message: "Dokumentindeksering feilet.",
      error: error instanceof Error ? error.message : "Ukjent feil.",
    }).catch(() => undefined);
    throw error;
  }
}

export async function runDocumentDoclingEnhancementWorkflow(
  input: Extract<
    ProjectWorkflowInput,
    { kind: "document_docling_enhancement" }
  >,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Henter dokument for Docling-forbedring ...");
  const document = await getDocumentDetail(input.projectId, input.documentId);
  handlers.onPhase?.("filhenting");

  const readyStatus =
    document.processing_status === "enhanced_ready"
      ? "enhanced_ready"
      : "basic_ready";

  if (!document.file_base64 || document.parser_used === "docling") {
    return {
      document,
      document_id: input.documentId,
      status: document.processing_status,
      parser_used: document.parser_used,
      project: await getProjectSnapshot(input.projectId),
      skipped: true,
    };
  }

  const shouldEnhance = shouldRunDoclingEnhancement({
    fileFormat: document.file_format,
    parserUsed: document.parser_used ?? "",
    role: document.role,
    rawText: document.raw_text,
    sourceMapLength: document.structure_map.length,
    fileSizeBytes: document.file_size_bytes,
  });

  if (!shouldEnhance) {
    return {
      document,
      document_id: input.documentId,
      status: document.processing_status,
      parser_used: document.parser_used,
      project: await getProjectSnapshot(input.projectId),
      skipped: true,
    };
  }

  handlers.setProgress("Forbedrer dokumentstruktur med Docling ...");
  await updateDocumentProcessingState({
    projectId: input.projectId,
    documentId: input.documentId,
    status: readyStatus,
    message: "Dokumentet er RAG-klart. Docling-forbedring pågår i bakgrunnen ...",
    error: null,
    parserUsed: document.parser_used,
  });

  const buffer = Buffer.from(document.file_base64, "base64");
  const enhanced = await extractTextFromBuffer({
    buffer,
    fileName: document.file_name,
    contentType: document.content_type,
    role: document.role,
    useDocling: true,
  }).catch(() => null);
  handlers.onPhase?.("docling_parser");

  if (
    !isUsableDoclingResult(enhanced) ||
    !isDoclingResultWorthReplacing({
      currentRawText: document.raw_text,
      enhancedRawText: enhanced.rawText,
    })
  ) {
    await updateDocumentProcessingState({
      projectId: input.projectId,
      documentId: input.documentId,
      status: readyStatus,
      message:
        "Dokumentet er RAG-klart. Docling-forbedring ga ikke bedre tekstgrunnlag.",
      error: null,
      parserUsed: document.parser_used,
    });

    return {
      document,
      document_id: input.documentId,
      status: readyStatus,
      parser_used: document.parser_used,
      project: await getProjectSnapshot(input.projectId),
      skipped: true,
    };
  }

  handlers.setProgress("Erstatter chunks med Docling-forbedret struktur ...");
  const enhancedDocument = await saveDocumentIngestionResult({
    projectId: input.projectId,
    documentId: input.documentId,
    role: document.role,
    supportingSubtype: document.supporting_subtype,
    title: document.title,
    fileName: enhanced.fileName,
    fileFormat: enhanced.fileFormat,
    contentType: enhanced.contentType,
    rawText: enhanced.rawText,
    structureMap: enhanced.sourceMap,
    parserUsed: enhanced.parserUsed,
    pageCountFallback: document.page_count,
    status: "enhanced_ready",
    message: "Dokumentet er forbedret med Docling og klart for RAG.",
  });
  handlers.onPhase?.("docling_indeksering");

  return {
    document: enhancedDocument,
    document_id: input.documentId,
    status: enhancedDocument.processing_status,
    parser_used: enhancedDocument.parser_used ?? enhanced.parserUsed,
    project: await getProjectSnapshot(input.projectId),
    skipped: false,
  };
}

export async function runCustomerAnalysisWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "customer_analysis" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster dokumentgrunnlag ...");
  const [projectDocuments, serviceCandidates] = await Promise.all([
    listProjectDocumentsForAnalysis(input.projectId),
    listProjectServiceDescriptions(input.projectId),
  ]);
  const { projectDocuments: analysisDocuments } =
    splitServiceDescriptionDetails(projectDocuments);
  const { customerDocument, supportingDocuments } =
    selectProjectDocuments(analysisDocuments);
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp minst ett dokument først.");
  }

  if (
    customerDocument.processing_status === "queued" ||
    customerDocument.processing_status === "processing"
  ) {
    throw new Error(
      "Kundedokumentet indekseres fortsatt. Prøv kundeanalysen igjen når dokumentet er RAG-klart.",
    );
  }

  if (customerDocument.processing_status === "failed") {
    throw new Error(
      customerDocument.processing_error ||
        "Kundedokumentet kunne ikke indekseres. Last det opp på nytt eller bruk OCR først.",
    );
  }

  if (!customerDocument.raw_text.trim()) {
    throw new Error(
      "Dokumentgrunnlaget har ingen lesbar tekst. Last opp dokumentet på nytt som tekstbasert PDF/DOCX/Excel-fil, eller bruk OCR først.",
    );
  }

  handlers.setProgress("Analyserer kundedokumentet med AI ...");
  const result = await analyzeCustomerDocuments({
    projectName: customerDocument.title,
    customerDocument,
    supportingDocuments,
    serviceCandidates,
    model: input.model,
  });
  handlers.onPhase?.("ai_analyse");

  handlers.setProgress("Lagrer kundeanalysen ...");
  const analysis = await saveCustomerAnalysis(
    input.projectId,
    [
      customerDocument.id,
      ...supportingDocuments.map((document) => document.id),
    ],
    result,
    {
      previousAnalysis: null,
      updatedSections: [...CUSTOMER_ANALYSIS_SECTIONS],
      historySource: "full_regeneration",
    },
  );
  handlers.onPhase?.("lagring");

  return {
    analysis,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runArtifactGenerationWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "artifact_generation" }>,
  handlers: ProjectWorkflowHandlers,
) {
  return generateAndSaveProjectArtifact({
    projectId: input.projectId,
    artifactType: input.artifactType,
    instructions: input.instructions,
    sourceDocumentIds: input.sourceDocumentIds,
    model: input.model,
    ensureSemanticChunks: true,
    onProgress: handlers.setProgress,
    onPhase: handlers.onPhase,
    timings: handlers.timings,
    totalDurationMs: handlers.totalDurationMs,
  });
}

export async function runSolutionEvaluationWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "solution_evaluation" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster kundedokument, analyse og støttedokumenter ...");
  const [
    projectDocuments,
    customerAnalysis,
    generatedArtifacts,
  ] = await Promise.all([
    listProjectDocumentsForAnalysis(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
    listGeneratedArtifacts(input.projectId),
  ]);
  const { projectDocuments: evaluationDocuments } =
    splitServiceDescriptionDetails(projectDocuments);
  const selectedSolutionDocument = input.solutionDocumentId
    ? evaluationDocuments.find(
        (document) => document.id === input.solutionDocumentId,
      ) ?? null
    : null;
  if (input.solutionDocumentId && !selectedSolutionDocument) {
    throw new Error("Fant ikke dokumentet som skal vurderes som Bilag 2 / arkitektløsning.");
  }
  const selectedDocuments = selectProjectDocuments(evaluationDocuments);
  if (selectedSolutionDocument?.role === "primary_customer_document") {
    throw new Error("Kundedokumentet kan ikke vurderes som Bilag 2 / arkitektløsning.");
  }
  let customerDocument = selectedDocuments.customerDocument;
  if (customerDocument?.id === input.solutionDocumentId) {
    customerDocument =
      evaluationDocuments.find(
        (document) =>
          document.id !== input.solutionDocumentId &&
          document.role === "primary_customer_document",
      ) ??
      evaluationDocuments.find(
        (document) =>
          document.id !== input.solutionDocumentId &&
          document.role !== "primary_solution_document",
      ) ??
      null;
  }
  let solutionDocument =
    selectedSolutionDocument ?? selectedDocuments.solutionDocument ?? null;
  const supportingDocuments = evaluationDocuments.filter(
    (document) =>
      document.id !== customerDocument?.id && document.id !== solutionDocument?.id,
  );
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp eller merk et primært kundedokument først.");
  }

  if (!customerAnalysis) {
    throw new Error("Generer kundeanalyse før løsningsvurdering.");
  }

  handlers.setProgress(
    "Bygger evalueringsledger fra krav, kriterier og dokumentstruktur ...",
  );
  const evaluationLedgers = [
    customerDocument,
    solutionDocument,
    ...supportingDocuments,
  ]
    .filter(readableDocument)
    .slice(0, 8)
    .map(buildDocumentLedger);
  const evaluationLedgerContext = buildDocumentLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    ledgers: evaluationLedgers,
  });
  handlers.onPhase?.("ledgerbygging");

  if (!solutionDocument) {
    if (!input.allowGeneratedSolution) {
      throw new Error("Velg dokumentet som skal vurderes som arkitektløsning.");
    }

    handlers.setProgress("Genererer en kort intern løsningsbeskrivelse ...");
    const generated = await synthesizeAndEvaluateSolution({
      projectName: customerDocument.title,
      customerAnalysis,
      customerDocument,
      supportingDocuments,
      model: input.model,
      documentLedgerContext: evaluationLedgerContext,
    });
    handlers.onPhase?.("ai_syntese_og_vurdering");

    handlers.setProgress("Lagrer systemgenerert utkast ...");
    const artifact = await saveGeneratedArtifact(
      input.projectId,
      "losningsutkast",
      generated.synthetic_solution.title,
      generated.synthetic_solution.content_markdown,
      {
        generated_for: "solution_evaluation_fallback",
        source: "system_generated_when_solution_document_missing",
      },
    );

    handlers.setProgress("Lagrer løsningsvurderingen ...");
    const evaluation = await saveSolutionEvaluation(input.projectId, {
      customerDocumentId: customerDocument.id,
      solutionDocumentId: null,
      result: generated.evaluation,
    });
    handlers.onPhase?.("lagring");

    return {
      evaluation,
      project: await getProjectSnapshot(input.projectId),
      artifact,
      used_generated_solution: true,
    };
  }

  solutionDocument = await hydratePdfFileForLayout(
    input.projectId,
    solutionDocument,
  );

  handlers.setProgress(
    "Sammenligner systemløsning og importert arkitektløsning ...",
  );
  const result = await evaluateSolutionDocument({
    projectName: customerDocument.title,
    customerDocument,
    solutionDocument,
    supportingDocuments,
    customerAnalysis,
    systemSolutionArtifact: getLatestSolutionDraft(generatedArtifacts),
    model: input.model,
    documentLedgerContext: evaluationLedgerContext,
    onProgress: handlers.setProgress,
  });
  handlers.onPhase?.("ai_vurdering");

  handlers.setProgress("Lagrer sammenligning og vurdering ...");
  const evaluation = await saveSolutionEvaluation(input.projectId, {
    customerDocumentId: customerDocument.id,
    solutionDocumentId: solutionDocument.id,
    result,
  });
  handlers.onPhase?.("lagring");

  return {
    evaluation,
    project: await getProjectSnapshot(input.projectId),
    artifact: null,
    used_generated_solution: false,
  };
}

export async function runHighLevelDesignWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "high_level_design" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster kundedokument, analyse og støttedokumenter ...");
  const [documents, customerAnalysis] = await Promise.all([
    listProjectDocumentsForAnalysis(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
  ]);
  const { projectDocuments } = splitServiceDescriptionDetails(documents);
  const { customerDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  handlers.onPhase?.("dokumenthenting");

  if (!customerDocument) {
    throw new Error("Last opp minst ett dokument først.");
  }

  if (!customerAnalysis) {
    throw new Error(
      "Generer kundeanalyse først. High-level design bygger på eksisterende kundeanalyse.",
    );
  }

  handlers.setProgress(
    "Genererer oppdatert high-level design og arkitekturdiagram ...",
  );
  const highLevelDesign = await generateHighLevelDesign({
    projectName: customerDocument.title,
    customerDocument,
    supportingDocuments,
    customerAnalysis,
    model: input.model,
  });
  handlers.onPhase?.("ai_design");

  handlers.setProgress("Lagrer oppdatert high-level design i kundeanalysen ...");
  const analysis = await saveCustomerAnalysis(
    input.projectId,
    [customerDocument.id, ...supportingDocuments.map((document) => document.id)],
    {
      ...customerAnalysis,
      high_level_solution_design: highLevelDesign.high_level_solution_design,
      high_level_architecture_mermaid:
        highLevelDesign.high_level_architecture_mermaid,
    },
    {
      previousAnalysis: customerAnalysis,
      updatedSections: ["design"],
      historySource: "high_level_design_update",
    },
  );
  handlers.onPhase?.("lagring");

  return {
    analysis,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runExecutiveSummaryWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "executive_summary" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster prosjekt, kundeanalyse og vurdering ...");
  const [project, customerAnalysis, solutionEvaluation] = await Promise.all([
    getProjectDetail(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
    getSolutionEvaluation(input.projectId),
  ]);
  handlers.onPhase?.("dokumenthenting");

  if (!solutionEvaluation) {
    throw new Error("Generer vurdering før lederoppsummering.");
  }

  handlers.setProgress("Genererer lederoppsummering ...");
  const generated = await generateExecutiveSummary({
    projectName: project.name,
    customerAnalysis,
    solutionEvaluation,
    model: input.model,
  });
  handlers.onPhase?.("ai_oppsummering");

  handlers.setProgress("Lagrer lederoppsummeringen ...");
  const executiveSummary = await saveExecutiveSummary(input.projectId, generated, {
    source: "solution_evaluation",
    solution_evaluation_present: true,
    solution_evaluation_snapshot: {
      fit_to_customer_needs: solutionEvaluation.fit_to_customer_needs,
      likely_score_assessment: solutionEvaluation.likely_score_assessment,
      architecture_comparison: solutionEvaluation.architecture_comparison,
    },
  });
  handlers.onPhase?.("lagring");

  return {
    executive_summary: executiveSummary,
    project: await getProjectSnapshot(input.projectId),
  };
}

export async function runPerfectSystemSolutionWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "perfect_system_solution" }>,
  handlers: ProjectWorkflowHandlers,
) {
  handlers.setProgress("Laster vurdering, dokumenter og siste løsningsbeskrivelse ...");
  const project = await getProjectDetail(input.projectId);
  handlers.onPhase?.("prosjekthenting");

  if (!project.solution_evaluation) {
    throw new Error("Generer vurdering før du forbedrer systemløsningen.");
  }

  const systemScore =
    project.solution_evaluation.architecture_comparison?.system_solution_score ??
    0;

  if (systemScore >= 100) {
    throw new Error("Systemløsningen har allerede 100/100 i vurderingen.");
  }

  const instructions = [
    `Systemløsningen scoret ${Math.round(systemScore)}/100 i siste vurdering.`,
    "Lag en ny, forbedret systemløsning som eksplisitt lukker alle gap som hindrer 100/100.",
    "Bruk improvement_recommendations, weaknesses, missing_elements, risks_to_customer, rewrite_suggestions og architecture_comparison.strategy_improvement_advice som endringsliste.",
    "Ikke bare kommenter hva som bør gjøres. Skriv inn endringene direkte i løsningsbeskrivelsen.",
    "Målet er en løsningsbeskrivelse som kan vurderes til 100/100 fordi den er kundespesifikk, komplett, gjennomførbar, risikoreduserende og tydelig differensiert.",
    "Hvis vurderingen peker på manglende overgangsmodell, beslutningspunkter, ansvar, risiko, bevis eller kundeverdi, skal dette konkret innarbeides i riktig seksjon.",
  ].join("\n");

  handlers.setProgress("Skriver forbedret systemløsning mot 100/100 ...");
  const { artifact } = await generateAndSaveProjectArtifact({
    projectId: input.projectId,
    artifactType: "losningsutkast",
    instructions,
    model: input.model,
    inputSnapshotExtra: {
      generated_for: "perfect_system_solution",
      previous_system_solution_score: systemScore,
      source: "solution_evaluation_improvement",
    },
    ensureSemanticChunks: true,
    onProgress: handlers.setProgress,
    onPhase: handlers.onPhase,
    timings: handlers.timings,
    totalDurationMs: handlers.totalDurationMs,
  });

  handlers.setProgress("Laster dokumentgrunnlag for ny vurdering ...");
  const [customerAnalysis, documents] = await Promise.all([
    getFreshCustomerAnalysis(input.projectId),
    listProjectDocumentsForAnalysis(input.projectId),
  ]);
  const { projectDocuments } = splitServiceDescriptionDetails(documents);
  const { customerDocument, solutionDocument, supportingDocuments } =
    selectProjectDocuments(projectDocuments);
  handlers.onPhase?.("revalueringsgrunnlag");

  if (!customerDocument || !customerAnalysis || !solutionDocument) {
    return {
      artifact,
      project: await getProjectSnapshot(input.projectId),
    };
  }

  const hydratedSolutionDocument = await hydratePdfFileForLayout(
    input.projectId,
    solutionDocument,
  );

  handlers.setProgress("Kjører ny vurdering av forbedret systemløsning ...");
  const improvedEvaluation = await evaluateSolutionDocument({
    projectName: project.name,
    customerDocument,
    solutionDocument: hydratedSolutionDocument,
    supportingDocuments,
    customerAnalysis,
    systemSolutionArtifact: artifact,
    model: input.model,
  });
  handlers.onPhase?.("ai_revaluering");

  await saveSolutionEvaluation(input.projectId, {
    customerDocumentId: customerDocument.id,
    solutionDocumentId: hydratedSolutionDocument.id,
    result: improvedEvaluation,
  });
  handlers.onPhase?.("vurderingslagring");

  return {
    artifact,
    project: await getProjectSnapshot(input.projectId),
    evaluation: improvedEvaluation,
  };
}

export async function runProjectWorkflow(
  input: ProjectWorkflowInput,
  handlers: ProjectWorkflowHandlers,
): Promise<ProjectJobResult> {
  switch (input.kind) {
    case "document_ingestion":
      return runDocumentIngestionWorkflow(input, handlers);
    case "document_docling_enhancement":
      return runDocumentDoclingEnhancementWorkflow(input, handlers);
    case "customer_analysis":
      return runCustomerAnalysisWorkflow(input, handlers);
    case "solution_evaluation":
      return runSolutionEvaluationWorkflow(input, handlers);
    case "artifact_generation":
      return runArtifactGenerationWorkflow(input, handlers);
    case "high_level_design":
      return runHighLevelDesignWorkflow(input, handlers);
    case "perfect_system_solution":
      return runPerfectSystemSolutionWorkflow(input, handlers);
    case "executive_summary":
      return runExecutiveSummaryWorkflow(input, handlers);
  }
}
