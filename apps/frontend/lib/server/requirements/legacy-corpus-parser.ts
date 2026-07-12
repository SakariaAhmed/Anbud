import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import { splitInlineNumberedHeadingRequirement } from "@/lib/server/requirements/heading-detection";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";
import {
  findRequirementOrderOffset,
  isMixedRequirementLineCandidate,
  normalizedRequirementOrderSearchText,
} from "@/lib/server/requirements/mixed-corpus-rules";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

export function isLegacyMixedFofingerCorpus(document: ProjectDocumentDetail) {
  return (
    /Bilag\s+2\s*-\s*Krav\s+og\s+føringer/i.test(document.raw_text) &&
    (/\bKrav\s*\/\s*føring\b/i.test(document.raw_text) ||
      /\bKravene\s+(?:er|under\s+er)\s+samlet\s+fra\b/i.test(
        document.raw_text,
      ))
  );
}

export function repairLegacyFofingerTextArtifacts(value: string) {
  return normalizePageText(value)
    .replace(/\s*\[\[SIDE:\d+[^\]]*\]\]\s*/gi, " ")
    .replace(/[•]/g, " ")
    .replace(/\s+Internt\s+notat:.*$/i, "")
    .replace(
      /\s+Dette\s+er\s+nevnt\s+i\s+arbeidsmøte\s+og\s+må\s+konkretiseres\.?$/i,
      "",
    )
    .replace(
      /^(?:[A-ZÆØÅ]{1,8}\s*-\s*\d{1,5}|[A-ZÆØÅ]{1,4}\d{1,5}|[A-ZÆØÅ0-9]{2,12}\s*[- ]\s*REQ\s*[- ]\s*\d{1,5}|REQ\s*[- ]\s*\d{1,5}|KRAV\s*[- ]\s*\d{1,5})\s*[-–—:]?\s*/iu,
      "",
    )
    .replace(
      /^(?:rad\s+\d{1,4}|obs|notat|uten\s+id|ikke\s+satt|se\s+notat|må\s+avklares|x|\?)\s*(?:[-–—:]?\s+|[-–—:]|(?=\p{Lu}))/iu,
      "",
    )
    .replace(/\bMarkering\s+Type\s+krav\s*\/\s*føring\s+Kommentar\b.*$/i, "")
    .replace(
      /^(?:avklaringskrav|tabellkrav|punktkrav|tekstkrav|notatkrav|implisitt\s+krav)\s+/i,
      "",
    )
    .replace(
      /\s+-\s+(?:avklaringskrav|tabellkrav|punktkrav|tekstkrav|notatkrav|implisitt\s+krav)\s+/gi,
      " ",
    )
    .replace(
      legacyInlineStatusBeforeRowRegex(),
      " ",
    )
    .replace(
      legacyInlineStatusBeforeAcronymContinuationRegex(),
      " ",
    )
    .replace(
      /\s+(?:Må\s+besvares|Bør\s+beskrives|Se\s+forslag|Avklares|Avklares\s+i\s+tilbud)$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function legacyRequirementTypePattern() {
  return "(?:avklaringskrav|tabellkrav|punktkrav|tekstkrav|notatkrav|implisitt\\s+krav)";
}

function legacyStatusPattern() {
  return "(?:Må\\s+besvares|Bør\\s+beskrives|Se\\s+forslag|Avklares|Avklares\\s+i\\s+tilbud)";
}

function legacyExplicitIdPattern() {
  return "(?:(?:[A-ZÆØÅ0-9]{1,12}\\s*[- ]\\s*)?REQ\\s*[- ]\\s*\\d{1,5}|KRAV\\s*[- ]\\s*\\d{1,5}|[A-ZÆØÅ]{2,8}\\s*-\\s*[A-ZÆØÅ]{1,4}\\s*[- ]?\\d{1,5}|[A-ZÆØÅ]{1,8}\\s*-\\s*\\d{1,5}|(?:K|R|KR|TEK)\\s*[- ]?\\d{1,5})";
}

function legacyPlaceholderPattern() {
  return "(?:obs|notat|uten\\s+id|ikke\\s+satt|se\\s+notat|må\\s+avklares|rad\\s+\\d{1,4}|x|\\?|[—-])";
}

function legacyRowStartRegex() {
  return new RegExp(
    `(?:^|\\s)(?:${legacyExplicitIdPattern()}|${legacyPlaceholderPattern()})\\s+${legacyRequirementTypePattern()}\\b`,
    "giu",
  );
}

function legacyInlineStatusBeforeRowRegex() {
  return new RegExp(
    `\\s+${legacyStatusPattern()}(?=\\s+(?:${legacyExplicitIdPattern()}|${legacyPlaceholderPattern()})\\s+${legacyRequirementTypePattern()}\\b)`,
    "giu",
  );
}

function legacyInlineStatusBeforeAcronymContinuationRegex() {
  return /\s+(?:Må\s+besvares|Bør\s+beskrives|Se\s+forslag|Avklares|Avklares\s+i\s+tilbud)(?=\s+[A-ZÆØÅ0-9]{2,}(?:[-/][\p{L}0-9]+)?\b)/gu;
}

function stripLegacyLinearTableHeader(value: string) {
  return normalizePageText(value)
    .replace(
      /^Markering\s+Type\s+krav\s*\/\s*føring\s+Kommentar\s*/i,
      "",
    )
    .trim();
}

function splitLegacyLinearTableSegments(value: string) {
  const line = stripLegacyLinearTableHeader(value);
  if (!line) {
    return [];
  }

  const starts = [];
  for (const match of line.matchAll(legacyRowStartRegex())) {
    if (isLikelyLegacyStandardReferenceStart(match[0])) {
      continue;
    }
    const prefixLength = /^\s/.test(match[0]) ? 1 : 0;
    starts.push((match.index ?? 0) + prefixLength);
  }

  if (!starts.length) {
    return [line];
  }

  const segments = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? line.length;
    const segment = line.slice(start, end).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  return segments;
}

function isLikelyLegacyStandardReferenceStart(value: string) {
  const text = normalizePageText(value).toUpperCase().replace(/[\s._-]+/g, "");
  return /^(?:ISO|IEC|NS|EN|RFC|AES|TLS|SSL|SHA|HTTP|HTTPS|SAML|OIDC|NIST|CIS|OWASP)\d/.test(
    text,
  );
}

function parseLegacyPrefixedRequirement(
  sourceLine: string,
  context: RequirementCorpusParserContext,
) {
  const requirementType = legacyRequirementTypePattern();
  const explicitMatch = new RegExp(
    `^\\s*(${legacyExplicitIdPattern()})(?:\\s+${requirementType})?\\s+(.+)$`,
    "iu",
  ).exec(sourceLine);
  const placeholderMatch =
    new RegExp(
      `^\\s*${legacyPlaceholderPattern()}(?:\\s+${requirementType})?\\s*(?:[-–—:]\\s+|\\s+|(?=\\p{Lu}))(.+)$`,
      "iu",
    ).exec(sourceLine) ?? /^\s*[—-]\s*[-–—:]?\s+(.+)$/u.exec(sourceLine);
  const explicitId = explicitMatch?.[1]
    ? normalizePageText(explicitMatch[1])
    : "";
  if (explicitId && isLikelyLegacyStandardReferenceStart(explicitId)) {
    return null;
  }
  const rawText = explicitMatch?.[2] ?? placeholderMatch?.[1] ?? "";
  const textCandidate = rawText
    .replace(/^\s*[-–—:]\s*/, "")
    .replace(
      new RegExp(`^${requirementType}\\s+`, "iu"),
      "",
    )
    .trim();
  const match = explicitMatch ?? placeholderMatch;
  if (!match) {
    return null;
  }

  const text = context.stripAnswerTextFromRequirement(
    context.stripRequirementChrome(textCandidate),
  );
  if (!isMixedRequirementLineCandidate(text, context)) {
    return null;
  }

  return { explicitId, text };
}

function isLegacyContinuationLine(value: string) {
  const text = normalizePageText(value);
  return (
    /^[a-zæøå0-9(]/u.test(text) ||
    /^[A-ZÆØÅ]{2,8}(?:[-/][a-zæøå]+)+\b/u.test(text) ||
    /^(?:og|eller|samt|som|med|for|til)\b/i.test(text)
  );
}

function isLegacyCorpusBoilerplateLine(value: string) {
  const text = normalizePageText(value);
  return (
    /^Kravene\s+(?:er|under\s+er)\s+samlet\s+fra\b/i.test(text) ||
    /^Bilag\s+2\s*-\s*Krav\s+og\s+føringer$/i.test(text) ||
    /^Leverandøren\s+må\s+selv\s+foreslå\s+hvordan\s+punktene\s+over\s+dokumenteres\b/i.test(
      text,
    ) ||
    /^Tabellen\s+under\s+er\s+ikke\s+endelig\s+prioritert\b/i.test(text)
  );
}

function buildSimplePrefixedLineRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 0;
  let heading = "";
  let inStandaloneNoteSection = false;
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;

  const lines = document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizePageText(line))
    .filter(Boolean);

  for (const line of lines) {
    const sourceLine = line.replace(/^[\u2022\uF0B7*]\s*/u, "").trim();
    if (/^Rad\s+\d{1,4}\s*:/i.test(sourceLine)) {
      inStandaloneNoteSection = false;
      continue;
    }
    if (/^Tabell\s+\d{1,4}$/i.test(sourceLine)) {
      inStandaloneNoteSection = false;
      heading = context.cleanHeadingCandidate(sourceLine);
      continue;
    }
    if (/^Notater\s+fra\s+gjennomgang:?$/i.test(sourceLine)) {
      heading = context.cleanHeadingCandidate(sourceLine);
      inStandaloneNoteSection = true;
      continue;
    }
    if (isLegacyCorpusBoilerplateLine(sourceLine)) {
      inStandaloneNoteSection = false;
      continue;
    }
    if (context.isLikelyHeadingLine(sourceLine)) {
      heading = context.cleanHeadingCandidate(sourceLine);
      inStandaloneNoteSection = false;
      continue;
    }

    const explicitMatch = new RegExp(
      `^\\s*(${legacyExplicitIdPattern()})(?:\\s+${legacyRequirementTypePattern()})?\\s*(?:[-–—:]\\s*)?(.+)$`,
      "iu",
    ).exec(sourceLine);
    const placeholderMatch =
      new RegExp(
        `^\\s*${legacyPlaceholderPattern()}(?:\\s+${legacyRequirementTypePattern()})?\\s*(?:[-–—:]\\s+|[-–—:]|\\s+|(?=\\p{Lu}))(.+)$`,
        "iu",
      ).exec(
        sourceLine,
      ) ?? /^\s*[—-]\s*[-–—:]?\s+(.+)$/u.exec(sourceLine);
    const explicitId = explicitMatch?.[1]
      ? normalizePageText(explicitMatch[1])
      : "";
    if (explicitId && isLikelyLegacyStandardReferenceStart(explicitId)) {
      continue;
    }
    const rawText = explicitMatch?.[2] ?? placeholderMatch?.[1] ?? "";
    const textCandidate = rawText
      .replace(/^\s*[-–—:]\s*/, "")
      .replace(
        /^(?:avklaringskrav|tabellkrav|punktkrav|tekstkrav|notatkrav)\s+/i,
        "",
      )
      .trim();
    const match = explicitMatch ?? placeholderMatch;
    const text = context.stripAnswerTextFromRequirement(
      context.stripRequirementChrome(
        match ? textCandidate : inStandaloneNoteSection ? sourceLine : "",
      ),
    );
    if (!isMixedRequirementLineCandidate(text, context)) {
      continue;
    }

    sequence += 1;
    const sourceOrderOffset =
      findRequirementOrderOffset(normalizedRawText, sourceLine, sourceOrderCursor) ??
      findRequirementOrderOffset(normalizedRawText, text, sourceOrderCursor);
    const documentEntryOrder =
      sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
    if (sourceOrderOffset !== null) {
      sourceOrderCursor =
        sourceOrderOffset +
        normalizedRequirementOrderSearchText(sourceLine || text).length;
    }
    requirements.push({
      id: explicitId || `Dokumenttekst krav ${sequence}`,
      text,
      pages: [],
      heading,
      tableId: explicitId ? "Dokumenttekst krav-ID" : "Dokumenttekst",
      sourceExcerpt: sourceLine,
      documentEntryOrder,
    });
  }

  return requirements;
}

