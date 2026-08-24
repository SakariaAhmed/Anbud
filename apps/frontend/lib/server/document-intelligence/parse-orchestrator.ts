import "server-only";

import { getProjectWorkflowAbortSignal } from "@/lib/server/project-workflow-cancellation";
import type { ParsedUpload } from "@/lib/server/documents";
import { buildCanonicalDocumentProjection } from "@/lib/server/document-intelligence/canonical-document";
import { documentSourceContentHash } from "@/lib/server/document-intelligence/content-hash";
import { isHighImpactDocument } from "@/lib/server/document-intelligence/document-policy";
import {
  extractWithAzureLayout,
  isAzureDocumentIntelligenceConfigured,
} from "@/lib/server/document-intelligence/azure-layout";
import {
  chooseDocumentParserRoute,
  evaluateDocumentParseQuality,
} from "@/lib/server/document-intelligence/quality-router";
import type {
  DocumentParseQuality,
  DocumentRoutingDecision,
} from "@/lib/server/document-intelligence/types";
import type { ProjectDocumentDetail } from "@/lib/types";
import { isDocumentAnalysisEnabled } from "@/lib/server/document-intelligence/config";

export type DocumentParseSelection = {
  parsed: ParsedUpload;
  decision: DocumentRoutingDecision;
  selectedQuality: DocumentParseQuality;
  selectedContentHash: string;
  localAttempted: boolean;
  azureAttempted: boolean;
};

export type DocumentParserAttemptEvent = {
  eventType: "parser_escalated" | "parser_fallback";
  sourceRevision: number;
  metadata: Record<string, string | number | boolean | null>;
};

export async function selectBestDocumentParse(input: {
  buffer: Buffer;
  fastParsed: ParsedUpload;
  document: ProjectDocumentDetail;
  doclingAvailable: boolean;
  extractWithLocalStructure?: () => Promise<ParsedUpload | null>;
  onLocalStart?: () => void | Promise<void>;
  onAzureStart?: () => void | Promise<void>;
}): Promise<DocumentParseSelection> {
  const azureAvailable = isAzureDocumentIntelligenceConfigured();
  const fastAssessment = assessParsedUpload(
    input.fastParsed,
    input.document.file_size_bytes,
  );
  const decision = chooseDocumentParserRoute({
    rawText: input.fastParsed.rawText,
    canonicalText: fastAssessment.canonicalText,
    sourceMap: input.fastParsed.sourceMap,
    fileFormat: input.fastParsed.fileFormat,
    fileSizeBytes: input.document.file_size_bytes,
    parserUsed: input.fastParsed.parserUsed,
    isHighImpactDocument: isHighImpactDocument(input.document),
    azureAvailable,
    doclingAvailable: input.doclingAvailable,
    quality: fastAssessment.quality,
  });
  if (!isDocumentAnalysisEnabled()) {
    return {
      parsed: input.fastParsed,
      decision,
      selectedQuality: decision.quality,
      selectedContentHash: fastAssessment.contentHash,
      localAttempted: false,
      azureAttempted: false,
    };
  }

  const workflowSignal = getProjectWorkflowAbortSignal();
  let selected = input.fastParsed;
  let selectedQuality = decision.quality;
  let selectedCanonicalText = fastAssessment.canonicalText;
  let selectedContentHash = fastAssessment.contentHash;
  let localAttempted = false;

  if (decision.route === "docling" && input.extractWithLocalStructure) {
    localAttempted = true;
    await input.onLocalStart?.();
    const localCandidate = await input.extractWithLocalStructure().catch(() => {
      workflowSignal?.throwIfAborted();
      return null;
    });
    if (localCandidate?.rawText.trim()) {
      const localAssessment = assessParsedUpload(
        localCandidate,
        input.document.file_size_bytes,
      );
      if (
        candidateImprovesParse({
          current: selected,
          currentQuality: selectedQuality,
          candidate: localCandidate,
          candidateQuality: localAssessment.quality,
        })
      ) {
        selected = localCandidate;
        selectedQuality = localAssessment.quality;
        selectedCanonicalText = localAssessment.canonicalText;
        selectedContentHash = localAssessment.contentHash;
      }
    }
  }

  const postLocalDecision = chooseDocumentParserRoute({
    rawText: selected.rawText,
    canonicalText: selectedCanonicalText,
    sourceMap: selected.sourceMap,
    fileFormat: selected.fileFormat,
    fileSizeBytes: input.document.file_size_bytes,
    parserUsed: selected.parserUsed,
    isHighImpactDocument: isHighImpactDocument(input.document),
    azureAvailable,
    doclingAvailable: localAttempted ? false : input.doclingAvailable,
    quality: selectedQuality,
  });
  if (postLocalDecision.route !== "azure_layout" || !azureAvailable) {
    return {
      parsed: selected,
      decision,
      selectedQuality,
      selectedContentHash,
      localAttempted,
      azureAttempted: false,
    };
  }

  await input.onAzureStart?.();
  const enhanced = await extractWithAzureLayout({
    buffer: input.buffer,
    fileName: input.fastParsed.fileName,
    contentType: input.fastParsed.contentType,
    fileFormat: input.fastParsed.fileFormat,
    title: input.document.title,
    useHighResolution: shouldUseHighResolution(selectedQuality),
    signal: workflowSignal,
  }).catch(() => {
    workflowSignal?.throwIfAborted();
    return null;
  });
  if (!enhanced?.rawText.trim()) {
    return {
      parsed: selected,
      decision,
      selectedQuality,
      selectedContentHash,
      localAttempted,
      azureAttempted: true,
    };
  }

  const enhancedAssessment = assessParsedUpload(
    enhanced,
    input.document.file_size_bytes,
  );
  const enhancedIsUseful = candidateImprovesParse({
    current: selected,
    currentQuality: selectedQuality,
    candidate: enhanced,
    candidateQuality: enhancedAssessment.quality,
  });
  return {
    parsed: enhancedIsUseful ? enhanced : selected,
    decision,
    selectedQuality: enhancedIsUseful
      ? enhancedAssessment.quality
      : selectedQuality,
    selectedContentHash: enhancedIsUseful
      ? enhancedAssessment.contentHash
      : selectedContentHash,
    localAttempted,
    azureAttempted: true,
  };
}

