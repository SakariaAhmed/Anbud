import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";
import type { ExplicitIdPdfLayoutPage } from "@/lib/server/requirements/explicit-id-table-parser";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { explicitRequirementIdPattern } from "@/lib/server/requirements/id-detection";
import type { ProjectDocumentDetail } from "@/lib/types";
import { findRequirementOrderOffset, normalizedRequirementOrderSearchText } from "@/lib/server/requirements/mixed-corpus-rules";
import { withoutCorrectionsSection } from "@/lib/server/requirements/corrections";
import { findPdfPageMarkers } from "@/lib/server/requirements/pdf-normalization";
import { meetsSmallRequirementTextMinimum } from "@/lib/server/requirements/normalization";

type DoclingRequirementParserContext = Pick<RequirementCorpusParserContext,
  "detectExplicitRequirementIds" | "stripAnswerTextFromRequirement" | "stripRequirementChrome" |
  "hasRequirementSignal" | "hasStandaloneRequirementLanguage"
>;

function splitDoclingRequirementParagraph(source: string, context: DoclingRequirementParserContext) {
  const ids = context.detectExplicitRequirementIds(source).map((id) => normalizePageText(id).toUpperCase());
  const matches = [...source.matchAll(explicitRequirementIdPattern())].filter((match) =>
    context.detectExplicitRequirementIds(match[0]).some((id) => ids.includes(normalizePageText(id).toUpperCase()))
  );
  if (!matches.length || matches[0].index !== 0) return [];
  // A reference inside a sentence is not a new row. Merged rows need an ID
  // separator at a sentence/line boundary; otherwise leave the paragraph to
  // the existing parsers rather than guessing its units.
  if (matches.slice(1).some((match) =>
    !/(?:[.!?;]|\n)\s*$/u.test(source.slice(0, match.index)) ||
    !/^\s*[:–—-]\s+/u.test(source.slice(match.index + match[0].length))
  )) return [];
  const units = matches.map((match, index) => {
    const excerpt = source.slice(match.index, matches[index + 1]?.index ?? source.length).trim();
    const text = context.stripAnswerTextFromRequirement(context.stripRequirementChrome(
      excerpt.slice(match[0].length).replace(/^\s*[:–—-]\s*/u, "").trim(),
    ));
    return { id: context.detectExplicitRequirementIds(match[0])[0], text, sourceExcerpt: excerpt };
  });
  return units.every((unit) => unit.text.length >= 18 &&
    (context.hasRequirementSignal(unit.text) || context.hasStandaloneRequirementLanguage(unit.text))) ? units : [];
}

