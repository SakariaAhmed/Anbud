import { correctionsSectionRanges } from "@/lib/server/requirements/corrections";
import type { ExplicitIdPdfLayoutPage } from "@/lib/server/requirements/explicit-id-table-parser";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

// Requirement registers numbered by chapter ("K-3.1.1", "KRAV-2.4") start
// each requirement at the left of a line, in prose or in an ID/type/text
// table. The flattened-text parsers read "K-3.1.1" as "K-3" or "K-3.1" plus
// text, so every row became several partial rows. This parser keeps one row
// per ID, from the PDF layout or from the text lines of other formats, and
// leaves every other numbering to them.

type LayoutLine = ExplicitIdPdfLayoutPage["lines"][number];
type LayoutItem = LayoutLine["items"][number];

const HIERARCHICAL_ID = /^([A-ZÆØÅ]{1,8}-\d{1,3}(?:\.\d{1,3}){1,4})(?=$|\s|\p{Lu}|[:–—-]\s)/u;
// Any numbered requirement at a line or cell start ("R-7 Leverandøren …"),
// apart from standards ("NS-3451", "ISO-9001").
const REQUIREMENT_LINE_START = /^(?!(?:ISO|IEC|NS|EN|SN|DIN|RFC)-)[A-ZÆØÅ]{1,8}-\d{1,4}(?:\.\d{1,3})*[:.]?\s+\p{Lu}/u;
const REQUIREMENT_CELL_START = /\|\s*(?!(?:ISO|IEC|NS|EN|SN|DIN|RFC)-)[A-ZÆØÅ]{1,8}-\d/u;
const TYPE_LABEL = /^(Minstekrav|Evalueres|Evalueringskrav|Skal-krav|Bør-krav|Absolutt krav)\s+/iu;
const NUMBERED_HEADING = /^\d{1,2}(?:\.\d{1,2}){0,4}\.?\s+\p{Lu}[^.!?]{0,90}$/u;
const TABLE_CAPTION = /^Tabell\s+\d+(?:[-.]\d+)*\b/iu;
const TABLE_HEADER_ID = /^(?:Krav[\s-]*ID|Kravnr\.?|ID|Nr\.?|Requirement[\s-]*ID)$/iu;
const TABLE_ROW = /^(?:Rad\s+\d+:|\|)/u;
const LIST_ITEM = /^(?:[a-zæøå]\)|\d{1,2}\)|[-–•*])\s/u;
const OBLIGATION = /(?<![\p{L}\p{N}])(?:skal|må|bør|shall|must|should)(?![\p{L}\p{N}])/iu;
const MIN_DISTINCT_IDS = 6;
const COLUMN_GAP = 8;

