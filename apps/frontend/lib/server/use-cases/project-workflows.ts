import "server-only";

import { CUSTOMER_ANALYSIS_SECTIONS } from "@/lib/customer-analysis-history";
import {
  normalizeArtifactInstructions,
  normalizeSourceDocumentIds,
} from "@/lib/server/artifact-generation-input";
import {
  buildDocumentLedger,
  buildDocumentLedgerContext,
} from "@/lib/server/document-ledger";
import { selectProjectDocuments } from "@/lib/server/domain/project-documents";
import {
  analyzeCustomerDocuments,
  evaluateSolutionDocument,
  extractRequirementLedgerForDocument,
  generateExecutiveSummary,
  generateHighLevelDesign,
  inferProjectMetadataFromCustomerDocument,
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
  GeneratedArtifactType,
  ProjectDocumentDetail,
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
      solutionDocumentId?: string;
      model?: string;
    }
  | {
      kind: "artifact_generation";
      projectId: string;
      artifactType: GeneratedArtifactType;
      instructions?: string;
      sourceDocumentIds?: string[];
      useSolutionEvaluationContext?: boolean;
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

function readableDocument(
  document: ProjectDocumentDetail | null,
): document is ProjectDocumentDetail {
  return Boolean(document?.raw_text.trim());
}

const EVALUATION_FILE_LEDGER_FORMATS = new Set(["pdf", "docx", "xlsx", "xls"]);

async function hydrateEvaluationFileDocument(
  projectId: string,
  document: ProjectDocumentDetail,
) {
  if (
    document.file_base64 ||
    !EVALUATION_FILE_LEDGER_FORMATS.has(document.file_format)
  ) {
    return document;
  }

  return getDocumentDetail(projectId, document.id);
}

function compactLedgerText(value: string, maxLength = 420) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function formatRequirementPages(pages: number[]) {
  const sorted = [...new Set(pages)]
    .filter((page) => Number.isFinite(page))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return "";
  }

  return sorted.length === 1
    ? `Side ${sorted[0]}`
    : `Side ${sorted[0]}-${sorted[sorted.length - 1]}`;
}

function formatEvaluationRequirementLedger(input: {
  document: ProjectDocumentDetail;
  ledger: Awaited<ReturnType<typeof extractRequirementLedgerForDocument>>;
}) {
  if (!input.ledger.length) {
    return "";
  }

  const rows = input.ledger.slice(0, 180).map((entry, index) => {
    const source = [
      formatRequirementPages(entry.pages),
      entry.heading,
      entry.tableId,
      entry.id,
    ]
      .filter(Boolean)
      .join(", ");

    return `- ${index + 1}. ${entry.id || `Krav ${index + 1}`} | ${
      source || input.document.title
    } | ${compactLedgerText(entry.text)}`;
  });

  return [
    `Dokument: ${input.document.title}`,
    `Krav funnet: ${input.ledger.length}`,
    ...rows,
  ].join("\n");
}

async function buildEvaluationLedgerContext(input: {
  artifactType: GeneratedArtifactType;
  documents: ProjectDocumentDetail[];
}) {
  const readableDocuments = input.documents.filter(readableDocument).slice(0, 8);
  const documentLedgerContext = buildDocumentLedgerContext({
    artifactType: input.artifactType,
    ledgers: readableDocuments.map(buildDocumentLedger),
  });
  const requirementLedgerResults = await Promise.all(
    readableDocuments.map(async (document) => {
      try {
        const ledger = await extractRequirementLedgerForDocument(document);
        return {
          document,
          ledger,
          context: formatEvaluationRequirementLedger({ document, ledger }),
        };
      } catch (error) {
        console.info(
          JSON.stringify({
            event: "evaluation_requirement_ledger_failed",
            document_id: document.id,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        return {
          document,
          ledger: [] as Awaited<ReturnType<typeof extractRequirementLedgerForDocument>>,
          context: "",
        };
      }
    }),
  );
  const preciseRequirementLedgerContext = requirementLedgerResults
    .map((result) => result.context)
    .filter(Boolean)
    .join("\n\n");

  const context = [
    documentLedgerContext,
    preciseRequirementLedgerContext
      ? [
          "### Presis kravledger for vurdering",
          "Denne kravledgeren er bygget deterministisk fra krav-/svar-dokumentene. Bruk den som primær kravliste for kravdekning, kravrekkefølge og kildehenvisninger. Ikke legg til, fjern eller slå sammen krav i vurderingen.",
          preciseRequirementLedgerContext,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    context,
    requirementLedgerResults,
  };
}

function isLikelyRequirementSourceDocument(document: ProjectDocumentDetail) {
  return (
    document.supporting_subtype === "kravdokument" ||
    /\b(?:bilag\s*2|krav|requirements?)\b/i.test(
      `${document.title} ${document.file_name}`,
    )
  );
}

function sourceRequirementLedgerFromEvaluationBundle(
  bundle: Awaited<ReturnType<typeof buildEvaluationLedgerContext>>,
  documents: ProjectDocumentDetail[],
) {
  const sourceDocumentIds = new Set(
    documents.filter(isLikelyRequirementSourceDocument).map((document) => document.id),
  );
  const sourceResults = bundle.requirementLedgerResults.filter((result) =>
    sourceDocumentIds.has(result.document.id),
  );

  return sourceResults.flatMap((result, documentIndex) =>
    result.ledger.map((entry, entryIndex) => ({
      ...entry,
      documentOrder: documentIndex,
      documentEntryOrder: entryIndex,
    })),
  );
}

function workflowInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new Error("Prosjektjobben mangler gyldig kjøredata.");
  }

  return value as Record<string, unknown>;
}

function requiredWorkflowString(
  value: unknown,
  message: string,
) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }

  return value.trim();
}

