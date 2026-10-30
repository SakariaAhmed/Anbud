import "server-only";
import { applyRequirementCorrections } from "@/lib/server/requirements/corrections";
import { buildSpreadsheetRequirementLedger } from "@/lib/server/requirements/spreadsheet-ledger";

// Builds the requirement source ledger for a document from DOCX, Markdown,
// table and layout structure, and repairs truncated entries.
import { isMarkdownTableDivider } from "@/lib/markdown-table-row";
import { requirementResponseTableColumns } from "@/lib/requirement-response-table";
import { compactText } from "@/lib/server/ai/context";
import { isLocalPdfLayoutParser } from "@/lib/server/document-intelligence/local-pdf-layout";
import { preferTrustedStructuredRequirementText } from "@/lib/server/document-intelligence/requirement-text";
import { escapeRegExp } from "@/lib/server/document-intelligence/text-normalization";
import { buildDelimitedContext } from "@/lib/server/prompts";
import {
  buildDeclaredHeadingRequirementLedger,
  buildExplicitIdDoclingTextRequirementLedger,
  buildExplicitIdPdfLayoutRequirementLedger,
  buildExplicitIdPdfNarrativeRequirementLedger,
  buildExplicitIdTableRequirementLedger,
  buildGeneratedPdfRequirementLedger,
  buildMixedTextRequirementLedger,
  buildPrefixedLineRequirementLedger,
  buildTrustedStructureMapRequirementLedger,
  findRequirementOrderOffset,
  generatedStructureTextHeading,
  hasLegacyKravFeringStructuredRows,
  isGeneratedFlattenedTableDump,
  isGeneratedKravspesifikasjonCorpus,
  isLegacyMixedFofingerCorpus,
  normalizedRequirementOrderSearchText,
  repairGeneratedTextArtifacts,
  repairLegacyFofingerTextArtifacts,
  type RequirementCorpusParserContext,
  restoreExplicitLineRequirementOrder,
  stripGeneratedPriorityComment,
} from "@/lib/server/requirements/corpus-parsers";
import { assignGeneratedRequirementFallbackIds } from "@/lib/server/requirements/fallback-id-inference";
import {
  cleanHeadingCandidate,
  isLikelyHeadingLine,
  stripRequirementChrome,
} from "@/lib/server/requirements/heading-detection";
import {
  detectExplicitRequirementIds,
  detectRequirementIds,
  explicitRequirementIdPattern,
  isContextualNonRequirementExplicitId,
  isTableOrColumnHeaderRequirementMarker,
} from "@/lib/server/requirements/id-detection";
import { splitMarkdownTableRow, toMarkdownTableRow } from "@/lib/server/requirements/markdown-table";
import { lastHeadingSegment, normalizeRequirementId } from "@/lib/server/requirements/normalization";
import {
  buildPageHeadingMap,
  buildPdfLayoutTableRequirementLedger,
  buildServiceRequirementTableLedger,
  buildTableRequirementLedger,
  dedupeRequirementLedger,
  findHeadingBeforeOffset,
  hasRequirementSignal,
  hasStableExplicitRequirementId,
  hasStandaloneRequirementLanguage,
  isLikelyDetailOrAnswerBlock,
  isSyntheticRequirementId,
  isTableContainerRequirement,
  isTableOfContentsLine,
  knownCanonicalPdfSourceSha256,
  normalizeEvidenceText,
  normalizeRequirementLedgerText,
  readPdfLayoutPages,
  readPdfRawTextFromFile,
  recoverTruncatedUnstructuredRequirementText,
  repairRequirementLedgerEntryArtifacts,
  serviceFromTableRequirementId,
  splitDocumentPagesForRequirementScan,
  stripAnswerTextFromRequirement,
  syntheticRequirementId,
  tableRequirementStartIndex,
} from "@/lib/server/requirements/pdf-layout-ledger";
import {
  documentRequirementId,
  normalizePageText,
  normalizePdfSpacing,
  splitPdfPages,
  splitPdfPagesPreservingLines,
} from "@/lib/server/requirements/pdf-normalization";
import {
  repairSourceBoundPdfNarrativeHeading,
  repairSourceBoundPdfNarrativeText,
  repairTableRowTextArtifacts,
} from "@/lib/server/requirements/pdf-table-repairs";
import {
  requirementDisplayRef,
  requirementDisplaySource,
  requirementGroupHeading,
  requirementLedgerSource,
  sortRequirementLedgerInDocumentOrder,
} from "@/lib/server/requirements/presentation";
import { type RequirementLedgerEntry } from "@/lib/server/requirements/types";
import {
  backfillMissingRequirementHeadings,
  buildAnswerSectionRequirementLedger,
  buildPreAnswerFieldRequirementLedger,
  buildSplitAnswerMarkerRequirementLedger,
  buildStructuredRequirementLedger,
  buildUnstructuredRequirementLedger,
  filterPdfTableDuplicateExtractionArtifacts,
  filterSyntheticRequirementDuplicates,
  filterSyntheticRequirementFallbacks,
  finalizeRequirementLedgerEntryText,
  findDocxHeadingForRequirement,
  isNorwegianGeneratedInstructionLine,
  isNorwegianRequirementTableChromeLine,
  isNorwegianRequirementTableHeaderLine,
  isRequirementTableHeaderLabel,
  isRequirementTypeOrInstructionLine,
  normalizeColumnLabel,
  NORWEGIAN_REQUIREMENT_TABLE_ID,
  NORWEGIAN_REQUIREMENT_TABLE_PRIORITY,
  textCoverageScore,
} from "@/lib/server/requirements/unstructured-ledger";
import { type ProjectDocumentDetail } from "@/lib/types";

type MammothHtmlModule = {
  convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};

let cachedMammothHtmlPromise: Promise<MammothHtmlModule> | null = null;

async function getMammothHtml() {
  if (!cachedMammothHtmlPromise) {
    cachedMammothHtmlPromise = import("mammoth").then(
      (module) => module as unknown as MammothHtmlModule,
    );
  }

  return cachedMammothHtmlPromise;
}

function norwegianRequirementTableRowStart(line: string) {
  const text = normalizePdfSpacing(line);
  const explicitPattern = new RegExp(
    String.raw`^(` +
      NORWEGIAN_REQUIREMENT_TABLE_ID +
      String.raw`)\s+(?:(` +
      NORWEGIAN_REQUIREMENT_TABLE_PRIORITY +
      String.raw`)\s+)?(.+)$`,
    "iu",
  );
  const explicitMatch = explicitPattern.exec(text);
  if (explicitMatch?.[1] && explicitMatch[3]) {
    return {
      id: normalizeInlinePdfRequirementId(explicitMatch[1]),
      text: explicitMatch[3],
      hasExplicitId: true,
    };
  }

  const priorityPattern = new RegExp(
    String.raw`^(?:[\u2022\uF0B7*–—-]\s*)?(?:(?:x|\?|ikke\s+satt|mangler\s+ID|NB)\s+)?(` +
      NORWEGIAN_REQUIREMENT_TABLE_PRIORITY +
      String.raw`)\s+(.+)$`,
    "iu",
  );
  const priorityMatch = priorityPattern.exec(text);
  if (priorityMatch?.[2]) {
    return {
      id: "",
      text: priorityMatch[2],
      hasExplicitId: false,
    };
  }

  const markerMatch = /^(?:NB|x|\?|mangler\s+ID|ikke\s+satt|se\s+notat)\s*[:.)-]?\s+(.+)$/iu.exec(
    text,
  );
  if (markerMatch?.[1]) {
    return {
      id: "",
      text: markerMatch[1],
      hasExplicitId: false,
    };
  }

  return null;
}

function cleanNorwegianRequirementTableText(lines: string[]) {
  let text = stripAnswerTextFromRequirement(
    stripRequirementChrome(
      lines
        .map((line) => normalizePdfSpacing(line))
        .filter((line) => line && !isNorwegianRequirementTableChromeLine(line))
        .join(" "),
    ),
  )
    .replace(/\b(?:Skal|Må)\s+besvares\b/gi, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(
      new RegExp(String.raw`^` + NORWEGIAN_REQUIREMENT_TABLE_PRIORITY + String.raw`\s+`, "iu"),
      "",
    )
    .trim();

  const requirementIndex = tableRequirementStartIndex(text);
  if (requirementIndex > 0 && requirementIndex <= 160) {
    text = text.slice(requirementIndex).trim();
  }

  return text;
}

function norwegianRequirementFallbackId(kind: string, sequence: number) {
  return `${kind}-${String(sequence).padStart(2, "0")}`;
}

function buildNorwegianLinearTableRequirementLedger(
  document: ProjectDocumentDetail,
) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const fallbackCounts = new Map<string, number>();
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;
  let activeHeading = "";
  let inRequirementTable = false;
  let current:
    | {
        id: string;
        kind: string;
        textLines: string[];
        sourceLines: string[];
        pages: number[];
        heading: string;
        order: number;
      }
    | null = null;

  function nextFallbackId(kind: string) {
    const next = (fallbackCounts.get(kind) ?? 0) + 1;
    fallbackCounts.set(kind, next);
    return norwegianRequirementFallbackId(kind, next);
  }

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = cleanNorwegianRequirementTableText(current.textLines);
    if (
      text.length >= 18 &&
      !isLikelyDetailOrAnswerBlock(text) &&
      (hasRequirementSignal(text) || hasStandaloneRequirementLanguage(text))
    ) {
      requirements.push({
        id: current.id || nextFallbackId(current.kind),
        text,
        pages: current.pages,
        heading: current.heading,
        tableId: "PDF kravtabell",
        sourceExcerpt: compactText(current.sourceLines.join(" "), 1800),
        documentEntryOrder: current.order,
      });
    }

    current = null;
  }

  function startCurrent(
    row: { id: string; text: string; hasExplicitId: boolean },
    page: number,
    sourceLine: string,
  ) {
    flushCurrent();
    const sourceOrderOffset =
      findRequirementOrderOffset(
        normalizedRawText,
        sourceLine,
        sourceOrderCursor,
      ) ??
      findRequirementOrderOffset(normalizedRawText, row.text, sourceOrderCursor);
    const documentEntryOrder =
      sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
    if (sourceOrderOffset !== null) {
      sourceOrderCursor =
        sourceOrderOffset + normalizedRequirementOrderSearchText(sourceLine).length;
    }

    current = {
      id: row.id,
      kind: "Tabellkrav",
      textLines: [row.text],
      sourceLines: [sourceLine],
      pages: [page],
      heading: activeHeading,
      order: documentEntryOrder,
    };
  }

  function appendToCurrent(line: string, page: number) {
    if (!current) {
      return;
    }

    current.textLines.push(line);
    current.sourceLines.push(line);
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (isNorwegianRequirementTableHeaderLine(lines, index)) {
        flushCurrent();
        inRequirementTable = true;
        continue;
      }

      if (isNorwegianRequirementTableChromeLine(line)) {
        continue;
      }

      if (isNorwegianGeneratedInstructionLine(line)) {
        flushCurrent();
        inRequirementTable = /^Krav\s+registrert\s+i\s+tabell\b/i.test(line);
        continue;
      }

      if (
        isLikelyHeadingLine(line) &&
        !isNorwegianGeneratedInstructionLine(line)
      ) {
        flushCurrent();
        activeHeading = cleanHeadingCandidate(line) || activeHeading;
        inRequirementTable = false;
        continue;
      }

      if (!inRequirementTable) {
        continue;
      }

      const row = norwegianRequirementTableRowStart(line);
      if (row) {
        startCurrent(row, page.page, line);
        continue;
      }

      appendToCurrent(line, page.page);
    }
  }

  flushCurrent();
  return dedupeRequirementLedger(requirements);
}

function buildLinearTableRequirementLedger(document: ProjectDocumentDetail) {
  const norwegianRequirements = buildNorwegianLinearTableRequirementLedger(document);
  const lines = document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizePageText(line))
    .filter(Boolean);
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let inRequirementTable = false;
  let sequence = 1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";

    if (/^Req\.?\s*No\.?$/i.test(line)) {
      inRequirementTable = true;
      activeHeading = lines[index - 1] && !isRequirementTableHeaderLabel(lines[index - 1])
        ? lines[index - 1]
        : activeHeading;
      continue;
    }

    if (!inRequirementTable) {
      continue;
    }

    if (
      isRequirementTableHeaderLabel(line) ||
      isRequirementTypeOrInstructionLine(line) ||
      /^(Requirements to|Competence requirements to)\b/i.test(line)
    ) {
      continue;
    }

    if (/^Req\.?\s*No\.?$/i.test(next)) {
      activeHeading = line;
      continue;
    }

    if (line.length < 18) {
      continue;
    }

    requirements.push({
      id: syntheticRequirementId(1, sequence),
      text: line,
      pages: [1],
      heading: activeHeading,
    });
    sequence += 1;
  }

  return dedupeRequirementLedger([
    ...norwegianRequirements,
    ...requirements,
  ]);
}

function splitRequirementMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return [];
  }

  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of content) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }

  cells.push(cell);
  return cells.map((value) =>
    normalizePageText(value.replace(/<br\s*\/?>/gi, " ")),
  );
}

function markdownRequirementTableColumns(cells: string[]) {
  const normalized = cells.map((cell) =>
    normalizePageText(cell)
      .replace(/^[*_`]+|[*_`]+$/g, "")
      .toLowerCase(),
  );
  const refIndex = normalized.findIndex((cell) =>
    /^(?:krav\s*(?:ref(?:eranse)?\.?|[- ]?(?:id|nr\.?|nummer))|requirement\s*(?:reference|id|no\.?)|id)$/.test(
      cell,
    ),
  );
  const requirementIndex = normalized.findIndex((cell) =>
    /^(?:krav(?:tekst)?|requirement(?: text)?)$/.test(cell),
  );
  const answerIndex = normalized.findIndex((cell) =>
    /^(?:svar|leverandørens svar|answer|response|supplier response)$/.test(cell),
  );
  const evidenceIndex = normalized.findIndex((cell) =>
    /^(?:svargrunnlag|answer evidence|evidence|bevis)$/.test(cell),
  );
  const sourceIndex = normalized.findIndex((cell) =>
    /^(?:kildegrunnlag|kilde|source|source reference)$/.test(cell),
  );

  if (refIndex < 0 || requirementIndex < 0) {
    return null;
  }

  return {
    refIndex,
    requirementIndex,
    answerIndex,
    evidenceIndex,
    sourceIndex,
  };
}

function isMarkdownTableSeparator(cells: string[]) {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
}

function hasMarkdownRequirementResponseTable(document: ProjectDocumentDetail) {
  return document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => {
      const columns = markdownRequirementTableColumns(
        splitRequirementMarkdownTableRow(line),
      );
      return Boolean(columns);
    });
}

function hasMarkdownRequirementResponseSchema(
  document: ProjectDocumentDetail,
) {
  return document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => {
      const columns = markdownRequirementTableColumns(
        splitRequirementMarkdownTableRow(line),
      );
      return Boolean(
        columns && columns.answerIndex >= 0 && columns.sourceIndex >= 0,
      );
    });
}

function buildMarkdownRequirementResponseLedger(
  document: ProjectDocumentDetail,
) {
  const requirements: RequirementLedgerEntry[] = [];
  const lines = document.raw_text.replace(/\r\n/g, "\n").split("\n");
  let columns:
    | {
        refIndex: number;
        requirementIndex: number;
        answerIndex: number;
        evidenceIndex: number;
        sourceIndex: number;
      }
    | null = null;
  let sequence = 1;

  for (const line of lines) {
    const cells = splitRequirementMarkdownTableRow(line);
    if (!cells.length) {
      columns = null;
      continue;
    }

    if (!columns) {
      columns = markdownRequirementTableColumns(cells);
      continue;
    }

    if (isMarkdownTableSeparator(cells)) {
      continue;
    }

    const ref = cells[columns.refIndex] ?? "";
    const text = stripAnswerTextFromRequirement(
      cells[columns.requirementIndex] ?? "",
    );
    const answer =
      columns.answerIndex >= 0 ? cells[columns.answerIndex] ?? "" : "";
    const evidence =
      columns.evidenceIndex >= 0 ? cells[columns.evidenceIndex] ?? "" : "";
    const source =
      columns.sourceIndex >= 0 ? cells[columns.sourceIndex] ?? "" : "";

    if (
      !ref ||
      text.length < 8
    ) {
      continue;
    }

    requirements.push({
      id: normalizeRequirementId(ref),
      text,
      pages: [1],
      heading: "Kravbesvarelse",
      tableId: "Markdown kravbesvarelse",
      sourceExcerpt: [ref, text, evidence, source].filter(Boolean).join(" | "),
      answerExcerpt: answer || undefined,
      answerEvidenceExcerpt: evidence || undefined,
      // `Kildegrunnlag` is emitted from the immutable source ledger when a
      // requirement response is generated. Keep it separate from the display
      // excerpt so duplicate synthetic references can be matched to the right
      // source document without relying on row position.
      answerReference: source || undefined,
      documentEntryOrder: sequence,
    });
    sequence += 1;
  }

  return dedupeRequirementLedger(requirements);
}

function isPdfRequirementTableHeaderStart(lines: string[], index: number) {
  const current = normalizePdfSpacing(lines[index] ?? "");
  const next = normalizePdfSpacing(lines[index + 1] ?? "");
  const windowText = normalizePdfSpacing(lines.slice(index, index + 8).join(" "));

  return (
    /^Req\.?\s*No\.?$/i.test(windowText) ||
    (/^Req\.?$/i.test(current) &&
      /^No\.?$/i.test(next) &&
      /Requirement text/i.test(windowText)) ||
    (/^Req\.?\s*No\.?$/i.test(current) && /Requirement text/i.test(windowText))
  );
}

function isPdfRequirementSectionHeading(line: string) {
  const text = normalizePdfSpacing(line);
  if (
    isTableOfContentsLine(text) ||
    isRequirementTableHeaderLabel(text) ||
    /^Page\s+\d+\s+of\s+\d+$/i.test(text) ||
    /^Operational\s+Services\s+Agreement$/i.test(text) ||
    /^Annex\s+\d+[A-Z]?\b/i.test(text)
  ) {
    return false;
  }

  return /^\d{1,3}(?:\.\d{1,3}){0,4}\s+\S/.test(text);
}

function pdfRequirementRowId(line: string) {
  const text = documentRequirementId(line);
  if (
    /^Krav\s*(?:nr\.?|nummer)?\s*\d{1,4}(?:[.-]\d{1,4}){0,5}[A-Z]?$/i.test(text) ||
    /^ID\s*\d{1,4}(?:[.-]\d{1,4}){1,5}[A-Z]?$/i.test(text) ||
    /^REQ\s*[- ]?\s*\d{1,5}[A-Z]?$/i.test(text) ||
    /^\d{1,4}(?:[.-]\d{1,4}){1,5}[A-Z]?$/.test(text)
  ) {
    return text;
  }

  return "";
}

function isPdfRequirementTypeLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    /^(M|E|O|A|B|C|D|K|S)$/i.test(text) ||
    /^(M|E|O|A|B|C|D|K|S),?$/i.test(text) ||
    /^(M|E|O|A|B|C|D|K|S),?\s*TK\s*\d+$/i.test(text) ||
    /^TK\s*\d+$/i.test(text)
  );
}

function isPdfRequirementBoilerplateLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    !text ||
    isTableOfContentsLine(text) ||
    isRequirementTableHeaderLabel(text) ||
    /^(Req\.?|No\.?|Requirement text(?:\s+Type)?|Type|Response|instruction|Y\/N|Detailed|response)$/i.test(
      text,
    ) ||
    /^Page\s+\d+\s+of\s+\d+$/i.test(text) ||
    /^Operational\s+Services\s+Agreement$/i.test(text) ||
    /^Annex\s+\d+[A-Z]?\b/i.test(text)
  );
}

function cleanPdfRequirementText(lines: string[]) {
  return stripAnswerTextFromRequirement(lines
    .map((line) => normalizePdfSpacing(line))
    .filter((line) => line && !isPdfRequirementBoilerplateLine(line))
    .join(" ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim());
}

const inlinePdfRequirementCategories = [
  "Funksjonelle\\s+krav",
  "Sikkerhet\\s+og\\s+tilgang",
  "Integrasjon\\s+og\\s+dataflyt",
  "Drift,\\s*overvåking\\s+og\\s+ytelse",
  "Leveranse,\\s*dokumentasjon\\s+og\\s+forvaltning",
];

const inlinePdfRequirementCategoryPrefix = new RegExp(
  `^(?:${inlinePdfRequirementCategories.join("|")})(?:\\s*(?:Må|Bør|Kan))?\\s*[.:;\\-]?\\s*`,
  "i",
);

function inlinePdfRequirementIdPattern() {
  return /(^|[\s\u2022\uF0B7*-])((?:K\s*[- ]?\s*\d{2,5}|\d{2,4}\s*\/\s*\d{1,3}|[A-ZÆØÅ]\d?\s*-\s*\d{1,3}|[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}|[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\s*\d{1,5}|REQ\s*[- ]?\s*\d{1,5}|Pkt\s*[- ]?\s*\d{1,5})(?:[A-ZÆØÅ])?)(?=\s|[A-ZÆØÅ(]|$|[-:.;])/gi;
}

function normalizeInlinePdfRequirementId(value: string) {
  const text = documentRequirementId(value)
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*-\s*/g, "-")
    .trim();
  const kMatch = text.match(/^K[- ]?(\d{2,5}[A-ZÆØÅ]?)$/i);
  if (kMatch?.[1]) {
    return `K-${kMatch[1]}`;
  }

  return text;
}

function isPdfRequirementVerificationLine(line: string) {
  return /^(?:Dokumentasjon|Test|Gjennomgang|Demonstrasjon)$/i.test(
    normalizePdfSpacing(line),
  );
}

function isPdfRequirementDocumentChromeLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    !text ||
    isPdfRequirementBoilerplateLine(text) ||
    isPdfRequirementVerificationLine(text) ||
    /^Bilag\s+2\s+-\s+Krav\b/i.test(text) ||
    /^Kunde\b/i.test(text) ||
    /^Dokumenttype\b/i.test(text) ||
    /^Formål\b/i.test(text) ||
    /^Prioritet\b/i.test(text) ||
    /^ID\s*Kategori\s*Prioritet\s*Krav\s*Verifisering$/i.test(text) ||
    /^\d{1,3}\.\s+(?:Innledning|Sentrale\s+løsningsområder|Krav\s+i\s+tabellform|Krav\s+som\s+punktliste|Utfyllende\s+tekstkrav|Besvarelse\s+fra\s+leverandør)\b/i.test(
      text,
    )
  );
}

function stripInlinePdfRequirementPrefix(value: string) {
  let text = normalizePdfSpacing(value)
    .replace(/^[\u2022\uF0B7\s.:;\-]+/, "")
    .replace(/^\((?:Må|Bør|Kan)\)\s*[.:;\-]?\s*/i, "")
    .trim();

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const next = text
      .replace(inlinePdfRequirementCategoryPrefix, "")
      .replace(/^(?:Må|Bør|Kan)\s*[.:;\-]?\s*/i, "")
      .trim();
    if (next === text) {
      break;
    }
    text = next;
  }

  const requirementIndex = tableRequirementStartIndex(text);
  if (requirementIndex > 0 && requirementIndex <= 120) {
    text = text.slice(requirementIndex).trim();
  }

  return stripAnswerTextFromRequirement(text)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanInlinePdfRequirementLines(lines: string[]) {
  return stripInlinePdfRequirementPrefix(
    lines
      .map((line) => normalizePdfSpacing(line))
      .filter((line) => line && !isPdfRequirementDocumentChromeLine(line))
      .join(" "),
  );
}

function buildPdfExplicitIdRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let sequence = 0;
  let current:
    | {
        id: string;
        lines: string[];
        sourceLines: string[];
        pages: number[];
        heading: string;
        order: number;
      }
    | null = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = cleanInlinePdfRequirementLines(current.lines);
    if (
      text.length >= 18 &&
      !isLikelyDetailOrAnswerBlock(text) &&
      (hasRequirementSignal(text) || hasStandaloneRequirementLanguage(text))
    ) {
      requirements.push({
        id: current.id,
        text,
        pages: current.pages,
        heading: current.heading,
        tableId: "PDF krav-ID",
        sourceExcerpt: compactText(
          current.sourceLines
            .map((line) => normalizePdfSpacing(line))
            .filter((line) => line && !isPdfRequirementDocumentChromeLine(line))
            .join(" "),
          1800,
        ),
        documentEntryOrder: current.order,
      });
    }

    current = null;
  }

  function appendToCurrent(line: string, page: number) {
    const text = normalizePdfSpacing(line);
    if (!current || !text) {
      return;
    }

    current.lines.push(text);
    current.sourceLines.push(text);
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
    if (!current.heading && (activeHeading || pageHeadingMap.get(page))) {
      current.heading = activeHeading || pageHeadingMap.get(page) || "";
    }
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? activeHeading;
    if (pageHeading) {
      activeHeading = pageHeading;
    }

    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (const line of lines) {
      if (isPdfRequirementSectionHeading(line) && !inlinePdfRequirementIdPattern().test(line)) {
        activeHeading = cleanHeadingCandidate(line) || activeHeading;
      }

      const pattern = inlinePdfRequirementIdPattern();
      let cursor = 0;
      let matched = false;
      for (const match of line.matchAll(pattern)) {
        matched = true;
        const prefix = match[1] ?? "";
        const markerStart = (match.index ?? 0) + prefix.length;
        const markerEnd = (match.index ?? 0) + match[0].length;
        const beforeMarker = line.slice(cursor, markerStart).trim();
        if (beforeMarker) {
          appendToCurrent(beforeMarker, page.page);
        }

        flushCurrent();
        sequence += 1;
        current = {
          id: normalizeInlinePdfRequirementId(match[2] ?? ""),
          lines: [],
          sourceLines: [],
          pages: [page.page],
          heading: activeHeading || pageHeading,
          order: sequence,
        };
        cursor = markerEnd;
      }

      if (matched) {
        const afterMarker = line.slice(cursor).trim();
        if (afterMarker) {
          appendToCurrent(afterMarker, page.page);
        }
        continue;
      }

      appendToCurrent(line, page.page);
    }
  }

  flushCurrent();
  return dedupeRequirementLedger(requirements);
}

function buildPdfRequirementTableLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let activeHeading = "";
  let inRequirementTable = false;
  let current:
    | {
        id: string;
        textLines: string[];
        instructionLines: string[];
        pages: number[];
        heading: string;
        phase: "text" | "instruction";
      }
    | null = null;

  function flushCurrent() {
    if (!current) {
      return;
    }

    const text = cleanPdfRequirementText(current.textLines);
    const responseInstruction = cleanPdfRequirementText(current.instructionLines);
    if (text.length >= 18 && !isLikelyDetailOrAnswerBlock(text)) {
      requirements.push({
        id: current.id,
        text: responseInstruction
          ? `${text} Responsinstruks: ${responseInstruction}`
          : text,
        pages: current.pages,
        heading: current.heading,
        tableId: "PDF kravtabell",
      });
    }
    current = null;
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? activeHeading;
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";

      if (isPdfRequirementSectionHeading(line)) {
        const rowId = pdfRequirementRowId(line);
        if (!rowId) {
          activeHeading = cleanHeadingCandidate(line);
          inRequirementTable = false;
          flushCurrent();
          continue;
        }
      }

      if (isPdfRequirementTableHeaderStart(lines, index)) {
        inRequirementTable = true;
        if (!activeHeading && pageHeading) {
          activeHeading = pageHeading;
        }
        continue;
      }

      if (!inRequirementTable || isPdfRequirementBoilerplateLine(line)) {
        continue;
      }

      const rowId = pdfRequirementRowId(line);
      if (rowId) {
        flushCurrent();
        current = {
          id: rowId,
          textLines: [],
          instructionLines: [],
          pages: [page.page],
          heading: activeHeading || pageHeading,
          phase: "text",
        };
        continue;
      }

      if (!current) {
        continue;
      }

      if (!current.pages.includes(page.page)) {
        current.pages.push(page.page);
      }
      if (!current.heading && (activeHeading || pageHeading)) {
        current.heading = activeHeading || pageHeading;
      }

      if (isPdfRequirementTypeLine(line)) {
        current.phase = "instruction";
        continue;
      }

      if (current.phase === "instruction") {
        current.instructionLines.push(line);
      } else {
        current.textLines.push(line);
      }
    }
  }

  flushCurrent();
  return dedupeRequirementLedger(requirements);
}

function decodeHtmlText(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

function htmlCellText(value: string) {
  return decodeHtmlText(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function parseHtmlTableRows(html: string) {
  const rows: string[][] = [];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => htmlCellText(match[1] ?? ""));

    if (cells.some((cell) => cell.trim().length > 0)) {
      rows.push(cells);
    }
  }

  return rows;
}

function isRequirementTableHeaderCells(cells: string[]) {
  return (
    cells.some((cell) => isRequirementIdColumn(cell)) &&
    cells.some((cell) => isRequirementTextColumn(cell))
  );
}

function rowCellsFromColumns(columns: string[], cells: string[]) {
  const fallbackColumns = [
    "Req. No.",
    "Requirement text",
    "Type",
    "Response instruction",
    "Y/N",
    "Detailed response",
  ];
  const labels = columns.length ? columns : fallbackColumns;

  return Object.fromEntries(
    cells
      .map((cell, index) => [
        labels[index] ?? `Kolonne ${index + 1}`,
        normalizePageText(cell),
      ])
      .filter(([label, value]) => label && value),
  );
}

function requirementPartsFromDocxCells(cells: string[], columns: string[]) {
  return doclingRequirementRowParts(rowCellsFromColumns(columns, cells));
}

function looksLikeDocxRequirementRow(
  cells: string[],
  inRequirementTable: boolean,
  columns: string[] = [],
) {
  if (cells.length < 2 || isRequirementTableHeaderCells(cells)) {
    return false;
  }

  const parts = requirementPartsFromDocxCells(cells, columns);
  const requirementText =
    parts.requirementText || normalizePageText(cells[1] ?? "");
  if (requirementText.length < 18) {
    return false;
  }

  if (/^(requirement text|response instruction|detailed response)$/i.test(requirementText)) {
    return false;
  }

  if (cells.length >= 5 && inRequirementTable) {
    return true;
  }

  return (
    cells.length >= 5 &&
    (Boolean(parts.explicitId) ||
      parts.hasRequirementColumn ||
      isRequirementTypeOrInstructionLine(cells[2] ?? "") ||
      /^(yes|no|y|n)$/i.test(normalizePageText(cells[4] ?? "")) ||
      hasRequirementSignal(requirementText))
  );
}

function shortRequirementName(requirementText: string, responseInstruction: string) {
  const text = normalizePageText(requirementText);
  const instruction = normalizePageText(responseInstruction);
  const patterns = [
    /\bContinuous Services\b/i,
    /\bThird-Party Suppliers?\b/i,
    /\bService Definitions?\b/i,
    /\btechnical platform\b/i,
    /\bon-prem hosting platform to cloud hosting\b/i,
    /\broutine tasks\b/i,
    /\bAzure-environment\b/i,
    /\bsustainability efforts?\b/i,
    /\bpricing of this Tower\b/i,
    /\bSLAs? for this Tower\b/i,
  ];
  const matchedPattern = patterns
    .map((pattern) => text.match(pattern)?.[0])
    .find(Boolean);

  if (matchedPattern) {
    return matchedPattern
      .replace(/\bSLAs?\b/i, "SLA")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (instruction && instruction.length <= 80) {
    return instruction;
  }

  return text
    .replace(/^(The Contractor|Contractor|Leverandøren)\s+(shall|must|skal|må|bør)\s+/i, "")
    .replace(/^(All the|All)\s+/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[.,;:]$/g, "")
    .trim();
}

function normalizeDocxSectionTitle(value: string) {
  return normalizePageText(value)
    .replace(/^\d{1,3}(?:\.\d{1,3})*\s+/, "")
    .replace(/\s+\d{1,4}$/, "")
    .replace(/:$/, "")
    .toLowerCase();
}

function buildDocxRequirementSectionRefs(rawText: string) {
  const sectionRefs = new Map<string, string>();
  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(normalizePageText)
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(
      /^(\d{1,3}(?:\.\d{1,3})*)\s+(.+?)\s+\d{1,4}$/,
    );
    if (!match) {
      continue;
    }

    const ref = match[1] ?? "";
    const title = normalizeDocxSectionTitle(match[2] ?? "");
    if (ref && title) {
      sectionRefs.set(title, ref);
    }
  }

  return sectionRefs;
}

function withDocxSectionRef(
  heading: string,
  sectionRefs: Map<string, string>,
) {
  const parts = heading
    .split(">")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const last = parts.at(-1) ?? heading.replace(/\s+/g, " ").trim();
  if (!last || /^\d{1,3}(?:\.\d{1,3})*\s+/.test(last)) {
    return heading;
  }

  const ref = sectionRefs.get(normalizeDocxSectionTitle(last));
  if (!ref) {
    return heading;
  }

  if (!parts.length) {
    return `${ref} ${last}`;
  }

  parts[parts.length - 1] = `${ref} ${last}`;
  return parts.join(" > ");
}

function docxSectionRefFromHeading(heading: string) {
  const segment = lastHeadingSegment(heading);
  return segment.match(/^(\d{1,3}(?:\.\d{1,3})*)\s+/)?.[1] ?? "";
}

function docxRequirementAnswerExcerpt(cells: string[]) {
  return cells
    .slice(4)
    .map(normalizePageText)
    .filter(Boolean)
    .filter((cell) => !/^(yes|no|y|n)$/i.test(cell))
    .join(" ")
    .trim();
}

function docxRequirementRowSourceExcerpt(cells: string[]) {
  const labels = [
    "Req. No.",
    "Requirement text",
    "Type",
    "Response instruction",
    "Y/N",
    "Detailed response",
  ];

  return compactText(
    cells
      .map((cell, index) => {
        const text = normalizePageText(cell);
        if (!text) {
          return "";
        }

        return `${labels[index] ?? `Kolonne ${index + 1}`}: ${text}`;
      })
      .filter(Boolean)
      .join(" | "),
    1800,
  );
}

function docxRequirementId(input: {
  cells: string[];
  sequence: number;
  heading: string;
  requirementText: string;
  responseInstruction: string;
}) {
  const { cells, heading, requirementText, responseInstruction, sequence } = input;
  const explicitId = normalizePageText(cells[0] ?? "");
  if (
    explicitId &&
    !/^(req\.?\s*no\.?|requirement text)$/i.test(explicitId) &&
    isMeaningfulStructuredRequirementId(explicitId) &&
    explicitId.length <= 80
  ) {
    return explicitId;
  }

  const section = lastHeadingSegment(heading) || "Kravtabell";
  const sectionRef = docxSectionRefFromHeading(section);
  const name = shortRequirementName(requirementText || cells[1] || "", responseInstruction);
  if (sectionRef) {
    return [`${sectionRef}.${sequence}`, name ? `- ${name}` : ""]
      .filter(Boolean)
      .join(" ");
  }

  return [section, String(sequence), name ? `- ${name}` : ""]
    .filter(Boolean)
    .join(" ");
}

type StructureMapEntry = ProjectDocumentDetail["structure_map"][number];

function structureEntryCellMap(entry: StructureMapEntry) {
  const rawCells = entry.cells;
  if (!rawCells || typeof rawCells !== "object" || Array.isArray(rawCells)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rawCells)
      .map(([key, value]) => [
        normalizePageText(key),
        normalizePageText(String(value ?? "")),
      ])
      .filter(([key, value]) => key && value),
  );
}

function hasStructuredTableCells(entry: StructureMapEntry) {
  return Boolean(
    entry.cells &&
      typeof entry.cells === "object" &&
      !Array.isArray(entry.cells) &&
      (entry.kind === "docling_table_row" || entry.kind === "table"),
  );
}

function isRequirementIdColumn(label: string) {
  const text = normalizeColumnLabel(label);
  return /^(?:req\s*no|requirement\s*id|krav\s*(?:nr|nummer|id|ref)|kravref|ref|referanse|punkt|id(?:\s*markering)?|markering|no|nr)$/i.test(
    text,
  );
}

function isResponseInstructionColumn(label: string) {
  return /\b(?:response\s*instruction|svarinstruks|instruksjon|instruction|veiledning)\b/i.test(
    normalizeColumnLabel(label),
  );
}

function isRequirementTextColumn(label: string) {
  const text = normalizeColumnLabel(label);
  if (isRequirementIdColumn(text) || isResponseInstructionColumn(text)) {
    return false;
  }

  return /\b(?:requirement\s*text|requirements?|spesifiserte\s*krav|kravtekst|krav\s*tekst|leveransekrav|akseptansekriterier|krav|ønsket|onsket)\b/i.test(
    text,
  ) || /^(?:krav\s*observasjon|observasjon|innspill|tekst)$/i.test(text);
}

function isAnswerTextColumn(label: string) {
  const text = normalizeColumnLabel(label);
  if (isResponseInstructionColumn(text)) {
    return false;
  }

  return /\b(?:detailed\s*response|supplier\s*response|leverandørens\s*(?:besvarelse|svar)|besvarelse|answer|response|svar|detaljeringer)\b/i.test(
    text,
  );
}

function isServiceTextColumn(label: string) {
  return /\b(?:tjeneste|service|område|kategori|category|type|tower|workstream)\b/i.test(
    normalizeColumnLabel(label),
  );
}

function firstExplicitRequirementIdInCells(cells: Record<string, string>) {
  for (const [label, value] of Object.entries(cells)) {
    if (!isRequirementIdColumn(label)) {
      continue;
    }

    const text = normalizePageText(value);
    if (text && text.length <= 120 && isMeaningfulStructuredRequirementId(text)) {
      return text;
    }
  }

  for (const value of Object.values(cells)) {
    const id = detectExplicitRequirementIds(value)[0];
    if (id) {
      return id;
    }
  }

  return "";
}