export function buildPrefixedLineRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  if (!isLegacyMixedFofingerCorpus(document)) {
    return [];
  }

  if (document.file_format !== "pdf") {
    return buildSimplePrefixedLineRequirementLedger(document, context);
  }

  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 0;
  let heading = "";
  const state: {
    pending: {
      explicitId: string;
      text: string;
      sourceLine: string;
      heading: string;
    } | null;
  } = { pending: null };

  const lines = document.raw_text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizePageText(line))
    .filter(Boolean);

  function flushPending() {
    if (!state.pending) {
      return;
    }

    sequence += 1;
    requirements.push({
      id: state.pending.explicitId || `Dokumenttekst krav ${sequence}`,
      text: state.pending.text,
      pages: [],
      heading: state.pending.heading,
      tableId: state.pending.explicitId
        ? "Dokumenttekst krav-ID"
        : "Dokumenttekst",
      sourceExcerpt: state.pending.sourceLine,
      documentEntryOrder: sequence,
    });
    state.pending = null;
  }

  function startPending(sourceLine: string, activeHeading: string) {
    const parsed = parseLegacyPrefixedRequirement(sourceLine, context);
    if (!parsed) {
      return false;
    }

    flushPending();
    state.pending = {
      explicitId: parsed.explicitId,
      text: parsed.text,
      sourceLine,
      heading: activeHeading,
    };
    return true;
  }

  for (const line of lines) {
    const sourceLine = line.replace(/^[\u2022\uF0B7*]\s*/u, "").trim();
    if (
      /^Rad\s+\d{1,4}\s*:/i.test(sourceLine) ||
      /^Markering\s+Type\s+krav\s*\/\s*føring\s+Kommentar$/i.test(sourceLine) ||
      isLegacyCorpusBoilerplateLine(sourceLine)
    ) {
      continue;
    }

    const inlineHeadingRequirement =
      splitInlineNumberedHeadingRequirement(sourceLine);
    if (
      inlineHeadingRequirement &&
      context.isLikelyHeadingLine(inlineHeadingRequirement.heading)
    ) {
      const text = context.stripAnswerTextFromRequirement(
        context.stripRequirementChrome(inlineHeadingRequirement.requirement),
      );
      if (isMixedRequirementLineCandidate(text, context)) {
        flushPending();
        heading = context.cleanHeadingCandidate(
          inlineHeadingRequirement.heading,
        );
        state.pending = {
          explicitId: "",
          text,
          sourceLine,
          heading,
        };
        continue;
      }
    }

    const segments = splitLegacyLinearTableSegments(sourceLine);
    let startedAnySegment = false;
    for (const segment of segments) {
      startedAnySegment = startPending(segment, heading) || startedAnySegment;
    }

    if (startedAnySegment) {
      continue;
    }

    if (
      /^\d{1,3}(?:\.\d{1,3})*\.?\s+\S/.test(sourceLine) &&
      context.isLikelyHeadingLine(sourceLine)
    ) {
      flushPending();
      heading = context.cleanHeadingCandidate(sourceLine);
      continue;
    }

    if (state.pending && isLegacyContinuationLine(sourceLine)) {
      state.pending.text = [state.pending.text, sourceLine]
        .filter(Boolean)
        .join(" ");
      state.pending.sourceLine = [state.pending.sourceLine, sourceLine]
        .filter(Boolean)
        .join(" ");
      continue;
    }

    if (context.isLikelyHeadingLine(sourceLine)) {
      flushPending();
      heading = context.cleanHeadingCandidate(sourceLine);
      continue;
    }

    if (!state.pending) {
      continue;
    }

    state.pending.text = [state.pending.text, sourceLine]
      .filter(Boolean)
      .join(" ");
    state.pending.sourceLine = [state.pending.sourceLine, sourceLine]
      .filter(Boolean)
      .join(" ");
  }

  flushPending();
  return requirements;
}