function optionalWorkflowString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseWorkflowArtifactType(value: unknown): GeneratedArtifactType {
  if (
    value === "losningsutkast" ||
    value === "bilag1_rekonstruksjon" ||
    value === "forbedret_kravsvar" ||
    value === "gjennomforing_og_risiko"
  ) {
    return value;
  }

  throw new Error("Prosjektjobben har ugyldig artefakttype.");
}

export function parseProjectWorkflowInput(value: unknown): ProjectWorkflowInput {
  const input = workflowInputRecord(value);
  const projectId = requiredWorkflowString(
    input.projectId,
    "Prosjektjobben mangler prosjekt-ID.",
  );
  const model = optionalWorkflowString(input.model);

  switch (input.kind) {
    case "document_ingestion":
      return {
        kind: "document_ingestion",
        projectId,
        documentId: requiredWorkflowString(
          input.documentId,
          "Dokumentjobben mangler dokument-ID.",
        ),
      };
    case "document_docling_enhancement":
      return {
        kind: "document_docling_enhancement",
        projectId,
        documentId: requiredWorkflowString(
          input.documentId,
          "Docling-jobben mangler dokument-ID.",
        ),
      };
    case "customer_analysis":
      return { kind: "customer_analysis", projectId, model };
    case "solution_evaluation":
      return {
        kind: "solution_evaluation",
        projectId,
        solutionDocumentId: optionalWorkflowString(input.solutionDocumentId),
        model,
      };
    case "artifact_generation":
      return {
        kind: "artifact_generation",
        projectId,
        artifactType: parseWorkflowArtifactType(input.artifactType),
        instructions: normalizeArtifactInstructions(input.instructions),
        sourceDocumentIds: normalizeSourceDocumentIds(input.sourceDocumentIds),
        useSolutionEvaluationContext:
          input.useSolutionEvaluationContext === true,
        model,
      };
    case "high_level_design":
      return { kind: "high_level_design", projectId, model };
    case "perfect_system_solution":
      return { kind: "perfect_system_solution", projectId, model };
    case "executive_summary":
      return { kind: "executive_summary", projectId, model };
    default:
      throw new Error("Prosjektjobben har ugyldig jobbtype.");
  }
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
  supportingSubtype?: ProjectDocumentDetail["supporting_subtype"];
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
    input.supportingSubtype === "kravdokument" ||
    (input.fileFormat === "pdf" && looksLikePoorPdfExtraction(input)) ||
    looksLikePdfWithTablesOrRequirements(input.rawText) ||
    looksLikeComplexDocument(input)
  );
}