// A word before "Krav K-1:" that makes it a citation rather than the start of a requirement.
const LABEL_REFERENCE_LEAD = /^(?:se|jf|jfr|ref|iht|ifølge|viser|svar|besvarelse|respons|response|answer)$/iu;
const SENTENCE_ABBREVIATION = /(?:^|[\s(])(?:f\.eks|bl\.a|m\.a|m\.fl|jf|jfr|kl|nr|pkt|ca|dvs|mv|osv|inkl|ekskl|evt|ev|iht|kap|ref|tlf|vedr)\.$/iu;

/** The literal word in `Krav <ID>:` declares a requirement unit, so the unit
 * needs no modal verb. A bare `<ID>:` stays with the line and table parsers. */
function labelledRequirementMarkers(source: string, context: Pick<DoclingRequirementParserContext, "detectExplicitRequirementIds">) {
  const markers: Array<{ id: string; start: number; textStart: number }> = [];
  for (const match of source.matchAll(explicitRequirementIdPattern())) {
    const idAt = match.index;
    const id = context.detectExplicitRequirementIds(match[0])[0];
    const separator = /^\s*\*{0,2}\s*[:–—-]\s*\*{0,2}\s+/u.exec(source.slice(idAt + match[0].length));
    if (!id || !separator) continue;
    const labelWord = /^krav\s/iu.test(match[0]) ? "" : /(?<![\p{L}\p{N}])krav\s+$/iu.exec(source.slice(Math.max(0, idAt - 16), idAt))?.[0];
    if (labelWord === undefined) continue;
    const start = idAt - labelWord.length;
    const lead = source.slice(source.lastIndexOf("\n", start - 1) + 1, start).replace(/\*+/gu, "").trim();
    if (lead && !/^[-*•]$/u.test(lead)) {
      // Merged OCR paragraphs hold labels mid-line; a citation stays prose.
      if (!/^K(?:rav|RAV)/u.test(source.slice(start))) continue;
      const word = lead.split(/\s+/u).at(-1) ?? "";
      if (LABEL_REFERENCE_LEAD.test(word.replace(/[.:;]$/u, "")) || (!/[.!?;:]$/u.test(lead) && /^\p{Ll}/u.test(word))) continue;
    }
    markers.push({ id, start, textStart: idAt + match[0].length + separator[0].length });
  }
  return markers;
}

/** OCR can merge unrelated lines after a label. Keep the sentence it introduces
 * and only what structurally or linguistically continues the requirement. */
function labelledRequirementBody(body: string, context: Pick<DoclingRequirementParserContext, "hasRequirementSignal" | "hasStandaloneRequirementLanguage">) {
  const paragraph = body.split(/\n\s*\n/u)[0].trimEnd();
  const boundaries = [...paragraph.matchAll(/(?<=[.!?])\s+(?=[\p{Lu}\d(«"])|\n(?=\s*(?:[-*•]|\d{1,3}[.)])\s)|\n(?=\s*\p{Lu}[\p{L} /-]{0,40}:\s)/gu)]
    .filter(match => !SENTENCE_ABBREVIATION.test(paragraph.slice(Math.max(0, match.index - 8), match.index)));
  let end = paragraph.length;
  for (const [index, boundary] of boundaries.entries()) {
    const nextStart = boundary.index + boundary[0].length;
    const next = paragraph.slice(nextStart, boundaries[index + 1]?.index ?? paragraph.length).trim();
    const continues = /^(?:[-*•]|\d{1,3}[.)])\s/u.test(next) || paragraph.slice(0, boundary.index).trimEnd().endsWith(":") ||
      context.hasRequirementSignal(next) || context.hasStandaloneRequirementLanguage(next);
    if (!continues) { end = boundary.index; break; }
  }
  return paragraph.slice(0, end).trim();
}

function labelledRequirementUnits(source: string, context: DoclingRequirementParserContext) {
  const markers = labelledRequirementMarkers(source, context);
  return markers.flatMap((marker, index) => {
    const body = labelledRequirementBody(source.slice(marker.textStart, markers[index + 1]?.start ?? source.length), context);
    const text = context.stripAnswerTextFromRequirement(context.stripRequirementChrome(body));
    if (!meetsSmallRequirementTextMinimum(text)) return [];
    return [{ id: marker.id, text, sourceExcerpt: normalizePageText(source.slice(marker.start, marker.textStart) + body) }];
  });
}

function labelledRequirementSegments(document: ProjectDocumentDetail) {
  const lines = (value: string) => value.replace(/\r\n/gu, "\n").split("\n").map(line => /^\s*(?:\||#)/u.test(line) ? "" : line).join("\n");
  const original = withoutCorrectionsSection(document.raw_text);
  const markers = findPdfPageMarkers(original);
  if (!markers.length) return [{ text: lines(original), pages: [] as number[] }];
  return markers.map((marker, index) => ({
    text: lines(original.slice(marker.index + marker.marker.length, markers[index + 1]?.index ?? original.length)),
    pages: [marker.startPage],
  }));
}

/** Labelled lines where no paragraph map exists: text, DOCX and page-marked or unmarked PDF text. */
export function buildLabelledLineRequirementLedger(
  document: ProjectDocumentDetail,
  context: DoclingRequirementParserContext,
): RequirementLedgerEntry[] {
  if (document.role === "primary_solution_document" ||
    document.structure_map.some(entry => entry.kind === "docling_text" && entry.parser === "docling")) return [];
  const sourceText = normalizedRequirementOrderSearchText(document.raw_text);
  let sourceCursor = 0;
  return labelledRequirementSegments(document).flatMap((segment, segmentIndex) =>
    labelledRequirementUnits(segment.text, context).map((unit, unitIndex) => {
      const offset = findRequirementOrderOffset(sourceText, unit.sourceExcerpt, sourceCursor);
      if (offset !== null) sourceCursor = offset + normalizedRequirementOrderSearchText(unit.sourceExcerpt).length;
      return { ...unit, pages: segment.pages, heading: "", documentEntryOrder: offset ?? 1_000_000 + segmentIndex + unitIndex / 1000 };
    }));
}

/** Keep explicit ID/text boundaries in both separate and merged Docling paragraphs. */
export function buildExplicitIdDoclingTextRequirementLedger(
  document: ProjectDocumentDetail,
  context: DoclingRequirementParserContext,
): RequirementLedgerEntry[] {
  if (document.file_format !== "pdf") return [];
  const requirements: RequirementLedgerEntry[] = [];
  const sourceText = normalizedRequirementOrderSearchText(document.raw_text);
  const originalSource = normalizedRequirementOrderSearchText(withoutCorrectionsSection(document.raw_text));
  let sourceCursor = 0;
  let heading = "";
  for (const [order, entry] of document.structure_map.entries()) {
    if (entry.kind !== "docling_text" || entry.parser !== "docling") continue;
    if (/\bsection_header\b/iu.test(entry.reference)) {
      heading = normalizePageText(entry.text);
      continue;
    }
    const source = entry.text.trim().replace(/^[•*]\s*/u, "");
    const anchored = splitDoclingRequirementParagraph(source, context);
    // A correction names an ID; applyRequirementCorrections owns its wording.
    const units = anchored.length || document.role === "primary_solution_document" ? anchored
      : labelledRequirementUnits(source, context).filter(unit => originalSource.includes(normalizedRequirementOrderSearchText(unit.sourceExcerpt)));
    for (const [unitIndex, unit] of units.entries()) {
      const offset = findRequirementOrderOffset(sourceText, unit.sourceExcerpt, sourceCursor);
      if (offset !== null) sourceCursor = offset + normalizedRequirementOrderSearchText(unit.sourceExcerpt).length;
      requirements.push({
        ...unit,
        pages: typeof entry.page === "number" ? [entry.page] : [],
        heading: entry.heading_path?.join(" / ") || heading,
        documentEntryOrder: offset ?? 1_000_000 + order + unitIndex / units.length,
      });
    }
  }
  return requirements;
}

const NARRATIVE_SECTION_PATTERN =
  /(?:Ustrukturert\s+krav(?:beskrivelse|\s*-\s*krav\s*-\s*besvarelse|[\s-]*for[\s-]*krav[\s-]*besvarelse)|kravene\s+nedenfor\s+er\s+bevisst\s+skrevet\s+som\s+fritekst)/iu;
const NARRATIVE_END_PATTERN =
  /^(?:Krysshenvisninger\s+og\s+dokumentkontroll|Forhold\s+som\s+skal\s+avklares|Åpne\s+forhold)$/iu;
const ANSWER_LEAD_PATTERN =
  /^(?:Leverandørens\s+bindende\s+svar\s+til|Svar\s+på\s+krav|Respons\b|Bindende\s+svar\s*-\s*kravreferanse|Beslutning\s+og\s+svar)\b/iu;
const EXPLICIT_REQUIREMENT_HEADING_PATTERN =
  /^(?:Arbeidsnotat\s+\d+\b|Krav\s+\S+|\d+\)\s|Referatpunkt\s+\d+\b)/iu;
const TRAILING_REQUIREMENT_HEADING_PATTERN =
  /^Behovsområde\s+\d+\s*:/iu;
const TRAILING_REFERENCE_PATTERN = /\bKravreferanse\s*:/iu;
const NARRATIVE_NOTE_PATTERN =
  /^(?:Mellomnotat|Lesemerknad|Kravene\s+nedenfor\s+er\s+bevisst\s+skrevet)/iu;

function isNarrativeChrome(value: string) {
  const text = normalizePageText(value);
  return (
    /^Bilag\s+\d+\s*-\s*ustrukturert\s*\|/iu.test(text) ||
    /^(?:Fiktivt\s+testgrunnlag|Konfidensiell)\s*\|\s*Side\s+\d+(?:\s+av\s+\d+)?$/iu.test(
      text,
    )
  );
}

function serviceFromNarrativeHeading(value: string, id: string) {
  return normalizePageText(value)
    .replace(id, " ")
    .replace(/\b(?:Arbeidsnotat|Referatpunkt|Behovsområde|Krav)\s*\d*\s*[:.)-]?\s*/iu, "")
    .replace(/\b(?:referanse|prioritet|klassifisering)\s*[:,-]?\s*[ABC]?\b.*$/iu, "")
    .replace(/[\[\](),:-]+$/gu, "")
    .trim();
}

function requirementTextBeforeTrailingReference(value: string) {
  const marker = value.search(TRAILING_REFERENCE_PATTERN);
  return marker >= 0
    ? normalizePageText(value.slice(0, marker))
    : normalizePageText(value);
}

export function buildExplicitIdPdfNarrativeRequirementLedger(
  pages: ExplicitIdPdfLayoutPage[],
  context: RequirementCorpusParserContext,
) {
  type Draft = {
    id: string;
    service: string;
    requirementLines: string[];
    answerLines: string[];
    pages: number[];
    heading: string;
    order: number;
    mode: "requirement" | "answer";
  };

  const lines = pages.flatMap((page) =>
    page.lines
      .map((line) => ({
        page: page.page,
        text: normalizePageText(line.text),
      }))
      .filter((line) => line.text && !isNarrativeChrome(line.text)),
  );
  const sectionStart = lines.findIndex((line) =>
    NARRATIVE_SECTION_PATTERN.test(line.text),
  );
  if (sectionStart < 0) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  let current: Draft | null = null;
  let pendingHeading = "";
  let pendingLines: string[] = [];
  let activeHeading = "";
  let order = 0;

  function flush() {
    if (!current) return;

    const text = context.stripAnswerTextFromRequirement(
      context.stripRequirementChrome(current.requirementLines.join(" ")),
    );
    const answerExcerpt = normalizePageText(current.answerLines.join(" "));
    if (
      text.length >= 18 &&
      (context.hasRequirementSignal(text) ||
        context.hasStandaloneRequirementLanguage(text))
    ) {
      requirements.push({
        id: current.id,
        text,
        pages: [...new Set(current.pages)].sort((left, right) => left - right),
        heading: current.heading || "Ustrukturert kravbeskrivelse",
        tableId: "Ustrukturert eksplisitt kravblokk",
        service: current.service || undefined,
        sourceExcerpt: [
          current.heading,
          current.id,
          text,
          answerExcerpt ? `Leverandørens svar: ${answerExcerpt}` : "",
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1800),
        answerExcerpt: answerExcerpt || undefined,
        documentEntryOrder: current.order,
      });
    }
    current = null;
  }

  for (const line of lines.slice(sectionStart + 1)) {
    const text = line.text;
    if (NARRATIVE_END_PATTERN.test(text)) {
      flush();
      break;
    }
    if (/^\d+\.\s+\S/u.test(text) && !TRAILING_REQUIREMENT_HEADING_PATTERN.test(text)) {
      activeHeading = text;
    }

    const ids = context.detectExplicitRequirementIds(text);
    const answerLead = ANSWER_LEAD_PATTERN.test(text);
    if (answerLead) {
      const answerId = ids.length === 1 ? ids[0] : "";
      if (
        current &&
        answerId &&
        normalizePageText(answerId) === normalizePageText(current.id)
      ) {
        current.mode = "answer";
        current.pages.push(line.page);
      }
      continue;
    }

    if (TRAILING_REQUIREMENT_HEADING_PATTERN.test(text)) {
      flush();
      pendingHeading = text;
      pendingLines = [];
      continue;
    }

    const wrappedTrailingReference =
      ids.length === 1 &&
      Boolean(pendingHeading) &&
      pendingLines.some((candidate) =>
        TRAILING_REFERENCE_PATTERN.test(candidate),
      );
    const isTrailingReference =
      ids.length === 1 &&
      (TRAILING_REFERENCE_PATTERN.test(text) || wrappedTrailingReference);
    if (isTrailingReference) {
      flush();
      const id = ids[0];
      const inlineText = TRAILING_REFERENCE_PATTERN.test(text)
        ? requirementTextBeforeTrailingReference(text)
        : "";
      const requirementLines = [
        ...pendingLines.map(requirementTextBeforeTrailingReference),
        inlineText,
      ].filter(Boolean);
      current = {
        id,
        service: serviceFromNarrativeHeading(pendingHeading, id),
        requirementLines,
        answerLines: [],
        pages: [line.page],
        heading: pendingHeading || activeHeading,
        order,
        mode: "requirement",
      };
      order += 1;
      pendingHeading = "";
      pendingLines = [];
      continue;
    }

    const isExplicitHeading =
      ids.length === 1 && EXPLICIT_REQUIREMENT_HEADING_PATTERN.test(text);
    if (isExplicitHeading) {
      flush();
      const id = ids[0];
      current = {
        id,
        service: serviceFromNarrativeHeading(text, id),
        requirementLines: [],
        answerLines: [],
        pages: [line.page],
        heading: text,
        order,
        mode: "requirement",
      };
      order += 1;
      pendingHeading = "";
      pendingLines = [];
      continue;
    }

    if (NARRATIVE_NOTE_PATTERN.test(text)) {
      flush();
      pendingHeading = "";
      pendingLines = [];
      continue;
    }

    if (current) {
      if (!/^Klassifisering\s*:/iu.test(text)) {
        if (current.mode === "answer") {
          current.answerLines.push(text);
        } else {
          current.requirementLines.push(text);
        }
        current.pages.push(line.page);
      }
      continue;
    }

    if (
      pendingHeading &&
      (pendingLines.length > 0 ||
        context.hasRequirementSignal(text) ||
        context.hasStandaloneRequirementLanguage(text))
    ) {
      pendingLines.push(text);
    }
  }
  flush();

  const seen = new Set<string>();
  const unique = requirements.filter((entry) => {
    const id = normalizePageText(entry.id).toLocaleUpperCase("nb-NO");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return unique.length >= 2 ? unique : [];
}