function text(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

/** One source line, from either the PDF layout or the text of another format. */
type SourceLine = {
  page: number | null;
  text: string;
  /** Set when the line starts a requirement. */
  start?: { id: string; type: string; text: string; x: number };
  /** Starts with a requirement ID, hierarchical or not. */
  requirementStart: boolean;
  heading?: string;
  x: number;
  /** Vertical distance to the previous line on the same page (PDF only). */
  gap: number | null;
  skip: boolean;
};

/** Words of a line from its layout runs: a run starting more than a point
 * after the previous one is a separate word. */
function joinItems(items: LayoutItem[]) {
  let previousEnd: number | null = null;
  let joined = "";
  for (const item of items) {
    const value = text(item.str);
    if (!value) continue;
    joined += `${previousEnd !== null && item.x - previousEnd > 1 ? " " : ""}${value}`;
    previousEnd = item.x + item.width;
  }
  return text(joined);
}

function layoutStart(line: LayoutLine): SourceLine["start"] {
  const [first, ...rest] = line.items;
  if (!first) return undefined;
  const firstText = text(first.str);
  const id = HIERARCHICAL_ID.exec(firstText)?.[1];
  if (!id) return undefined;
  const glued = text(firstText.slice(id.length));
  const items = glued ? [{ ...first, str: glued }, ...rest] : rest;
  // A short label separated by a column gap is the type column
  // ("Minstekrav", "Evalueres"), not the start of the requirement.
  const [second, third] = items;
  const typeColumn =
    !glued &&
    second &&
    third &&
    text(second.str).length <= 25 &&
    text(second.str).split(" ").length <= 3 &&
    !/[.,;:!?]$/u.test(text(second.str)) &&
    third.x - (second.x + second.width) >= COLUMN_GAP;
  return {
    id,
    type: typeColumn ? text(second.str) : "",
    text: joinItems(typeColumn ? items.slice(1) : items),
    x: first.x,
  };
}

/** Page headers and footers repeat at the top or bottom of several pages,
 * with only page numbers changing. Body lines such as "innenfor EØS." may
 * repeat too, so only the outermost lines of a page are candidates, and a
 * line that starts a requirement never is. */
function layoutSourceLines(pages: ExplicitIdPdfLayoutPage[]): SourceLine[] {
  const outermost = (page: ExplicitIdPdfLayoutPage, index: number) =>
    index < 2 || index >= page.lines.length - 2;
  const chromeKey = (line: LayoutLine) => joinItems(line.items).replace(/\d+/gu, "#");
  const pagesByKey = new Map<string, Set<number>>();
  for (const page of pages) {
    page.lines.forEach((line, index) => {
      if (!outermost(page, index) || layoutStart(line)) return;
      const key = chromeKey(line);
      if (key) pagesByKey.set(key, (pagesByKey.get(key) ?? new Set()).add(page.page));
    });
  }
  return pages.flatMap((page) =>
    page.lines.map((line, index): SourceLine => {
      const value = joinItems(line.items) || text(line.text);
      const start = layoutStart(line);
      const firstItem = text(line.items[0]?.str ?? "");
      return {
        page: page.page,
        text: value,
        start,
        requirementStart: REQUIREMENT_LINE_START.test(value),
        x: line.items[0]?.x ?? 0,
        gap: index > 0 ? page.lines[index - 1]!.y - line.y : null,
        skip:
          !value ||
          (!start &&
            ((outermost(page, index) && (pagesByKey.get(chromeKey(line))?.size ?? 0) >= 2) ||
              (TABLE_HEADER_ID.test(firstItem) && line.items.length >= 2))),
      };
    }),
  );
}

/** Paragraph lines of DOCX, text and Markdown: no layout, one paragraph per line. */
function textSourceLines(rawText: string): SourceLine[] {
  let page: number | null = null;
  return rawText.split("\n").flatMap((raw): SourceLine[] => {
    const marker = /^\[\[SIDE:(\d+)\]\]$/u.exec(raw.trim());
    if (marker) {
      page = Number(marker[1]);
      return [];
    }
    const markdownHeading = /^#{1,6}\s+(.+)$/u.exec(raw.trim())?.[1];
    const value = text(raw)
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^[-•*]\s+(?=[A-ZÆØÅ]{1,8}-\d)/u, "")
      .replace(/^\*\*([^*]+)\*\*/u, "$1");
    const id = HIERARCHICAL_ID.exec(value)?.[1];
    const rest = id ? text(value.slice(id.length).replace(/^\s*[:–—-]\s*/u, "")) : "";
    const type = TYPE_LABEL.exec(rest)?.[1] ?? "";
    return [{
      page,
      text: value,
      start: id ? { id, type, text: rest.slice(type.length).trim(), x: 0 } : undefined,
      requirementStart: REQUIREMENT_LINE_START.test(value),
      heading: markdownHeading && !id ? text(markdownHeading) : undefined,
      x: 0,
      gap: null,
      skip: !value,
    }];
  });
}

function baseLinePitch(lines: SourceLine[]) {
  const gaps = lines
    .map((line) => line.gap)
    .filter((gap): gap is number => gap !== null && gap > 4)
    .sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length * 0.2)] ?? 12;
}

/** A register lists each ID once under one prefix and numbers every
 * requirement the same way. Anything else (an ID repeated in a summary
 * table, a single-level "K-7" or "R-7" among "K-6.2") stays with the other
 * parsers. */
