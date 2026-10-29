import "server-only";

// Requirement extraction from PDF layout lines and tables, with the shared
// duplicate and source-order rules the later ledger builders rely on.
import { compactText } from "@/lib/server/ai/context";
import { escapeRegExp } from "@/lib/server/document-intelligence/text-normalization";
import { parsePdf } from "@/lib/server/pdf-parser";
import { buildDelimitedContext } from "@/lib/server/prompts";
import {
  buildHeadingPath,
  headingLevel,
  isLikelyHeadingLine,
  stripRequirementChrome,
} from "@/lib/server/requirements/heading-detection";
import {
  detectExplicitRequirementIds,
  detectRequirementIds,
  explicitRequirementIdPattern,
  isContextualNonRequirementExplicitId,
} from "@/lib/server/requirements/id-detection";
import { lastHeadingSegment, normalizeRequirementId } from "@/lib/server/requirements/normalization";
import {
  documentRequirementId,
  isPdfFooterOrChromeHeadingLine,
  normalizePageText,
  normalizePdfReferenceTypography,
  normalizePdfSpacing,
  normalizeTableId,
  splitPdfPagesPreservingLines,
} from "@/lib/server/requirements/pdf-normalization";
import {
  cleanTableRequirement,
  cleanTableService,
  isPetoroCanonicalRepairPdfSha256,
  repairTableRowTextArtifacts,
} from "@/lib/server/requirements/pdf-table-repairs";
import { type RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { type ProjectDocumentDetail } from "@/lib/types";
import { createHash } from "node:crypto";

type PdfLayoutTextItem = {
  str: string;
  transform: number[];
  width?: number;
};

type PdfLayoutLine = {
  y: number;
  items: Array<{ str: string; x: number; y: number; width: number }>;
  text: string;
};

type PdfLayoutPage = {
  page: number;
  lines: PdfLayoutLine[];
};

export function hasRequirementSignal(value: string) {
  const text = normalizePageText(value);
  if (text.length < 18 || text.length > 1600) {
    return false;
  }

  return (
    /(?:^|[^\p{L}\p{N}_])(?:skal|bes|beskriv(?:e|er)?|redegjør(?:e|er)?|krever|forutsetter|forventes|ønsker|etterspør|skal kunne|må kunne|blir\s+ansvarlig|har\s+ansvar\s+for|shall|must|should|required|expected|responsible)(?=$|[^\p{L}\p{N}_])/iu.test(
      text,
    ) ||
    /(?:^|[\s(])(?:må|bør|ønskes|ønskelig)(?=\s|$)/i.test(text)
  );
}

function isStructuredRequirementStart(value: string) {
  const text = normalizePageText(value);
  return (
    detectExplicitRequirementIds(text).length > 0 ||
    /^\s*(?:[-*•]|\d{1,3}[.)]|\d+(?:\.\d+){1,4})\s+/.test(value) ||
    /^\s*(?:Krav|Requirement|Leverandøren|Tilbyder|Løsningen|Tjenesten|Systemet|Plattformen|Kunden)\b/i.test(
      text,
    )
  );
}

export function isLikelyDetailOrAnswerBlock(value: string) {
  const text = normalizePageText(value);
  const hasStrongRequirementVerb =
    /\b(?:skal|må|bør|bes|krever|forutsetter|shall|must|should|required)\b/i.test(
      text,
    );
  if (
    /^(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Leveransen|Leveransene|Løsningen|Løsningene|Tjenesten|Tjenestene|Systemet|Plattformen)\b.{0,700}\b(?:skal|må|bør|bes|krever|forutsetter|shall|must|should|required)\b/i.test(
      text,
    )
  ) {
    return false;
  }

  return (
    /^(?:[-*•]\s*)?(?:forutsetninger?|avklaringer?|presiseringer?|detaljeringer?|eksempler?|ved behov|i tillegg|dette innebærer|status|tiltak|anbefaling|retting|bevis|vurdering)\b/i.test(
      text,
    ) ||
    (!hasStrongRequirementVerb &&
      /\b(?:for eksempel|eksempelvis|kan også|avklares i|forutsetning(?:en|er)?|presisering(?:en|er)?|detaljering(?:en|er)?)\b/i.test(
        text,
      )) ||
    /^\s*(?:Leverandørens\s+besvarelse|Detailed\s+response|Supplier\s+response|Answer|Response)\b/i.test(
      text,
    ) ||
    /^(?!(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Løsningen|Løsningene|Tjenesten|Tjenestene|Tjenester|Systemet|Plattformen)\b)[A-ZÆØÅ][\p{L}\d&./-]{1,50}\s+(?:bekrefter|besvarer|tilbyr|leverer|etablerer|ivaretar|sikrer|benytter|gjennomfører|har|vil)\b/iu.test(
      text,
    )
  );
}

export function hasStandaloneRequirementLanguage(value: string) {
  const text = normalizePageText(value);
  return (
    /\b(?:skal|må|bes|krever|forutsetter|shall|must|required)\b/i.test(text) &&
    (/\b(?:Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Leveransen|Leveransene|Løsningen|Tjenesten|Systemet|Plattformen|Kunden)\s+(?:skal|må|bes|bør|kan|har|skal kunne|må kunne)\b/i.test(
      text,
    ) ||
      /\b(?:det|dette)\s+skal\b/i.test(text) ||
      /\b(?:det|dette)\s+forventes\b/i.test(text) ||
      /\bkrav(?:et|ene)?\s+(?:skal|må|er|bes)\b/i.test(text))
  );
}

export function isStandaloneRequirementCandidate(input: {
  block: string;
  text: string;
  explicitId: string;
}) {
  if (input.explicitId) {
    return input.text.length >= 8 && !isLikelyDetailOrAnswerBlock(input.text);
  }

  if (
    !hasRequirementSignal(input.text) ||
    !isStructuredRequirementStart(input.block) ||
    isLikelyDetailOrAnswerBlock(input.text)
  ) {
    return false;
  }

  if (hasStandaloneRequirementLanguage(input.text)) {
    return true;
  }

  return (
    /^\s*(?:[-*•]|\d{1,3}[.)]|\d+(?:\.\d+){1,4})\s+/.test(input.block) &&
    input.text.length <= 420 &&
    /\b(?:skal|må|bes|krever|forutsetter|shall|must|required)\b/i.test(input.text)
  );
}

export function syntheticRequirementId(page: number, index: number) {
  return `Side ${page} krav ${index}`;
}

function pageExcerpt(text: string, position: "start" | "end") {
  const normalized = normalizePageText(text);
  if (normalized.length <= 260) {
    return normalized;
  }

  return position === "start"
    ? `${normalized.slice(0, 260)}...`
    : `...${normalized.slice(-260)}`;
}

export function buildRequirementContinuityContext(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return "";
  }

  const pages = splitPdfPagesPreservingLines(document.raw_text);
  if (!pages.length) {
    return "";
  }

  const lines: string[] = [
    `Dokument: ${document.title}`,
    "Denne kontrollen styrer kravdeling over sideskift:",
    "- Opprett ny kravrad bare når en ny krav-ID er synlig i kravdokumentet, eller når teksten åpenbart starter et nytt selvstendig krav med egen markør.",
    "- Ikke finn opp neste løpenummer. Tekst på ny side uten synlig krav-ID er fortsettelse av forrige krav.",
    "- Hvis en side starter med kravtekst, men uten ny ID, skal teksten slås sammen med forrige krav og samme krav-ID beholdes.",
    "",
  ];
  let lastExplicitId: string | null = null;

  for (const page of pages.slice(0, 60)) {
    const ids = detectRequirementIds(page.text);

    if (ids.length) {
      lastExplicitId = ids[ids.length - 1] ?? lastExplicitId;
      lines.push(
        `Side ${page.page}: synlige krav-ID-er: ${ids.join(", ")}. Start: ${pageExcerpt(page.text, "start")}`,
      );
      continue;
    }

    if (lastExplicitId) {
      lines.push(
        `Side ${page.page}: ingen ny synlig krav-ID. Behandle teksten som fortsettelse av ${lastExplicitId}, ikke som nytt krav. Start: ${pageExcerpt(page.text, "start")}`,
      );
    } else {
      lines.push(
        `Side ${page.page}: ingen synlig krav-ID. Ikke opprett krav-ID basert på antatt løpenummer. Start: ${pageExcerpt(page.text, "start")}`,
      );
    }
  }

  return buildDelimitedContext(
    `Sideskift- og krav-ID-kontroll for ${document.title}`,
    lines.join("\n"),
  );
}

function detectTableId(line: string) {
  const normalized = normalizePdfSpacing(line);
  const match = normalized.match(
    /\bTabell\s*ID\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i,
  );
  return match ? normalizeTableId(match[0]) : "";
}

export function isTableHeaderOrAnswerLine(line: string) {
  return /^(Tjeneste|Spesifiserte krav|Ja|Nei|Del\b|-vis|Detaljeringer\b|Leverandørens svar)/i.test(
    normalizePdfSpacing(line),
  );
}

function isServiceRequirementTableHeaderLine(line: string) {
  const normalized = normalizePdfSpacing(line);
  return /^Tjeneste\s+Spesifiserte\s+krav\b/i.test(normalized);
}

export function tableRequirementStartIndex(line: string) {
  const normalized = normalizePdfSpacing(line);
  const patterns = [
    /\b(?:Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Leverandør)\s+(?:skal|må|bes|bør|har|kan)(?=\s|$|[.,;:])/iu,
    /\b(?:Løsningen|Løsningene|Tjenesten|Tjenestene|Systemet|Plattformen)\s+(?:skal|må|bør|kan)(?=\s|$|[.,;:])/iu,
    /\bKunden\s+(?:skal|kan|må)(?=\s|$|[.,;:])/iu,
    /\bAll\s+drifts-/i,
    /\bOversikt\s+over\b/i,
    /\bI\s+samråd\s+med\s+Kunden\b/i,
    /\bFølgende\s+oppgaver\b/i,
    /\bAktiviteter\s+under\b/i,
    /\bVed\s+avtaleperiodens\s+utløp\b/i,
    /\bDet\s+(?:skal|er)\b/i,
    /\b(?:Beskriv|Redegjør)\s+(?:hvordan|hvilket|hvilke|for|kort|rutiner|løsning|prosess)\b/i,
    /\bKrav(?:et|ene)?\s+(?:skal|må|bør)(?=\s|$|[.,;:])/iu,
  ];

  const indexes = patterns
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0);

  return indexes.length ? Math.min(...indexes) : -1;
}

function stripPdfBoilerplatePrefix(value: string) {
  let text = cleanTableRequirement(value);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = text
      .replace(/^Konfidensiel\s*l?\s*/i, "")
      .replace(
        /^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\s*[\d,.\s]+\s*TIL\s*SSA\s*-\s*D\s*\d{3,4}\s*/i,
        "",
      )
      .replace(/^Side\s*\d+\s*av\s*\d+\s*/i, "")
      .replace(/^\d+\s*TIL\s*SSA\s*-\s*D\s*\d{3,4}\s*/i, "")
      .trim();
    if (next === text) {
      break;
    }
    text = next;
  }

  return text;
}