export function buildDocumentParserAttemptEvents(input: {
  selection: DocumentParseSelection;
  sourceRevision: number;
}): DocumentParserAttemptEvent[] {
  const events: DocumentParserAttemptEvent[] = [];
  if (input.selection.localAttempted) {
    events.push({
      eventType: "parser_escalated",
      sourceRevision: input.sourceRevision,
      metadata: {
        requested_parser: "docling",
        selected_parser: input.selection.parsed.parserUsed,
        quality_score: input.selection.selectedQuality.score,
        norwegian_anomaly_count:
          input.selection.selectedQuality.norwegianAnomalies.length,
      },
    });
  }
  if (input.selection.azureAttempted) {
    events.push({
      eventType:
        input.selection.parsed.parserUsed === "azure-layout-v4"
          ? "parser_escalated"
          : "parser_fallback",
      sourceRevision: input.sourceRevision,
      metadata: {
        requested_parser: "azure-layout-v4",
        selected_parser: input.selection.parsed.parserUsed,
        quality_score: input.selection.decision.quality.score,
        norwegian_anomaly_count:
          input.selection.decision.quality.norwegianAnomalies.length,
      },
    });
  }
  return events;
}

function assessParsedUpload(parsed: ParsedUpload, fileSizeBytes: number) {
  const canonicalText = buildCanonicalDocumentProjection({
    rawText: parsed.rawText,
    structureMap: parsed.sourceMap,
    parserUsed: parsed.parserUsed,
  }).canonicalText;
  return {
    canonicalText,
    contentHash: documentSourceContentHash({
      rawText: parsed.rawText,
      structureMap: parsed.sourceMap,
    }),
    quality: evaluateDocumentParseQuality({
      rawText: parsed.rawText,
      canonicalText,
      sourceMap: parsed.sourceMap,
      fileFormat: parsed.fileFormat,
      fileSizeBytes,
    }),
  };
}

function candidateImprovesParse(input: {
  current: ParsedUpload;
  currentQuality: DocumentParseQuality;
  candidate: ParsedUpload;
  candidateQuality: DocumentParseQuality;
}) {
  const currentLength = input.current.rawText.trim().length;
  const candidateLength = input.candidate.rawText.trim().length;
  const gainedStructure =
    input.candidate.sourceMap.length > input.current.sourceMap.length ||
    input.candidate.sourceMap.some(
      (entry) => entry.kind?.includes("table") || entry.kind === "table",
    );
  return (
    (currentLength < 2_000 || candidateLength >= currentLength * 0.55) &&
    input.candidateQuality.score >= input.currentQuality.score - 0.05 &&
    (gainedStructure || input.candidateQuality.score > input.currentQuality.score)
  );
}

function shouldUseHighResolution(quality: DocumentParseQuality) {
  const configured =
    process.env.AZURE_DOCUMENT_INTELLIGENCE_HIGH_RESOLUTION?.trim().toLowerCase();
  if (configured === "on" || configured === "true" || configured === "1") {
    return true;
  }
  if (configured === "off" || configured === "false" || configured === "0") {
    return false;
  }
  return quality.textCoverage < 0.22 || quality.readability < 0.52;
}