function shouldUseDoclingOcr(input: {
  fileFormat: ProjectDocumentDetail["file_format"];
  rawText: string;
  sourceMapLength: number;
  fileSizeBytes: number;
}) {
  if (input.fileFormat !== "pdf") {
    return false;
  }

  const configured = process.env.DOCLING_OCR?.trim().toLowerCase();
  if (configured === "on" || configured === "true" || configured === "1") {
    return true;
  }
  if (configured === "off" || configured === "false" || configured === "0") {
    return false;
  }

  return looksLikePoorPdfExtraction(input);
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

async function runDocumentIngestionWorkflow(
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
          supportingSubtype: document.supporting_subtype,
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
          useDoclingOcr: true,
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
      supportingSubtype: document.supporting_subtype,
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
      useDoclingOcr: shouldUseDoclingOcr({
        fileFormat: parsed.fileFormat,
        rawText: parsed.rawText,
        sourceMapLength: parsed.sourceMap.length,
        fileSizeBytes: document.file_size_bytes,
      }),
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

async function runDocumentDoclingEnhancementWorkflow(
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
    supportingSubtype: document.supporting_subtype,
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
    useDoclingOcr: shouldUseDoclingOcr({
      fileFormat: document.file_format,
      rawText: document.raw_text,
      sourceMapLength: document.structure_map.length,
      fileSizeBytes: document.file_size_bytes,
    }),
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

async function runCustomerAnalysisWorkflow(
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

async function runArtifactGenerationWorkflow(
  input: Extract<ProjectWorkflowInput, { kind: "artifact_generation" }>,
  handlers: ProjectWorkflowHandlers,
) {
  return generateAndSaveProjectArtifact({
    projectId: input.projectId,
    artifactType: input.artifactType,
    instructions: input.instructions,
    sourceDocumentIds: input.sourceDocumentIds,
    useSolutionEvaluationContext: input.useSolutionEvaluationContext,
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
  const [projectDocuments, customerAnalysis] = await Promise.all([
    listProjectDocumentsForAnalysis(input.projectId),
    getFreshCustomerAnalysis(input.projectId),
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
  let supportingDocuments = evaluationDocuments.filter(
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

  if (!solutionDocument) {
    throw new Error("Velg dokumentet som skal vurderes som arkitektløsning.");
  }

  [customerDocument, solutionDocument, supportingDocuments] = await Promise.all([
    hydrateEvaluationFileDocument(input.projectId, customerDocument),
    hydrateEvaluationFileDocument(input.projectId, solutionDocument),
    Promise.all(
      supportingDocuments.map((document) =>
        hydrateEvaluationFileDocument(input.projectId, document),
      ),
    ),
  ]);

  handlers.setProgress(
    "Bygger evalueringsledger fra krav, kriterier og dokumentstruktur ...",
  );
  const evaluationLedgerBundle = await buildEvaluationLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    documents: [customerDocument, solutionDocument, ...supportingDocuments].filter(
      readableDocument,
    ),
  });
  const sourceRequirementLedger = sourceRequirementLedgerFromEvaluationBundle(
    evaluationLedgerBundle,
    supportingDocuments,
  );
  handlers.onPhase?.("ledgerbygging");

  handlers.setProgress(
    "Sammenligner systemløsning og importert arkitektløsning ...",
  );
  const result = await evaluateSolutionDocument({
    projectName: customerDocument.title,
    customerDocument,
    solutionDocument,
    supportingDocuments,
    customerAnalysis,
    systemSolutionArtifact: null,
    model: input.model,
    sourceRequirementLedger: sourceRequirementLedger.length
      ? sourceRequirementLedger
      : undefined,
    documentLedgerContext: evaluationLedgerBundle.context,
    onProgress: handlers.setProgress,
  });
  handlers.onPhase?.("ai_vurdering");

  handlers.setProgress("[96%] Lagrer sammenligning og vurdering ...");
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

async function runHighLevelDesignWorkflow(
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

async function runExecutiveSummaryWorkflow(
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

async function runPerfectSystemSolutionWorkflow(
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

  const [
    hydratedCustomerDocument,
    hydratedSolutionDocument,
    hydratedSupportingDocuments,
  ] = await Promise.all([
    hydrateEvaluationFileDocument(input.projectId, customerDocument),
    hydrateEvaluationFileDocument(input.projectId, solutionDocument),
    Promise.all(
      supportingDocuments.map((document) =>
        hydrateEvaluationFileDocument(input.projectId, document),
      ),
    ),
  ]);
  const evaluationLedgerBundle = await buildEvaluationLedgerContext({
    artifactType: "gjennomforing_og_risiko",
    documents: [
      hydratedCustomerDocument,
      hydratedSolutionDocument,
      ...hydratedSupportingDocuments,
    ],
  });
  const sourceRequirementLedger = sourceRequirementLedgerFromEvaluationBundle(
    evaluationLedgerBundle,
    hydratedSupportingDocuments,
  );

  handlers.setProgress("Kjører ny vurdering av forbedret systemløsning ...");
  const improvedEvaluation = await evaluateSolutionDocument({
    projectName: project.name,
    customerDocument: hydratedCustomerDocument,
    solutionDocument: hydratedSolutionDocument,
    supportingDocuments: hydratedSupportingDocuments,
    customerAnalysis,
    systemSolutionArtifact: artifact,
    model: input.model,
    sourceRequirementLedger: sourceRequirementLedger.length
      ? sourceRequirementLedger
      : undefined,
    documentLedgerContext: evaluationLedgerBundle.context,
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