function supplierNarrativeStartPattern() {
  // Deliberately case-sensitive for the supplier-name token. With /i,
  // lowercase Norwegian relative clauses such as "brukere som har hatt ..."
  // make `som har` look like a supplier subject + verb and truncate the
  // requirement. Supplier narratives start with a proper-name capital.
  return /^(?!(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Løsningen|Løsningene|Tjenesten|Tjenestene|Tjenester|Systemet|Plattformen)\b)[A-ZÆØÅ][\p{L}\d&./-]{1,50}\s+(?:bekrefter|besvarer|tilbyr|leverer|etablerer|ivaretar|sikrer|benytter|gjennomfører|har\s+(?:etablert|implementert|utviklet|dokumentert|valgt|konfigurert)|vil\s+(?:levere|etablere|implementere|benytte|sikre|tilby|gjennomføre))\b/u;
}

export function stripAnswerTextFromRequirement(value: string) {
  let text = stripPdfBoilerplatePrefix(value);
  if (!text) {
    return "";
  }

  const embeddedId = [...text.matchAll(explicitRequirementIdPattern())].find(
    (match) => {
      const markerStart = match.index ?? 0;
      return !isContextualNonRequirementExplicitId(
        match[0],
        text.slice(Math.max(0, markerStart - 24), markerStart),
      );
    },
  );
  const embeddedIdIndex = embeddedId?.index ?? -1;
  if (embeddedId?.[0] && embeddedIdIndex > 0) {
    const beforeId = stripPdfBoilerplatePrefix(text.slice(0, embeddedIdIndex));
    const afterId = stripPdfBoilerplatePrefix(
      text.slice(embeddedIdIndex + embeddedId[0].length),
    );
    if (
      beforeId &&
      (hasRequirementSignal(beforeId) ||
        hasStandaloneRequirementLanguage(beforeId))
    ) {
      text = beforeId;
    } else if (
      afterId &&
      (!beforeId ||
        beforeId.length < 220 ||
        (!hasRequirementSignal(beforeId) &&
          !hasStandaloneRequirementLanguage(beforeId)))
    ) {
      text = afterId;
    }
  }

  if (supplierNarrativeStartPattern().test(text)) {
    return "";
  }

  const explicitAnswerMarker =
    /\b(?:leverandørens|tilbyders|supplier(?:'s)?|detailed)\s+(?:besvarelse|svar|response)\b|\b(?:besvarelse|svar|answer|response)\s*:/i;
  const explicitMatch = explicitAnswerMarker.exec(text);
  if (explicitMatch?.index && explicitMatch.index > 0) {
    const before = text.slice(0, explicitMatch.index).trim();
    const markerIsRequirementPhrase =
      /\b(?:i|på|til|fra|av|med|for)$/iu.test(before);
    if (
      !markerIsRequirementPhrase &&
      (hasRequirementSignal(before) || hasStandaloneRequirementLanguage(before))
    ) {
      return before;
    }
  }

  const yesNoAnswerMarker =
    /\s+(?:x|ja|nei|yes|no|y|n)\s+(?=(?!(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Løsningen|Løsningene|Tjenesten|Tjenestene|Tjenester|Systemet|Plattformen)\b)[A-ZÆØÅ][\p{L}\d&./-]{1,50}\s+(?:bekrefter|besvarer|tilbyr|leverer|etablerer|ivaretar|sikrer|benytter|gjennomfører|har\s+(?:etablert|implementert|utviklet|dokumentert|valgt|konfigurert)|vil\s+(?:levere|etablere|implementere|benytte|sikre|tilby|gjennomføre))\b)/u;
  const yesNoMatch = yesNoAnswerMarker.exec(text);
  if (yesNoMatch?.index && yesNoMatch.index > 0) {
    const before = text.slice(0, yesNoMatch.index).trim();
    if (hasRequirementSignal(before) || hasStandaloneRequirementLanguage(before)) {
      return before;
    }
  }

  const supplierNarrativeMarker =
    /\s+(?=(?!(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Løsningen|Løsningene|Tjenesten|Tjenestene|Tjenester|Systemet|Plattformen)\b)[A-ZÆØÅ][\p{L}\d&./-]{1,50}\s+(?:bekrefter|besvarer|tilbyr|leverer|etablerer|ivaretar|sikrer|benytter|gjennomfører|har\s+(?:etablert|implementert|utviklet|dokumentert|valgt|konfigurert)|vil\s+(?:levere|etablere|implementere|benytte|sikre|tilby|gjennomføre))\b)/u;
  const narrativeMatch = supplierNarrativeMarker.exec(text);
  if (narrativeMatch?.index && narrativeMatch.index > 12) {
    const before = text.slice(0, narrativeMatch.index).trim();
    const markerContinuesRequirementSentence =
      /\b(?:at|som|der|hvordan|hvorvidt|om|og|eller|samt|med|for|til|av)$/iu.test(
        before,
      );
    if (
      !markerContinuesRequirementSentence &&
      (hasRequirementSignal(before) || hasStandaloneRequirementLanguage(before))
    ) {
      return before;
    }
  }

  return text;
}

type PdfRequirementTableLayout = {
  serviceX: number;
  requirementX: number;
  yesX: number;
  noX: number;
  answerX: number;
  answerBoundary: number;
};

type PdfLayoutRequirementDraft = {
  tableId: string;
  service: string;
  requirementLines: string[];
  answerLines: string[];
  sourceLines: string[];
  pages: number[];
  heading: string;
  startPage: number;
  standalone: boolean;
};

function renderPdfLayoutLines(items: PdfLayoutTextItem[]) {
  const lines: PdfLayoutLine[] = [];

  for (const item of items) {
    const text = item.str.trim();
    if (!text) {
      continue;
    }

    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    const target =
      line ??
      (() => {
        const created: PdfLayoutLine = { y, items: [], text: "" };
        lines.push(created);
        return created;
      })();

    target.items.push({
      str: text,
      x,
      y,
      width: Number(item.width ?? 0),
    });
  }

  return lines
    .sort(
      (left, right) =>
        right.y - left.y ||
        ((left.items[0]?.x ?? 0) - (right.items[0]?.x ?? 0)),
    )
    .map((line) => {
      const sortedItems = [...line.items].sort((left, right) => left.x - right.x);
      return {
        ...line,
        items: sortedItems,
        text: normalizePdfSpacing(sortedItems.map((item) => item.str).join(" ")),
      };
    });
}

type PdfSourceExtraction = {
  layoutPages: PdfLayoutPage[];
  rawText: string;
};

const pdfSourceExtractionCache = new WeakMap<
  ProjectDocumentDetail,
  Promise<PdfSourceExtraction>
>();

async function readPdfSourceExtraction(
  document: ProjectDocumentDetail,
): Promise<PdfSourceExtraction> {
  if (
    document.file_format !== "pdf" ||
    !document.file_base64 ||
    document.file_base64.length < 100
  ) {
    return { layoutPages: [], rawText: "" };
  }

  const cached = pdfSourceExtractionCache.get(document);
  if (cached) {
    return cached;
  }

  const extraction = (async () => {
    const layoutPages: PdfLayoutPage[] = [];
    const textPages: Array<{ page: number; text: string }> = [];
    try {
      await parsePdf(Buffer.from(document.file_base64, "base64"), (page, items) => {
        const textItems = items as PdfLayoutTextItem[];
        layoutPages.push({
          page,
          lines: renderPdfLayoutLines(textItems),
        });
        const text = normalizePdfReferenceTypography(
          textItems.map((item) => item.str).join(" "),
        );
        if (text) {
          textPages.push({ page, text });
        }
        return "";
      });
    } catch {
      return { layoutPages: [], rawText: "" };
    }

    layoutPages.sort((left, right) => left.page - right.page);
    textPages.sort((left, right) => left.page - right.page);
    return {
      layoutPages,
      rawText: textPages
        .map((page) => `[[SIDE:${page.page}]]\n${page.text}`)
        .join("\n\n"),
    };
  })();
  pdfSourceExtractionCache.set(document, extraction);
  return extraction;
}

export async function readPdfLayoutPages(document: ProjectDocumentDetail) {
  return (await readPdfSourceExtraction(document)).layoutPages;
}

export async function readPdfRawTextFromFile(document: ProjectDocumentDetail) {
  return (await readPdfSourceExtraction(document)).rawText;
}

function pdfLayoutHeaderItem(
  line: PdfLayoutLine,
  pattern: RegExp,
) {
  return line.items.find((item) => pattern.test(normalizePdfSpacing(item.str)));
}

function detectPdfRequirementTableLayout(
  line: PdfLayoutLine,
): PdfRequirementTableLayout | null {
  const service = pdfLayoutHeaderItem(line, /^Tjeneste$/i);
  const requirement = pdfLayoutHeaderItem(line, /Spesifiserte\s+krav/i);
  const yes = pdfLayoutHeaderItem(line, /^Ja$/i);
  const no = pdfLayoutHeaderItem(line, /^Nei$/i);
  const answer = pdfLayoutHeaderItem(
    line,
    /Detaljeringer|presiseringer|Detailed|Response/i,
  );

  if (!service || !requirement) {
    return null;
  }

  const yesX = yes?.x ?? (answer ? requirement.x + (answer.x - requirement.x) * 0.55 : requirement.x + 180);
  const noX = no?.x ?? yesX + 20;
  const answerX = answer?.x ?? noX + 75;

  return {
    serviceX: service.x,
    requirementX: requirement.x,
    yesX,
    noX,
    answerX,
    answerBoundary: noX + (answerX - noX) * 0.45,
  };
}

function pdfLayoutTableHeading(line: string, tableId: string) {
  return normalizePdfSpacing(line)
    .replace(new RegExp(escapeRegExp(tableId), "i"), " ")
    .replace(/\bLeverandørens\s+svar\b/gi, " ")
    .replace(/\bSupplier\s+response\b/gi, " ")
    .replace(/[–-]\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPdfLayoutBoilerplateLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    !text ||
    /^Konfidensiell$/i.test(text) ||
    /^(Tjeneste|Spesifiserte krav|Ja|Nei|Del|-vis)$/i.test(text) ||
    /^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G/i.test(text) ||
    /^,\d*\s*TIL\s*SSA-D/i.test(text) ||
    /^Side\s*\d+\s*av\s*\d+$/i.test(text) ||
    /Side\s*\d+\s*av\s*\d+$/i.test(text)
  );
}

function splitPdfLayoutRequirementColumns(
  line: PdfLayoutLine,
  layout: PdfRequirementTableLayout,
) {
  const service: string[] = [];
  const requirement: string[] = [];
  const answer: string[] = [];
  const marker: string[] = [];

  for (const item of line.items) {
    if (item.x < layout.requirementX - 8) {
      service.push(item.str);
      continue;
    }

    if (item.x >= layout.answerBoundary - 6) {
      answer.push(item.str);
      continue;
    }

    if (item.x >= layout.yesX - 12 && item.x < layout.answerBoundary - 6) {
      marker.push(item.str);
      continue;
    }

    requirement.push(item.str);
  }

  return {
    service: cleanTableService(service.join(" ")),
    requirement: cleanTableRequirement(requirement.join(" ")),
    answer: cleanTableRequirement(answer.join(" ")),
    marker: cleanTableRequirement(marker.join(" ")),
  };
}

function isPdfLayoutServiceStart(value: string) {
  const service = cleanTableService(value);
  if (
    !service ||
    service.length > 110 ||
    /[.!?]$/.test(service) ||
    /^[-•]/.test(service) ||
    /^(og|eller|for|til|i|av|på|med)\b/i.test(service) ||
    /\b(skal|må|bes|følge|sikre|utføre|beskrive)\b/i.test(service)
  ) {
    return false;
  }

  return /^[A-ZÆØÅ0-9]/.test(service) && service.split(/\s+/).length <= 10;
}

function shouldContinuePdfLayoutService(input: {
  current: PdfLayoutRequirementDraft | null;
  service: string;
  requirement: string;
  answer: string;
  page: number;
}) {
  const service = cleanTableService(input.service);
  if (
    !input.current ||
    !service ||
    input.page !== input.current.startPage ||
    input.current.sourceLines.length > 8
  ) {
    return false;
  }

  if (/^[a-zæøå]/.test(service) || input.current.service.endsWith("-")) {
    return true;
  }

  const incomingStartsNewRequirement =
    hasRequirementSignal(input.requirement) ||
    hasStandaloneRequirementLanguage(input.requirement);
  if (
    incomingStartsNewRequirement &&
    input.current.requirementLines.join(" ").length >= 18
  ) {
    return false;
  }

  const serviceWords = service.split(/\s+/);
  const compactService = service.replace(/\s+/g, "");
  if (
    serviceWords.length <= 3 &&
    compactService.length <= 28 &&
    input.current.sourceLines.length <= 4
  ) {
    return true;
  }

  return (
    service.length <= 28 &&
    !hasRequirementSignal(input.requirement) &&
    input.current.requirementLines.join(" ").length < 260 &&
    !input.answer
  );
}

function isPdfLayoutStandaloneRequirementHeading(value: string) {
  const service = cleanTableService(value);
  return (
    service.length >= 18 &&
    service.length <= 130 &&
    /krav/i.test(service) &&
    /^[A-ZÆØÅ0-9]/.test(service) &&
    !/[.!?]$/.test(service)
  );
}

function sourceExcerptFromLayoutDraft(draft: PdfLayoutRequirementDraft) {
  return compactText(cleanTableRequirement(draft.sourceLines.join(" ")), 1600);
}

export function looksLikeTruncatedRequirementText(value: string) {
  const text = cleanTableRequirement(value);
  return (
    text.length < 120 &&
    (!/[.!?]$/.test(text) ||
      /\b(?:og|eller|for|ved|hvordan|hvilket|hvilke)$/i.test(text))
  );
}

function completeLayoutRequirementTextFromSource(input: {
  service: string;
  text: string;
  sourceExcerpt: string;
}) {
  if (!looksLikeTruncatedRequirementText(input.text)) {
    return input.text;
  }

  const labeled = labeledRequirementTextCandidate(input.sourceExcerpt);
  if (labeled && labeled.length >= input.text.length) {
    return labeled;
  }

  const source = cleanTableRequirement(input.sourceExcerpt)
    .replace(/\s+-\s*vis\b/gi, " ")
    .replace(/\s+/g, " ");
  const startIndex = tableRequirementStartIndex(source);
  if (startIndex < 0) {
    return input.text;
  }

  const candidate = cleanTableRequirement(source.slice(startIndex))
    .replace(/\bved\s+tilganger\s+bruk\b/gi, "ved bruk")
    .replace(/\s+/g, " ");

  if (
    candidate.length >= input.text.length + 24 &&
    hasRequirementSignal(candidate)
  ) {
    return stripAnswerTextFromRequirement(candidate);
  }

  return input.text;
}

const knownCanonicalPdfSourceSha256Cache = new WeakMap<
  ProjectDocumentDetail,
  string
>();

export function knownCanonicalPdfSourceSha256(document: ProjectDocumentDetail) {
  const cached = knownCanonicalPdfSourceSha256Cache.get(document);
  if (cached !== undefined) {
    return cached;
  }

  const sourceSha256 =
    document.file_format === "pdf" && document.file_base64
      ? createHash("sha256")
          .update(Buffer.from(document.file_base64, "base64"))
          .digest("hex")
      : "";
  const knownSourceSha256 = isPetoroCanonicalRepairPdfSha256(sourceSha256)
    ? sourceSha256
    : "";
  knownCanonicalPdfSourceSha256Cache.set(document, knownSourceSha256);
  return knownSourceSha256;
}

function layoutDraftToRequirement(
  draft: PdfLayoutRequirementDraft,
  sourceDocumentSha256: string,
): RequirementLedgerEntry | null {
  const sourceExcerpt = sourceExcerptFromLayoutDraft(draft);
  const repaired = repairTableRowTextArtifacts({
    service: draft.service,
    text: completeLayoutRequirementTextFromSource({
      service: draft.service,
      text: stripAnswerTextFromRequirement(draft.requirementLines.join(" ")),
      sourceExcerpt,
    }),
    sourceDocumentSha256,
    tableId: draft.tableId,
  });
  const { service, text } = repaired;
  const answer = cleanTableRequirement(draft.answerLines.join(" "));
  const pages = [...new Set(draft.pages)].sort((left, right) => left - right);

  if (!text || text.length < 18 || isLikelyDetailOrAnswerBlock(text)) {
    return null;
  }

  if (
    !service &&
    draft.tableId &&
    (pages.length > 2 || detectExplicitRequirementIds(sourceExcerpt).length > 1)
  ) {
    return null;
  }

  return {
    id: `${draft.tableId} - ${service || text.slice(0, 48)}`,
    text,
    pages,
    heading: draft.heading,
    tableId: draft.tableId,
    service,
    sourceExcerpt,
    answerExcerpt: answer || undefined,
  };
}

function shortPdfLayoutRequirementLabel(text: string) {
  return cleanTableRequirement(text)
    .replace(/^(Leverandøren|Tilbyder|Kunden|Løsningen|Tjenesten)\s+(skal|må|bør|bes|kan)\s+/i, "")
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[.,;:]$/g, "")
    .trim();
}

function makePdfLayoutRequirementReferencesUnique(
  entries: RequirementLedgerEntry[],
) {
  const groups = new Map<string, RequirementLedgerEntry[]>();
  for (const entry of entries) {
    const key = normalizeRequirementLedgerText(
      `${entry.tableId ?? ""}|${entry.service ?? entry.id}`,
    );
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return entries.map((entry) => {
    const key = normalizeRequirementLedgerText(
      `${entry.tableId ?? ""}|${entry.service ?? entry.id}`,
    );
    const group = groups.get(key) ?? [];
    if (group.length <= 1) {
      return entry;
    }

    const index = group.indexOf(entry);
    const label = shortPdfLayoutRequirementLabel(entry.text) || `del ${index + 1}`;
    return {
      ...entry,
      id: `${entry.id} - ${label}`,
    };
  });
}

function buildPdfLayoutOptionRequirements(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const seen = new Set<string>();

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const text = normalizePdfSpacing(page.text);
    for (const match of text.matchAll(
      /\b(?:Opsjon|Option)\s+ID\s*(\d{1,3}\s*[-.]\s*\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?)\s*:\s*([^•\n]+(?:\s+(?!Opsjon\s+ID|Option\s+ID)[^•\n]+){0,2})/gi,
    )) {
      const id = `ID ${normalizePdfSpacing(match[1] ?? "").replace(/\s*[-.]\s*/g, "-")}`;
      const optionText = cleanTableRequirement(match[2] ?? "");
      const key = normalizeRequirementId(id);

      if (!optionText || seen.has(key)) {
        continue;
      }

      seen.add(key);
      requirements.push({
        id,
        text: optionText,
        pages: [page.page],
        heading: "Opsjoner",
        service: id,
        sourceExcerpt: optionText,
      });
    }
  }

  return requirements;
}

export async function buildPdfLayoutTableRequirementLedger(
  document: ProjectDocumentDetail,
) {
  const pages = await readPdfLayoutPages(document);
  if (!pages.length) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const sourceDocumentSha256 = knownCanonicalPdfSourceSha256(document);
  let activeTableId = "";
  let activeHeading = "";
  let layout: PdfRequirementTableLayout | null = null;
  let current: PdfLayoutRequirementDraft | null = null;
  let mode: "table" | "standaloneRequirement" | "standaloneAnswer" = "table";

  function flushCurrent() {
    if (!current) {
      return;
    }

    const entry = layoutDraftToRequirement(current, sourceDocumentSha256);
    if (entry) {
      requirements.push(entry);
    }

    current = null;
    mode = "table";
  }

  function appendToCurrent(input: {
    page: number;
    source: string;
    requirement?: string;
    answer?: string;
  }) {
    if (!current) {
      return;
    }

    if (!current.pages.includes(input.page)) {
      current.pages.push(input.page);
    }

    if (input.requirement) {
      current.requirementLines.push(input.requirement);
    }

    if (input.answer) {
      current.answerLines.push(input.answer);
    }

    if (input.source) {
      current.sourceLines.push(input.source);
    }
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const tableId = detectTableId(line.text);
      if (tableId) {
        if (
          (activeTableId && tableId !== activeTableId) ||
          (current?.standalone &&
            mode === "standaloneAnswer" &&
            page.page > current.startPage + 1)
        ) {
          flushCurrent();
        }

        activeTableId = tableId;
        activeHeading = pdfLayoutTableHeading(line.text, tableId) || activeHeading;
        continue;
      }

      const detectedLayout = detectPdfRequirementTableLayout(line);
      if (detectedLayout) {
        layout = detectedLayout;
        continue;
      }

      if (
        !activeTableId ||
        !layout ||
        line.y < 55 ||
        line.y > 470 ||
        isPdfLayoutBoilerplateLine(line.text)
      ) {
        continue;
      }

      const columns = splitPdfLayoutRequirementColumns(line, layout);
      const hasColumnText = Boolean(columns.requirement || columns.answer);

      if (current?.standalone && mode === "standaloneAnswer") {
        if (page.page > current.startPage + 1) {
          flushCurrent();
          activeTableId = "";
          layout = null;
          continue;
        }

        appendToCurrent({
          page: page.page,
          source: line.text,
          answer: line.text,
        });
        continue;
      }

      if (/^Leverandørens\s+besvarelse\b/i.test(line.text)) {
        if (current) {
          mode = "standaloneAnswer";
          appendToCurrent({
            page: page.page,
            source: line.text,
            answer: line.text,
          });
        }
        continue;
      }

      if (current?.standalone && mode === "standaloneRequirement") {
        appendToCurrent({
          page: page.page,
          source: line.text,
          requirement: line.text,
        });
        continue;
      }

      if (
        columns.service &&
        hasColumnText &&
        shouldContinuePdfLayoutService({
          current,
          service: columns.service,
          requirement: columns.requirement,
          answer: columns.answer,
          page: page.page,
        })
      ) {
        if (current) {
          current.service = cleanTableService(
            [current.service, columns.service].join(" "),
          );
        }
        appendToCurrent({
          page: page.page,
          source: line.text,
          requirement: columns.requirement,
          answer: columns.answer,
        });
        continue;
      }

      if (
        columns.service &&
        isPdfLayoutServiceStart(columns.service) &&
        hasColumnText &&
        (hasRequirementSignal(columns.requirement) || columns.answer || !current)
      ) {
        flushCurrent();
        current = {
          tableId: activeTableId,
          service: columns.service,
          requirementLines: columns.requirement ? [columns.requirement] : [],
          answerLines: columns.answer ? [columns.answer] : [],
          sourceLines: [line.text],
          pages: [page.page],
          heading: activeHeading,
          startPage: page.page,
          standalone: false,
        };
        mode = "table";
        continue;
      }

      if (
        columns.service &&
        !hasColumnText &&
        isPdfLayoutStandaloneRequirementHeading(columns.service)
      ) {
        flushCurrent();
        current = {
          tableId: activeTableId,
          service: columns.service,
          requirementLines: [columns.service],
          answerLines: [],
          sourceLines: [line.text],
          pages: [page.page],
          heading: activeHeading,
          startPage: page.page,
          standalone: true,
        };
        mode = "standaloneRequirement";
        continue;
      }

      if (current) {
        appendToCurrent({
          page: page.page,
          source: line.text,
          requirement: columns.requirement,
          answer:
            columns.answer ||
            (!columns.requirement && !columns.service ? line.text : ""),
        });
      }
    }
  }

  flushCurrent();

  return dedupeRequirementLedger(
    makePdfLayoutRequirementReferencesUnique([
      ...requirements,
      ...buildPdfLayoutOptionRequirements(document),
    ]),
  );
}

