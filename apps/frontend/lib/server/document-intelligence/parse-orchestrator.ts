import "server-only";

import { getProjectWorkflowAbortSignal } from "@/lib/server/project-workflow-cancellation";
import type { ParsedUpload } from "@/lib/server/documents";
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
import { isDocumentIntelligenceV2Enabled } from "@/lib/server/document-intelligence/config";

export type DocumentParseSelection = {
  parsed: ParsedUpload;
  decision: DocumentRoutingDecision;
  selectedQuality: DocumentParseQuality;
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
  const decision = chooseDocumentParserRoute({
    rawText: input.fastParsed.rawText,
    sourceMap: input.fastParsed.sourceMap,
    fileFormat: input.fastParsed.fileFormat,
    fileSizeBytes: input.document.file_size_bytes,
    parserUsed: input.fastParsed.parserUsed,
    isHighImpactDocument:
      input.document.role === "primary_customer_document" ||
      input.document.supporting_subtype === "kravdokument" ||
      input.document.supporting_subtype === "rfp",
    azureAvailable,
    doclingAvailable: input.doclingAvailable,
  });
  if (!isDocumentIntelligenceV2Enabled()) {
    return {
      parsed: input.fastParsed,
      decision,
      selectedQuality: decision.quality,
      localAttempted: false,
      azureAttempted: false,
    };
  }

  const workflowSignal = getProjectWorkflowAbortSignal();
  let selected = input.fastParsed;
  let selectedQuality = decision.quality;
  let localAttempted = false;

  if (decision.route === "docling" && input.extractWithLocalStructure) {
    localAttempted = true;
    await input.onLocalStart?.();
    const localCandidate = await input.extractWithLocalStructure().catch(() => {
      workflowSignal?.throwIfAborted();
      return null;
    });
    if (localCandidate?.rawText.trim()) {
      const localQuality = parseQuality(localCandidate, input.document.file_size_bytes);
      if (
        candidateImprovesParse({
          current: selected,
          currentQuality: selectedQuality,
          candidate: localCandidate,
          candidateQuality: localQuality,
        })
      ) {
        selected = localCandidate;
        selectedQuality = localQuality;
      }
    }
  }

  const postLocalDecision = chooseDocumentParserRoute({
    rawText: selected.rawText,
    sourceMap: selected.sourceMap,
    fileFormat: selected.fileFormat,
    fileSizeBytes: input.document.file_size_bytes,
    parserUsed: selected.parserUsed,
    isHighImpactDocument:
      input.document.role === "primary_customer_document" ||
      input.document.supporting_subtype === "kravdokument" ||
      input.document.supporting_subtype === "rfp",
    azureAvailable,
    doclingAvailable: localAttempted ? false : input.doclingAvailable,
  });
  if (postLocalDecision.route !== "azure_layout" || !azureAvailable) {
    return {
      parsed: selected,
      decision,
      selectedQuality,
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
      localAttempted,
      azureAttempted: true,
    };
  }

  const enhancedQuality = parseQuality(enhanced, input.document.file_size_bytes);
  const enhancedIsUseful = candidateImprovesParse({
    current: selected,
    currentQuality: selectedQuality,
    candidate: enhanced,
    candidateQuality: enhancedQuality,
  });
  return {
    parsed: enhancedIsUseful ? enhanced : selected,
    decision,
    selectedQuality: enhancedIsUseful ? enhancedQuality : selectedQuality,
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

function parseQuality(parsed: ParsedUpload, fileSizeBytes: number) {
  return evaluateDocumentParseQuality({
    rawText: parsed.rawText,
    sourceMap: parsed.sourceMap,
    fileFormat: parsed.fileFormat,
    fileSizeBytes,
  });
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
