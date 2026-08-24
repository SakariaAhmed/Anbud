import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { normalizePdfReferenceTypography } from "@/lib/server/requirements/pdf-normalization";

// Retained to recognize documents parsed before the v3 layout rollout.
// fallow-ignore-next-line unused-export
export const LEGACY_LOCAL_PDF_LAYOUT_PARSER = "pdf-parse-local-layout-v2";
export const LOCAL_PDF_LAYOUT_PARSER = "pdf-parse-local-layout-v3";

export function isLocalPdfLayoutParser(parser: string | null | undefined) {
  return parser === LOCAL_PDF_LAYOUT_PARSER || parser === LEGACY_LOCAL_PDF_LAYOUT_PARSER;
}

export type LocalPdfTextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
};

type LocalPdfFragment = {
  text: string;
  x: number;
  endX: number;
  y: number;
  height: number;
};

export type LocalPdfLine = {
  text: string;
  x: number;
  endX: number;
  y: number;
  height: number;
};

export type LocalPdfPage = {
  pageNumber: number;
  rawText: string;
  lines: LocalPdfLine[];
};

// Exported for local parser fixture and migration contracts.
// fallow-ignore-next-line unused-type
export type LocalPdfStructureEntry = {
  reference: string;
  text: string;
  kind: "text" | "table";
  parser: typeof LOCAL_PDF_LAYOUT_PARSER;
  page: number;
  table_index?: number;
  row_index?: number;
  columns?: string[];
  cells?: Record<string, string>;
  source_id: string;
  confidence?: number;
  heading_path?: string[];
};

type RequirementRowCandidate = {
  id: string;
  remainder: string;
  ordinal: string;
  priority: string;
};