export function normalizeRequirementLedgerText(value: string) {
  return normalizePdfSpacing(value)
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

export function isTableOfContentsLine(value: string) {
  const text = normalizePdfSpacing(value);
  return (
    /^Table of Contents$/i.test(text) ||
    /\.{5,}\s*\d{1,4}\s*$/.test(text)
  );
}

function isTableOfContentsRequirementCandidate(entry: RequirementLedgerEntry) {
  const text = normalizePdfSpacing(entry.text);
  return (
    /table of contents/i.test(entry.heading) ||
    (isTableOfContentsLine(text) && !hasRequirementSignal(text))
  );
}

export function isTableContainerRequirement(entry: RequirementLedgerEntry) {
  const source = normalizeRequirementLedgerText(entry.sourceExcerpt ?? "");
  const sourceLooksLikeFlattenedKravObservasjonTable =
    /ref\s+tema\s+krav\s*\/\s*observasjon\s+må\s*\/?\s*bør\??\s+kommentar/i.test(
      source,
    ) &&
    source.length >= 700 &&
    (source.match(/\bleverandøren\s+skal\s+ta\b/gi) ?? []).length >= 3;
  if (sourceLooksLikeFlattenedKravObservasjonTable) {
    return true;
  }

  if (entry.tableId) {
    return false;
  }

  const text = normalizeRequirementLedgerText(entry.text);
  const tableMarkerCount = (
    text.match(/\btabell\s+id\s+\d{1,3}-\d{1,3}[a-z]?\b/g) ?? []
  ).length;

  const hasTableIntroLanguage =
    /\b(følgende|nedenfor|under|tabell|tabellene|oversikt|oppgaver|aktiviteter|krav)\b/i.test(
      text,
    );
  const hasManyRequirementSignals =
    (text.match(/\b(?:skal|må|bes|bør)\b/g) ?? []).length >= 4;

  return (
    tableMarkerCount >= 2 ||
    (tableMarkerCount >= 1 &&
      text.length >= 700 &&
      hasTableIntroLanguage &&
      hasManyRequirementSignals)
  );
}

function isLikelyTableServiceLine(line: string) {
  const cleaned = cleanTableService(line);
  if (!cleaned || cleaned.length > 70 || /[.!?]$/.test(cleaned)) {
    return false;
  }

  const wordCount = cleaned.split(/\s+/).length;
  return wordCount <= 5 && !/\b(skal|må|kan|bes|følge|sikre|utføre)\b/i.test(cleaned);
}

export function isLikelyTableServiceOrTitleLine(line: string) {
  if (isLikelyTableServiceLine(line)) {
    return true;
  }

  const cleaned = cleanTableService(line);
  if (!cleaned || cleaned.length > 120 || /[.!?]$/.test(cleaned)) {
    return false;
  }

  const wordCount = cleaned.split(/\s+/).length;
  return (
    wordCount <= 12 &&
    /^[A-ZÆØÅ]/.test(cleaned) &&
    !/\b(?:skal|må|kan|bes|følge|sikre|utføre|bekrefter|inngår|leveres)\b/i.test(
      cleaned,
    ) &&
    /\b(?:krav|helpdesk|tam|administrasjon|håndtering|overvåke|dokumentasjon|kontroll|forvaltning|patcher|rapportering|vedlikehold|tilgang|lisens|feil|sikkerhet|varsling|rådgivning|erfaring|avslutning)\b/i.test(
      cleaned,
    )
  );
}

export function buildPageHeadingMap(document: ProjectDocumentDetail) {
  const map = new Map<number, string>();
  const stack: string[] = [];

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const lines = page.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines.slice(0, 30)) {
      if (
        isAnswerSectionMarkerLine(line) ||
        /^\s*ID\s*\d{1,3}\s*[-.]\s*$/i.test(normalizePdfSpacing(line))
      ) {
        break;
      }

      if (!isLikelyHeadingLine(line)) {
        continue;
      }

      const level = headingLevel(line);
      stack[level - 1] = line;
      stack.length = level;
    }

    const path = buildHeadingPath(stack);
    if (path) {
      map.set(page.page, path);
    }
  }

  return map;
}

