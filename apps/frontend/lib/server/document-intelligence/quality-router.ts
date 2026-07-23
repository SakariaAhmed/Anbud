import type { ProjectDocumentStructureEntry } from "@/lib/types";
import type {
  DocumentParseQuality,
  DocumentRoutingDecision,
} from "@/lib/server/document-intelligence/types";
import {
  detectNorwegianParseAnomalies,
  normalizeNorwegianTextForSearch,
} from "@/lib/server/document-intelligence/norwegian-language";

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number) {
  return Number(value.toFixed(3));
}

function visibleCharacterRatio(text: string) {
  if (!text) return 0;
  const visible = text.match(/[\p{L}\p{N}\p{P}\p{S}\s]/gu)?.length ?? 0;
  return clamp(visible / text.length);
}

function suspiciousCharacterRatio(text: string) {
  if (!text) return 1;
  const suspicious =
    (text.match(/[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu)?.length ?? 0) +
    (text.match(/(?:\S\s){8,}\S/gu)?.join("").length ?? 0) * 0.1;
  return clamp(suspicious / text.length);
}

export function evaluateDocumentParseQuality(input: {
  rawText: string;
  sourceMap: ProjectDocumentStructureEntry[];
  fileFormat: string;
  fileSizeBytes: number;
}): DocumentParseQuality {
  const text = input.rawText.trim();
  const pages = new Set(
    input.sourceMap
      .map((entry) => entry.page)
      .filter((page): page is number => typeof page === "number" && page > 0),
  );
  const tableCount = new Set(
    input.sourceMap
      .filter((entry) => entry.kind?.includes("table") || entry.kind === "table")
      .map((entry, index) => entry.table_index ?? `entry-${index}`),
  ).size;
  const norwegianAnomalies = detectNorwegianParseAnomalies({
    text,
    hasStructuredTables: tableCount > 0,
  });
  const suspiciousRatio = suspiciousCharacterRatio(text);
  const textCoverage = clamp(
    text.length /
      Math.max(
        input.fileFormat === "pdf" ? 1_200 : 500,
        Math.min(40_000, input.fileSizeBytes * (input.fileFormat === "pdf" ? 0.01 : 0.025)),
      ),
  );
  const readability = clamp(visibleCharacterRatio(text) - suspiciousRatio * 3);
  const structureCoverage = clamp(
    input.sourceMap.length / Math.max(6, pages.size * 5 || 6),
  );
  const searchableText = normalizeNorwegianTextForSearch(text);
  const hasRequirementSignals =
    /\b(?:krav|skal|må|shall|must|required|requirement)\b/iu.test(searchableText);
  const hasEvaluationSignals =
    /\b(?:evalueringskriter|tildelingskriter|award criteria|evaluation criteria|vekting)\b/iu.test(
      searchableText,
    );
  const hasUnresolvedVisualReferences =
    /\b(?:figur|diagram|illustrasjon|se tabell|figure|chart|drawing)\s*(?:\d+|[A-Z])?/iu.test(
      searchableText,
    ) && !input.sourceMap.some((entry) => entry.kind === "azure_figure");

  const norwegianPenalty = Math.min(0.28, norwegianAnomalies.length * 0.055);
  const score = clamp(
    textCoverage * 0.42 + readability * 0.38 + structureCoverage * 0.2 -
      norwegianPenalty,
  );

  return {
    score: rounded(score),
    textCoverage: rounded(textCoverage),
    readability: rounded(readability),
    structureCoverage: rounded(structureCoverage),
    sourceEntryCount: input.sourceMap.length,
    pageCount: pages.size,
    tableCount,
    suspiciousCharacterRatio: rounded(suspiciousRatio),
    hasRequirementSignals,
    hasEvaluationSignals,
    hasUnresolvedVisualReferences,
    norwegianAnomalies,
  };
}

export function chooseDocumentParserRoute(input: {
  rawText: string;
  sourceMap: ProjectDocumentStructureEntry[];
  fileFormat: string;
  fileSizeBytes: number;
  parserUsed: string;
  isHighImpactDocument: boolean;
  azureAvailable: boolean;
  doclingAvailable: boolean;
}): DocumentRoutingDecision {
  const quality = evaluateDocumentParseQuality(input);
  const isPdf = input.fileFormat === "pdf";
  const alreadyExternallyStructured = input.parserUsed.startsWith("azure-layout");
  const canTryLocalStructure =
    input.doclingAvailable && input.parserUsed !== "docling";
  const structureSensitive =
    quality.tableCount > 0 ||
    quality.hasRequirementSignals ||
    quality.hasEvaluationSignals;
  const requiresEscalation =
    isPdf &&
    !alreadyExternallyStructured &&
    (quality.score < 0.58 ||
      quality.textCoverage < 0.35 ||
      quality.readability < 0.72 ||
      quality.norwegianAnomalies.includes("unstructured_requirement_table") ||
      (input.isHighImpactDocument && structureSensitive && quality.score < 0.76));

  let route: DocumentRoutingDecision["route"] = "native";
  let reason = "Native parser har tilstrekkelig tekst- og strukturkvalitet.";

  if (requiresEscalation && canTryLocalStructure) {
    route = "docling";
    reason = "PDF-en trenger strukturforbedring; lokal Docling prøves før skytjenester.";
  } else if (requiresEscalation && input.azureAvailable) {
    route = "azure_layout";
    reason =
      input.parserUsed === "docling"
        ? "Lokal strukturforbedring var utilstrekkelig; PDF-en trenger layout/OCR."
        : "PDF-en trenger layout/OCR fordi ingen lokal strukturmotor er tilgjengelig.";
  } else if (requiresEscalation) {
    reason = "Parserkvaliteten er lav, men ingen strukturparser er konfigurert.";
  }

  return {
    route,
    reason,
    quality,
    recommendVisionReview:
      quality.hasUnresolvedVisualReferences &&
      (input.isHighImpactDocument || quality.score < 0.76),
  };
}