const QUICK_REQUIREMENT_ID_START =
  /^\s*(?:[•*]|[-–—]\s+)?(?:\[\s*)?(?:Krav\s*(?:nr\.?|nummer)?\s*\d|ID\s*\d|P\d{3}\s*[- ]|(?:REQ|KRAV|KR|K|R|TEK|Pkt)\s*[- ]?\s*\d|[A-ZÆØÅ]\d?\s*-\s*\d|[A-ZÆØÅ]{1,12}\s*(?:[-.]\s*)+(?:[A-ZÆØÅ]{1,4}\s*[- ]?\s*)?\d|\d{2,4}\s*\/\s*\d)/iu;

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedItem(item: LocalPdfTextItem): LocalPdfFragment | null {
  const rawText = String(item.str ?? "").replace(/\u0000/gu, "");
  const text = rawText.replace(/\s+/gu, " ").trim();
  if (!text) return null;

  const x = finiteNumber(item.transform?.[4]);
  const y = finiteNumber(item.transform?.[5]);
  const height = Math.max(
    1,
    Math.abs(
      finiteNumber(
        item.height,
        finiteNumber(item.transform?.[3], finiteNumber(item.transform?.[0], 10)),
      ),
    ),
  );
  const estimatedCharacterWidth = Math.max(1.5, height * 0.42);
  const width = Math.max(
    0,
    Math.abs(finiteNumber(item.width, text.length * estimatedCharacterWidth)),
  );

  return {
    text,
    x,
    endX: x + width,
    y,
    height,
  };
}

function renderProductionCompatiblePage(items: LocalPdfTextItem[]) {
  const lines: Array<{ y: number; items: LocalPdfTextItem[] }> = [];
  for (const item of items) {
    const text = item.str.trim();
    const y = item.transform[5] ?? 0;
    if (!text) continue;
    const line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (line) {
      line.items.push(item);
    } else {
      lines.push({ y, items: [item] });
    }
  }

  const renderedLines = lines
    .sort((left, right) => right.y - left.y)
    .flatMap((line): LocalPdfLine[] => {
      const orderedItems = line.items.sort(
        (left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0),
      );
      let previousEnd: number | null = null;
      const text = orderedItems
        .map((item) => {
          const x = item.transform[4] ?? 0;
          const gap = previousEnd == null ? 0 : x - previousEnd;
          previousEnd = x + (item.width ?? item.str.length * 4);
          return `${gap > 3 ? " " : ""}${item.str.trim()}`;
        })
        .join("")
        .replace(/[ \t]+/gu, " ")
        .trim();
      if (!text) return [];
      const fragments = orderedItems
        .map(normalizedItem)
        .filter((fragment): fragment is LocalPdfFragment => Boolean(fragment));
      if (!fragments.length) return [];
      return [
        {
          text,
          x: Math.min(...fragments.map((fragment) => fragment.x)),
          endX: Math.max(...fragments.map((fragment) => fragment.endX)),
          y: line.y,
          height: Math.max(...fragments.map((fragment) => fragment.height)),
        },
      ];
    })
    .filter((line) => Boolean(line.text));
  return {
    rawText: renderedLines.map((line) => line.text).join("\n"),
    lines: renderedLines,
  };
}

/**
 * Reconstructs lines and keeps PDF.js geometry without invoking another
 * process. Its text output intentionally matches the production fast path.
 */
export function analyzeLocalPdfPage(input: {
  pageNumber: number;
  items: LocalPdfTextItem[];
}): LocalPdfPage {
  const rendered = renderProductionCompatiblePage(input.items);

  return {
    pageNumber: input.pageNumber,
    rawText: rendered.rawText,
    lines: rendered.lines,
  };
}

function chromeKey(value: string) {
  return normalizePdfReferenceTypography(value)
    .toLocaleLowerCase("nb-NO")
    .replace(/\b(?:side|page)\s*\d+\s*(?:av|of)\s*\d+\b/giu, "side # av #")
    .replace(/\s+/gu, " ")
    .trim();
}

function repeatedChromeKeys(pages: LocalPdfPage[]) {
  if (pages.length < 3) return new Set<string>();
  const pagesByKey = new Map<string, Set<number>>();
  for (const page of pages) {
    const candidates = [...page.lines.slice(0, 2), ...page.lines.slice(-2)];
    for (const line of candidates) {
      const key = chromeKey(line.text);
      if (!key || key.length > 180) continue;
      const pageNumbers = pagesByKey.get(key) ?? new Set<number>();
      pageNumbers.add(page.pageNumber);
      pagesByKey.set(key, pageNumbers);
    }
  }

  const minimumPages = Math.max(3, Math.ceil(pages.length * 0.6));
  return new Set(
    [...pagesByKey.entries()]
      .filter(([, pageNumbers]) => pageNumbers.size >= minimumPages)
      .map(([key]) => key),
  );
}

function requirementRowCandidate(
  line: LocalPdfLine,
): RequirementRowCandidate | null {
  if (!QUICK_REQUIREMENT_ID_START.test(line.text)) return null;
  const normalized = normalizePdfReferenceTypography(line.text);
  const ids = detectExplicitRequirementIds(normalized);
  const located = ids
    .map((id) => ({ id, index: normalized.indexOf(id) }))
    .find(({ index }) => index >= 0 && index <= 32);
  if (!located) return null;

  const prefix = normalized.slice(0, located.index).replace(/[\s:|#.-]+/gu, "");
  if (prefix && !/^\d{1,3}$/u.test(prefix)) return null;

  const remainder = normalized
    .slice(located.index + located.id.length)
    .replace(/^[\s:|.-]+/gu, "")
    .trim();
  const ordinalMatch = /^(\d{1,4})(?=\s|[|:.-]|$)[\s|:.-]*/u.exec(remainder);
  const afterOrdinal = ordinalMatch
    ? remainder.slice(ordinalMatch[0].length).trim()
    : remainder;
  const priorityMatch = /^(Må|Bør|Kan|Opsjon|Skal)(?=\s|[|:.-]|$)[\s|:.-]*/iu.exec(
    afterOrdinal,
  );

  return {
    id: located.id,
    remainder,
    ordinal: ordinalMatch?.[1] ?? "",
    priority: priorityMatch?.[1] ?? "",
  };
}

function isTableHeaderLine(value: string) {
  if (!/(?:krav|prioritet|kategori|beskrivelse|requirement|mandatory|opsjon|markering|\bID\b)/iu.test(value)) {
    return false;
  }
  const text = normalizePdfReferenceTypography(value);
  const labelMatches =
    text.match(
      /\b(?:krav(?:tekst|ref|referanse|nummer|nr|id)?|prioritet|kategori|beskrivelse|requirement|mandatory|opsjon|rad)\b/giu,
    )?.length ?? 0;
  return labelMatches >= 2;
}

function headingText(value: string) {
  const rawText = String(value ?? "").trim();
  if (!rawText || rawText.length > 160 || /[!?]$/u.test(rawText)) return "";
  const text = normalizePdfReferenceTypography(value).replace(/:$/u, "").trim();
  if (!text || text.length > 140 || /[.!?]$/u.test(text)) return "";
  if (
    /^(?:kapittel|chapter|section|del|vedlegg|appendix)\b/iu.test(text) ||
    /^\d+(?:\.\d+){0,5}\s+[\p{Lu}ÆØÅ]/u.test(text) ||
    (/^[\p{Lu}ÆØÅ0-9][\p{Lu}ÆØÅ0-9 /&()_-]{5,}$/u.test(text) &&
      text.split(/\s+/u).length <= 12)
  ) {
    return text;
  }
  return "";
}

function isRequirementSectionBoundary(
  value: string,
  hasPriorityColumn: boolean,
) {
  const text = normalizePdfReferenceTypography(value);
  if (
    /^(?:[-–—•]\s*)?(?:mangler\s+ID|Punktkrav\s+som\s+skal\s+besvares|Krav\s+uten\s+egen\s+tabellrad|krav\s+registrert\s+i\s+tabell|Fra\s+arbeidsnotatet|Notater?\s+(?:som|fra)|Avklaringer?\/|Avklaring\b|Implisitt\b|Markering\b|NB\s*[:.-])/iu.test(
      text,
    )
  ) {
    return true;
  }
  return (
    hasPriorityColumn &&
    /^(?:[-–—•]\s*)?(?:Må|Bør|Kan|Opsjon|Skal)\s+(?:Kunden|Leverandøren|Løsningen|Tjenesten|Systemet|Plattformen|Det|Endringer|Brukere)\b/iu.test(
      text,
    )
  );
}

function appendText(current: string, next: string) {
  if (!current) return next;
  if (/[-‐‑]$/u.test(current) && /^\p{Ll}/u.test(next)) {
    return `${current.slice(0, -1)}${next}`;
  }
  return `${current} ${next}`;
}

function parsedRequirementCells(input: {
  candidate: RequirementRowCandidate;
  continuations: LocalPdfLine[];
  hasOrdinalColumn: boolean;
  hasPriorityColumn: boolean;
}) {
  let remainder = input.candidate.remainder;
  let ordinal = "";
  let priority = "";

  if (input.hasOrdinalColumn) {
    const match = /^(\d{1,4})(?=\s|[|:.-]|$)[\s|:.-]*/u.exec(remainder);
    if (match) {
      ordinal = match[1];
      remainder = remainder.slice(match[0].length).trim();
    }
  }
  if (input.hasPriorityColumn) {
    const match = /^(Må|Bør|Kan|Opsjon|Skal)(?=\s|[|:.-]|$)[\s|:.-]*/iu.exec(
      remainder,
    );
    if (match) {
      priority = match[1];
      remainder = remainder.slice(match[0].length).trim();
    }
  }

  let requirementText = remainder;
  for (const continuation of input.continuations) {
    requirementText = appendText(
      requirementText,
      normalizePdfReferenceTypography(continuation.text),
    );
  }
  requirementText = requirementText.replace(/\s+/gu, " ").trim();

  return {
    requirementText,
    ordinal,
    priority,
  };
}

function pageLinesWithoutChrome(
  page: LocalPdfPage,
  repeatedChrome: Set<string>,
) {
  return page.lines.filter((line, index) => {
    const nearPageEdge = index < 2 || index >= page.lines.length - 2;
    return !nearPageEdge || !repeatedChrome.has(chromeKey(line.text));
  });
}

/**
 * Builds a loss-aware local structure map. Raw page text stays available while
 * repeated requirement rows get typed cells for deterministic downstream use.
 */
export function buildLocalPdfDocument(input: {
  pages: LocalPdfPage[];
  label: string;
}) {
  const pages = [...input.pages].sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  const repeatedChrome = repeatedChromeKeys(pages);
  const cleanedPages = pages.map((page) => ({
    ...page,
    lines: pageLinesWithoutChrome(page, repeatedChrome),
  }));
  const candidateByLine = new Map<LocalPdfLine, RequirementRowCandidate>();
  const headingByLine = new Map<LocalPdfLine, string>();
  const tableHeaderLines = new Set<LocalPdfLine>();
  const candidates: RequirementRowCandidate[] = [];
  for (const page of cleanedPages) {
    for (const line of page.lines) {
      const candidate = requirementRowCandidate(line);
      if (candidate) {
        candidateByLine.set(line, candidate);
        candidates.push(candidate);
      }
      const heading = headingText(line.text);
      if (heading) headingByLine.set(line, heading);
      if (isTableHeaderLine(line.text)) tableHeaderLines.add(line);
    }
  }
  const repeatedOrdinalColumn =
    candidates.filter((candidate) => Boolean(candidate.ordinal)).length >=
    Math.max(2, Math.ceil(candidates.length * 0.35));
  const repeatedPriorityColumn =
    candidates.filter((candidate) => Boolean(candidate.priority)).length >=
    Math.max(2, Math.ceil(candidates.length * 0.35));
  const hasTableHeader = tableHeaderLines.size > 0;
  const hasRequirementTable =
    candidates.length >= 3 &&
    (hasTableHeader || repeatedOrdinalColumn || repeatedPriorityColumn);
  const hasOrdinalColumn = hasRequirementTable && repeatedOrdinalColumn;
  const hasPriorityColumn = hasRequirementTable && repeatedPriorityColumn;

  const sourceMap: LocalPdfStructureEntry[] = [];
  let blockIndex = 0;
  let tableRowIndex = 0;
  let activeHeading = "";

  for (const page of cleanedPages) {
    const lines = page.lines;
    let paragraphLines: LocalPdfLine[] = [];
    const flushParagraph = () => {
      if (!paragraphLines.length) return;
      blockIndex += 1;
      const text = paragraphLines.map((line) => line.text).join("\n").trim();
      if (text) {
        sourceMap.push({
          reference: `${input.label} – side ${page.pageNumber}, tekstblokk ${blockIndex}`,
          text,
          kind: "text",
          parser: LOCAL_PDF_LAYOUT_PARSER,
          page: page.pageNumber,
          source_id: `local-page-${page.pageNumber}-block-${blockIndex}`,
          ...(activeHeading ? { heading_path: [activeHeading] } : {}),
        });
      }
      paragraphLines = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const heading = headingByLine.get(line) ?? "";
      if (heading) {
        flushParagraph();
        activeHeading = heading;
        blockIndex += 1;
        sourceMap.push({
          reference: `${input.label} – side ${page.pageNumber}, ${heading}`,
          text: line.text,
          kind: "text",
          parser: LOCAL_PDF_LAYOUT_PARSER,
          page: page.pageNumber,
          source_id: `local-page-${page.pageNumber}-heading-${blockIndex}`,
          heading_path: [activeHeading],
        });
        continue;
      }

      const candidate = hasRequirementTable
        ? candidateByLine.get(line) ?? null
        : null;
      if (!candidate) {
        if (tableHeaderLines.has(line)) {
          flushParagraph();
          continue;
        }
        paragraphLines.push(line);
        if (paragraphLines.length >= 8) flushParagraph();
        continue;
      }

      flushParagraph();
      const continuations: LocalPdfLine[] = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const next = lines[nextIndex];
        if (
          candidateByLine.has(next) ||
          headingByLine.has(next) ||
          tableHeaderLines.has(next) ||
          isRequirementSectionBoundary(next.text, hasPriorityColumn)
        ) {
          break;
        }
        const previous = lines[nextIndex - 1];
        const verticalGap = Math.max(0, previous.y - next.y);
        if (
          verticalGap > Math.max(20, previous.height * 2.2) &&
          (candidate.remainder.length > 30 || continuations.length > 0)
        ) {
          break;
        }
        continuations.push(next);
        nextIndex += 1;
      }

      const cells = parsedRequirementCells({
        candidate,
        continuations,
        hasOrdinalColumn,
        hasPriorityColumn,
      });
      if (cells.requirementText.length < 8) {
        paragraphLines.push(line, ...continuations);
        index = nextIndex - 1;
        continue;
      }

      tableRowIndex += 1;
      const cellMap: Record<string, string> = {
        "Krav-ID": candidate.id,
        Kravtekst: cells.requirementText,
      };
      if (cells.ordinal) cellMap.Rad = cells.ordinal;
      if (cells.priority) cellMap.Prioritet = cells.priority;
      const sourceText = [line, ...continuations]
        .map((rowLine) => rowLine.text)
        .join("\n")
        .trim();
      sourceMap.push({
        reference: `${input.label} – lokal tabell 1, rad ${tableRowIndex}, side ${page.pageNumber}`,
        text: sourceText,
        kind: "table",
        parser: LOCAL_PDF_LAYOUT_PARSER,
        page: page.pageNumber,
        table_index: 0,
        row_index: tableRowIndex - 1,
        columns: Object.keys(cellMap),
        cells: cellMap,
        source_id: `local-table-0-row-${tableRowIndex - 1}`,
        confidence: hasOrdinalColumn || hasPriorityColumn ? 0.94 : 0.86,
        ...(activeHeading ? { heading_path: [activeHeading] } : {}),
      });
      index = nextIndex - 1;
    }
    flushParagraph();
  }

  const rawText = cleanedPages
    .map(
      (page) =>
        `[[SIDE:${page.pageNumber}]]\n${page.rawText}`,
    )
    .join("\n\n")
    .trim();

  return {
    rawText,
    sourceMap,
    metrics: {
      pageCount: cleanedPages.length,
      lineCount: cleanedPages.reduce((sum, page) => sum + page.lines.length, 0),
      repeatedChromeLineCount: repeatedChrome.size,
      requirementRowCount: tableRowIndex,
      hasOrdinalColumn,
      hasPriorityColumn,
    },
  };
}