export function findHeadingBeforeOffset(
  pageText: string,
  offset: number,
  fallback: string,
) {
  const before = pageText.slice(0, Math.max(0, offset));
  const lines = before
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter(isLikelyHeadingLine);

  if (!headings.length) {
    return fallback;
  }

  return buildHeadingPath(headings.slice(-3)) || fallback;
}

function serviceRequirementTableIdFromHeading(value: string) {
  const heading = lastHeadingSegment(value || "").trim();
  if (
    !heading ||
    /^kravtabell$/i.test(heading) ||
    isPdfFooterOrChromeHeadingLine(heading)
  ) {
    return "";
  }

  return heading;
}

function isServiceRequirementTableIntroLine(line: string) {
  return /^(?:Følgende|Nedenfor)\b/i.test(line) &&
    /\b(?:oppgaver|aktiviteter|tjenesten|inngår|beskriver)\b/i.test(line);
}

function cleanServiceRequirementTableService(value: string) {
  return cleanTableService(value)
    .replace(/^\d{1,3}[.)]\s*/, "")
    .replace(/^[,.;:–—]+|[,.;:–—]+$/g, "")
    .trim();
}

function isPlausibleServiceRequirementRowService(value: string) {
  const service = cleanServiceRequirementTableService(value);
  if (!service) {
    return false;
  }

  if (
    /\b(?:Kunden|Kundens|Leveransen|Leveransens|Leverandøren|Leverandørens)\b/i.test(
      service,
    ) ||
    /^(?:og|eller|som|for|til|av|på|med)\b/i.test(service) ||
    /\b(?:og|eller|som|for|til|av|på|med)$/i.test(service)
  ) {
    return false;
  }

  return (
    /^[A-ZÆØÅ]/.test(service) && isLikelyTableServiceOrTitleLine(service)
  );
}

export function buildServiceRequirementTableLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  const sourceDocumentSha256 = knownCanonicalPdfSourceSha256(document);
  let activeTableId = "";
  let tableActive = false;
  let pendingHeading = "";
  let activeSectionHeading = "";
  let pendingSectionHeading = "";
  let current:
    | {
        tableId: string;
        section: string;
        service: string;
        text: string;
        pages: number[];
        heading: string;
        order: number;
      }
    | null = null;
  let serviceBuffer: string[] = [];
  let pendingServiceBuffer: string[] = [];

  function flushCurrent() {
    if (!current) {
      return;
    }

    const repaired = repairTableRowTextArtifacts({
      service: current.service,
      text: stripAnswerTextFromRequirement(current.text),
      sourceDocumentSha256,
      tableId: current.tableId,
    });
    const { service, text } = repaired;
    if (service && text.length >= 20 && !isLikelyDetailOrAnswerBlock(text)) {
      const section = cleanTableService(current.section);
      const baseId = `${current.tableId} - ${service}`;
      const shouldDisambiguate =
        section &&
        normalizeRequirementId(section) !== normalizeRequirementId(service) &&
        requirements.some((entry) => entry.id === baseId);
      const id = shouldDisambiguate
        ? `${current.tableId} - ${section} - ${service}`
        : baseId;
      requirements.push({
        id,
        text,
        pages: current.pages,
        heading:
          current.section && current.heading
            ? `${current.heading} > ${current.section}`
            : current.heading || current.tableId,
        tableId: current.tableId,
        service,
        sourceExcerpt: [section, service, text].filter(Boolean).join(" "),
        documentEntryOrder: current.order,
      });
    }
    current = null;
  }

  function startRow(input: {
    tableId: string;
    section: string;
    service: string;
    text: string;
    page: number;
    heading: string;
    order: number;
  }) {
    flushCurrent();
    current = {
      tableId: input.tableId,
      section: cleanTableService(input.section),
      service: cleanServiceRequirementTableService(input.service),
      text: cleanTableRequirement(input.text),
      pages: [input.page],
      heading: input.heading || input.tableId,
      order: input.order,
    };
    serviceBuffer = [];
    pendingServiceBuffer = [];
    pendingSectionHeading = "";
  }

  function appendToCurrent(line: string, page: number, heading: string) {
    if (!current) {
      return;
    }

    if (pendingServiceBuffer.length) {
      current.text = [current.text, pendingServiceBuffer.join(" ")]
        .filter(Boolean)
        .join(" ");
      pendingServiceBuffer = [];
    }
    current.text = [current.text, line].filter(Boolean).join(" ");
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
    if (heading) {
      current.heading = heading;
    }
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? "";
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);
    const pageHasServiceRequirementTableHeader = lines.some(
      isServiceRequirementTableHeaderLine,
    );

    if (tableActive && !pageHasServiceRequirementTableHeader) {
      flushCurrent();
      activeTableId = "";
      tableActive = false;
      serviceBuffer = [];
      pendingServiceBuffer = [];
      activeSectionHeading = "";
      pendingSectionHeading = "";
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const order = page.page * 10_000 + lineIndex;

      if (detectTableId(line)) {
        flushCurrent();
        activeTableId = "";
        tableActive = false;
        serviceBuffer = [];
        pendingServiceBuffer = [];
        activeSectionHeading = "";
        pendingSectionHeading = "";
        continue;
      }

      if (isServiceRequirementTableHeaderLine(line)) {
        if (pendingSectionHeading) {
          flushCurrent();
          activeSectionHeading = cleanTableService(pendingSectionHeading);
          pendingSectionHeading = "";
        }
        activeTableId =
          activeTableId ||
          serviceRequirementTableIdFromHeading(pendingHeading) ||
          serviceRequirementTableIdFromHeading(pageHeading);
        tableActive = Boolean(activeTableId);
        serviceBuffer = [];
        pendingServiceBuffer = [];
        continue;
      }

      if (!tableActive || !activeTableId) {
        if (
          !isTableHeaderOrAnswerLine(line) &&
          !isServiceRequirementTableIntroLine(line) &&
          isLikelyHeadingLine(line)
        ) {
          pendingHeading = line;
        }
        continue;
      }

      if (/^Leverandørens\s+besvarelse\b/i.test(line)) {
        flushCurrent();
        activeTableId = "";
        tableActive = false;
        serviceBuffer = [];
        pendingServiceBuffer = [];
        activeSectionHeading = "";
        pendingSectionHeading = "";
        continue;
      }

      if (isTableHeaderOrAnswerLine(line)) {
        continue;
      }

      const nextLine = lines[lineIndex + 1] ?? "";
      const serviceOnlyLine = isLikelyTableServiceOrTitleLine(line);
      if (serviceOnlyLine && isServiceRequirementTableHeaderLine(nextLine)) {
        pendingSectionHeading = line;
        continue;
      }

      const nextRequirementIndex = tableRequirementStartIndex(nextLine);
      if (serviceOnlyLine && nextRequirementIndex >= 0) {
        const service = [
          serviceBuffer.join(" "),
          pendingServiceBuffer.join(" "),
          line,
        ]
          .map(cleanServiceRequirementTableService)
          .filter(Boolean)
          .join(" ");
        const requirementText = stripAnswerTextFromRequirement(
          nextLine.slice(nextRequirementIndex),
        );
        if (service && requirementText) {
          startRow({
            tableId: activeTableId,
            section: activeSectionHeading,
            service,
            text: requirementText,
            page: page.page,
            heading: activeTableId,
            order,
          });
          lineIndex += 1;
          continue;
        }
      }

      const requirementIndex = tableRequirementStartIndex(line);
      if (requirementIndex >= 0) {
        const beforeRequirement = cleanServiceRequirementTableService(
          line.slice(0, requirementIndex),
        );
        const requirementText = stripAnswerTextFromRequirement(
          line.slice(requirementIndex),
        );
        const rowService =
          beforeRequirement &&
          isPlausibleServiceRequirementRowService(beforeRequirement)
            ? beforeRequirement
            : "";
        const service = [
          serviceBuffer.join(" "),
          pendingServiceBuffer.join(" "),
          rowService,
        ]
          .map(cleanServiceRequirementTableService)
          .filter(Boolean)
          .join(" ");

        if (service) {
          startRow({
            tableId: activeTableId,
            section: activeSectionHeading,
            service,
            text: requirementText,
            page: page.page,
            heading: activeTableId,
            order,
          });
          continue;
        }

        if (current) {
          appendToCurrent(line, page.page, activeTableId);
          continue;
        }
      }

      if (serviceOnlyLine) {
        if (current) {
          pendingServiceBuffer.push(line);
        } else {
          serviceBuffer.push(line);
        }
        continue;
      }

      appendToCurrent(line, page.page, activeTableId);
    }
  }

  flushCurrent();
  return requirements;
}

