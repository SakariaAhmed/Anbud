import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";
import type { ExplicitIdPdfLayoutPage } from "@/lib/server/requirements/explicit-id-table-parser";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

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