function isHierarchicalRegister(lines: SourceLine[]) {
  const ids = lines.flatMap((line) => (line.start ? [line.start.id] : []));
  const distinct = new Set(ids);
  if (distinct.size < MIN_DISTINCT_IDS || distinct.size !== ids.length) return false;
  const prefixCounts = new Map<string, number>();
  for (const id of distinct) {
    const prefix = id.replace(/-.*$/u, "");
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const count = Math.max(...prefixCounts.values());
  if (count < distinct.size * 0.8) return false;
  return !lines.some((line) =>
    !line.start &&
    (line.requirementStart || (TABLE_ROW.test(line.text) && REQUIREMENT_CELL_START.test(line.text))),
  );
}

/** In a text format, a short capitalised line without punctuation or an
 * obligation that opens the next requirement or section ("Sikkerhet") is a
 * heading. After an unfinished lead-in ("sertifisert etter" / "ISO/IEC
 * 27001:2022", "lagres i" / "Norge …") or before more text it is the rest of
 * the sentence. */
function isUnmarkedHeading(line: SourceLine, previous: string, next: SourceLine | undefined) {
  return (
    /^\p{Lu}/u.test(line.text) &&
    !/[.!?:;,]$/u.test(line.text) &&
    !OBLIGATION.test(line.text) &&
    !/(?<![\p{L}\p{N}])(?:i|på|etter|og|eller|for|med|til|av|om|fra|ved|som|at|mellom|under|over|innen|uten)$/iu.test(previous) &&
    Boolean(next && (next.start || next.heading || NUMBERED_HEADING.test(next.text)))
  );
}

function buildHierarchicalIdLedger(sourceLines: SourceLine[]): RequirementLedgerEntry[] {
  // A corrections chapter names IDs it changes ("K-4.1.2 endres …"); those
  // lines are applied by the corrections step, not read as requirements.
  const corrections = new Set(
    correctionsSectionRanges(sourceLines.map((line) => line.text)).flatMap(([start, end]) =>
      Array.from({ length: end - start }, (_, offset) => start + offset)),
  );
  const lines = sourceLines.filter((_, index) => !corrections.has(index));
  if (!isHierarchicalRegister(lines)) return [];
  const layout = lines.some((line) => line.gap !== null);
  const continuationGap = baseLinePitch(lines) * 1.35;
  const requirements: RequirementLedgerEntry[] = [];
  type Draft = {
    id: string;
    type: string;
    lines: string[];
    pages: number[];
    heading: string;
    tableId?: string;
    x: number;
    lastPage: number | null;
  };
  let current: Draft | null = null;
  let heading = "";
  let tableId: string | undefined;

  const flush = () => {
    if (!current) return;
    const requirementText = text(current.lines.join(" "));
    if (requirementText) {
      requirements.push({
        id: current.id,
        text: requirementText,
        pages: [...new Set(current.pages)],
        heading: current.heading,
        ...(current.tableId ? { tableId: current.tableId } : {}),
        sourceExcerpt: text(`${current.id} ${current.type} ${requirementText}`),
        documentEntryOrder: requirements.length,
      });
    }
    current = null;
  };

  const nextLine = (index: number) => lines.slice(index + 1).find((candidate) => !candidate.skip);
  for (const [index, line] of lines.entries()) {
    if (line.skip) continue;
    if (line.start) {
      flush();
      current = {
        id: line.start.id,
        type: line.start.type,
        lines: [line.start.text],
        pages: line.page === null ? [] : [line.page],
        heading,
        tableId,
        x: line.start.x,
        lastPage: line.page,
      };
      continue;
    }
    const value = line.text;
    if (current) {
      const draft: Draft = current;
      const previous = draft.lines.at(-1) ?? "";
      const sentenceEnded = /[.!?:]$/u.test(previous);
      // "5 Gbit/s og …" continues an unfinished sentence; a heading or
      // caption follows a completed one.
      // A paragraph in a text format is a line of its own: a numbered line
      // there is a heading even after an unfinished sentence.
      const structural =
        Boolean(line.heading) ||
        TABLE_ROW.test(value) ||
        ((sentenceEnded || !layout) && (NUMBERED_HEADING.test(value) || TABLE_CAPTION.test(value)));
      const listContinues = (/:$/u.test(previous) || LIST_ITEM.test(previous)) && LIST_ITEM.test(value);
      const samePage = draft.lastPage === line.page;
      const wrapped = layout
        ? samePage
          ? (line.gap ?? Infinity) <= continuationGap && line.x >= draft.x - 3
          : !/[.!?]$/u.test(previous)
        : !sentenceEnded && !isUnmarkedHeading(line, previous, nextLine(index));
      // A further paragraph that still states an obligation belongs to the
      // requirement it follows; background prose without one ends it.
      if (!structural && (wrapped || listContinues || OBLIGATION.test(value))) {
        draft.lines.push(value);
        if (line.page !== null) draft.pages.push(line.page);
        draft.lastPage = line.page;
        continue;
      }
      flush();
    }

    if (line.heading) {
      heading = line.heading;
      tableId = undefined;
    } else if (!layout && isUnmarkedHeading(line, "", nextLine(index))) {
      heading = value;
      tableId = undefined;
    } else if (TABLE_CAPTION.test(value)) {
      tableId = value;
    } else if (NUMBERED_HEADING.test(value)) {
      heading = value;
      tableId = undefined;
    }
  }
  flush();
  return requirements;
}

export function buildHierarchicalIdPdfRequirementLedger(
  pages: ExplicitIdPdfLayoutPage[],
): RequirementLedgerEntry[] {
  return buildHierarchicalIdLedger(layoutSourceLines(pages));
}

export function buildHierarchicalIdTextRequirementLedger(
  document: Pick<ProjectDocumentDetail, "file_format" | "raw_text">,
): RequirementLedgerEntry[] {
  if (!["docx", "txt", "md"].includes(document.file_format)) return [];
  return buildHierarchicalIdLedger(textSourceLines(document.raw_text));
}