export function buildTableRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  const sourceDocumentSha256 = knownCanonicalPdfSourceSha256(document);
  let activeTableId = "";
  let current:
    | {
        tableId: string;
        service: string;
        text: string;
        pages: number[];
        heading: string;
      }
    | null = null;
  let serviceBuffer: string[] = [];
  let pendingServiceBuffer: string[] = [];

  function flushCurrent() {
    if (!current) {
      return;
    }

    const repaired = repairTableRowTextArtifacts({
      service: current.service,
      text: stripAnswerTextFromRequirement(current.text),
      sourceDocumentSha256,
      tableId: current.tableId,
    });
    const { service, text } = repaired;
    if (text.length >= 20 && !isLikelyDetailOrAnswerBlock(text)) {
      if (
        !service &&
        current.tableId &&
        (current.pages.length > 2 || detectExplicitRequirementIds(text).length > 1)
      ) {
        current = null;
        return;
      }

      requirements.push({
        id: `${current.tableId}${service ? ` - ${service}` : ""}`,
        text,
        pages: current.pages,
        heading: current.heading,
        tableId: current.tableId,
        service,
      });
    }
    current = null;
  }

  function flushPendingServiceIntoCurrent() {
    if (current && pendingServiceBuffer.length) {
      current.text = [current.text, pendingServiceBuffer.join(" ")]
        .filter(Boolean)
        .join(" ");
    }
    pendingServiceBuffer = [];
  }

  function startRow(input: {
    tableId: string;
    service: string;
    text: string;
    page: number;
    heading: string;
  }) {
    flushCurrent();
    current = {
      tableId: input.tableId,
      service: cleanTableService(input.service),
      text: cleanTableRequirement(input.text),
      pages: [input.page],
      heading: input.heading,
    };
    serviceBuffer = [];
    pendingServiceBuffer = [];
  }

  function appendToCurrent(line: string, page: number, heading: string) {
    if (!current) {
      serviceBuffer.push(line);
      return;
    }

    flushPendingServiceIntoCurrent();
    current.text = [current.text, line].filter(Boolean).join(" ");
    if (!current.pages.includes(page)) {
      current.pages.push(page);
    }
    if (heading) {
      current.heading = heading;
    }
  }

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? "";
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const tableId = detectTableId(line);
      if (tableId) {
        if (current && tableId === activeTableId) {
          serviceBuffer = [];
          pendingServiceBuffer = [];
          continue;
        }

        flushPendingServiceIntoCurrent();
        flushCurrent();
        activeTableId = tableId;
        serviceBuffer = [];
        pendingServiceBuffer = [];
        continue;
      }

      if (!activeTableId || isTableHeaderOrAnswerLine(line)) {
        continue;
      }

      if (/^Leverandørens\s+besvarelse\b/i.test(line)) {
        flushPendingServiceIntoCurrent();
        flushCurrent();
        activeTableId = "";
        serviceBuffer = [];
        pendingServiceBuffer = [];
        continue;
      }

      const nextLine = lines[lineIndex + 1] ?? "";
      const serviceOnlyLine = isLikelyTableServiceOrTitleLine(line);
      const nextRequirementIndex = tableRequirementStartIndex(nextLine);
      if (serviceOnlyLine && nextRequirementIndex >= 0) {
        const service = [
          serviceBuffer.join(" "),
          pendingServiceBuffer.join(" "),
          line,
        ]
          .map(cleanTableService)
          .filter(Boolean)
          .join(" ");
        const requirementText = stripAnswerTextFromRequirement(
          nextLine.slice(nextRequirementIndex),
        );
        if (service && requirementText) {
          startRow({
            tableId: activeTableId,
            service,
            text: requirementText,
            page: page.page,
            heading: pageHeading,
          });
          lineIndex += 1;
          continue;
        }
      }

      const requirementIndex = tableRequirementStartIndex(line);
      if (requirementIndex >= 0) {
        const beforeRequirement = cleanTableService(line.slice(0, requirementIndex));
        const requirementText = stripAnswerTextFromRequirement(
          line.slice(requirementIndex),
        );
        const rowService =
          /^[A-ZÆØÅ]/.test(beforeRequirement) &&
          isLikelyTableServiceOrTitleLine(beforeRequirement)
            ? beforeRequirement
            : "";
        const service = [
          serviceBuffer.join(" "),
          pendingServiceBuffer.join(" "),
          rowService,
        ]
          .map(cleanTableService)
          .filter(Boolean)
          .join(" ");

        if (current && (service || pendingServiceBuffer.length) && requirementIndex >= 0) {
          startRow({
            tableId: activeTableId,
            service,
            text: requirementText,
            page: page.page,
            heading: pageHeading,
          });
          continue;
        }

        if (!current) {
          startRow({
            tableId: activeTableId,
            service,
            text: requirementText,
            page: page.page,
            heading: pageHeading,
          });
          continue;
        }
      }

      if (
        current &&
        serviceOnlyLine &&
        (/^[A-ZÆØÅ]/.test(line) || pendingServiceBuffer.length > 0)
      ) {
        pendingServiceBuffer.push(line);
        continue;
      }

      appendToCurrent(line, page.page, pageHeading);
    }
  }

  flushCurrent();
  return requirements;
}

export function splitDocumentPagesForRequirementScan(document: ProjectDocumentDetail) {
  if (document.file_format === "pdf") {
    const pages = splitPdfPagesPreservingLines(document.raw_text);
    if (pages.length) {
      return pages;
    }
  }

  return [{ page: 1, text: document.raw_text.replace(/\r\n/g, "\n").trim() }];
}

function requirementDocumentDedupeScope(entry: RequirementLedgerEntry) {
  return normalizeEvidenceText(entry.documentId ?? "");
}

function scopedRequirementDedupeKey(
  entry: RequirementLedgerEntry,
  key: string,
) {
  const scope = requirementDocumentDedupeScope(entry);
  return scope ? `${scope}::${key}` : key;
}

export function canDedupeRequirementEntries(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  const leftScope = requirementDocumentDedupeScope(left);
  const rightScope = requirementDocumentDedupeScope(right);
  return !leftScope || !rightScope || leftScope === rightScope;
}