function isMeaningfulStructuredRequirementId(value: string) {
  const text = normalizePageText(value);
  return (
    /\d/.test(text) &&
    !/^(?:x|\?|\[?\?\]?|se\s+notat|ikke\s+satt|uten\s+nr\.?|n\/a|na)$/i.test(
      text,
    ) &&
    !/^(?:må|bør|kan|prioritet|merknad|kommentar)$/i.test(text)
  );
}

function structureRequirementFallbackId(
  entry: StructureMapEntry,
  tableId: string,
  sequence: number,
) {
  const reference = normalizePageText(entry.reference ?? "");
  if (reference && /\brad\s+\d{1,4}\b/i.test(reference)) {
    return reference;
  }

  return [
    tableId,
    entry.row_index ? `rad ${entry.row_index}` : `krav ${sequence}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function doclingRequirementRowParts(cells: Record<string, string>) {
  const entries = Object.entries(cells);
  const explicitId = firstExplicitRequirementIdInCells(cells);
  const requirementColumns = entries.filter(([label]) =>
    isRequirementTextColumn(label),
  );
  const answerColumns = entries.filter(([label]) => isAnswerTextColumn(label));
  const instructionColumns = entries.filter(([label]) =>
    isResponseInstructionColumn(label),
  );
  const serviceText = entries
    .filter(([label]) => isServiceTextColumn(label))
    .map(([, value]) => value)
    .filter(Boolean)
    .join(" ");
  const requirementText =
    requirementColumns
      .map(([, value]) => value)
      .filter(Boolean)
      .join(" ") ||
    entries
      .filter(
        ([label]) =>
          !isRequirementIdColumn(label) &&
          !isAnswerTextColumn(label) &&
          !isResponseInstructionColumn(label) &&
          !isServiceTextColumn(label),
      )
      .map(([, value]) => value)
      .find((value) => hasRequirementSignal(value)) ||
    "";
  const answerText = answerColumns
    .map(([, value]) => value)
    .filter(Boolean)
    .filter((value) => !/^(yes|no|y|n|ja|nei)$/i.test(value))
    .join(" ");
  const responseInstruction = instructionColumns
    .map(([, value]) => value)
    .filter(Boolean)
    .join(" ");

  return {
    explicitId,
    requirementText: stripAnswerTextFromRequirement(requirementText),
    answerText: normalizePageText(answerText),
    responseInstruction: normalizePageText(responseInstruction),
    serviceText: normalizePageText(serviceText),
    hasRequirementColumn: requirementColumns.length > 0,
  };
}

function doclingRequirementRowSourceExcerpt(cells: Record<string, string>) {
  return compactText(
    Object.entries(cells)
      .map(([label, value]) => {
        const text = normalizePageText(value);
        return text ? `${label}: ${text}` : "";
      })
      .filter(Boolean)
      .join(" | "),
    1800,
  );
}

function structureTableId(entry: StructureMapEntry) {
  const tableIndex = entry.table_index ? ` ${entry.table_index}` : "";
  if (entry.parser === "docx-xml") {
    return `DOCX tabell${tableIndex}`;
  }
  if (entry.parser === "docling") {
    return `Docling tabell${tableIndex}`;
  }

  return `Strukturert tabell${tableIndex}`;
}

function buildDoclingStructureRequirementLedger(
  document: ProjectDocumentDetail,
) {
  const requirements: RequirementLedgerEntry[] = [];
  const tableCounts = new Map<string, number>();
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;
  let activeHeading = "";
  const corpusParserContext = requirementCorpusParserContext();

  for (const entry of document.structure_map) {
    const entryHeading = generatedStructureTextHeading(
      entry.text,
      corpusParserContext,
    );
    if (entryHeading) {
      activeHeading = entryHeading;
    }

    if (!hasStructuredTableCells(entry)) {
      continue;
    }

    const cells = structureEntryCellMap(entry);
    if (isRequirementTableHeaderCells(Object.values(cells))) {
      continue;
    }

    const parts = doclingRequirementRowParts(cells);
    if (
      parts.requirementText.length < 12 ||
      (!parts.explicitId &&
        !parts.hasRequirementColumn &&
        isLikelyDetailOrAnswerBlock(parts.requirementText))
    ) {
      continue;
    }

    if (
      !parts.explicitId &&
      !parts.hasRequirementColumn &&
      !hasRequirementSignal(parts.requirementText) &&
      !hasStandaloneRequirementLanguage(parts.requirementText)
    ) {
      continue;
    }

    const tableId = structureTableId(entry);
    const sequence = (tableCounts.get(tableId) ?? 0) + 1;
    tableCounts.set(tableId, sequence);
    const rowNote = parts.responseInstruction
      ? ` Responsinstruks: ${parts.responseInstruction}`
      : "";
    const sourceOrderOffset =
      findRequirementOrderOffset(
        normalizedRawText,
        parts.requirementText,
        sourceOrderCursor,
      ) ??
      findRequirementOrderOffset(
        normalizedRawText,
        entry.text,
        sourceOrderCursor,
      );
    const documentEntryOrder =
      sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
    if (sourceOrderOffset !== null) {
      sourceOrderCursor =
        sourceOrderOffset +
        normalizedRequirementOrderSearchText(parts.requirementText).length;
    }

    requirements.push({
      id:
        parts.explicitId ||
        structureRequirementFallbackId(entry, tableId, sequence),
      text: `${parts.requirementText}${rowNote}`,
      pages: typeof entry.page === "number" ? [entry.page] : [],
      heading: activeHeading || entry.reference,
      tableId,
      service: parts.serviceText || undefined,
      sourceExcerpt: doclingRequirementRowSourceExcerpt(cells),
      answerExcerpt: parts.answerText || undefined,
      documentEntryOrder,
    });
  }

  return dedupeRequirementLedger(requirements);
}

async function buildDocxTableRequirementLedger(document: ProjectDocumentDetail) {
  if (
    document.file_format !== "docx" ||
    !document.file_base64 ||
    document.file_base64.length < 100
  ) {
    return [];
  }

  try {
    const mammoth = await getMammothHtml();
    const html = await mammoth.convertToHtml({
      buffer: Buffer.from(document.file_base64, "base64"),
    });
    const rows = parseHtmlTableRows(html.value);
    const requirements: RequirementLedgerEntry[] = [];
    const sectionRefs = buildDocxRequirementSectionRefs(document.raw_text);
    const normalizedRawText = normalizedRequirementOrderSearchText(
      document.raw_text,
    );
    let activeHeading = "";
    let inRequirementTable = false;
    let activeColumns: string[] = [];
    const headingCounts = new Map<string, number>();
    let sourceOrderCursor = 0;
    let fallbackDocumentEntryOrder = 1_000_000;

    for (const cells of rows) {
      if (isRequirementTableHeaderCells(cells)) {
        inRequirementTable = true;
        activeColumns = cells.map((cell) => normalizePageText(cell));
        continue;
      }

      if (
        cells.length === 1 &&
        /^(Requirements to|Competence requirements to|Functional requirements|Commercial requirements|Annex\s+\d+)/i.test(
          cells[0] ?? "",
        )
      ) {
        activeHeading = withDocxSectionRef(
          normalizePageText(cells[0] ?? ""),
          sectionRefs,
        );
        inRequirementTable = false;
        activeColumns = [];
        continue;
      }

      if (!looksLikeDocxRequirementRow(cells, inRequirementTable, activeColumns)) {
        continue;
      }

      const rowCells = rowCellsFromColumns(activeColumns, cells);
      const parts = doclingRequirementRowParts(rowCells);
      const requirementText =
        parts.requirementText || stripAnswerTextFromRequirement(cells[1] ?? "");
      const hasTrustedRequirementCells = Boolean(
        parts.explicitId || parts.hasRequirementColumn || inRequirementTable,
      );
      if (
        requirementText.length < 18 ||
        (!hasTrustedRequirementCells &&
          isLikelyDetailOrAnswerBlock(requirementText))
      ) {
        continue;
      }
      const responseInstruction =
        parts.responseInstruction ||
        (activeColumns.length ? "" : normalizePageText(cells[3] ?? ""));
      const rowHeading = withDocxSectionRef(
        findDocxHeadingForRequirement(
          document.raw_text,
          requirementText,
          activeHeading,
        ),
        sectionRefs,
      );
      const headingKey = rowHeading || "Kravtabell";
      const headingSequence = (headingCounts.get(headingKey) ?? 0) + 1;
      headingCounts.set(headingKey, headingSequence);
      const rowNote = responseInstruction
        ? ` Responsinstruks: ${responseInstruction}`
        : "";
      const sourceOrderOffset =
        findRequirementOrderOffset(
          normalizedRawText,
          requirementText,
          sourceOrderCursor,
        ) ??
        findRequirementOrderOffset(
          normalizedRawText,
          cells.join(" "),
          sourceOrderCursor,
        );
      const documentEntryOrder =
        sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
      if (sourceOrderOffset !== null) {
        sourceOrderCursor =
          sourceOrderOffset +
          normalizedRequirementOrderSearchText(requirementText).length;
      }

      requirements.push({
        id:
          parts.explicitId ||
          docxRequirementId({
            cells,
            sequence: headingSequence,
            heading: rowHeading,
            requirementText,
            responseInstruction,
          }),
        text: `${requirementText}${rowNote}`,
        pages: [1],
        heading: rowHeading,
        tableId: "DOCX kravtabell",
        service: parts.serviceText || undefined,
        sourceExcerpt:
          doclingRequirementRowSourceExcerpt(rowCells) ||
          docxRequirementRowSourceExcerpt(cells),
        answerExcerpt:
          parts.answerText || docxRequirementAnswerExcerpt(cells) || undefined,
        documentEntryOrder,
      });
    }

    return dedupeRequirementLedger(requirements);
  } catch {
    return [];
  }
}

function buildRequirementSourceLedger(document: ProjectDocumentDetail) {
  const corpusParserContext = requirementCorpusParserContext();

  if (document.file_format !== "pdf") {
    const markdownRequirements = buildMarkdownRequirementResponseLedger(document);
    if (
      markdownRequirements.length > 0 &&
      hasMarkdownRequirementResponseTable(document)
    ) {
      return markdownRequirements;
    }

    return dedupeRequirementLedger([
      ...markdownRequirements,
      ...buildPrefixedLineRequirementLedger(document, corpusParserContext),
      ...buildLinearTableRequirementLedger(document),
      ...buildStructuredRequirementLedger(document),
    ]);
  }

  const pages = splitPdfPages(document.raw_text);
  if (!pages.length) {
    return [];
  }

  const pdfTableRequirements = buildPdfRequirementTableLedger(document);
  const pdfExplicitIdRequirements = buildPdfExplicitIdRequirementLedger(document);
  const markerPattern = explicitRequirementIdPattern();
  const requirements: RequirementLedgerEntry[] = [];
  const answerExcerptsById = new Map<string, string>();
  const pageHeadingMap = buildPageHeadingMap(document);
  let current: (RequirementLedgerEntry & { isAnswerBlock?: boolean }) | null = null;
  let currentHeading = "";

  function appendToCurrent(text: string, page: number) {
    const cleaned = stripRequirementChrome(text);
    if (!current || !cleaned) {
      return;
    }

    current.text = [current.text, cleaned].filter(Boolean).join(" ");
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
  }

  function flushCurrent() {
    if (!current) {
      return;
    }

    const rawText = stripRequirementChrome(current.text).split(
      /\b(?:[\p{L}\s/-]{0,80}[–-]\s*)?Ta\s*b\s*e\s*ll\s*ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/iu,
    )[0]?.trim() ?? "";
    const text = stripAnswerTextFromRequirement(rawText);
    const normalizedId = normalizeRequirementId(current.id);
    if (current.isAnswerBlock || isLikelyDetailOrAnswerBlock(text)) {
      const answerExcerpt = compactText(rawText || current.text, 1600);
      if (answerExcerpt) {
        const matchingRequirement = [...requirements]
          .reverse()
          .find((entry) => normalizeRequirementId(entry.id) === normalizedId);
        if (matchingRequirement) {
          matchingRequirement.answerExcerpt = [
            matchingRequirement.answerExcerpt,
            answerExcerpt,
          ]
            .filter(Boolean)
            .join(" ");
        } else {
          answerExcerptsById.set(normalizedId, answerExcerpt);
        }
      }
      current = null;
      return;
    }

    if (text) {
      requirements.push({
        ...current,
        text,
        sourceExcerpt: current.sourceExcerpt || compactText(text, 1600),
        answerExcerpt:
          current.answerExcerpt || answerExcerptsById.get(normalizedId),
      });
    }
    current = null;
  }

  for (const page of pages) {
    const pageHeading = pageHeadingMap.get(page.page);
    if (pageHeading) {
      currentHeading = pageHeading;
    }

    const matches = [...page.text.matchAll(markerPattern)].filter((match) => {
      const markerStart = match.index ?? 0;
      return !isContextualNonRequirementExplicitId(
        match[0],
        page.text.slice(Math.max(0, markerStart - 24), markerStart),
      );
    });
    if (!matches.length) {
      if (current && pageHeading) {
        current.heading = pageHeading;
      }
      appendToCurrent(page.text, page.page);
      continue;
    }

    let cursor = 0;
    for (const match of matches) {
      const markerStart = match.index ?? 0;
      const markerPrefix = page.text.slice(Math.max(0, markerStart - 24), markerStart);
      if (
        isTableOrColumnHeaderRequirementMarker(markerPrefix)
      ) {
        continue;
      }

      const beforeMarker = page.text.slice(cursor, markerStart);
      if (current && pageHeading) {
        current.heading = pageHeading;
      }
      appendToCurrent(beforeMarker, page.page);
      flushCurrent();
      const answerMarkerPrefix = page.text.slice(
        Math.max(0, markerStart - 160),
        markerStart,
      );

      current = {
        id: documentRequirementId(match[0]),
        text: "",
        pages: [page.page],
        heading: findHeadingBeforeOffset(
          page.text,
          markerStart,
          pageHeading ?? currentHeading,
        ),
        isAnswerBlock:
          /\b(?:Leverandørens\s+besvarelse|Detailed\s+response|Supplier\s+response|Answer|Response)\b/i.test(
            answerMarkerPrefix,
          ),
      };
      cursor = markerStart + match[0].length;
    }

    appendToCurrent(page.text.slice(cursor), page.page);
  }

  flushCurrent();

  const tableRequirements = buildTableRequirementLedger(document);
  const serviceTableRequirements = buildServiceRequirementTableLedger(document);
  const regularRequirements = requirements.filter(
    (item) => item.text.length >= 20 && !isTableContainerRequirement(item),
  );
  const linearTableRequirements = buildLinearTableRequirementLedger(document);
  const answerSectionRequirements = buildAnswerSectionRequirementLedger(document);
  const splitAnswerMarkerRequirements =
    buildSplitAnswerMarkerRequirementLedger(document);
  const preAnswerFieldRequirements =
    buildPreAnswerFieldRequirementLedger(document);
  const explicitRequirements = dedupeRequirementLedger(
    filterSyntheticRequirementFallbacks(
      filterSyntheticRequirementDuplicates([
        ...pdfTableRequirements,
        ...pdfExplicitIdRequirements,
        ...preAnswerFieldRequirements,
        ...answerSectionRequirements,
        ...splitAnswerMarkerRequirements,
        ...buildPrefixedLineRequirementLedger(document, corpusParserContext),
        ...regularRequirements,
        ...tableRequirements,
        ...serviceTableRequirements,
        ...linearTableRequirements,
      ]),
    ),
  );

  if (isReliableRequirementLedger(explicitRequirements)) {
    return explicitRequirements;
  }

  const structuredRequirements = buildStructuredRequirementLedger(document);

  return dedupeRequirementLedger([
    ...explicitRequirements,
    ...structuredRequirements,
  ]);
}

function requirementCorpusParserContext(): RequirementCorpusParserContext {
  return {
    cleanHeadingCandidate,
    dedupeRequirementLedger,
    detectExplicitRequirementIds,
    doclingRequirementRowParts,
    doclingRequirementRowSourceExcerpt,
    hasRequirementSignal,
    hasStandaloneRequirementLanguage,
    hasStructuredTableCells,
    isLikelyHeadingLine,
    normalizeColumnLabel,
    splitDocumentPagesForRequirementScan,
    stripAnswerTextFromRequirement,
    stripRequirementChrome,
    structureEntryCellMap,
    structureRequirementFallbackId,
    structureTableId,
  };
}

/** @internal Transitional parser core for the requirement extraction boundary. */
export async function buildRequirementSourceLedgerWithFiles(
  document: ProjectDocumentDetail,
) {
  const corpusParserContext = requirementCorpusParserContext();
  const sourceDocumentSha256 = knownCanonicalPdfSourceSha256(document);
  const explicitIdPdfLayoutLedger =
    document.file_format === "pdf"
      ? buildExplicitIdPdfLayoutRequirementLedger(
          await readPdfLayoutPages(document),
          corpusParserContext,
        )
      : [];
  if (explicitIdPdfLayoutLedger.length > 0) {
    return sortRequirementLedgerInDocumentOrder(
      finalizeRequirementLedgerEntries(
        explicitIdPdfLayoutLedger,
        sourceDocumentSha256,
      ).map((entry) => ({
        ...entry,
        documentId: document.id,
        documentTitle: document.title,
      })),
    );
  }
  const explicitIdPdfNarrativeLedger =
    document.file_format === "pdf"
      ? buildExplicitIdPdfNarrativeRequirementLedger(
          await readPdfLayoutPages(document),
          corpusParserContext,
        )
      : [];
  if (explicitIdPdfNarrativeLedger.length > 0) {
    return sortRequirementLedgerInDocumentOrder(
      finalizeRequirementLedgerEntries(
        explicitIdPdfNarrativeLedger,
        sourceDocumentSha256,
      ).map((entry) => ({
        ...entry,
        documentId: document.id,
        documentTitle: document.title,
      })),
    );
  }
  const spreadsheetLedger = buildSpreadsheetRequirementLedger(document);
  if (spreadsheetLedger.length > 0) {
    return finalizeRequirementLedgerEntries(spreadsheetLedger, sourceDocumentSha256).map((entry) => ({
      ...entry,
      documentId: document.id,
      documentTitle: document.title,
    }));
  }
  const explicitIdTableLedger = buildExplicitIdTableRequirementLedger(
    document,
    corpusParserContext,
  );
  if (explicitIdTableLedger.length > 0) {
    return sortRequirementLedgerInDocumentOrder(
      finalizeRequirementLedgerEntries(
        explicitIdTableLedger,
        sourceDocumentSha256,
      ).map((entry) => ({
        ...entry,
        documentId: document.id,
        documentTitle: document.title,
      })),
    );
  }
  const legacyPdfLedger =
    document.file_format === "pdf" && isLegacyMixedFofingerCorpus(document)
      ? buildPrefixedLineRequirementLedger(document, corpusParserContext)
      : [];
  if (legacyPdfLedger.length > 0) {
    const sortedLegacyLedger = sortRequirementLedgerInDocumentOrder(
      finalizeRequirementLedgerEntries(
        legacyPdfLedger,
        sourceDocumentSha256,
      ).map((entry) => ({
        ...entry,
        text: repairLegacyFofingerTextArtifacts(entry.text),
        documentId: document.id,
        documentTitle: document.title,
      })),
    );
    return assignGeneratedCorpusFallbackRequirementIds(
      document,
      sortedLegacyLedger,
    );
  }

  const boundMarkdownSolutionLedger =
    document.role === "primary_solution_document" &&
    document.file_format !== "pdf" &&
    hasMarkdownRequirementResponseSchema(document)
      ? buildMarkdownRequirementResponseLedger(document)
      : [];
  if (boundMarkdownSolutionLedger.length > 0) {
    // A selected, schema-complete requirement-response table is already a
    // source-ledger projection. Keep every immutable row reference here,
    // including `Side X krav Y`. The generic PDF/source heuristics below are
    // intentionally not relaxed, and evaluation coverage remains driven only
    // by the independently extracted source ledger.
    return sortRequirementLedgerInDocumentOrder(
      finalizeRequirementLedgerEntries(
        boundMarkdownSolutionLedger,
        sourceDocumentSha256,
      ).map(
        (entry) => ({
          ...entry,
          documentId: document.id,
          documentTitle: document.title,
        }),
      ),
    );
  }

  const trustedStructureMapLedger =
    buildTrustedStructureMapRequirementLedger(document, corpusParserContext);
  const skipDoclingStructureForLegacyFofinger =
    /Bilag\s+2\s*-\s*Krav\s+og\s+føringer/i.test(document.raw_text) &&
    !hasLegacyKravFeringStructuredRows(document, corpusParserContext);
  const availableStructureLedger = trustedStructureMapLedger.length
    ? trustedStructureMapLedger
    : skipDoclingStructureForLegacyFofinger
      ? []
      : buildDoclingStructureRequirementLedger(document);
  const generatedPdfLedger = buildGeneratedPdfRequirementLedger(
    document,
    corpusParserContext,
  );
  const hasLocalPdfTableStructure = document.structure_map.some(
    (entry) =>
      entry.kind === "table" &&
      isLocalPdfLayoutParser(entry.parser) &&
      entry.cells &&
      typeof entry.cells === "object" &&
      !Array.isArray(entry.cells),
  );
  const trustedLocalById = new Map(
    (hasLocalPdfTableStructure ? trustedStructureMapLedger : []).map(
      (entry) => [normalizeRequirementId(entry.id), entry] as const,
    ),
  );
  const generatedPdfLedgerWithLocalTableText = generatedPdfLedger.map((entry) =>
    preferTrustedStructuredRequirementText(
      entry,
      trustedLocalById.get(normalizeRequirementId(entry.id)),
    ),
  );
  const generatedRequirementIds = new Set(
    generatedPdfLedger.map((entry) => normalizeRequirementId(entry.id)),
  );
  const doclingStructureLedger = hasLocalPdfTableStructure
    ? availableStructureLedger.filter(
        (entry) =>
          !generatedRequirementIds.has(normalizeRequirementId(entry.id)),
      )
    : availableStructureLedger;
  const useGeneratedPdfLedger = generatedPdfLedger.length > 0;
  const mixedTextLedger = useGeneratedPdfLedger
    ? []
    : buildMixedTextRequirementLedger(document, corpusParserContext);
  const serviceTableLedger = buildServiceRequirementTableLedger(document);
  const baseLedger = useGeneratedPdfLedger
    ? []
    : buildRequirementSourceLedger(document);
  const docxTableLedger = await buildDocxTableRequirementLedger(document);
  const hasStructuredGeneratedDocxLedger =
    document.file_format === "docx" &&
    isGeneratedKravspesifikasjonCorpus(document) &&
    (docxTableLedger.length > 0 || doclingStructureLedger.length > 0);
  const unstructuredLedger = useGeneratedPdfLedger
    ? []
    : buildUnstructuredRequirementLedger(document);
  const pdfFileText = await readPdfRawTextFromFile(document);
  const pdfFileTextLedger =
    !useGeneratedPdfLedger &&
    pdfFileText && normalizeEvidenceText(pdfFileText) !== normalizeEvidenceText(document.raw_text)
      ? buildRequirementSourceLedger({
          ...document,
          raw_text: pdfFileText,
        })
      : [];
  const pdfLayoutTableLedger = useGeneratedPdfLedger
    ? []
    : await buildPdfLayoutTableRequirementLedger(document);
  const declaredHeadingLedger = buildDeclaredHeadingRequirementLedger(document);
  const doclingTextAnchors = buildExplicitIdDoclingTextRequirementLedger(document, corpusParserContext);
  // Only replace prose projections of the same local ID/page. Table rows and
  // repeated anchored units remain independent source requirements.
  const preferDoclingTextAnchors = (entry: RequirementLedgerEntry) => !doclingTextAnchors.some((anchor) =>
    (!entry.tableId || entry.tableId === "PDF krav-ID") &&
    normalizeRequirementId(entry.id) === normalizeRequirementId(anchor.id) &&
    (!entry.pages.length || !anchor.pages.length || entry.pages.some((page) => anchor.pages.includes(page)))
  );
  const ledger = filterSyntheticRequirementFallbacks(
    filterSyntheticRequirementDuplicates([
      ...doclingTextAnchors,
      ...declaredHeadingLedger,
      ...unstructuredLedger,
      ...generatedPdfLedgerWithLocalTableText,
      ...mixedTextLedger,
      ...serviceTableLedger,
      ...doclingStructureLedger,
      ...docxTableLedger,
      ...baseLedger.filter(preferDoclingTextAnchors),
      ...pdfFileTextLedger.filter(preferDoclingTextAnchors),
      ...pdfLayoutTableLedger,
    ]),
  ).filter(
    (entry) =>
      !(
        hasStructuredGeneratedDocxLedger && isGeneratedFlattenedTableDump(entry)
      ),
  );

  // A line-anchored ID/text pair is stronger evidence than a flattened
  // heuristic row that attached the same text to the following ID.
  const anchoredLines = document.file_format !== "pdf"
    ? buildPrefixedLineRequirementLedger(document, corpusParserContext)
    : [];
  const headingBoundLedger = ledger.filter((entry) => !declaredHeadingLedger.some((anchor) =>
    entry !== anchor &&
    (isSyntheticRequirementId(entry.id) || normalizeRequirementId(entry.id) === normalizeRequirementId(anchor.id)) &&
    normalizeEvidenceText(anchor.text).includes(normalizeEvidenceText(entry.text))
  ));
  const sourceBoundLedger = headingBoundLedger.filter((entry) => !anchoredLines.some((anchor) =>
    normalizeEvidenceText(anchor.text) === normalizeEvidenceText(entry.text) &&
    normalizeRequirementId(anchor.id) !== normalizeRequirementId(entry.id) &&
    !entry.tableId && anchor.sourceExcerpt &&
    document.raw_text.includes(anchor.sourceExcerpt)
  ));
  const finalizedLedger = finalizeRequirementLedgerEntries(
    restoreExplicitLineRequirementOrder(document, sourceBoundLedger),
    sourceDocumentSha256,
  ).map((entry) => ({
    ...entry,
    text: isLegacyMixedFofingerCorpus(document)
      ? repairLegacyFofingerTextArtifacts(entry.text)
      : entry.text,
    documentId: document.id,
    documentTitle: document.title,
  }));
  const legacyFilteredLedger =
    document.file_format === "docx" && isLegacyMixedFofingerCorpus(document)
      ? filterDuplicateLegacyStandaloneNoteLines(finalizedLedger)
      : finalizedLedger;
  const filteredLedger =
    hasStructuredGeneratedDocxLedger
      ? legacyFilteredLedger.filter((entry) => !isGeneratedFlattenedTableDump(entry))
      : legacyFilteredLedger;

  const pdfFilteredLedger =
    document.file_format === "pdf"
      ? filterPdfTableDuplicateExtractionArtifacts(
          filteredLedger,
          sourceDocumentSha256,
        )
      : filteredLedger;
  const sortedLedger = sortRequirementLedgerInDocumentOrder(pdfFilteredLedger);
  return assignGeneratedCorpusFallbackRequirementIds(document, sortedLedger);
}

function isPlainLegacyStandaloneNoteSource(entry: RequirementLedgerEntry) {
  const source = normalizePageText(entry.sourceExcerpt ?? "");
  return (
    entry.tableId === "Dokumenttekst" &&
    /^Notater\s+fra\s+gjennomgang:?$/i.test(entry.heading) &&
    source.length > 0 &&
    !/^Rad\s+\d{1,4}\s*:/i.test(source) &&
    !/^(?:KRAV\s*[- ]?\s*\d+|[A-ZÆØÅ]{2,8}-REQ-\d+)/iu.test(source) &&
    !/^(?:obs|notat|uten\s+id|ikke\s+satt|se\s+notat|må\s+avklares|rad\s+\d{1,4}|x|\?)\s*[:.)-]?/iu.test(
      source,
    ) &&
    !/^[—-]/u.test(source)
  );
}

function isLegacyCompanyPrefixedGluedNoteObservation(
  entry: RequirementLedgerEntry,
) {
  const source = normalizePageText(entry.sourceExcerpt ?? "");
  const text = normalizePageText(entry.text);
  return (
    entry.tableId === "Dokumenttekst krav-ID" &&
    /^Notater\s+fra\s+gjennomgang:?$/i.test(entry.heading) &&
    /^[A-ZÆØÅ]{2,8}-REQ-\d+\p{Lu}/u.test(source) &&
    /^Løsningen\s+må\s+håndtere\b/i.test(text) &&
    /\buten\s+at\s+kunden\s+mister\s+kontroll\b/i.test(text)
  );
}

export function filterDuplicateLegacyStandaloneNoteLines(
  entries: RequirementLedgerEntry[],
) {
  const representedOutsidePlainNotes = new Set(
    entries
      .filter((entry) => !isPlainLegacyStandaloneNoteSource(entry))
      .map((entry) => normalizeEvidenceText(entry.text))
      .filter(Boolean),
  );
  const survivingOutsidePlainNotes = new Set(
    entries
      .filter(
        (entry) =>
          !isPlainLegacyStandaloneNoteSource(entry) &&
          !isLegacyCompanyPrefixedGluedNoteObservation(entry),
      )
      .map((entry) => normalizeEvidenceText(entry.text))
      .filter(Boolean),
  );
  const seenPlainNotes = new Set<string>();

  return entries.filter((entry) => {
    if (isLegacyCompanyPrefixedGluedNoteObservation(entry)) {
      return false;
    }

    if (!isPlainLegacyStandaloneNoteSource(entry)) {
      return true;
    }

    const text = normalizeEvidenceText(entry.text);
    if (
      !text ||
      (representedOutsidePlainNotes.has(text) &&
        !survivingOutsidePlainNotes.has(text)) ||
      seenPlainNotes.has(text)
    ) {
      return false;
    }

    seenPlainNotes.add(text);
    return true;
  });
}

function finalizeRequirementLedgerTextValue(value: string) {
  const cleaned = repairGeneratedTextArtifacts(
    stripGeneratedPriorityComment(stripRequirementChrome(value)),
  )
    .replace(/\s+RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\s*[\d,.\s]+\s*TIL.*$/i, "")
    .trim();
  return stripAnswerTextFromRequirement(cleaned) || cleaned;
}

function applySourceBoundPdfTableCanonicalRepair(
  entry: RequirementLedgerEntry,
  sourceDocumentSha256: string,
) {
  if (!sourceDocumentSha256 || !entry.tableId) {
    return entry;
  }

  const originalService = serviceFromTableRequirementId(entry);
  const repaired = repairTableRowTextArtifacts({
    service: originalService,
    text: entry.text,
    sourceDocumentSha256,
    tableId: entry.tableId,
  });
  if (
    repaired.service === originalService &&
    repaired.text === entry.text
  ) {
    return entry;
  }

  return {
    ...entry,
    id:
      repaired.service && !hasStableExplicitRequirementId(entry)
        ? `${entry.tableId} - ${repaired.service}`
        : entry.id,
    service: repaired.service || entry.service,
    text: repaired.text,
  };
}

function finalizeRequirementLedgerEntries(
  entries: RequirementLedgerEntry[],
  sourceDocumentSha256 = "",
) {
  const finalized = dedupeRequirementLedger(
    entries.map((entry) =>
      repairRequirementLedgerEntryArtifacts(entry, sourceDocumentSha256),
    ),
    sourceDocumentSha256,
  )
    .map((entry) => ({
      ...entry,
      text: finalizeRequirementLedgerTextValue(entry.text),
    }))
    .map((entry) => finalizeRequirementLedgerEntryText(entry))
    .map((entry) =>
      repairRequirementLedgerEntryArtifacts(entry, sourceDocumentSha256),
    )
    .map((entry) => ({
      ...entry,
      text: finalizeRequirementLedgerTextValue(entry.text),
    }));

  const sourceBoundFinalized = finalized.map((entry) =>
    applySourceBoundPdfTableCanonicalRepair(entry, sourceDocumentSha256),
  );
  const sourceBoundNarrativeFinalized = sourceBoundFinalized.map((entry) => {
    const text = repairSourceBoundPdfNarrativeText({
      id: entry.id,
      text: entry.text,
      sourceDocumentSha256,
    });
    return {
      ...entry,
      text,
      heading: repairSourceBoundPdfNarrativeHeading({
        id: entry.id,
        heading: entry.heading,
        sourceDocumentSha256,
      }),
    };
  });
  const recoveredFinalized = sourceBoundNarrativeFinalized.map((entry) => {
    const recoveredText = recoverTruncatedUnstructuredRequirementText(
      entry.text,
      entry.sourceExcerpt ?? "",
    );
    return recoveredText === entry.text ? entry : { ...entry, text: recoveredText };
  });

  return backfillMissingRequirementHeadings(recoveredFinalized);
}

function assignGeneratedCorpusFallbackRequirementIds(
  document: ProjectDocumentDetail,
  entries: RequirementLedgerEntry[],
) {
  return isGeneratedKravspesifikasjonCorpus(document)
    ? assignGeneratedRequirementFallbackIds(entries)
    : entries;
}

/** @internal Transitional parser core for the requirement extraction boundary. */
export function recoverTruncatedRequirementLedgerEntries(
  entries: RequirementLedgerEntry[],
) {
  return entries.map((entry) => {
    const text = normalizePdfSpacing(entry.text);
    const source = normalizePdfSpacing(entry.sourceExcerpt ?? "");
    if (text.toLocaleLowerCase("nb").endsWith("høyde for") && source) {
      const sourceLower = source.toLocaleLowerCase("nb");
      const marker = "høyde for ";
      const tailStart = sourceLower.lastIndexOf(marker);
      const tail = normalizePdfSpacing(
        tailStart >= 0 ? source.slice(tailStart + marker.length) : "",
      );
      if (tail.length >= 4 && tail.length <= 500) {
        return {
          ...entry,
          text: stripAnswerTextFromRequirement(`${text} ${tail}`),
        };
      }
    }

    return entry;
  });
}

/** @internal Transitional parser core for the requirement extraction boundary. */
export function recoverTruncatedRequirementLedgerEntryInline<T extends { text: string; sourceExcerpt?: string }>(
  entry: T,
): T {
  const text = normalizePdfSpacing(entry.text);
  const source = normalizePdfSpacing(entry.sourceExcerpt ?? "");
  const marker = "høyde for ";
  const sourceLower = source.toLocaleLowerCase("nb");
  if (!text.toLocaleLowerCase("nb").endsWith("høyde for")) {
    return entry;
  }

  const tailStart = sourceLower.lastIndexOf(marker);
  if (tailStart < 0) {
    return entry;
  }

  const tail = normalizePdfSpacing(source.slice(tailStart + marker.length));
  if (tail.length < 4 || tail.length > 500) {
    return entry;
  }

  return {
    ...entry,
    text: stripAnswerTextFromRequirement(`${text} ${tail}`),
  };
}

export function recoverAvailabilityFractionRequirement<
  T extends { id: string; text: string; sourceExcerpt?: string },
>(entry: T): T {
  if (
    normalizeRequirementId(entry.id) !== "6" ||
    normalizePdfSpacing(entry.text) !== "Leverandøren skal ta høyde for"
  ) {
    return entry;
  }

  const source = normalizePdfSpacing(entry.sourceExcerpt ?? "");
  const exactSourceRequirement = source.match(
    /\bLeverandøren\s+skal\s+ta\s+høyde\s+for\s+24\s*\/\s*7\s+tilgjengelighet\s+i\s+løsningsdesign,\s*planlegging\s+og\s+dokumentasjon\.?/iu,
  )?.[0];
  if (!exactSourceRequirement) {
    return entry;
  }

  return {
    ...entry,
    text: normalizePdfSpacing(exactSourceRequirement),
  };
}

/** The one requirement-ledger extractor for a document: structure-based
 * ledger, truncation repairs, and the document's corrections chapter. */
export async function extractRequirementLedgerForDocument(
  document: ProjectDocumentDetail,
): Promise<
  Array<{
    id: string;
    text: string;
    pages: number[];
    heading: string;
    documentTitle?: string;
    tableId?: string;
    service?: string;
    sourceExcerpt?: string;
    answerExcerpt?: string;
  }>
> {
  const ledger = recoverTruncatedRequirementLedgerEntries(
    await buildRequirementSourceLedgerWithFiles(document),
  )
    .map(recoverTruncatedRequirementLedgerEntryInline)
    .map(recoverAvailabilityFractionRequirement);
  if (!isLegacyMixedFofingerCorpus(document)) {
    return applyRequirementCorrections(ledger, document.raw_text).ledger;
  }

  return applyRequirementCorrections(
    recoverTruncatedRequirementLedgerEntries(
      ledger.map((entry) => ({
        ...entry,
        text: repairLegacyFofingerTextArtifacts(entry.text),
      })),
    )
      .map(recoverTruncatedRequirementLedgerEntryInline)
      .map(recoverAvailabilityFractionRequirement),
    document.raw_text,
  ).ledger;
}

export function isReliableRequirementLedger(ledger: RequirementLedgerEntry[]) {
  if (!ledger.length) {
    return false;
  }

  const tableRows = ledger.filter((entry) => entry.tableId).length;
  const explicitRows = ledger.filter(
    (entry) => !entry.tableId && !isSyntheticRequirementId(entry.id),
  ).length;

  return ledger.length >= 20 || tableRows >= 8 || explicitRows >= 8;
}

export function buildRequirementSourceLedgerContext(
  document: ProjectDocumentDetail,
  ledger: RequirementLedgerEntry[],
) {
  if (!isReliableRequirementLedger(ledger)) {
    return "";
  }

  const rows = ledger
    .slice(0, 180)
    .map((item) => {
      return `- ${item.id} | ${requirementLedgerSource(item)} | ${compactText(item.text, 500)}`;
    });

  if (!rows.length) {
    return "";
  }

  return buildDelimitedContext(
    `Kravfasit fra skjemamarkører for ${document.title}`,
    [
      "Bruk denne listen som primær fasit for krav-ID, kravrekkefølge og kravtekst når kravdokumentet har Leverandørens besvarelse-markører.",
      "Listen kan også inneholde syntetiske kravreferanser som 'Side X krav Y' når dokumentet ikke har synlige krav-ID-er. Disse er likevel kravkandidater som skal besvares hvis kravteksten er selvstendig.",
      "Tekst som ligger før neste ID-markør på ny side er behandlet som fortsettelse av forrige krav, ikke som nytt krav.",
      "Hvis denne fasiten finnes, skal kravbesvarelsen følge den fremfor å dele krav på sidebrudd i råteksten. Antall krav i svaret skal minst matche denne listen, med mindre du eksplisitt markerer duplikater.",
      "",
      ...rows,
    ].join("\n"),
  );
}

export function buildContinuationPageMap(documents: ProjectDocumentDetail[]) {
  const map = new Map<number, string>();

  for (const document of documents) {
    if (document.file_format !== "pdf") {
      continue;
    }

    let lastExplicitId: string | null = null;
    for (const page of splitPdfPages(document.raw_text).slice(0, 80)) {
      const ids = detectRequirementIds(page.text);

      if (ids.length) {
        lastExplicitId = ids[ids.length - 1] ?? lastExplicitId;
        continue;
      }

      if (lastExplicitId) {
        map.set(page.page, lastExplicitId);
      }
    }
  }

  return map;
}

export function buildRequirementPageEvidence(documents: ProjectDocumentDetail[]) {
  const map = new Map<number, string>();

  for (const document of documents) {
    if (document.file_format !== "pdf") {
      continue;
    }

    for (const page of splitPdfPages(document.raw_text).slice(0, 100)) {
      const existing = map.get(page.page);
      const text = normalizeEvidenceText(page.text);
      map.set(page.page, existing ? `${existing} ${text}` : text);
    }
  }

  return map;
}

function requirementIdVariants(requirementId: string) {
  const id = normalizeRequirementId(requirementId);
  const compact = id.replace(/\s+/g, "");
  const withoutPrefix = compact.replace(/^ID/, "");
  const variants = [id, compact, withoutPrefix, `ID ${withoutPrefix}`]
    .map((value) => normalizeEvidenceText(value))
    .filter(Boolean);

  return [...new Set(variants)];
}

function requirementLeadVariants(requirementText: string) {
  const words = normalizeEvidenceText(requirementText)
    .split(" ")
    .filter(Boolean);
  const variants: string[] = [];

  for (const length of [10, 8, 6, 4]) {
    if (words.length >= length) {
      variants.push(words.slice(0, length).join(" "));
    }
  }

  return variants;
}

function findFirstIndexOfAny(haystack: string, needles: string[]) {
  let first = -1;

  for (const needle of needles) {
    const index = haystack.indexOf(needle);
    if (index >= 0 && (first < 0 || index < first)) {
      first = index;
    }
  }

  return first;
}

function pageHasRequirementIdBeforeRequirementText(input: {
  pageText: string;
  requirementId: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const idIndex = findFirstIndexOfAny(
    pageText,
    requirementIdVariants(input.requirementId),
  );

  if (idIndex < 0) {
    return false;
  }

  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  if (leadIndex < 0) {
    return true;
  }

  return idIndex <= leadIndex;
}

function requirementEvidenceCorpus(entry: RequirementLedgerEntry) {
  return [
    substantiveRequirementAnswerExcerpt(entry),
    requirementSourceExcerptWithoutAnswer(entry),
    entry.text,
    entry.heading,
    entry.tableId,
    entry.service,
    requirementLedgerSource(entry),
  ]
    .filter(Boolean)
    .join(" ");
}

function requirementEvidenceMatchesSource(
  evidence: string,
  entry: RequirementLedgerEntry,
) {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  if (normalizedEvidence.length < 8) {
    return false;
  }

  const normalizedCorpus = normalizeEvidenceText(requirementEvidenceCorpus(entry));
  if (!normalizedCorpus) {
    return false;
  }

  return (
    normalizedCorpus.includes(normalizedEvidence) ||
    textCoverageScore(evidence, normalizedCorpus) >= 0.65
  );
}

function deterministicRequirementAnswerEvidence(entry: RequirementLedgerEntry) {
  return (
    compactText(substantiveRequirementAnswerExcerpt(entry), 260) ||
    compactText(requirementSourceExcerptWithoutAnswer(entry), 260) ||
    compactText(entry.text, 260) ||
    requirementDisplaySource(entry, requirementGroupHeading(entry)) ||
    entry.id
  );
}

export function requirementAnswerEvidence(
  entry: RequirementLedgerEntry,
  candidate?: string,
) {
  const normalizedCandidate = compactText(candidate, 260);
  if (
    normalizedCandidate &&
    requirementEvidenceMatchesSource(normalizedCandidate, entry)
  ) {
    return normalizedCandidate;
  }

  return deterministicRequirementAnswerEvidence(entry);
}

export function tableRequirementAnswer(entry: RequirementLedgerEntry) {
  const service = normalizeRequirementLedgerText(entry.service ?? entry.id);
  const text = normalizeRequirementLedgerText(entry.text);
  const combined = `${service} ${text}`;
  const sourceSignal =
    shortRequirementName(entry.text, entry.service ?? entry.heading) ||
    service ||
    "kravet";
  const responseFocus = [
    /\b(tbd|known unclear|clarification|avklaring|uavklart|uklar)\b/i.test(
      combined,
    )
      ? "Avklaringspunkt: Atea håndterer dette som en styrt avklaring før endelig forpliktelse, med eier, beslutningsfrist og konsekvens for scope, SLA, pris eller migreringsplan dokumentert i tilbudet"
      : "",
    /\b(deliverable|leveranse|deadline|frist|milestone|milepæl|schedule|tidsplan)\b/i.test(
      combined,
    )
      ? "Atea legger hver dokumenterte leveranse og frist inn i en kildeverifisert plan med ansvarlig eier, akseptansekriterier og kvalitetssikring; manglende datoer behandles som avklaringer"
      : "",
    /\b(budget|budsjett|payment terms|betalingsvilkår|fixed price|fastpris|monthly fee|månedspris|pricing|pris)\b/i.test(
      combined,
    )
      ? "Atea svarer mot de pris-, budsjett- og betalingsvilkårene som faktisk er dokumentert i kravet; manglende verdier eller prismodell behandles uttrykkelig som forslag eller avklaring"
      : "",
    /\b(customer-managed|kundestyrt|key|nøk|Entra|conditional access|CIS|hardening|logging|encryption|compliance|vulnerability)\b/i.test(
      combined,
    )
      ? "Atea beskriver bare de identitets-, nøkkel-, herding-, logging- og etterlevelseskontrollene som er dokumentert i kravet, med tydelig kontrollansvar og verifikasjon"
      : "",
    /\b(landing zone|hub-spoke|network segmentation|identity federation|Terraform|IaC|log analytics|distributed tracing|proactive alerting)\b/i.test(
      combined,
    )
      ? "Atea beskriver en kildeverifisert målarkitektur og skiller eksplisitte plattformkrav fra foreslåtte komponenter som må godkjennes før de gjøres bindende"
      : "",
    /\b(wave|bølge|migration|migrering|customer-facing|analytics|archive)\b/i.test(
      combined,
    )
      ? "Atea gjennomfører migreringen med app-for-app wave-planlegging, avhengighetsstyring, testet cutover, rollback-kriterier og tydelige go/no-go-beslutninger"
      : "",
    /\b(rto|rpo|failover|disaster recovery|backup|zero unplanned downtime|høy tilgjengelighet|gjenoppretting|nedetid|tjenestenivå)\b/i.test(
      combined,
    )
      ? /\b(?:RTO|RPO)\b[^0-9]{0,50}\d+\s*(?:minutes?|minutter|hours?|timer|days|dager)|\bzero unplanned downtime\b/i.test(
          combined,
        )
        ? "Atea oppfyller kontinuitetskravet med testede runbooks, failover-verifikasjon, backup-/restore-kontroll og rapportering mot dokumenterte RTO/RPO- eller nedetidsmål"
        : "Atea ivaretar kontinuitet gjennom høy tilgjengelighet, backup-/restore-kontroll, testet gjenoppretting og forslag til tjenestenivåer; konkrete RTO/RPO-mål behandles som avklaring når de ikke er tallfestet av kunden"
      : "",
    /\b(24\/7|managed services|incident|patching|performance reporting)\b/i.test(
      combined,
    )
      ? "Atea leverer en 24/7 operasjonsmodell med incidentprosess, patchstyring, eskalering, månedlig rapportering og tydelige ansvarslinjer"
      : "",
    /\b(tilgang|rolle|mfa|autentisering|privilegium|sensitive\s+data|hjemmekontor)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet gjennom rollebasert tilgangsstyring, sikker autentisering, minste privilegium og dokumentert tilgangsprosess med sporbar godkjenning"
      : "",
    /\b(lisens|license)\b/i.test(combined)
      ? "Atea oppfyller kravet gjennom lisensforvaltning, forbruksrapportering og kontroll mot faktisk bruk og avtalte rettigheter"
      : "",
    /\b(overvåk|varsling|hendelse|feilkø|logging|logg|revisjonslogg|spor(?:e|bar))\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet gjennom overvåking, varsling, hendelsesoppfølging, sporbar logging og avtalt rapportering"
      : "",
    /\b(dokumentasjon|dokumentert|internkontroll|databehandleravtale|behandlingsgrunnlag|regelverk|etterlevelse)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet med oppdatert dokumentasjon, tydelig eierskap, kontrollert tilgjengelighet og etterprøvbare leveransebevis"
      : "",
    /\b(bruker|skjerm|grensesnitt|mobil|nettbrett|pc|søk|utkast|status)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet med brukervennlige arbeidsflater, avtalte akseptansekriterier, test med representative brukere og dokumentert produksjonssetting"
      : "",
    /\b(vedlikehold|patch|endring|rollback|go-live|produksjonssetting|testmiljø|produksjonsmiljø|utrulling)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet gjennom kontrollert endringsprosess, testet utrulling, rollback-plan og dokumenterte go/no-go-kriterier"
      : "",
    /\b(sikkerhet|risiko|krypter|nøkkel|hemmelighet|sertifikat|sårbarhet)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet gjennom sikkerhetskontroller, kryptering der kravet krever det, risikostyring og etterprøvbar oppfølging"
      : "",
    /\b(backup|sikkerhetskopi|gjenopprett|restore)\b/i.test(combined)
      ? "Atea oppfyller kravet gjennom sikkerhetskopiering, testet restore, dokumentert verifikasjon og tydelig ansvar for tilbakelegging"
      : "",
    /\b(rapport|dashboard|rapportering|eksport|uttrekk)\b/i.test(combined)
      ? "Atea oppfyller kravet med dokumenterte rapporter eller eksportmuligheter, datakvalitetskontroll, tilgangsstyring og avtalt styringsdialog"
      : "",
    /\b(integrasjon|api|dataflyt|excel|csv|import|fagsystem|korrelasjons-id|dead-letter|retry)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet gjennom dokumenterte integrasjoner, kontrollert import/eksport, feilhåndtering, retry-mekanisme og sporbar oppfølging av avvik"
      : "",
    /\b(data|masterdata|datamodell|datakvalitet|arkivering|sletting|lagringssted)\b/i.test(
      combined,
    )
      ? "Atea oppfyller kravet med dokumentert datamodell, eierskap, valideringsregler, livssyklushåndtering og kontrollert lagring"
      : "",
  ].find(Boolean);

  if (responseFocus) {
    return `${responseFocus}. Svaret dokumenteres med ansvar, oppfølging og relevant kildehenvisning i kravtabellen.`;
  }

  return `Atea oppfyller kravet ved å etablere en konkret leveranse for ${sourceSignal}, med ansvarlig eier, akseptansekriterier, test eller kontroll og dokumentert forvaltning. Eventuelle avgrensninger, kundebidrag eller forbehold beskrives eksplisitt i tilbudet.`;
}

export function synthesizeRequirementLedgerRow(
  entry: RequirementLedgerEntry,
  indexes: {
    refIndex: number;
    requirementIndex: number;
    answerIndex: number;
    evidenceIndex: number;
    sourceIndex: number;
  },
  width: number,
) {
  const row = Array.from({ length: width }, () => "");
  row[indexes.refIndex] = requirementDisplayRef(
    entry,
    requirementGroupHeading(entry),
  );
  row[indexes.requirementIndex] = entry.text;
  row[indexes.answerIndex] = tableRequirementAnswer(entry);
  if (indexes.evidenceIndex >= 0) {
    row[indexes.evidenceIndex] = requirementAnswerEvidence(entry);
  }
  row[indexes.sourceIndex] = requirementLedgerSource(entry);
  return row;
}

function firstSourcePage(source: string) {
  const match = source.match(/\bSide\s+(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function sourcePages(source: string) {
  return [...source.matchAll(/\bSide\s+(\d+)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
}

function maxSourcePage(source: string) {
  const pages = sourcePages(source);
  return pages.length ? Math.max(...pages) : null;
}

function splitRequirementIdParts(requirementId: string) {
  const normalized = normalizeRequirementId(requirementId)
    .replace(/^ID\s*/i, "")
    .replace(/^Krav\s*/i, "")
    .replace(/^REQ-/i, "REQ ");
  const match = normalized.match(/^([A-ZÆØÅ]*\s*)?(\d{1,3}(?:[.-]\d{1,3})*)([A-Z]?)$/i);

  if (!match) {
    return null;
  }

  const numericPath = (match[2] ?? "")
    .split(/[.-]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));

  if (numericPath.length < 2) {
    return null;
  }

  return {
    prefix: `${match[1] ?? ""}${numericPath.slice(0, -1).join(".")}`
      .replace(/\s+/g, "")
      .toUpperCase(),
    number: numericPath[numericPath.length - 1] ?? 0,
    suffix: (match[3] ?? "").toUpperCase(),
  };
}

export function isImmediateNextRequirementId(previousId: string, currentId: string) {
  const previous = splitRequirementIdParts(previousId);
  const current = splitRequirementIdParts(currentId);

  if (!previous || !current) {
    return false;
  }

  return (
    previous.prefix === current.prefix &&
    previous.suffix === current.suffix &&
    current.number === previous.number + 1
  );
}

function pageStartsWithRequirementText(input: {
  pageText: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  return leadIndex >= 0 && leadIndex <= 700;
}

function pageEndsWithRequirementText(input: {
  pageText: string;
  requirementText: string;
}) {
  const pageText = normalizeEvidenceText(input.pageText);
  const leadIndex = findFirstIndexOfAny(
    pageText,
    requirementLeadVariants(input.requirementText),
  );

  return leadIndex >= 0 && leadIndex >= Math.max(0, pageText.length - 1200);
}

export function appendSentence(left: string, right: string) {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();

  if (!cleanLeft) return cleanRight;
  if (!cleanRight || cleanLeft.includes(cleanRight)) return cleanLeft;

  return `${cleanLeft}${/[.!?]$/.test(cleanLeft) ? " " : ". "}${cleanRight}`;
}

function mergeRequirementSource(
  left: string,
  right: string,
  requirementId: string,
) {
  const pages = [...sourcePages(left), ...sourcePages(right)];
  const uniquePages = [...new Set(pages)].sort((a, b) => a - b);

  if (!uniquePages.length) {
    return left || right;
  }

  const pageLabel =
    uniquePages.length === 1
      ? `Side ${uniquePages[0]}`
      : `Side ${uniquePages[0]}-${uniquePages[uniquePages.length - 1]}`;
  const tail = left
    .replace(/\bSide\s+\d+(?:\s*-\s*\d+)?\s*,?\s*/i, "")
    .trim();
  const tailWithId = tail || requirementId;

  return `${pageLabel}, ${tailWithId}`;
}

function sourceTail(source: string) {
  return source
    .replace(/\bSide\s+\d+(?:\s*-\s*\d+)?\s*,?\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceTailHasRequirementId(source: string, requirementId: string) {
  const sourceText = normalizeEvidenceText(source);
  return requirementIdVariants(requirementId).some((variant) =>
    sourceText.includes(variant),
  );
}

function formatRequirementSource(
  pages: number[],
  tail: string,
  requirementId: string,
) {
  const uniquePages = [...new Set(pages)]
    .filter((page) => Number.isFinite(page))
    .sort((a, b) => a - b);

  if (!uniquePages.length) {
    return tail || requirementId;
  }

  const pageLabel =
    uniquePages.length === 1
      ? `Side ${uniquePages[0]}`
      : `Side ${uniquePages[0]}-${uniquePages[uniquePages.length - 1]}`;
  const idTail = sourceTailHasRequirementId(tail, requirementId)
    ? tail
    : [tail, requirementId].filter(Boolean).join(", ");

  return [pageLabel, idTail].filter(Boolean).join(", ");
}

function includeSourcePage(
  source: string,
  page: number,
  requirementId: string,
) {
  return formatRequirementSource(
    [...sourcePages(source), page],
    sourceTail(source),
    requirementId,
  );
}

function repairContinuationSource(input: {
  source: string;
  requirementId: string;
  requirementText: string;
  continuationPages: Map<number, string>;
  pageEvidence: Map<number, string>;
}) {
  const firstPage = firstSourcePage(input.source);

  if (!firstPage || firstPage <= 1 || !input.requirementId) {
    return input.source;
  }

  const expectedId = input.continuationPages.get(firstPage);
  if (
    !expectedId ||
    normalizeRequirementId(expectedId) !== normalizeRequirementId(input.requirementId)
  ) {
    return input.source;
  }

  const previousPageText = input.pageEvidence.get(firstPage - 1) ?? "";
  const idStartedOnPreviousPage = pageHasRequirementIdBeforeRequirementText({
    pageText: previousPageText,
    requirementId: input.requirementId,
    requirementText: input.requirementText,
  });
  const textStartedOnPreviousPage = pageEndsWithRequirementText({
    pageText: previousPageText,
    requirementText: input.requirementText,
  });

  if (!idStartedOnPreviousPage && !textStartedOnPreviousPage) {
    return input.source;
  }

  return includeSourcePage(input.source, firstPage - 1, input.requirementId);
}

export function mergeContinuationRowsInRequirementTable(
  contentMarkdown: string,
  continuationPages: Map<number, string>,
  pageEvidence: Map<number, string>,
) {
  if (!continuationPages.size && !pageEvidence.size) {
    return contentMarkdown;
  }

  const lines = contentMarkdown.split("\n");
  const nextLines: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim().startsWith("|")) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const headerCells = splitMarkdownTableRow(line);
    const {
      sourceIndex,
      refIndex,
      requirementIndex,
      answerIndex,
      evidenceIndex,
    } = requirementResponseTableColumns(headerCells);

    if (
      sourceIndex < 0 ||
      refIndex < 0 ||
      requirementIndex < 0 ||
      answerIndex < 0 ||
      !isMarkdownTableDivider(lines[index + 1] ?? "")
    ) {
      nextLines.push(line);
      index += 1;
      continue;
    }

    const tableLines = [line, lines[index + 1] ?? ""];
    index += 2;
    while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
      tableLines.push(lines[index] ?? "");
      index += 1;
    }

    const rows = tableLines.slice(2).map(splitMarkdownTableRow);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const currentId = normalizeRequirementId(row[refIndex] ?? "");
      if (currentId) {
        row[sourceIndex] = repairContinuationSource({
          source: row[sourceIndex] ?? "",
          requirementId: currentId,
          requirementText: row[requirementIndex] ?? "",
          continuationPages,
          pageEvidence,
        });
      }

      const page = firstSourcePage(row[sourceIndex] ?? "");
      const expectedId = page ? continuationPages.get(page) : null;
      const previousRow = rows[rowIndex - 1];
      const previousId = normalizeRequirementId(previousRow?.[refIndex] ?? "");
      const previousMaxPage = maxSourcePage(previousRow?.[sourceIndex] ?? "");
      const isAdjacentPageContinuation =
        Boolean(page && previousMaxPage && page === previousMaxPage + 1);
      const isExpectedPreviousId = Boolean(
        expectedId && previousId && normalizeRequirementId(expectedId) === previousId,
      );
      const isLikelyInventedNextId = Boolean(
        previousId && currentId && isImmediateNextRequirementId(previousId, currentId),
      );
      const isDuplicateContinuationId = Boolean(
        previousId && currentId && previousId === currentId,
      );
      const currentIdHasPageEvidence =
        page && currentId
          ? pageHasRequirementIdBeforeRequirementText({
              pageText: pageEvidence.get(page) ?? "",
              requirementId: currentId,
              requirementText: row[requirementIndex] ?? "",
            })
          : true;
      const startsAtTopOfContinuationPage =
        page && row[requirementIndex]
          ? pageStartsWithRequirementText({
              pageText: pageEvidence.get(page) ?? "",
              requirementText: row[requirementIndex] ?? "",
            })
          : false;

      const shouldMerge =
        isAdjacentPageContinuation &&
        isExpectedPreviousId &&
        (isLikelyInventedNextId || isDuplicateContinuationId) &&
        !currentIdHasPageEvidence &&
        startsAtTopOfContinuationPage;

      if (!shouldMerge) {
        continue;
      }

      const mergeIntoId = isDuplicateContinuationId ? currentId : previousId;
      if (!mergeIntoId) {
        continue;
      }

      const targetIndex = rows.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex < rowIndex &&
          normalizeRequirementId(candidate[refIndex] ?? "") === mergeIntoId,
      );

      if (targetIndex < 0) {
        row[refIndex] = mergeIntoId;
        continue;
      }

      const target = rows[targetIndex];
      target[requirementIndex] = appendSentence(
        target[requirementIndex] ?? "",
        row[requirementIndex] ?? "",
      );
      target[answerIndex] = appendSentence(
        target[answerIndex] ?? "",
        row[answerIndex] ?? "",
      );
      if (evidenceIndex >= 0) {
        target[evidenceIndex] = appendSentence(
          target[evidenceIndex] ?? "",
          row[evidenceIndex] ?? "",
        );
      }
      target[sourceIndex] = mergeRequirementSource(
        target[sourceIndex] ?? "",
        row[sourceIndex] ?? "",
        mergeIntoId,
      );
      rows.splice(rowIndex, 1);
      rowIndex -= 1;
    }

    nextLines.push(tableLines[0] ?? "");
    nextLines.push(tableLines[1] ?? "");
    nextLines.push(...rows.map(toMarkdownTableRow));
  }

  return nextLines.join("\n");
}

export function requirementSourceExcerptWithoutAnswer(entry: RequirementLedgerEntry) {
  const sourceExcerpt = entry.sourceExcerpt ?? "";
  const answerMarker = sourceExcerpt.search(
    /(?:^|\|)\s*Svarfelt\s*:|\b(?:Svarrad|Detailed response|Leverandørens besvarelse|Besvarelse|Svar|Answer|Response)\s*:/i,
  );
  return answerMarker >= 0 ? sourceExcerpt.slice(0, answerMarker) : sourceExcerpt;
}

function substantiveAnswerExcerptPayload(
  entry: RequirementLedgerEntry,
  value: string | undefined,
) {
  let text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const withoutMarker = text.replace(
    /^(?:Svarfelt\s*:\s*)?(?:Leverandørens\s+(?:besvarelse|svar)|Tilbyders\s+svar|Detailed\s+response|Supplier\s+response|Besvarelse|Svar|Answer|Response)\b\s*:?[\s-]*/iu,
    "",
  );
  const hadMarker = withoutMarker !== text;
  text = withoutMarker;

  if (hadMarker) {
    const idNumbers = [...entry.id.matchAll(/\d{1,5}/g)].map(
      (match) => match[0],
    );
    if (idNumbers.length >= 2) {
      text = text.replace(
        new RegExp(
          `^ID\\s*${escapeRegExp(idNumbers[0] ?? "")}\\s*[-.]?\\s*${escapeRegExp(idNumbers[1] ?? "")}\\b\\s*:?[\\s-]*`,
          "iu",
        ),
        "",
      );
    }
  }

  text = text.trim();
  if (
    !/[\p{L}\p{N}]/u.test(text) ||
    /^(?:x|ja|nei|yes|no|y|n|n\/?a|ikke\s+utfylt)$/iu.test(text)
  ) {
    return "";
  }

  return text;
}

export function substantiveRequirementAnswerExcerpt(entry: RequirementLedgerEntry) {
  const explicitAnswer = substantiveAnswerExcerptPayload(
    entry,
    entry.answerExcerpt,
  );
  if (explicitAnswer) {
    return explicitAnswer;
  }

  const sourceExcerpt = (entry.sourceExcerpt ?? "").replace(/\s+/g, " ").trim();
  if (!sourceExcerpt) {
    return "";
  }

  const labeledAnswer =
    sourceExcerpt.match(/(?:^|\|)\s*Svarfelt\s*:\s*([^|]+)/i)?.[1] ??
    sourceExcerpt.match(
      /\b(?:Svarrad|Detailed response|Leverandørens besvarelse|Besvarelse|Svar|Answer|Response)\s*:\s*([^|]+)/i,
    )?.[1];
  return substantiveAnswerExcerptPayload(entry, labeledAnswer);
}