export function dedupeRequirementLedger(
  entries: RequirementLedgerEntry[],
  sourceDocumentSha256 = "",
) {
  const seen = new Set<string>();
  const seenExplicitIds = new Map<string, number[]>();
  const seenRequirementTexts = new Map<string, number>();
  const result: RequirementLedgerEntry[] = [];

  for (const rawEntry of entries) {
    const entry = repairRequirementLedgerEntryArtifacts(
      rawEntry,
      sourceDocumentSha256,
    );
    if (
      isTableOfContentsRequirementCandidate(entry) ||
      isTableContainerRequirement(entry) ||
      isRunawayMergedRequirementBlock(entry) ||
      isSpuriousExplicitContinuationRequirement(entry) ||
      isSpuriousTableContinuationRequirement(entry)
    ) {
      continue;
    }

    const id = requirementDedupeIdKey(entry.id);
    const text = normalizeEvidenceText(entry.text);
    const explicitIdKey =
      id && /\d/.test(id) && !isGeneratedRequirementId(entry.id) ? id : "";
    const scopedExplicitIdKey = explicitIdKey
      ? scopedRequirementDedupeKey(entry, explicitIdKey)
      : "";
    if (explicitIdKey) {
      const existingIndex = (
        seenExplicitIds.get(scopedExplicitIdKey) ?? []
      ).find((candidateIndex) => {
        const candidate = result[candidateIndex];
        if (!candidate) return false;
        if (
          shouldPreferExistingExplicitDuplicate(candidate, entry) ||
          shouldPreferIncomingExplicitDuplicate(candidate, entry)
        ) {
          return true;
        }
        const sameRequirementText =
          normalizeEvidenceText(candidate.text) === text;
        if (sameRequirementText) {
          return !shouldPreserveRepeatedRequirementUnit(candidate, entry);
        }
        return (
          explicitIdEntriesAreDuplicateProjection(candidate, entry) ||
          isOverlappingTableRequirementDuplicate(candidate, entry)
        );
      });
      if (existingIndex !== undefined) {
        const existing = result[existingIndex];
        if (existing && shouldPreferExistingExplicitDuplicate(existing, entry)) {
          continue;
        }
        if (existing && shouldPreferIncomingExplicitDuplicate(existing, entry)) {
          result[existingIndex] = keepEarliestRequirementSourceOrder(
            existing,
            entry,
          );
          continue;
        }
        if (existing && shouldKeepOrderedSourceUnit(existing, entry)) {
          continue;
        }
        if (
          existing &&
          requirementLedgerEntryQuality(entry) >
            requirementLedgerEntryQuality(existing)
        ) {
          result[existingIndex] = keepEarliestRequirementSourceOrder(
            existing,
            entry,
          );
        }
        continue;
      }
    }

    const textOnlyKey = normalizeEvidenceText(
      entry.text.replace(/\bResponsinstruks:\s*.*$/i, ""),
    );
    const scopedTextOnlyKey = scopedRequirementDedupeKey(entry, textOnlyKey);
    if (!explicitIdKey && textOnlyKey.length >= 28) {
      const existingTextIndex = seenRequirementTexts.get(scopedTextOnlyKey);
      if (existingTextIndex !== undefined) {
        const existing = result[existingTextIndex];
        if (existing && shouldPreserveRepeatedRequirementUnit(existing, entry)) {
          seenRequirementTexts.set(scopedTextOnlyKey, result.length);
          result.push(entry);
          continue;
        }
        if (existing && shouldKeepOrderedSourceUnit(existing, entry)) {
          continue;
        }
        if (
          existing &&
          requirementLedgerEntryQuality(entry) >
            requirementLedgerEntryQuality(existing)
        ) {
          result[existingTextIndex] = keepEarliestRequirementSourceOrder(
            existing,
            entry,
          );
        }
        continue;
      }
    }

    const overlappingTableIndex = result.findIndex(
      (existing) =>
        isOverlappingTableRequirementDuplicate(existing, entry) &&
        canDedupeRequirementEntries(existing, entry) &&
        !shouldPreserveRepeatedRequirementUnit(existing, entry),
    );
    if (overlappingTableIndex >= 0) {
      const existing = result[overlappingTableIndex];
      if (existing && shouldKeepOrderedSourceUnit(existing, entry)) {
        continue;
      }
      if (
        existing &&
        requirementLedgerEntryQuality(entry) >=
          requirementLedgerEntryQuality(existing)
      ) {
        result[overlappingTableIndex] = keepEarliestRequirementSourceOrder(
          existing,
          entry,
        );
      }
      continue;
    }

    const normalizedExplicitSourceExcerpt = normalizeEvidenceText(
      entry.sourceExcerpt ?? "",
    );
    const explicitSourceUnitKey =
      explicitIdKey &&
      finiteRequirementOrderValue(entry.documentEntryOrder) !== null &&
      normalizedExplicitSourceExcerpt
        ? `:${entry.documentEntryOrder}:${normalizedExplicitSourceExcerpt}`
        : "";
    const key = scopedRequirementDedupeKey(
      entry,
      id
        ? `${id}:${text.slice(0, 120)}${explicitSourceUnitKey}`
        : text.slice(0, 180),
    );
    if (!text || seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (explicitIdKey) {
      const existingIndexes = seenExplicitIds.get(scopedExplicitIdKey);
      if (existingIndexes) {
        existingIndexes.push(result.length);
      } else {
        seenExplicitIds.set(scopedExplicitIdKey, [result.length]);
      }
    }
    if (!explicitIdKey && textOnlyKey.length >= 28) {
      seenRequirementTexts.set(scopedTextOnlyKey, result.length);
    }
    result.push(entry);
  }

  return result;
}

function isUnstructuredRequirementTableEntry(entry: RequirementLedgerEntry) {
  return /^Ustrukturert kravtabell$/i.test(entry.tableId ?? "");
}

function isPdfExplicitIdFallbackEntry(entry: RequirementLedgerEntry) {
  return /^PDF krav-ID$/i.test(entry.tableId ?? "");
}

function isUnstructuredRequirementEntry(entry: RequirementLedgerEntry) {
  return /^Ustrukturert\b/i.test(entry.tableId ?? "");
}

function isOrderedPdfAnswerFieldRequirement(
  entry: RequirementLedgerEntry,
) {
  return (
    hasPdfAnswerFieldSourceExcerpt(entry) &&
    finiteRequirementOrderValue(entry.documentEntryOrder) !== null
  );
}

function shouldPreferExistingExplicitDuplicate(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  return (
    (isOrderedPdfAnswerFieldRequirement(existing) &&
      !isOrderedPdfAnswerFieldRequirement(incoming)) ||
    (isUnstructuredRequirementTableEntry(existing) &&
      isPdfExplicitIdFallbackEntry(incoming))
  );
}

function shouldPreferIncomingExplicitDuplicate(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  return (
    (!isOrderedPdfAnswerFieldRequirement(existing) &&
      isOrderedPdfAnswerFieldRequirement(incoming)) ||
    (isPdfExplicitIdFallbackEntry(existing) &&
      isUnstructuredRequirementTableEntry(incoming))
  );
}

function finiteRequirementOrderValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type RequirementSourceOrderKey = {
  documentOrder: number;
  entryOrder: number | null;
  page: number | null;
  row: number | null;
};

function requirementSourceOrderKey(
  entry: RequirementLedgerEntry,
): RequirementSourceOrderKey | null {
  const documentOrder = finiteRequirementOrderValue(entry.documentOrder) ?? 0;
  const entryOrder = finiteRequirementOrderValue(entry.documentEntryOrder);
  if (entryOrder !== null) {
    return { documentOrder, entryOrder, page: null, row: null };
  }

  const firstPage = Array.isArray(entry.pages)
    ? entry.pages.find((page) => Number.isFinite(page))
    : undefined;
  if (typeof firstPage !== "number") {
    return null;
  }

  const row =
    Number(
      /\b(?:rad|row)\s+(\d{1,5})\b/i.exec(entry.sourceExcerpt ?? "")?.[1] ??
        "",
    ) || 0;
  return { documentOrder, entryOrder: null, page: firstPage, row };
}

function compareNullableOrderValue(
  left: number | null,
  right: number | null,
) {
  const missing = Number.MAX_SAFE_INTEGER;
  return (left ?? missing) - (right ?? missing);
}

function compareRequirementSourceOrder(
  left: RequirementSourceOrderKey,
  right: RequirementSourceOrderKey,
) {
  return (
    left.documentOrder - right.documentOrder ||
    compareNullableOrderValue(left.entryOrder, right.entryOrder) ||
    compareNullableOrderValue(left.page, right.page) ||
    compareNullableOrderValue(left.row, right.row)
  );
}

function keepEarliestRequirementSourceOrder(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  const existingOrder = requirementSourceOrderKey(existing);
  const incomingOrder = requirementSourceOrderKey(incoming);
  if (
    existingOrder === null ||
    (incomingOrder !== null &&
      compareRequirementSourceOrder(incomingOrder, existingOrder) < 0)
  ) {
    return incoming;
  }

  return {
    ...incoming,
    documentOrder: existing.documentOrder ?? incoming.documentOrder,
    documentEntryOrder:
      existing.documentEntryOrder ?? incoming.documentEntryOrder,
  };
}

function shouldKeepOrderedSourceUnit(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  return (
    typeof existing.documentEntryOrder === "number" &&
    Number.isFinite(existing.documentEntryOrder) &&
    (typeof incoming.documentEntryOrder !== "number" ||
      !Number.isFinite(incoming.documentEntryOrder))
  );
}

function shouldPreserveRepeatedRequirementUnit(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  if (
    typeof existing.documentEntryOrder !== "number" ||
    typeof incoming.documentEntryOrder !== "number"
  ) {
    return false;
  }

  const sourceLocatorHeadingSuffix =
    /(?:\s*[-–—:]\s*)?(?:tabell|table)\s+\d+\s*,?\s*(?:rad|row)\s+\d+\s*$/i;
  const existingHeading = normalizeRequirementLedgerText(existing.heading)
    .replace(sourceLocatorHeadingSuffix, "")
    .trim();
  const incomingHeading = normalizeRequirementLedgerText(incoming.heading)
    .replace(sourceLocatorHeadingSuffix, "")
    .trim();
  const existingSource = normalizeRequirementLedgerText(
    existing.sourceExcerpt || existing.id,
  );
  const incomingSource = normalizeRequirementLedgerText(
    incoming.sourceExcerpt || incoming.id,
  );
  if (!existingSource || !incomingSource || existingSource === incomingSource) {
    return false;
  }

  const existingAnswerReference = normalizeCoverageEvidenceText(
    existing.answerReference ?? "",
  );
  const incomingAnswerReference = normalizeCoverageEvidenceText(
    incoming.answerReference ?? "",
  );
  if (
    /^Markdown kravbesvarelse$/i.test(existing.tableId ?? "") &&
    /^Markdown kravbesvarelse$/i.test(incoming.tableId ?? "") &&
    existingAnswerReference &&
    incomingAnswerReference &&
    existingAnswerReference !== incomingAnswerReference
  ) {
    return true;
  }

  if (existingHeading && incomingHeading && existingHeading !== incomingHeading) {
    return true;
  }

  const existingId = requirementDedupeIdKey(existing.id);
  const incomingId = requirementDedupeIdKey(incoming.id);
  const hasDistinctRowReference =
    existingId &&
    incomingId &&
    existingId !== incomingId &&
    /\d/.test(existingId) &&
    /\d/.test(incomingId);

  const existingOrder = finiteRequirementOrderValue(
    existing.documentEntryOrder,
  );
  const incomingOrder = finiteRequirementOrderValue(
    incoming.documentEntryOrder,
  );
  const hasDistinctPhysicalSourceUnit =
    existingOrder !== null &&
    incomingOrder !== null &&
    existingOrder !== incomingOrder &&
    existingSource !== incomingSource &&
    (!hasSharedPage(existing, incoming) ||
      requirementLedgerEntryQuality(existing) ===
        requirementLedgerEntryQuality(incoming));

  return Boolean(hasDistinctRowReference || hasDistinctPhysicalSourceUnit);
}

function explicitIdEntriesAreDuplicateProjection(
  existing: RequirementLedgerEntry,
  incoming: RequirementLedgerEntry,
) {
  if (shouldPreserveRepeatedRequirementUnit(existing, incoming)) {
    return false;
  }
  const existingText = normalizeEvidenceText(existing.text);
  const incomingText = normalizeEvidenceText(incoming.text);
  if (!existingText || !incomingText) return false;
  const shorter =
    existingText.length <= incomingText.length ? existingText : incomingText;
  const longer =
    existingText.length > incomingText.length ? existingText : incomingText;
  const materiallyOverlapping =
    requirementTextsOverlap(existing.text, incoming.text) ||
    (shorter.length >= 28 &&
      longer.includes(shorter) &&
      shorter.length / longer.length >= 0.5);
  if (!materiallyOverlapping) return false;

  const existingOrder = finiteRequirementOrderValue(
    existing.documentEntryOrder,
  );
  const incomingOrder = finiteRequirementOrderValue(
    incoming.documentEntryOrder,
  );
  return (
    existingOrder === null ||
    incomingOrder === null ||
    hasSharedPage(existing, incoming) ||
    normalizeRequirementLedgerText(existing.heading) ===
      normalizeRequirementLedgerText(incoming.heading)
  );
}

function requirementDedupeIdKey(value: string) {
  return normalizeRequirementId(value).replace(/^([A-ZÆØÅ]{1,8})-(\d+)$/i, "$1$2");
}

export function normalizedTableDuplicateKey(value: string | null | undefined) {
  return normalizeRequirementId(value ?? "").replace(/\s+/g, "");
}

export function normalizedServiceDuplicateKey(value: string | null | undefined) {
  return normalizeEvidenceText(value ?? "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function tableServiceLooksLikeContinuationDuplicate(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  const leftService = normalizedServiceDuplicateKey(left.service || left.id);
  const rightService = normalizedServiceDuplicateKey(right.service || right.id);
  if (!leftService || !rightService) {
    return false;
  }

  const shorter =
    leftService.length <= rightService.length ? leftService : rightService;
  const longer =
    leftService.length > rightService.length ? leftService : rightService;

  return (
    shorter.length >= 5 &&
    longer.startsWith(shorter) &&
    longer.length - shorter.length <= 36
  );
}

function shortOverlappingTableRequirementTexts(left: string, right: string) {
  const leftWords = significantRequirementWords(left);
  const rightWords = significantRequirementWords(right);
  const smallestSize = Math.min(leftWords.size, rightWords.size);
  if (smallestSize < 3) {
    return false;
  }

  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }

  return shared / smallestSize >= 0.6;
}

function explicitRowRequirementDedupeKey(value: string) {
  const normalized = normalizeRequirementId(value);
  const match = normalized.match(
    /\b(?:K-\d{2,5}[A-Z]?|K\d{2,5}[A-Z]?|REQ-\d{1,5}[A-Z]?|\d{2,4}\/\d{1,3}|[A-ZÆØÅ]\d?-\d{1,3}|[A-ZÆØÅ]{2,8}\.\d{1,3}(?:\.\d{1,3}){1,5}[A-Z]?|Krav\s*\d{1,3}(?:[.-]\d{1,3}){0,5}[A-Z]?)\b/i,
  );
  return match ? requirementDedupeIdKey(match[0]) : "";
}

function isOverlappingTableRequirementDuplicate(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  if (!left.tableId || !right.tableId) {
    return false;
  }

  if (
    normalizedTableDuplicateKey(left.tableId) !==
      normalizedTableDuplicateKey(right.tableId)
  ) {
    return false;
  }

  const leftExplicitRequirement = explicitRowRequirementDedupeKey(left.id);
  const rightExplicitRequirement = explicitRowRequirementDedupeKey(right.id);
  if (
    leftExplicitRequirement &&
    rightExplicitRequirement &&
    leftExplicitRequirement !== rightExplicitRequirement
  ) {
    return false;
  }

  const leftRowReference = requirementDedupeIdKey(left.id);
  const rightRowReference = requirementDedupeIdKey(right.id);
  if (
    leftRowReference &&
    rightRowReference &&
    leftRowReference !== rightRowReference &&
    /\d/.test(leftRowReference) &&
    /\d/.test(rightRowReference)
  ) {
    return false;
  }

  return (
    hasSharedPage(left, right) &&
    tableServiceLooksLikeContinuationDuplicate(left, right) &&
    (requirementTextsOverlap(left.text, right.text) ||
      shortOverlappingTableRequirementTexts(left.text, right.text))
  );
}

function isRunawayMergedRequirementBlock(entry: RequirementLedgerEntry) {
  const text = normalizePageText(entry.text);
  const isLongTableIdOnlyContainer =
    Boolean(entry.tableId) &&
    normalizeRequirementId(entry.id) === normalizeRequirementId(entry.tableId ?? "") &&
    !serviceFromTableRequirementId(entry) &&
    entry.pages.length >= 8 &&
    text.length > 1800 &&
    /\b(?:Konfidensiel|Leverandørens svar|On\s*-\s*site|Power Automate|Copilot|Atea)\b/i.test(
      text,
    );

  return (
    /^Ref\s+Tema\s+krav\s*\/\s*observasjon\b/i.test(text) ||
    isLongTableIdOnlyContainer ||
    text.length > 2200 &&
    /Kommentar:\s*Tabellen\s+over/i.test(text) &&
    /(?:Løs\s+tekst\s+fra\s+behovsavklaring|Liten\s+Tabell\s+fra\s+fagansvarlige|Svarformat)/i.test(
      text,
    )
  );
}

function isSpuriousTableContinuationRequirement(entry: RequirementLedgerEntry) {
  if (!entry.tableId) {
    return false;
  }

  const service = cleanTableService(serviceFromTableRequirementId(entry));
  const text = cleanTableRequirement(entry.text);
  return (
    /^Der$/i.test(service) &&
    /^[a-zæøå]/.test(text) &&
    !hasStandaloneRequirementLanguage(text)
  );
}

function isSpuriousExplicitContinuationRequirement(entry: RequirementLedgerEntry) {
  if (entry.tableId || !/^ID\s+\d{1,3}-\d{1,3}[A-Z]?$/i.test(entry.id)) {
    return false;
  }

  const text = cleanTableRequirement(entry.text);
  return (
    /^[a-zæøå]/.test(text) &&
    !hasStandaloneRequirementLanguage(text) &&
    !/\b(?:Det\s+forventes|ønskelig|ønskes|må\s+kunne|skal\s+kunne)\b/i.test(
      text,
    )
  );
}

export function serviceFromTableRequirementId(entry: RequirementLedgerEntry) {
  if (entry.service) {
    return entry.service;
  }

  if (!entry.tableId || !entry.id) {
    return "";
  }

  const normalizedTable = normalizeRequirementId(entry.tableId);
  const normalizedId = normalizeRequirementId(entry.id);
  if (!normalizedId.startsWith(`${normalizedTable}-`)) {
    return "";
  }

  return cleanTableService(entry.id.slice(entry.tableId.length).replace(/^\s*-\s*/, ""));
}

export function hasStableExplicitRequirementId(entry: RequirementLedgerEntry) {
  const normalizedEntryId = normalizeRequirementId(entry.id).replace(/\s+/g, "");
  return detectExplicitRequirementIds(entry.id).some(
    (id) =>
      normalizeRequirementId(id).replace(/\s+/g, "") === normalizedEntryId,
  );
}

export function repairRequirementLedgerEntryArtifacts(
  entry: RequirementLedgerEntry,
  sourceDocumentSha256 = "",
): RequirementLedgerEntry {
  const sourcePreAnswerText = sourceExcerptTextBeforeAnswerField(
    entry.sourceExcerpt,
  );
  if (
    hasPdfAnswerFieldSourceExcerpt(entry) &&
    sourcePreAnswerText &&
    (hasRequirementSignal(sourcePreAnswerText) ||
      hasStandaloneRequirementLanguage(sourcePreAnswerText) ||
      isRequirementSentence(sourcePreAnswerText)) &&
    !isLikelyDetailOrAnswerBlock(sourcePreAnswerText)
  ) {
    return {
      ...entry,
      text: sourcePreAnswerText,
    };
  }

  const answerRequirementText =
    requirementTextAfterOwnId(entry.answerExcerpt, entry.id) ||
    (shouldRepairRequirementTextFromSourceOwnId(entry)
      ? requirementTextAfterOwnId(entry.sourceExcerpt, entry.id)
      : "") ||
    sourceOwnIdRequirementTextRepairCandidate(entry);
  if (
    answerRequirementText &&
    (foreignExplicitRequirementIds(entry.text, entry.id).length > 0 ||
      sourceOwnIdRequirementTextRepairCandidate(entry) === answerRequirementText ||
      /^Kravtekst\s+før\s+svarfelt\s*:/i.test(entry.sourceExcerpt ?? ""))
  ) {
    return {
      ...entry,
      text: answerRequirementText,
      answerExcerpt: undefined,
    };
  }

  if (isUnstructuredRequirementEntry(entry)) {
    const recoveredText = recoverTruncatedUnstructuredRequirementText(
      entry.text,
      entry.sourceExcerpt ?? "",
    );
    return recoveredText === entry.text ? entry : { ...entry, text: recoveredText };
  }

  const sourceLabeledText = entry.sourceExcerpt
    ? labeledRequirementTextCandidate(entry.sourceExcerpt)
    : "";
  const allowEarlyLabeledSourceTextRepair = !/^Markdown kravbesvarelse$/i.test(
    entry.tableId ?? "",
  ) && !/\bSvarrad\s*:/i.test(entry.sourceExcerpt ?? "");
  const textNeedsEarlyLabeledSourceRepair =
    foreignExplicitRequirementIds(entry.text, entry.id).length > 0 ||
    /\b(?:Tabell\s+ID|leverandørens\s+svar|spesifiserte\s+krav|krav\s+ti?l\s+Petor[oø]|Detaljeringer)\b/i.test(
      entry.text,
    );
  if (
    allowEarlyLabeledSourceTextRepair &&
    sourceLabeledText &&
    textNeedsEarlyLabeledSourceRepair &&
    foreignExplicitRequirementIds(sourceLabeledText, entry.id).length === 0 &&
    /^Kravtekst\s+før\s+svarfelt\s*:/i.test(entry.sourceExcerpt ?? "") &&
    (hasRequirementSignal(sourceLabeledText) ||
      hasStandaloneRequirementLanguage(sourceLabeledText)) &&
    !isLikelyDetailOrAnswerBlock(sourceLabeledText)
  ) {
    return {
      ...entry,
      text: sourceLabeledText,
    };
  }

  const trimmedText = trimAtForeignExplicitRequirementId(entry.text, entry.id);
  if (trimmedText !== entry.text) {
    return {
      ...entry,
      text: trimmedText,
    };
  }

  const originalService = serviceFromTableRequirementId(entry);
  const textFromSource =
    entry.sourceExcerpt
      ? completeLayoutRequirementTextFromSource({
          service: originalService,
          text: entry.text,
          sourceExcerpt: entry.sourceExcerpt,
        })
      : entry.text;
  const repaired = repairTableRowTextArtifacts({
    service: originalService,
    text: textFromSource,
    sourceDocumentSha256,
    tableId: entry.tableId,
  });
  const labeledText = entry.sourceExcerpt
    ? labeledRequirementTextCandidate(entry.sourceExcerpt)
    : "";
  const allowLabeledSourceTextRepair = !/^Markdown kravbesvarelse$/i.test(
    entry.tableId ?? "",
  ) && !/\bSvarrad\s*:/i.test(entry.sourceExcerpt ?? "");
  if (
    allowLabeledSourceTextRepair &&
    labeledText &&
    entry.tableId &&
    (hasRequirementSignal(labeledText) ||
      hasStandaloneRequirementLanguage(labeledText)) &&
    !isLikelyDetailOrAnswerBlock(labeledText)
  ) {
    repaired.text = labeledText;
  }
  if (
    allowLabeledSourceTextRepair &&
    labeledText &&
    /(?:\||\bSvarinstruks\b|\bResponse\s+instruction\b|\bDetailed\s+response\b)/i.test(
      repaired.text,
    )
  ) {
    repaired.text = labeledText;
  }

  if (
    repaired.service === originalService &&
    repaired.text === entry.text
  ) {
    return entry;
  }

  const next: RequirementLedgerEntry = {
    ...entry,
    text: repaired.text,
  };

  if (repaired.service) {
    next.service = repaired.service;
    if (entry.tableId && !hasStableExplicitRequirementId(entry)) {
      next.id = `${entry.tableId} - ${repaired.service}`;
    }
  }

  return next;
}

export function labeledRequirementTextCandidate(value: string) {
  const cells = value
    .split("|")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const cell of cells) {
    const match = /^(?:kravtekst(?:\s+før\s+svarfelt)?|krav|hva\s+er\s+sagt\s*\/\s*ønsket|hva\s+er\s+sagt\s*\/\s*onsket|requirement\s*text|leveransekrav|akseptansekriterier)\s*:\s*(.+)$/i.exec(
      cell,
    );
    if (match?.[1]) {
      return cleanTableRequirement(match[1]);
    }
  }

  return "";
}

function foreignExplicitRequirementIds(value: string, ownId: string) {
  const own = normalizeRequirementId(ownId).replace(/\s+/g, "");
  return detectExplicitRequirementIds(value).filter(
    (id) => normalizeRequirementId(id).replace(/\s+/g, "") !== own,
  );
}

function trimAtForeignExplicitRequirementId(
  text: string,
  ownId: string,
) {
  const own = normalizeRequirementId(ownId).replace(/\s+/g, "");
  const normalized = normalizePdfSpacing(text);
  for (const match of normalized.matchAll(explicitRequirementIdPattern())) {
    const index = match.index ?? 0;
    if (index < 20) {
      continue;
    }

    const id = documentRequirementId(match[0]);
    if (
      isContextualNonRequirementExplicitId(
        id,
        normalized.slice(Math.max(0, index - 24), index),
      )
    ) {
      continue;
    }
    if (normalizeRequirementId(id).replace(/\s+/g, "") === own) {
      continue;
    }

    const candidate = normalized.slice(0, index).trim();
    if (
      candidate.length >= 18 &&
      (hasRequirementSignal(candidate) || hasStandaloneRequirementLanguage(candidate))
    ) {
      return candidate;
    }
  }

  return text;
}

export function requirementTextAfterOwnId(value: string | undefined, ownId: string) {
  if (!value) {
    return "";
  }

  const own = normalizeRequirementId(ownId).replace(/\s+/g, "");
  const normalized = normalizePdfSpacing(value);
  for (const match of normalized.matchAll(explicitRequirementIdPattern())) {
    const id = documentRequirementId(match[0]);
    if (normalizeRequirementId(id).replace(/\s+/g, "") !== own) {
      continue;
    }

    const start = (match.index ?? 0) + match[0].length;
    const afterOwnId = normalized.slice(start);
    const text = stripAnswerTextFromRequirement(
      trimAtForeignExplicitRequirementId(
        stripRequirementChrome(afterOwnId),
        ownId,
      ),
    );
    if (
      text.length >= 18 &&
      isRequirementTextAfterOwnIdCandidate(text)
    ) {
      return text;
    }
  }

  return "";
}

function sourceOwnIdRequirementTextRepairCandidate(
  entry: RequirementLedgerEntry,
) {
  if (!hasPdfAnswerFieldSourceExcerpt(entry)) {
    return "";
  }

  const candidate = requirementTextAfterOwnId(entry.sourceExcerpt, entry.id);
  if (!candidate || !shouldUseSourceOwnIdRequirementText(entry, candidate)) {
    return "";
  }

  return candidate;
}

function shouldUseSourceOwnIdRequirementText(
  entry: RequirementLedgerEntry,
  candidate: string,
) {
  const currentText = cleanTableRequirement(entry.text);
  const candidateText = cleanTableRequirement(candidate);
  if (
    !currentText ||
    !candidateText ||
    candidateText.length < currentText.length + 24 ||
    isLikelyDetailOrAnswerBlock(candidateText)
  ) {
    return false;
  }

  const current = normalizeEvidenceText(currentText);
  const repaired = normalizeEvidenceText(candidateText);
  if (!current || !repaired || current === repaired) {
    return false;
  }

  const currentPdf = normalizeEvidenceText(normalizePdfSpacing(currentText));
  const repairedPdf = normalizeEvidenceText(normalizePdfSpacing(candidateText));
  if (currentPdf && repairedPdf) {
    if (repairedPdf.includes(currentPdf)) {
      return true;
    }

    const comparablePrefix = currentPdf.slice(0, Math.min(96, currentPdf.length));
    if (comparablePrefix.length >= 40 && repairedPdf.startsWith(comparablePrefix)) {
      return true;
    }
  }

  if (repaired.includes(current)) {
    return true;
  }

  return (
    looksLikeTruncatedRequirementText(currentText) &&
    requirementTextsOverlap(currentText, candidateText)
  );
}

export function hasPdfAnswerFieldSourceExcerpt(entry: RequirementLedgerEntry) {
  const source = entry.sourceExcerpt ?? "";
  return (
    /^Kravtekst\s+før\s+svarfelt\s*:/i.test(source) &&
    /\bSvarfelt\s*:/i.test(source) &&
    /\bLeverandørens\s+besvarelse\b/i.test(source)
  );
}

function sourceExcerptTextBeforeAnswerField(value: string | undefined) {
  if (!value) {
    return "";
  }

  const match = /Kravtekst\s+før\s+svarfelt\s*:\s*([^|]+?)(?:\s*\|\s*Svarfelt\s*:|$)/i.exec(
    value,
  );
  return cleanTableRequirement(match?.[1] ?? "");
}

function lastRequirementNumber(value: string) {
  const numbers = [...normalizeRequirementId(value).matchAll(/\d{1,5}/g)].map(
    (match) => Number(match[0]),
  );
  return numbers.at(-1) ?? null;
}

function shouldRepairRequirementTextFromSourceOwnId(
  entry: RequirementLedgerEntry,
) {
  const beforeAnswer = sourceExcerptTextBeforeAnswerField(entry.sourceExcerpt);
  if (!beforeAnswer) {
    return false;
  }

  if (foreignExplicitRequirementIds(beforeAnswer, entry.id).length > 0) {
    return true;
  }

  const leadingNumberMatch = /^\s*(\d{1,5})\b/.exec(beforeAnswer);
  const leadingNumber = leadingNumberMatch?.[1]
    ? Number(leadingNumberMatch[1])
    : null;
  const ownNumber = lastRequirementNumber(entry.id);
  return (
    leadingNumber !== null &&
    ownNumber !== null &&
    leadingNumber !== ownNumber
  );
}

function isRequirementTextAfterOwnIdCandidate(value: string) {
  const text = normalizePageText(value);
  if (hasRequirementSignal(text) || hasStandaloneRequirementLanguage(text)) {
    return true;
  }

  return (
    text.length >= 40 &&
    !isLikelyDetailOrAnswerBlock(text) &&
    ((/\bkrav(?:et|ene)?\b/i.test(text) &&
      /\b(?:Leverandøren|Kunden|Petoro|Det\s+stilles|ansvar|gjennomføres|følges\s+opp)\b/i.test(
        text,
      )) ||
      (/Leverandør(?:en|ens)?/i.test(text) &&
        /(?:underleverandør(?:er|ene)?|videreført|alternative\s+løsninger|foreslå)/i.test(
          text,
        )))
  );
}

function requirementLedgerEntryQuality(entry: RequirementLedgerEntry) {
  return [
    isLikelyDetailOrAnswerBlock(entry.text) ? -20 : 0,
    hasStandaloneRequirementLanguage(entry.text) ? 8 : 0,
    hasRequirementSignal(entry.text) ? 4 : 0,
    entry.sourceExcerpt ? 4 : 0,
    entry.answerExcerpt ? 2 : 0,
    entry.tableId ? 2 : 0,
    entry.service ? 1 : 0,
    Math.min(4, Math.floor(entry.text.length / 240)),
  ].reduce((sum, value) => sum + value, 0);
}

function significantRequirementWords(value: string) {
  return new Set(
    normalizeEvidenceText(value)
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 5)
      .filter(
        (word) =>
          ![
            "leverandøren",
            "kunden",
            "kravene",
            "kravet",
            "bilag",
            "tilbudet",
            "leveransen",
          ].includes(word),
      ),
  );
}

export function requirementTextsOverlap(left: string, right: string) {
  const leftText = normalizeEvidenceText(left);
  const rightText = normalizeEvidenceText(right);
  if (!leftText || !rightText) {
    return false;
  }

  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  if (shorter.length >= 24 && longer.includes(shorter)) {
    return true;
  }

  if (shorter.length >= 120 && longer.includes(shorter.slice(0, 120))) {
    return true;
  }

  const leftWords = significantRequirementWords(leftText);
  const rightWords = significantRequirementWords(rightText);
  const smallestSize = Math.min(leftWords.size, rightWords.size);
  if (smallestSize < 4) {
    return false;
  }

  let shared = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }

  return shared / smallestSize >= 0.55;
}

export function hasSharedPage(left: RequirementLedgerEntry, right: RequirementLedgerEntry) {
  return left.pages.some((page) => right.pages.includes(page));
}

export function isAnswerSectionMarkerLine(line: string) {
  return /^(?:Leverandørens\s+besvarelse|Detailed\s+response|Supplier\s+response|Answer|Response)$/i.test(
    normalizePageText(line),
  );
}

export function isNonRequirementInstructionSentence(value: string) {
  const text = normalizePageText(value);
  return (
    /^Bilag\s+\d+\s+inneholder\b/i.test(text) ||
    /^I\s+bilagene\s+er\s+det\s+lagt\s+inn\s+plass\b/i.test(text) ||
    /^Leverandøren\s+oppfordres\s+til\s+å\s+besvare\b/i.test(text) ||
    /^Det\s+er\s+viktig\s+at\s+denne\s+strukturen\s+følges\b/i.test(text) ||
    /^Tenk\s+kvalitet\s+fremfor\s+kvantitet\b/i.test(text) ||
    /^Hvis\s+det\s+er\s+behov\s+for\s+ytterligere\s+informasjon\b/i.test(text)
  );
}

export function isRequirementSentence(value: string) {
  const text = normalizePageText(value);
  if (isNonRequirementInstructionSentence(text)) {
    return false;
  }

  return (
    hasStandaloneRequirementLanguage(text) ||
    /\b[\p{Lu}][\p{L}\d&./-]{1,50}\s+(?:skal|må|bør)\b/u.test(text) ||
    /\bDet\s+stilles\b.{0,260}\bkrav\b/iu.test(text) ||
    /\bDet\s+forventes\b/i.test(text) ||
    /\b(?:ønskelig|ønskes)\b.{0,260}\b(?:må|skal)\s+kunne\b/i.test(text) ||
    /\bressursene\s+(?:må|skal)\s+kunne\b/i.test(text) ||
    /\bKunden\s+kan\s+kreve\b/i.test(text) ||
    /\bLeverandøren\s+bes\s+(?:kort\s+)?beskrive\b/i.test(text) ||
    /\bLeverandøren\s+(?:er|blir)(?:\s+herunder)?\s+ansvarlig\b/i.test(text) ||
    /\bLeverandøren\s+har\s+ansvar\s+for\b/i.test(text) ||
    /\bDette\s+innebærer\b.{0,700}(?:^|\s)må(?=\s|$|[.,;:])/i.test(text) ||
    /\bmå\s+dette\s+komme\s+frem\b/i.test(text)
  );
}

export function recoverTruncatedUnstructuredRequirementText(
  text: string,
  sourceExcerpt: string,
) {
  const normalizedText = normalizePdfSpacing(text).toLocaleLowerCase("nb");
  if (!normalizedText.endsWith("høyde for") || !sourceExcerpt) {
    return text;
  }

  const source = normalizePdfSpacing(sourceExcerpt);
  const directTailMatch = /\bhøyde\s+for\s+(.+)$/i.exec(source);
  const directTail = normalizePdfSpacing(directTailMatch?.[1] ?? "");
  if (directTail.length >= 4 && directTail.length <= 500) {
    return stripAnswerTextFromRequirement(`${text} ${directTail}`);
  }

  const startIndex = tableRequirementStartIndex(source);
  if (startIndex < 0) {
    return text;
  }

  const candidate = source
    .slice(startIndex)
    .replace(
      /\bskal\s+ta\s+(?:Må\s*\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\s*\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+høyde\b/giu,
      "skal ta høyde",
    )
    .replace(
      /(?:Må\s*\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\s*\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+(?=høyde\b)/giu,
      "",
    )
    .replace(/\bskal\s+ta\b.{0,120}?\bhøyde\s+for\b/iu, "skal ta høyde for")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedEvidenceText = normalizeEvidenceText(text);
  const normalizedCandidate = normalizeEvidenceText(candidate);

  if (
    candidate.length > text.length + 8 &&
    normalizedEvidenceText &&
    normalizedCandidate.startsWith(normalizedEvidenceText)
  ) {
    return stripAnswerTextFromRequirement(candidate);
  }

  return text;
}

export function isSyntheticRequirementId(id: string) {
  return /^Side\s+\d+\s+krav\s+\d+$/i.test(id.trim());
}

export function isGeneratedRequirementId(id: string) {
  const text = normalizePageText(id);
  return (
    isSyntheticRequirementId(text) ||
    /^(?:Åpent punkt|Leverandørpunkt|Faginnspill|Avklaringspunkt|Huskelistepunkt|Ustrukturert krav)\s+\d+$/i.test(
      text,
    ) ||
    /^(?:DOCX|Docling|Strukturert)\s+tabell\s+\d+\s+rad\s+\d+$/i.test(text)
  );
}

export function normalizeEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .trim();
}

export function normalizeCoverageEvidenceText(value: string) {
  return normalizePageText(value)
    .toLocaleLowerCase("nb")
    .replace(/[“”"«»]/g, "")
    .trim();
}
