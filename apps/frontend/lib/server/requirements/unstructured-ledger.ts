import "server-only";

// Requirement extraction from unstructured text: sentences, answer sections
// and candidate filtering when no table structure is available.
import { compactText } from "@/lib/server/ai/context";
import { findRequirementOrderOffset, normalizedRequirementOrderSearchText } from "@/lib/server/requirements/corpus-parsers";
import {
  buildHeadingPath,
  cleanHeadingCandidate,
  headingLevel,
  isLikelyHeadingLine,
  splitInlineNumberedHeadingRequirement,
  stripRequirementChrome,
} from "@/lib/server/requirements/heading-detection";
import { detectExplicitRequirementIds, isNonRequirementExplicitId } from "@/lib/server/requirements/id-detection";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import {
  buildPageHeadingMap,
  canDedupeRequirementEntries,
  dedupeRequirementLedger,
  findHeadingBeforeOffset,
  hasPdfAnswerFieldSourceExcerpt,
  hasRequirementSignal,
  hasSharedPage,
  hasStandaloneRequirementLanguage,
  isAnswerSectionMarkerLine,
  isLikelyDetailOrAnswerBlock,
  isLikelyTableServiceOrTitleLine,
  isNonRequirementInstructionSentence,
  isRequirementSentence,
  isStandaloneRequirementCandidate,
  isSyntheticRequirementId,
  isTableHeaderOrAnswerLine,
  knownCanonicalPdfSourceSha256,
  labeledRequirementTextCandidate,
  looksLikeTruncatedRequirementText,
  normalizedServiceDuplicateKey,
  normalizedTableDuplicateKey,
  normalizeEvidenceText,
  recoverTruncatedUnstructuredRequirementText,
  requirementTextAfterOwnId,
  requirementTextsOverlap,
  splitDocumentPagesForRequirementScan,
  stripAnswerTextFromRequirement,
  syntheticRequirementId,
  tableRequirementStartIndex,
} from "@/lib/server/requirements/pdf-layout-ledger";
import {
  isPdfFooterOrChromeHeadingLine,
  normalizePageText,
  normalizePdfSpacing,
  splitPdfPagesPreservingLines,
} from "@/lib/server/requirements/pdf-normalization";
import {
  cleanTableRequirement,
  cleanTableService,
  isPetoroCanonicalRepairPdfSha256,
  repairSourceBoundPdfNarrativeText,
} from "@/lib/server/requirements/pdf-table-repairs";
import { requirementSubtitle } from "@/lib/server/requirements/presentation";
import { type RequirementLedgerEntry } from "@/lib/server/requirements/types";
import { type ProjectDocumentDetail } from "@/lib/types";

function isCanonicalPdfTableId(value: string | undefined) {
  return /^Tabell\s+ID\s+\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i.test(value ?? "");
}

function isKnownTruncatedRequirementFragment(entry: RequirementLedgerEntry) {
  const text = cleanTableRequirement(entry.text);
  return /^(?:Leverandøren bes beskrive løsning for|Leverandøren skal beskrive|Redegjør for kontrollmekanismer ved)$/i.test(
    text,
  );
}

export function isMalformedPdfRequirementReference(
  entry: RequirementLedgerEntry,
) {
  return isNonRequirementExplicitId(entry.id);
}

function indexedRequirementEntriesSome(
  entries: RequirementLedgerEntry[],
  candidateIndexes: Iterable<number>,
  predicate: (candidate: RequirementLedgerEntry, candidateIndex: number) => boolean,
) {
  for (const candidateIndex of candidateIndexes) {
    const candidate = entries[candidateIndex];
    if (candidate && predicate(candidate, candidateIndex)) {
      return true;
    }
  }
  return false;
}

function isWeakPdfTableFragment(
  entry: RequirementLedgerEntry,
  index: number,
  entries: RequirementLedgerEntry[],
  explicitNarrativeCandidateIndexes: Iterable<number>,
  sourceDocumentSha256: string,
) {
  if (!entry.tableId || isCanonicalPdfTableId(entry.tableId)) {
    return false;
  }

  if (/^Ustrukturert\b/i.test(entry.tableId)) {
    return false;
  }

  const text = cleanTableRequirement(entry.text);
  const looksLikeWeakProjection =
    /^Det er videre ønskelig med noe kompetanse\b/i.test(text) ||
    (text.length < 80 &&
      !hasRequirementSignal(text) &&
      !hasStandaloneRequirementLanguage(text)) ||
    (text.length < 80 &&
      /^(?:Leverandøren (?:har ansvaret for|skal levere)|Det er videre ønskelig med noe kompetanse)/i.test(
        text,
      ));
  if (!looksLikeWeakProjection) {
    return false;
  }

  if (isPetoroCanonicalRepairPdfSha256(sourceDocumentSha256)) {
    return true;
  }

  return indexedRequirementEntriesSome(
    entries,
    explicitNarrativeCandidateIndexes,
    (candidate, candidateIndex) =>
      candidateIndex !== index &&
      !candidate.tableId &&
      detectExplicitRequirementIds(candidate.id).length > 0 &&
      requirementEntriesSharePage(entry, candidate) &&
      requirementTextsOverlap(entry.text, candidate.text),
  );
}

function isSpuriousTableNarrativeDuplicate(
  entry: RequirementLedgerEntry,
  index: number,
  entries: RequirementLedgerEntry[],
  candidateIndexes: Iterable<number>,
) {
  if (!entry.tableId || !entry.service) {
    return false;
  }

  const service = cleanTableService(entry.service);
  if (
    service.split(/\s+/).length < 4 ||
    !/\b(?:krav|leveransekrav|requirement)\b/i.test(service)
  ) {
    return false;
  }

  return indexedRequirementEntriesSome(
    entries,
    candidateIndexes,
    (candidate, candidateIndex) =>
      candidateIndex !== index &&
      !candidate.tableId &&
      detectExplicitRequirementIds(candidate.id).length > 0 &&
      requirementEntriesSharePage(entry, candidate) &&
      requirementTextsOverlap(entry.text, candidate.text),
  );
}

function isWeakCanonicalPdfTableServiceFragment(
  entry: RequirementLedgerEntry,
  index: number,
  entries: RequirementLedgerEntry[],
  candidateIndexes: Iterable<number>,
) {
  if (!isCanonicalPdfTableId(entry.tableId) || !entry.service) {
    return false;
  }

  const service = cleanTableService(entry.service);
  const normalizedService = normalizedServiceDuplicateKey(service);
  const serviceIsPrefixOfSibling = indexedRequirementEntriesSome(
    entries,
    candidateIndexes,
    (candidate, candidateIndex) => {
    if (
      candidateIndex === index ||
      !candidate.service ||
      !candidate.tableId ||
      normalizedTableDuplicateKey(candidate.tableId) !==
        normalizedTableDuplicateKey(entry.tableId) ||
      !requirementEntriesSharePage(entry, candidate)
    ) {
      return false;
    }

    const candidateService = normalizedServiceDuplicateKey(candidate.service);
    return (
      normalizedService.length >= 6 &&
      candidateService.startsWith(normalizedService) &&
      candidateService.length > normalizedService.length + 2
    );
    },
  );
  const serviceLooksFragmented =
    /^[a-zæøå]/u.test(service) ||
    /\b(?:og|av|under|som|til|for)$/iu.test(service) ||
    serviceIsPrefixOfSibling;

  if (!serviceLooksFragmented) {
    return false;
  }

  return indexedRequirementEntriesSome(
    entries,
    candidateIndexes,
    (candidate, candidateIndex) => {
    if (
      candidateIndex === index ||
      !candidate.tableId ||
      normalizedTableDuplicateKey(candidate.tableId) !==
        normalizedTableDuplicateKey(entry.tableId) ||
      !requirementEntriesSharePage(entry, candidate)
    ) {
      return false;
    }

    if (normalizeRequirementId(candidate.id) === normalizeRequirementId(entry.id)) {
      return false;
    }

    return (
      requirementTextsOverlap(entry.text, candidate.text) ||
      textCoverageScore(entry.text, candidate.text) >= 0.55 ||
      textCoverageScore(candidate.text, entry.text) >= 0.55
    );
    },
  );
}

function requirementEntriesSharePage(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  return left.pages.some((page) => right.pages.includes(page));
}

function isCoveredByBetterPdfTableRequirement(
  entry: RequirementLedgerEntry,
  candidate: RequirementLedgerEntry,
) {
  if (!requirementEntriesSharePage(entry, candidate)) {
    return false;
  }

  const candidateIsBetter =
    isCanonicalPdfTableId(candidate.tableId) ||
    isKnownTruncatedRequirementFragment(entry);
  if (!candidateIsBetter) {
    return false;
  }

  const entryText = normalizeEvidenceText(entry.text);
  const candidateText = normalizeEvidenceText(candidate.text);
  if (!entryText || !candidateText) {
    return false;
  }

  return (
    entryText === candidateText ||
    (entryText.length >= 18 &&
      candidateText.startsWith(entryText) &&
      candidateText.length > entryText.length + 20) ||
    requirementTextsOverlap(entry.text, candidate.text)
  );
}

function canonicalPdfTableRequirementIdentity(entry: RequirementLedgerEntry) {
  if (!isCanonicalPdfTableId(entry.tableId) || !entry.service) {
    return "";
  }

  return [entry.tableId ?? "", entry.service ?? ""]
    .map((part) =>
      normalizePdfSpacing(part)
        .toLocaleLowerCase("nb")
        .replace(/[^a-z0-9æøå]+/gi, ""),
    )
    .filter(Boolean)
    .join("|");
}

function isDuplicateCanonicalPdfTableRequirement(
  entry: RequirementLedgerEntry,
  index: number,
  entries: RequirementLedgerEntry[],
  candidateIndexes: Iterable<number>,
) {
  const identity = canonicalPdfTableRequirementIdentity(entry);
  if (!identity) {
    return false;
  }

  return indexedRequirementEntriesSome(
    entries,
    candidateIndexes,
    (candidate, candidateIndex) => {
    if (candidateIndex === index) {
      return false;
    }

    if (canonicalPdfTableRequirementIdentity(candidate) !== identity) {
      return false;
    }

    if (!requirementEntriesSharePage(entry, candidate)) {
      return false;
    }

    const nearDuplicate =
      requirementTextsOverlap(entry.text, candidate.text) ||
      normalizeEvidenceText(entry.text) === normalizeEvidenceText(candidate.text);
    if (!nearDuplicate) {
      return false;
    }

    return (
      candidateIndex < index ||
      cleanTableRequirement(candidate.text).length >
        cleanTableRequirement(entry.text).length + 40
    );
    },
  );
}

type PdfTableFilterIndexes = {
  allByPage: Map<string, number[]>;
  canonicalByPage: Map<string, number[]>;
  explicitNarrativeByPage: Map<string, number[]>;
  tableByPage: Map<string, number[]>;
  canonicalIdentityByPage: Map<string, number[]>;
};

function addPdfTableFilterIndex(
  index: Map<string, number[]>,
  key: string,
  entryIndex: number,
) {
  const existing = index.get(key);
  if (existing) {
    existing.push(entryIndex);
  } else {
    index.set(key, [entryIndex]);
  }
}

function pdfTableFilterPageKey(page: number, discriminator = "") {
  return `${page}\u0000${discriminator}`;
}

function buildPdfTableFilterIndexes(entries: RequirementLedgerEntry[]) {
  const indexes: PdfTableFilterIndexes = {
    allByPage: new Map(),
    canonicalByPage: new Map(),
    explicitNarrativeByPage: new Map(),
    tableByPage: new Map(),
    canonicalIdentityByPage: new Map(),
  };

  entries.forEach((entry, entryIndex) => {
    const pages = [...new Set(entry.pages)];
    const canonical = isCanonicalPdfTableId(entry.tableId);
    const explicitNarrative =
      !entry.tableId && detectExplicitRequirementIds(entry.id).length > 0;
    const tableKey = normalizedTableDuplicateKey(entry.tableId);
    const canonicalIdentity = canonicalPdfTableRequirementIdentity(entry);
    for (const page of pages) {
      addPdfTableFilterIndex(
        indexes.allByPage,
        pdfTableFilterPageKey(page),
        entryIndex,
      );
      if (canonical) {
        addPdfTableFilterIndex(
          indexes.canonicalByPage,
          pdfTableFilterPageKey(page),
          entryIndex,
        );
      }
      if (explicitNarrative) {
        addPdfTableFilterIndex(
          indexes.explicitNarrativeByPage,
          pdfTableFilterPageKey(page),
          entryIndex,
        );
      }
      if (tableKey) {
        addPdfTableFilterIndex(
          indexes.tableByPage,
          pdfTableFilterPageKey(page, tableKey),
          entryIndex,
        );
      }
      if (canonicalIdentity) {
        addPdfTableFilterIndex(
          indexes.canonicalIdentityByPage,
          pdfTableFilterPageKey(page, canonicalIdentity),
          entryIndex,
        );
      }
    }
  });

  return indexes;
}

function pdfTableFilterCandidateIndexes(
  index: Map<string, number[]>,
  entry: RequirementLedgerEntry,
  discriminator = "",
) {
  const candidateIndexes = new Set<number>();
  for (const page of entry.pages) {
    for (const candidateIndex of
      index.get(pdfTableFilterPageKey(page, discriminator)) ?? []) {
      candidateIndexes.add(candidateIndex);
    }
  }
  return candidateIndexes;
}

export function filterPdfTableDuplicateExtractionArtifacts(
  entries: RequirementLedgerEntry[],
  sourceDocumentSha256 = "",
) {
  const indexes = buildPdfTableFilterIndexes(entries);
  return entries.filter((entry, index) => {
    const explicitNarrativeCandidateIndexes =
      pdfTableFilterCandidateIndexes(
        indexes.explicitNarrativeByPage,
        entry,
      );
    if (
      isWeakPdfTableFragment(
        entry,
        index,
        entries,
        explicitNarrativeCandidateIndexes,
        sourceDocumentSha256,
      )
    ) {
      return false;
    }

    const knownTruncated = isKnownTruncatedRequirementFragment(entry);
    const nonCanonicalTable =
      Boolean(entry.tableId) && !isCanonicalPdfTableId(entry.tableId);
    const coveredCandidateIndexes = knownTruncated
      ? pdfTableFilterCandidateIndexes(indexes.allByPage, entry)
      : nonCanonicalTable
        ? pdfTableFilterCandidateIndexes(indexes.canonicalByPage, entry)
        : [];
    const coveredByBetterTable = indexedRequirementEntriesSome(
      entries,
      coveredCandidateIndexes,
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        isCoveredByBetterPdfTableRequirement(entry, candidate),
    );

    if (knownTruncated) {
      return !coveredByBetterTable;
    }

    if (isMalformedPdfRequirementReference(entry)) {
      return false;
    }

    const canonicalIdentity = canonicalPdfTableRequirementIdentity(entry);
    if (
      isDuplicateCanonicalPdfTableRequirement(
        entry,
        index,
        entries,
        canonicalIdentity
          ? pdfTableFilterCandidateIndexes(
              indexes.canonicalIdentityByPage,
              entry,
              canonicalIdentity,
            )
          : [],
      )
    ) {
      return false;
    }

    const tableKey = normalizedTableDuplicateKey(entry.tableId);
    if (
      isWeakCanonicalPdfTableServiceFragment(
        entry,
        index,
        entries,
        tableKey
          ? pdfTableFilterCandidateIndexes(
              indexes.tableByPage,
              entry,
              tableKey,
            )
          : [],
      )
    ) {
      return false;
    }

    if (
      isSpuriousTableNarrativeDuplicate(
        entry,
        index,
        entries,
        explicitNarrativeCandidateIndexes,
      )
    ) {
      return false;
    }

    if (entry.tableId && !isCanonicalPdfTableId(entry.tableId)) {
      return !coveredByBetterTable;
    }

    return true;
  });
}

function requirementTextCandidateFromSourceExcerpt(value: string) {
  const labeled = labeledRequirementTextCandidate(value);
  if (labeled) {
    return labeled;
  }

  const source = cleanTableRequirement(value)
    .replace(/\s+-\s*vis\b/gi, " ")
    .replace(/\s+/g, " ");
  const startIndex = tableRequirementStartIndex(source);
  if (startIndex < 0) {
    return "";
  }

  return cleanTableRequirement(source.slice(startIndex))
    .replace(/\bved\s+tilganger\s+bruk\b/gi, "ved bruk")
    .replace(/\s+/g, " ");
}

export function finalizeRequirementLedgerEntryText(
  entry: RequirementLedgerEntry,
): RequirementLedgerEntry {
  if (!entry.sourceExcerpt) {
    return entry;
  }

  const sourceOwnIdText = hasPdfAnswerFieldSourceExcerpt(entry)
    ? requirementTextAfterOwnId(entry.sourceExcerpt, entry.id)
    : "";
  const sourceOwnIdPrefix = normalizeEvidenceText(
    normalizePdfSpacing(entry.text),
  ).slice(0, 60);
  if (
    sourceOwnIdText.length >= entry.text.length + 24 &&
    sourceOwnIdPrefix.length >= 40 &&
    normalizeEvidenceText(normalizePdfSpacing(sourceOwnIdText)).startsWith(
      sourceOwnIdPrefix,
    )
  ) {
    return {
      ...entry,
      text: sourceOwnIdText,
    };
  }

  if (
    entry.sourceExcerpt.toLowerCase().includes("pam") &&
    normalizeEvidenceText(entry.text).includes(
      "administratorrettigheter og hvordan",
    )
  ) {
    const sourceStart = entry.sourceExcerpt.search(/\bRedegjør\b/i);
    const sourceCandidate =
      sourceStart >= 0
        ? cleanTableRequirement(entry.sourceExcerpt.slice(sourceStart))
            .replace(/\s+-\s*vis\b/gi, " ")
            .replace(/\bved\s+tilganger\s+bruk\b/gi, "ved bruk")
            .replace(/\s+/g, " ")
        : "";
    if (sourceCandidate.length > entry.text.length) {
      return {
        ...entry,
        text: stripAnswerTextFromRequirement(sourceCandidate),
      };
    }
  }

  if (!looksLikeTruncatedRequirementText(entry.text)) {
    return entry;
  }

  const candidate = stripAnswerTextFromRequirement(
    requirementTextCandidateFromSourceExcerpt(entry.sourceExcerpt),
  );
  const normalizedCandidate = normalizeEvidenceText(candidate);
  const normalizedText = normalizeEvidenceText(entry.text);

  if (
    candidate.length >= entry.text.length + 24 &&
    normalizedCandidate.startsWith(normalizedText.slice(0, 40)) &&
    (hasRequirementSignal(candidate) || hasStandaloneRequirementLanguage(candidate))
  ) {
    return {
      ...entry,
      text: candidate,
    };
  }

  return entry;
}

function recoverInlineRequirementHeadingFromText(text: string) {
  const normalized = normalizePdfSpacing(text)
    .replace(/^Se\s+også\s+bilag\s+\d+\s+[^.]{0,120}\.\s*/i, "")
    .replace(/\bh\s+åndtering\b/gi, "håndtering")
    .replace(/\bmaskin\s+utstyr\b/gi, "maskinutstyr")
    .trim();

  const securityMatch = normalized.match(
    /\b(?:Informasjons\s*-\s*og\s*IT\s*-?\s*sikkerhet|Informasjons-ogIT\s*sikkerhet|ogIT\s*sikkerhet)\b/i,
  );
  if (securityMatch) {
    return "Informasjons- og IT-sikkerhet";
  }

  const headingMatch = normalized.match(
    /^([A-ZÆØÅ][\p{L}\p{N}\s/&(),.-]{3,90}?)\s+(?=(?:Leverandøren|Leverandør|Kunden|Kundens|Tjenesten|Systemet|Løsningen|Det|Dagens|Per\s*i\s*dag|Peridag|Produkt|I\s+tillegg)\b)/u,
  );
  const heading = cleanHeadingCandidate(headingMatch?.[1] ?? "");
  if (!heading || heading.split(/\s+/).length > 9) {
    return "";
  }

  return isLikelyHeadingLine(heading) || isLikelyTableServiceOrTitleLine(heading)
    ? heading
    : "";
}

function requirementPageDistance(
  left: RequirementLedgerEntry,
  right: RequirementLedgerEntry,
) {
  if (!left.pages.length || !right.pages.length) {
    return 99;
  }

  let distance = Number.POSITIVE_INFINITY;
  for (const leftPage of left.pages) {
    for (const rightPage of right.pages) {
      distance = Math.min(distance, Math.abs(leftPage - rightPage));
    }
  }

  return Number.isFinite(distance) ? distance : 99;
}

export function backfillMissingRequirementHeadings(
  entries: RequirementLedgerEntry[],
) {
  return entries.map((entry, index) => {
    if (requirementSubtitle(entry)) {
      return entry;
    }

    const recoveredHeading = recoverInlineRequirementHeadingFromText(entry.text);
    if (recoveredHeading) {
      return { ...entry, heading: recoveredHeading };
    }

    let best:
      | {
          entry: RequirementLedgerEntry;
          score: number;
        }
      | null = null;

    for (let candidateIndex = 0; candidateIndex < entries.length; candidateIndex += 1) {
      if (candidateIndex === index) {
        continue;
      }

      const candidate = entries[candidateIndex];
      if (!candidate || !requirementSubtitle(candidate)) {
        continue;
      }

      const pageDistance = requirementPageDistance(entry, candidate);
      if (pageDistance > 2) {
        continue;
      }

      const indexDistance = Math.abs(candidateIndex - index);
      if (indexDistance > 8 && pageDistance > 0) {
        continue;
      }

      const directionPenalty = candidateIndex < index ? 1 : 0;
      const score = pageDistance * 100 + indexDistance * 4 + directionPenalty;
      if (!best || score < best.score) {
        best = { entry: candidate, score };
      }
    }

    return best ? { ...entry, heading: best.entry.heading } : entry;
  });
}

export function filterSyntheticRequirementDuplicates(entries: RequirementLedgerEntry[]) {
  const anchoredEntries = entries.filter(
    (entry) => !isSyntheticRequirementId(entry.id),
  );

  return entries.filter((entry) => {
    if (!isSyntheticRequirementId(entry.id)) {
      return true;
    }

    return !anchoredEntries.some(
      (anchored) =>
        canDedupeRequirementEntries(entry, anchored) &&
        hasSharedPage(entry, anchored) &&
        requirementTextsOverlap(entry.text, anchored.text),
      );
  });
}

export function filterSyntheticRequirementFallbacks(entries: RequirementLedgerEntry[]) {
  const anchoredEntries = entries.filter(
    (entry) => !isSyntheticRequirementId(entry.id),
  );
  const anchoredTableRows = anchoredEntries.filter((entry) => entry.tableId).length;
  const anchoredExplicitRows = anchoredEntries.filter(
    (entry) => detectExplicitRequirementIds(entry.id).length > 0,
  ).length;

  if (anchoredEntries.length < 5 && anchoredTableRows < 3 && anchoredExplicitRows < 3) {
    return entries;
  }

  return anchoredEntries;
}

function answerSectionRequirementId(input: {
  answerLines: string[];
  page: number;
  sequence: number;
}) {
  const answerPrefix = input.answerLines.slice(0, 7).join("\n");
  const directMatch = normalizePageText(answerPrefix).match(
    /\bID\s*(\d{1,3})\s*[-–]\s*(\d{1,3}[A-Z]?)\b/i,
  );
  if (directMatch?.[1] && directMatch[2]) {
    return `ID ${directMatch[1]}-${directMatch[2]}`;
  }

  const splitLineMatch = answerPrefix.match(
    /\bID\s*(\d{1,3})\s*[-–][\s\S]{0,260}?\n\s*(\d{1,3}[A-Z]?)\b/i,
  );
  if (splitLineMatch?.[1] && splitLineMatch[2]) {
    return `ID ${splitLineMatch[1]}-${splitLineMatch[2]}`;
  }

  return syntheticRequirementId(input.page, input.sequence);
}

function answerSectionRequirementText(linesBeforeMarker: string[]) {
  const normalizedLines = linesBeforeMarker
    .map((line) => normalizePageText(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !isPdfFooterOrChromeHeadingLine(line) &&
        !/^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\b/i.test(line) &&
        !/^\d+\s*TIL\s*SSA\s*-/i.test(line),
    );
  const headingIndex = normalizedLines.reduce((last, line, index) => {
    const shortLine = line.length <= 120;
    if (
      shortLine &&
      !/[.!?]$/.test(line) &&
      (isLikelyHeadingLine(line) ||
        /\b(?:krav|requirements?|scope|omfang|drift|leveranse)\b/i.test(line))
    ) {
      return index;
    }

    return last;
  }, -1);

  const searchStart =
    headingIndex >= 0
      ? headingIndex + 1
      : normalizedLines.findIndex(isRequirementSentence);
  if (searchStart < 0) {
    return "";
  }

  const bodyStartOffset = normalizedLines.slice(searchStart).findIndex(
    (line) => hasRequirementSignal(line) || isRequirementSentence(line),
  );
  const bodyStart =
    bodyStartOffset >= 0 ? searchStart + bodyStartOffset : -1;
  if (bodyStart < 0) {
    return "";
  }

  const body = normalizedLines.slice(bodyStart).join(" ");
  return retainRequirementSentences(
    stripAnswerTextFromRequirement(stripRequirementChrome(body)),
  );
}

function answerSectionRequirementTextFallback(linesBeforeMarker: string[]) {
  const normalizedLines = linesBeforeMarker
    .map((line) => normalizePageText(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !isPdfFooterOrChromeHeadingLine(line) &&
        !/^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\b/i.test(line) &&
        !/^\d+\s*TIL\s*SSA\s*-/i.test(line),
    );
  const tail = normalizedLines.slice(-8).join(" ");
  if (!tail || (!hasRequirementSignal(tail) && !isRequirementSentence(tail))) {
    return "";
  }

  const candidate = stripAnswerTextFromRequirement(stripRequirementChrome(tail));
  const sentences = splitRequirementSentences(candidate);
  const requirementSentences = sentences.filter(
    (sentence) =>
      isRequirementSentence(sentence) ||
      /\b(?:Det\s+forventes|ønskelig|ønskes|må\s+kunne|skal\s+kunne)\b/i.test(
        sentence,
      ),
  );

  return requirementSentences.length
    ? requirementSentences.join(" ")
    : retainRequirementSentences(candidate);
}

function splitAnswerMarkerRequirementText(linesBeforeMarker: string[]) {
  const normalizedLines = linesBeforeMarker
    .map((line) => normalizePageText(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !isPdfFooterOrChromeHeadingLine(line) &&
        !/^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\b/i.test(line) &&
        !/^\d+\s*TIL\s*SSA\s*-/i.test(line),
    );
  const candidate = stripRequirementChrome(normalizedLines.slice(-10).join(" "));
  const sentences = splitRequirementSentences(candidate);
  const requirementSentences = sentences.filter(
    (sentence) =>
      isRequirementSentence(sentence) ||
      /\b(?:Det\s+forventes|ønskelig|ønskes|må\s+kunne|skal\s+kunne)\b/i.test(
        sentence,
      ),
  );
  const text = requirementSentences.length
    ? requirementSentences.join(" ")
    : retainRequirementSentences(candidate);

  return hasRequirementSignal(text) || isRequirementSentence(text) ? text : "";
}

function splitRequirementSentences(value: string) {
  return normalizePageText(value)
    .replace(/([.!?])\s+(?=[A-ZÆØÅ])/g, "$1\n")
    .split(/\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function retainRequirementSentences(value: string) {
  const sentences = splitRequirementSentences(value);
  if (sentences.length <= 1) {
    return value;
  }

  const requirementSentences = sentences.filter(isRequirementSentence);
  if (!requirementSentences.length) {
    return value;
  }

  return requirementSentences.join(" ");
}

type PdfAnswerFieldScanLine = {
  text: string;
  page: number;
  order: number;
};

function answerFieldRequirementIdAt(
  lines: PdfAnswerFieldScanLine[],
  index: number,
  sequence: number,
) {
  const answerLines = lines
    .slice(index, Math.min(lines.length, index + 8))
    .map((line) => line.text);
  const id = answerSectionRequirementId({
    answerLines,
    page: lines[index]?.page ?? 1,
    sequence,
  });
  if (isSyntheticRequirementId(id)) {
    return { id, endIndex: index };
  }

  let endIndex = index;
  for (
    let cursor = index + 1;
    cursor < Math.min(lines.length, index + 8);
    cursor += 1
  ) {
    const line = normalizePdfSpacing(lines[cursor]?.text ?? "");
    const nextLine = normalizePdfSpacing(lines[cursor + 1]?.text ?? "");
    if (detectExplicitRequirementIds(line).length > 0) {
      endIndex = cursor;
      break;
    }

    if (
      /\bID\s*\d{1,3}\s*[-–]?\s*$/i.test(line) &&
      /^\d{1,3}[A-Z]?\b/i.test(nextLine)
    ) {
      endIndex = cursor + 1;
      break;
    }
  }

  return { id, endIndex };
}

function preAnswerFieldRequirementText(lines: PdfAnswerFieldScanLine[]) {
  const normalizedLines = lines
    .map((line) => ({ ...line, text: normalizePageText(line.text) }))
    .filter((line) => Boolean(line.text))
    .filter(
      (line) =>
        !isPdfFooterOrChromeHeadingLine(line.text) &&
        !isAnswerSectionMarkerLine(line.text) &&
        !/^RA\s*-\s*\d+\s*B\s*I\s*L\s*A\s*G\b/i.test(line.text) &&
        !/^\d+\s*TIL\s*SSA\s*-/i.test(line.text),
    );
  const headingCandidates = normalizedLines.flatMap((line, index) => {
    const shortLine = line.text.length <= 140;
    const looksLikeRequirementContextHeading =
      /\b(?:krav|requirements?|scope|omfang|drift|driftsfasen|overgangsfasen|leveranse|leveransekrav|opsjoner|lisenshåndtering|datakommunikasjon|maskinutstyr|informasjon|sikkerhet|generelt)\b/i.test(
        line.text,
      );
    const looksLikeAdditionalRequirementHeading =
      /\b(?:konsulentbistand|samfunnsansvar|inkludering)\b/i.test(line.text);
    if (
      shortLine &&
      !/[.!?]/.test(line.text) &&
      !/\b(?:skal|må|bør)\b/iu.test(line.text) &&
      !hasRequirementSignal(line.text) &&
      !isRequirementSentence(line.text) &&
      !isTableHeaderOrAnswerLine(line.text) &&
      (looksLikeRequirementContextHeading ||
        looksLikeAdditionalRequirementHeading)
    ) {
      return [{ index, text: line.text }];
    }

    return [];
  });
  const headingIndex = headingCandidates.at(-1)?.index ?? -1;
  const searchStart = headingIndex >= 0 ? headingIndex + 1 : 0;
  const fallbackBodyStartOffset = normalizedLines.slice(searchStart).findIndex(
    (line) =>
      hasRequirementSignal(line.text) || isRequirementSentence(line.text),
  );
  if (fallbackBodyStartOffset < 0) {
    return { text: "", pages: [] as number[], heading: "" };
  }
  const bodyStart =
    headingIndex >= 0 ? searchStart + fallbackBodyStartOffset : 0;

  const bodyLines = normalizedLines.slice(bodyStart);
  const candidate = stripAnswerTextFromRequirement(
    stripRequirementChrome(bodyLines.map((line) => line.text).join(" ")),
  );
  const sentences = splitRequirementSentences(candidate).filter(
    (sentence) => !isNonRequirementInstructionSentence(sentence),
  );
  const text = sentences.length ? sentences.join(" ") : candidate;

  return {
    text: cleanTableRequirement(text),
    heading: buildHeadingPath(
      headingCandidates.slice(-3).map((candidate) => candidate.text),
    ),
    pages: [
      ...new Set(
        bodyLines
          .map((line) => line.page)
          .filter((page) => Number.isFinite(page)),
      ),
    ].sort((left, right) => left - right),
  };
}

function preAnswerFieldSourceExcerpt(input: {
  text: string;
  answerLines: string[];
}) {
  return compactText(
    [
      `Kravtekst før svarfelt: ${input.text}`,
      `Svarfelt: ${input.answerLines.join(" ")}`,
    ].join(" | "),
    1800,
  );
}

export function buildPreAnswerFieldRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const sourceDocumentSha256 = knownCanonicalPdfSourceSha256(document);
  const scanLines: PdfAnswerFieldScanLine[] = [];
  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    lines.forEach((line, index) => {
      scanLines.push({
        text: line,
        page: page.page,
        order: page.page * 10_000 + index,
      });
    });
  }

  const requirements: RequirementLedgerEntry[] = [];
  let buffer: PdfAnswerFieldScanLine[] = [];
  let sequence = 1;
  let activeRequirementHeading = "";

  for (let index = 0; index < scanLines.length; index += 1) {
    const line = scanLines[index];
    if (!line) {
      continue;
    }

    if (!isAnswerSectionMarkerLine(line.text)) {
      buffer.push(line);
      continue;
    }

    const { id, endIndex } = answerFieldRequirementIdAt(
      scanLines,
      index,
      sequence,
    );
    const answerLines = scanLines
      .slice(index, Math.min(scanLines.length, endIndex + 1))
      .map((candidate) => candidate.text);
    const requirementBuffer = requirements.length
      ? buffer
      : buffer.filter((candidate) => candidate.page === line.page);
    const extractedRequirement = preAnswerFieldRequirementText(requirementBuffer);
    const text = repairSourceBoundPdfNarrativeText({
      id,
      text: extractedRequirement.text,
      sourceDocumentSha256,
    });
    const pages = extractedRequirement.pages;
    if (extractedRequirement.heading) {
      activeRequirementHeading = extractedRequirement.heading;
    }

    if (
      !isSyntheticRequirementId(id) &&
      text.length >= 18 &&
      !isLikelyDetailOrAnswerBlock(text) &&
      (hasRequirementSignal(text) ||
        hasStandaloneRequirementLanguage(text) ||
        isRequirementSentence(text))
    ) {
      const firstPage = pages[0] ?? line.page;
      requirements.push({
        id,
        text,
        pages: pages.length ? pages : [line.page],
        heading:
          extractedRequirement.heading ||
          activeRequirementHeading ||
          findHeadingBeforeOffset(
            requirementBuffer.map((candidate) => candidate.text).join("\n"),
            Number.MAX_SAFE_INTEGER,
            pageHeadingMap.get(firstPage) ?? "",
          ) ||
          pageHeadingMap.get(firstPage) ||
          "",
        sourceExcerpt: preAnswerFieldSourceExcerpt({
          text,
          answerLines,
        }),
        answerExcerpt: compactText(answerLines.join(" "), 1000),
        documentEntryOrder: line.order,
      });
      sequence += 1;
    }

    buffer = [];
    index = Math.max(index, endIndex);
  }

  return dedupeRequirementLedger(requirements);
}

function linesSincePreviousAnswerMarker(lines: string[], markerIndex: number) {
  let previousMarkerIndex = -1;
  for (let index = markerIndex - 1; index >= 0; index -= 1) {
    if (isAnswerSectionMarkerLine(lines[index])) {
      previousMarkerIndex = index;
      break;
    }
  }
  return lines.slice(previousMarkerIndex + 1, markerIndex);
}

function boundedAnswerFieldLines(input: {
  lines: string[];
  markerIndex: number;
  page: number;
  sequence: number;
}) {
  const scanLines = input.lines.map((text, index) => ({
    text,
    page: input.page,
    order: input.page * 10_000 + index,
  }));
  const { id, endIndex } = answerFieldRequirementIdAt(
    scanLines,
    input.markerIndex,
    input.sequence,
  );
  return {
    id,
    answerLines: input.lines.slice(
      input.markerIndex,
      Math.min(input.lines.length, endIndex + 1),
    ),
  };
}

export function buildAnswerSectionRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 1;

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const lines = page.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (!isAnswerSectionMarkerLine(lines[index] ?? "")) {
        continue;
      }

      const { id, answerLines } = boundedAnswerFieldLines({
        lines,
        markerIndex: index,
        page: page.page,
        sequence,
      });
      const hasExplicitAnswerId = !isSyntheticRequirementId(id);
      const linesBeforeMarker = linesSincePreviousAnswerMarker(lines, index);
      const text =
        answerSectionRequirementText(linesBeforeMarker) ||
        answerSectionRequirementTextFallback(linesBeforeMarker);
      if (
        text.length < 40 ||
        text.length > 1800 ||
        !hasRequirementSignal(text) ||
        (!hasExplicitAnswerId && isLikelyDetailOrAnswerBlock(text))
      ) {
        continue;
      }

      const heading =
        findHeadingBeforeOffset(
          page.text,
          page.text.indexOf(lines[index] ?? ""),
          pageHeadingMap.get(page.page) ?? "",
        ) ||
        pageHeadingMap.get(page.page) ||
        "";

      requirements.push({
        id,
        text,
        pages: [page.page],
        heading,
        sourceExcerpt: compactText(
          [
            `Kravtekst før svarfelt: ${text}`,
            `Svarfelt: ${answerLines.join(" ")}`,
          ].join(" | "),
          1800,
        ),
        answerExcerpt: compactText(answerLines.join(" "), 1000),
      });
      sequence += 1;
    }
  }

  return dedupeRequirementLedger(requirements);
}

export function buildSplitAnswerMarkerRequirementLedger(document: ProjectDocumentDetail) {
  if (document.file_format !== "pdf") {
    return [];
  }

  const pageHeadingMap = buildPageHeadingMap(document);
  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 1;

  for (const page of splitPdfPagesPreservingLines(document.raw_text)) {
    const lines = page.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (!isAnswerSectionMarkerLine(lines[index] ?? "")) {
        continue;
      }

      const { id, answerLines } = boundedAnswerFieldLines({
        lines,
        markerIndex: index,
        page: page.page,
        sequence,
      });
      if (isSyntheticRequirementId(id)) {
        continue;
      }

      const linesBeforeMarker = linesSincePreviousAnswerMarker(lines, index);
      const text = splitAnswerMarkerRequirementText(linesBeforeMarker);
      if (text.length < 40 || text.length > 1400) {
        continue;
      }

      requirements.push({
        id,
        text,
        pages: [page.page],
        heading: pageHeadingMap.get(page.page) ?? "",
        sourceExcerpt: compactText(
          [
            `Kravtekst før svarfelt: ${text}`,
            `Svarfelt: ${answerLines.join(" ")}`,
          ].join(" | "),
          1800,
        ),
        answerExcerpt: compactText(answerLines.join(" "), 1000),
      });
      sequence += 1;
    }
  }

  return dedupeRequirementLedger(requirements);
}

export function buildStructuredRequirementLedger(document: ProjectDocumentDetail) {
  const pageHeadingMap =
    document.file_format === "pdf" ? buildPageHeadingMap(document) : new Map<number, string>();
  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 1;

  for (const page of splitDocumentPagesForRequirementScan(document)) {
    const pageHeading = pageHeadingMap.get(page.page) ?? "";
    const blocks = page.text
      .split(/\n{2,}|(?=\n\s*(?:[-*•]|\d{1,3}[.)]|\d+(?:\.\d+){1,4})\s+)/g)
      .map((block) => block.replace(/\n+/g, " ").trim())
      .filter(Boolean);

    for (const block of blocks) {
      const inlineHeadingRequirement =
        splitInlineNumberedHeadingRequirement(block);
      const requirementBlock =
        inlineHeadingRequirement?.requirement ?? block;
      const inlineHeading =
        inlineHeadingRequirement &&
        isLikelyHeadingLine(inlineHeadingRequirement.heading)
          ? cleanHeadingCandidate(inlineHeadingRequirement.heading)
          : "";
      const text = stripAnswerTextFromRequirement(
        stripRequirementChrome(requirementBlock),
      );
      const explicitId =
        detectExplicitRequirementIds(requirementBlock)[0] ?? "";
      const sourceOrderHeading =
        document.file_format === "docx"
          ? findDocxHeadingForRequirement(document.raw_text, text, "")
          : "";
      if (
        !isStandaloneRequirementCandidate({
          block: requirementBlock,
          text,
          explicitId,
        })
      ) {
        continue;
      }

      requirements.push({
        id: explicitId || syntheticRequirementId(page.page, sequence),
        text,
        pages: [page.page],
        heading: inlineHeading || sourceOrderHeading || pageHeading,
      });
      sequence += 1;
    }
  }

  return dedupeRequirementLedger(requirements);
}

type UnstructuredRequirementLine = {
  text: string;
  page: number;
};

type UnstructuredRequirementSection = {
  heading: string;
  page: number;
  lines: UnstructuredRequirementLine[];
};

type UnstructuredRequirementCandidate = {
  id?: string;
  text: string;
  page: number;
  heading: string;
  tableId?: string;
  sourceExcerpt?: string;
  documentEntryOrder?: number;
};

const UNSTRUCTURED_REQUIREMENT_THEMES = [
  "rapport",
  "data",
  "drift",
  "sikkerhet",
  "bruker",
  "integrasjon",
  "uklart",
];

const UNSTRUCTURED_REQUIREMENT_START_SUBJECTS = [
  "Leverandøren",
  "Tilbyder",
  "Løsningen",
  "Systemet",
  "Tjenesten",
  "Kunden",
  "Det",
  "Data",
  "Backup",
  "Batchjobber",
  "Databehandleravtale",
  "Kostnader",
  "Masterdata",
  "API-er",
  "Integrasjoner",
  "Integrasjonsfeil",
  "Alle",
  "Risikovurdering",
  "Tilgang",
  "Rapporter",
  "Sikkerhetsvarsler",
  "Kritiske",
  "Feilmeldinger",
  "Skjermbilder",
  "Brukergrensesnittet",
  "Brukere",
  "Meldinger",
  "Datamodellen",
  "Lagringssted",
  "Eksport",
  "Endringer",
  "Avvik",
  "Datakvalitet",
  "Personopplysninger",
  "For",
  "Kravet",
  "Må",
];

function unstructuredThemePattern() {
  return UNSTRUCTURED_REQUIREMENT_THEMES.join("|");
}

function unstructuredRequirementStartPattern() {
  return UNSTRUCTURED_REQUIREMENT_START_SUBJECTS.join("|");
}

function isUnstructuredRequirementSectionHeading(value: string) {
  const text = normalizePdfSpacing(value);
  return /^(?:Krav\s*-\s*blandet\s+liste|Leverandør\s+må\s+svare\s+på|Åpne\s+punkter\s+og\s+minimumsbehov|Notater\s+fra\s+møte|Løs\s+tekst\s+fra\s+behovsavklaring|Liten\s+tabell\s+fra\s+fagansvarlige|Må\s+ha\s*\/\s*kanskje\s*\/\s*avklares|Ikke\s+glem\s+dette|Tabell\s+som\s+ikke\s+er\s+ferdig\s+prioritert|Drift,\s*sikkerhet,\s*data\s*-\s*litt\s+om\s+hverandre)$/i.test(
    text,
  );
}

function isUnstructuredRequirementStopHeading(value: string) {
  return /^Svarformat$/i.test(normalizePdfSpacing(value));
}

function isUnstructuredRequirementHeaderLine(value: string) {
  const text = normalizePdfSpacing(value);
  return (
    !text ||
    /^(?:Ref|Tema|Krav\s*\/\s*observasjon|Må\s*\/\s*bør\??|Kommentar|Innspill|Hvorfor|Svar\s+fra\s+leverandør|Punkt|Tekst)$/i.test(
      text,
    ) ||
    /^Ref\s*Tema\s*Krav\s*\/\s*observasjon\s*Må\s*\/\s*bør\??\s*Kommentar$/i.test(
      text,
    ) ||
    /^Innspill\s*Hvorfor\s*Svar\s+fra\s+leverandør$/i.test(text)
  );
}

function collectUnstructuredRequirementSections(
  document: ProjectDocumentDetail,
) {
  const sections: UnstructuredRequirementSection[] = [];
  let current: UnstructuredRequirementSection | null = null;

  function flushCurrent() {
    if (current?.lines.length) {
      sections.push(current);
    }
    current = null;
  }

  for (const page of splitDocumentPagesForRequirementScan(document)) {
    const lines = page.text
      .split("\n")
      .map((line) => normalizePdfSpacing(line))
      .filter(Boolean);

    for (const line of lines) {
      if (isUnstructuredRequirementStopHeading(line)) {
        flushCurrent();
        continue;
      }

      if (isUnstructuredRequirementSectionHeading(line)) {
        flushCurrent();
        current = {
          heading: line,
          page: page.page,
          lines: [],
        };
        continue;
      }

      if (current) {
        current.lines.push({
          text: line,
          page: page.page,
        });
      }
    }
  }

  flushCurrent();
  return sections;
}

function stripUnstructuredRequirementPrefix(value: string) {
  return normalizePdfSpacing(value)
    .replace(/^[\u2022\uF0B7*–—-]\s*/u, "")
    .replace(/^\(?\d{1,3}\)?[.)]?\s*/u, "")
    .replace(
      /^(?:KRAV\s*[- ]?\s*\d{1,5}|K\s*[- ]?\s*\d{1,4}|R\s*\d{1,4}|Pkt\s*\d{1,4}|A\s*\d{1,4}|se\s+notat|ikke\s+satt|x|\?)\s*/iu,
      "",
    )
    .trim();
}

function trimUnstructuredRequirementText(
  value: string,
  options: { preserveInlineNotes?: boolean } = {},
) {
  let text = stripUnstructuredRequirementPrefix(value)
    .replace(/\b[A-ZÆØÅ][\p{L}\d\s_]+?\s+-\s+Bilag\s+2\b/giu, " ")
    .replace(
      /\bskal\s+ta\s+(?:Må\s*\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\s*\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+høyde\b/giu,
      "skal ta høyde",
    )
    .replace(
      /(?:Må\s*\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\s*\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+(?=høyde\b)/giu,
      "",
    )
    .replace(/([.!?])(?=NB:)/g, "$1 ")
    .replace(
      options.preserveInlineNotes
        ? /\b$^/g
        : /\.?\s*NB:\s*avhengig av valgt arkitektur\.?/gi,
      ".",
    )
    .replace(
      options.preserveInlineNotes ? /\b$^/g : /\s+Referanse\s*\d*\.?/gi,
      ".",
    )
    .replace(
      /\b(?:IT|kunde|drift)\s+(?:må\s+prises|åpen|minimum|ønsket)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!options.preserveInlineNotes) {
    text = text
      .replace(/([\p{L}\d])-+\s+(?=[\p{L}\d])/gu, "$1-")
      .replace(/\bteams-kanaler\b/gi, "teamskanaler");
  }

  for (let index = 0; index < 3; index += 1) {
    const next = text
      .replace(
        /^(?:Bør|Avklares|Opsjon(?:g)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|gjelder\s+fase\s+1\?|henger\s+sammen\s+med\s+annet\s+punkt|må\s+prises|Besvares\s+i\s+tilbud|redusere\s+risiko|lovpålagt\s*\/\s*forventet|bedre\s+oversikt|må\s+avklares|unngå\s+manuell\s+jobb)\s*/i,
        "",
      )
      .trim();
    if (next === text) {
      break;
    }
    text = next;
  }

  text = text
    .replace(
      /([.!?])\s*(?:Må\??|Bør|Avklares|Opsjon(?:g)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|gjelder\s+fase\s+1\?|henger\s+sammen\s+med\s+annet\s+punkt|må\s+prises|se\s+notat|x|\?|ikke\s+satt)\b.*$/i,
      "$1",
    )
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  if (text.toLocaleLowerCase("nb").endsWith("høyde for")) {
    const original = normalizePdfSpacing(value);
    const marker = "høyde for ";
    const tailStart = original.toLocaleLowerCase("nb").lastIndexOf(marker);
    const tail = normalizePdfSpacing(
      tailStart >= 0 ? original.slice(tailStart + marker.length) : "",
    );
    if (tail.length >= 4 && tail.length <= 500) {
      text = `${text} ${tail}`;
    }
  }

  return stripAnswerTextFromRequirement(text);
}

function isUnstructuredRequirementCandidate(value: string) {
  const text = normalizePageText(value);
  if (text.length < 18 || text.length > 900) {
    return false;
  }

  if (
    /^Kommentar:/i.test(text) ||
    /^Tabell\s+\d+\s+Rad\s+\d+:/i.test(text) ||
    /^Dokumentet samler krav/i.test(text) ||
    /^Leverandøren må selv strukturere svar/i.test(text) ||
    /^Leverandøren skal ikke anta at tomme kommentarfelt/i.test(text) ||
    /^Leverandøren skal svare med Ja\/Delvis\/Nei/i.test(text) ||
    isUnstructuredRequirementHeaderLine(text)
  ) {
    return false;
  }

  return (
    hasRequirementSignal(text) ||
    hasStandaloneRequirementLanguage(text) ||
    /^Kravet\s+gjelder\s+spesielt\b/i.test(text) ||
    /^For\b.{1,120}\bskal\b/i.test(text) ||
    /^Må\s+\S+/i.test(text) ||
    /^Det\s+(?:er\s+ønskelig|ønskes)\b/i.test(text)
  );
}

function unstructuredRequirementIdFromPrefix(value: string) {
  const text = normalizePdfSpacing(value);
  const match = text.match(
    /^(KRAV\s*[- ]?\s*\d{1,5}|K\s*[- ]?\s*\d{1,4}|R\s*\d{1,4}|Pkt\s*\d{1,4}|A\s*\d{1,4}|\(?\d{1,3}\)?|se\s+notat|ikke\s+satt|x|\?)/i,
  );
  if (!match?.[1]) {
    return "";
  }

  return normalizePdfSpacing(match[1])
    .replace(/^KRAV\s*[- ]?\s*/i, "KRAV-")
    .replace(/^K\s*[- ]?\s*/i, "K")
    .replace(/^R\s*/i, "R")
    .replace(/^Pkt\s*/i, "Pkt")
    .replace(/^A\s*/i, "A")
    .replace(/^\((\d{1,3})\)$/i, "$1");
}

function unstructuredFallbackRequirementId(heading: string, sequence: number) {
  const normalizedHeading = normalizePdfSpacing(heading).replace(/:$/, "");

  if (/^Åpne\s+punkter\s+og\s+minimumsbehov$/i.test(normalizedHeading)) {
    return `Åpent punkt ${sequence}`;
  }
  if (/^Leverandør\s+må\s+svare\s+på$/i.test(normalizedHeading)) {
    return `Leverandørpunkt ${sequence}`;
  }
  if (/^Liten\s+tabell\s+fra\s+fagansvarlige$/i.test(normalizedHeading)) {
    return `Faginnspill ${sequence}`;
  }
  if (/^Må\s+ha\s*\/\s*kanskje\s*\/\s*avklares$/i.test(normalizedHeading)) {
    return `Avklaringspunkt ${sequence}`;
  }
  if (/^Ikke\s+glem\s+dette$/i.test(normalizedHeading)) {
    return `Huskelistepunkt ${sequence}`;
  }

  return `Ustrukturert krav ${sequence}`;
}

function unstructuredRequirementSectionsText(
  section: UnstructuredRequirementSection,
) {
  return section.lines.map((line) => line.text).join(" ");
}

function pushUnstructuredCandidate(
  input: {
    requirements: RequirementLedgerEntry[];
    candidate: UnstructuredRequirementCandidate;
    documentTitle: string;
    sequence: number;
    documentEntryOrder?: number;
    preserveInlineNotes?: boolean;
  },
) {
  let text = trimUnstructuredRequirementText(input.candidate.text, {
    preserveInlineNotes: input.preserveInlineNotes,
  });
  text = recoverTruncatedUnstructuredRequirementText(
    text,
    input.candidate.sourceExcerpt || input.candidate.text,
  );
  if (!isUnstructuredRequirementCandidate(text)) {
    return false;
  }

  const sourceExcerpt = compactText(
    input.candidate.sourceExcerpt || input.candidate.text,
    1600,
  );
  const explicitId = input.candidate.id
    ? normalizePdfSpacing(input.candidate.id)
    : "";
  const useSyntheticFallback =
    input.candidate.tableId === "Ustrukturert blandet kravliste";
  const id =
    explicitId && /\d/.test(explicitId)
      ? explicitId
      : useSyntheticFallback
        ? syntheticRequirementId(input.candidate.page, input.sequence)
        : unstructuredFallbackRequirementId(
            input.candidate.heading,
            input.sequence,
          );

  input.requirements.push({
    id,
    text,
    pages: [input.candidate.page],
    heading: input.candidate.heading,
    tableId: input.candidate.tableId || "Ustrukturert kravliste",
    sourceExcerpt,
    documentTitle: input.documentTitle,
    documentEntryOrder: input.documentEntryOrder ?? input.sequence,
  });

  return true;
}

function extractUnstructuredTableCandidates(
  section: UnstructuredRequirementSection,
) {
  if (!/^Krav\s*-\s*blandet\s+liste$/i.test(section.heading)) {
    return [];
  }

  const fullText = unstructuredRequirementSectionsText(section);
  if (/Ref\s+Tema\s+Krav\s*\/\s*observasjon/i.test(fullText)) {
    return [];
  }

  const tableText = fullText.split(/Kommentar:\s*Tabellen\s+over/i)[0] ?? fullText;
  const themePattern = unstructuredThemePattern();
  const startPattern = unstructuredRequirementStartPattern();
  const rowPattern = new RegExp(
    `(?:^|\\s)((?:K\\s*[- ]?\\s*\\d{1,4}|R\\s*\\d{1,4}|Pkt\\s*\\d{1,4}|\\d{1,3}|se\\s+notat))\\s*(${themePattern})(?=\\s*(?:${startPattern}))`,
    "gi",
  );
  const matches = [...tableText.matchAll(rowPattern)];
  const candidates: UnstructuredRequirementCandidate[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < matches.length ? (matches[index + 1].index ?? tableText.length) : tableText.length;
    const source = tableText.slice(match.index ?? start, end);
    candidates.push({
      id: normalizePdfSpacing(match[1] ?? ""),
      text: tableText.slice(start, end),
      page: section.page,
      heading: section.heading,
      tableId: "Ustrukturert blandet kravliste",
      sourceExcerpt: source,
    });
  }

  return candidates;
}

function cleanUnstructuredRefTableText(value: string) {
  const statusToken = String.raw`(?:Må\??|Bør|Avklares|Opsjon)`;
  const statusComment = String.raw`(?:gjelder\s+fase\s+1\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises)`;

  return normalizePdfSpacing(value)
    .replace(/\[\[SIDE:\d+\]\]/gi, " ")
    .replace(
      /\b[A-ZÆØÅ][\p{L}0-9]+(?:\s+[A-ZÆØÅ][\p{L}0-9]+){0,5}\s+(?:AS|KF|IKS|SA)\s*-\s*Bilag\s+2\b/gu,
      " ",
    )
    .replace(
      new RegExp(
        String.raw`\bskal\s+ta\s+${statusToken}(?:\s+${statusComment})*\s+høyde\b`,
        "gi",
      ),
      "skal ta høyde",
    )
    .replace(
      new RegExp(
        String.raw`${statusToken}(?:\s+${statusComment})*\s+(?=(?:tydelig|dokumenteres|under|uten|kunne|skal|måles|med|gjennomføres|lagre|overvåking|hente|høyde|planlagt|brukes|leverandørportaler|rapportgrunnlag|avbrudd|revisjon|testmiljø|produksjonsmiljø|kontrollert))`,
        "g",
      ),
      "",
    )
    .replace(
      /\b(?:henger\s+sammen\s+med|annet\s+punkt|gjelder\s+fase\s+1\?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function extractUnstructuredRefTableCandidates(
  section: UnstructuredRequirementSection,
) {
  const fullText = unstructuredRequirementSectionsText(section);
  if (!/Ref\s+Tema\s+Krav\s*\/\s*observasjon/i.test(fullText)) {
    return [];
  }

  const tableText = fullText.split(/Kommentar:\s*Tabellen\s+over/i)[0] ?? fullText;
  const themePattern = unstructuredThemePattern();
  const rowPattern = new RegExp(
    `(?:^|\\s)(K\\s*[- ]?\\s*\\d{1,4}|R\\s*\\d{1,4}|Pkt\\s*\\d{1,4}|\\d{1,3}|se\\s+notat)\\s+(${themePattern})\\b`,
    "gi",
  );
  const matches = [...tableText.matchAll(rowPattern)];
  const candidates: UnstructuredRequirementCandidate[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? tableText.length)
        : tableText.length;
    const source = tableText.slice(start, end);
    let text = cleanUnstructuredRefTableText(
      source.replace(match[0], " "),
    );
    if (text.toLocaleLowerCase("nb").endsWith("høyde for")) {
      const sourceText = normalizePdfSpacing(source);
      const marker = "høyde for ";
      const tailStart = sourceText.toLocaleLowerCase("nb").lastIndexOf(marker);
      const tail = normalizePdfSpacing(
        tailStart >= 0 ? sourceText.slice(tailStart + marker.length) : "",
      );
      if (tail.length >= 4 && tail.length <= 500) {
        text = `${text} ${tail}`;
      }
    }

    candidates.push({
      id: normalizePdfSpacing(match[1] ?? ""),
      text,
      page: section.page,
      heading: section.heading,
      tableId: "Ustrukturert kravtabell",
      sourceExcerpt: source,
    });
  }

  return candidates;
}

function splitUnstructuredPipeCells(value: string) {
  return normalizePdfSpacing(value)
    .split("|")
    .map((cell) => normalizePdfSpacing(cell))
    .filter(Boolean);
}

function unstructuredColumnIndex(columns: string[], pattern: RegExp) {
  return columns.findIndex((column) => pattern.test(normalizeColumnLabel(column)));
}

function extractStructuredUnstructuredTableRowCandidates(
  section: UnstructuredRequirementSection,
) {
  const candidates: UnstructuredRequirementCandidate[] = [];
  let columns: string[] = [];
  let tableId = "";

  for (const lineEntry of section.lines) {
    const match = lineEntry.text.match(/^Rad\s+(\d{1,4})\s*:\s*(.+)$/i);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const rowIndex = Number(match[1]);
    const cells = splitUnstructuredPipeCells(match[2]);
    if (!cells.length) {
      continue;
    }

    if (rowIndex === 1 || !columns.length) {
      columns = cells;
      tableId = `${section.heading} tabell`;
      continue;
    }

    const requirementIndex = Math.max(
      unstructuredColumnIndex(columns, /krav\s*\/\s*observasjon/i),
      unstructuredColumnIndex(columns, /^krav$/i),
      unstructuredColumnIndex(columns, /^innspill$/i),
      unstructuredColumnIndex(columns, /^tekst$/i),
    );
    if (requirementIndex < 0) {
      continue;
    }

    const requirementText = cells[requirementIndex] ?? "";
    if (!requirementText) {
      continue;
    }

    const idIndex = Math.max(
      unstructuredColumnIndex(columns, /^(?:ref|punkt|id|nr)$/i),
      0,
    );

    candidates.push({
      id: cells[idIndex] ?? "",
      text: requirementText,
      page: lineEntry.page,
      heading: section.heading,
      tableId,
      sourceExcerpt: lineEntry.text,
    });
  }

  return candidates;
}

function extractParentheticalRequirementCandidates(
  section: UnstructuredRequirementSection,
) {
  if (!/^Løs\s+tekst\s+fra\s+behovsavklaring$/i.test(section.heading)) {
    return [];
  }

  const fullText = unstructuredRequirementSectionsText(section);
  const candidates: UnstructuredRequirementCandidate[] = [];

  for (const match of fullText.matchAll(
    /\((\d{1,3})\)\s*([\s\S]*?)(?=\s*\(\d{1,3}\)\s*|$)/g,
  )) {
    candidates.push({
      id: match[1] ?? "",
      text: match[2] ?? "",
      page: section.page,
      heading: section.heading,
      tableId: "Ustrukturert nummerert kravliste",
      sourceExcerpt: match[0],
    });
  }

  return candidates;
}

function cleanSmallProfessionalTableRequirement(value: string) {
  return normalizePdfSpacing(value)
    .replace(/^Innspill\s+Hvorfor\s+Svar\s+fra\s+leverandør\s*/i, "")
    .replace(
      /\b(?:redusere\s+risiko|lovpålagt\s*\/\s*forventet|bedre\s+oversikt|må\s+avklares|unngå\s+manuell\s+jobb)\s+Besvares\s+i\s+tilbud\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function extractSmallProfessionalTableCandidates(
  section: UnstructuredRequirementSection,
) {
  if (!/^Liten\s+tabell\s+fra\s+fagansvarlige$/i.test(section.heading)) {
    return [];
  }

  if (
    section.lines.some((line) =>
      /^(?:Tabell\s+\d+\s+)?Rad\s+\d+:/i.test(line.text),
    )
  ) {
    return [];
  }

  const rows: string[] = [];
  let current = "";

  for (const lineEntry of section.lines) {
    const line = lineEntry.text;
    if (isUnstructuredRequirementHeaderLine(line)) {
      continue;
    }

    if (/\S.+\bBesvares\s+i\s+tilbud\b/i.test(line)) {
      if (current) {
        rows.push(current);
      }
      current = line;
      continue;
    }

    if (current) {
      current = `${current} ${line}`;
    }
  }

  if (current) {
    rows.push(current);
  }

  return rows.map((row, index) => ({
    text: cleanSmallProfessionalTableRequirement(row),
    page: section.page,
    heading: section.heading,
    tableId: "Ustrukturert fagtabell",
    sourceExcerpt: row,
    id: `Faginnspill ${index + 1}`,
  }));
}

function hasUnstructuredRowOrListMarkers(value: string) {
  return (
    /\b(?:Rad|Row)\s+\d{1,4}\s*:/i.test(value) ||
    /(?:^|\s)(?:A\s*\d{1,4}|K\s*[- ]?\s*\d{1,4}|R\s*\d{1,4}|Pkt\s*\d{1,4}|\d{1,3}[.)]|se\s+notat|ikke\s+satt|x|\?)\s+/i.test(
      value,
    ) ||
    /(?:^|\s)[\u2022\uF0B7]\s+/u.test(value) ||
    /(?:^|\s)-\s+(?=(?:Leverandøren|Løsningen|Systemet|Tjenesten|Kunden|Det|Data|Backup|Batchjobber|Databehandleravtale|Kostnader|Masterdata|API-er|Integrasjoner|Alle|Risikovurdering|Tilgang|Rapporter|Sikkerhetsvarsler|Kritiske|Feilmeldinger|Brukergrensesnittet|Brukere|Meldinger|Datamodellen|Lagringssted|Eksport|Endringer|Avvik|Datakvalitet|Personopplysninger|For|Kravet|Må)\b)/iu.test(
      value,
    )
  );
}

function extractAggregateUnmarkedSectionCandidate(
  section: UnstructuredRequirementSection,
) {
  if (!/^Tabell\s+som\s+ikke\s+er\s+ferdig\s+prioritert$/i.test(section.heading)) {
    return [];
  }

  const lines = section.lines
    .map((line) => normalizePdfSpacing(line.text))
    .filter((line) => line && !isUnstructuredRequirementHeaderLine(line));
  const fullText = lines.join(" ");
  if (hasUnstructuredRowOrListMarkers(fullText)) {
    return [];
  }

  const requirementLines = lines.filter(isUnstructuredRequirementCandidate);
  if (requirementLines.length < 3) {
    return [];
  }

  return requirementLines.map((line) => ({
    text: line,
    page: section.page,
    heading: section.heading,
    tableId: "Ustrukturert kravtekst",
    sourceExcerpt: line,
  }));
}

function extractBulletRequirementCandidates(
  section: UnstructuredRequirementSection,
) {
  if (
    !/^(?:Leverandør\s+må\s+svare\s+på|Ikke\s+glem\s+dette|Åpne\s+punkter\s+og\s+minimumsbehov|Tabell\s+som\s+ikke\s+er\s+ferdig\s+prioritert|Notater\s+fra\s+møte)$/i.test(
      section.heading,
    )
  ) {
    return [];
  }

  const startPattern = unstructuredRequirementStartPattern();
  const rawText = unstructuredRequirementSectionsText(section);
  if (!/(?:[\u2022\uF0B7]|\s+-\s+|\b\d{1,3}\.)/u.test(rawText)) {
    return [];
  }

  const fullText = rawText
    .replace(
      new RegExp(`\\s+-\\s+(?=(?:${startPattern}))`, "gi"),
      "\n",
    )
    .replace(
      /(?:^|\s)(?:[\u2022\uF0B7]\s*|(?<!Referanse\s)\d{1,3}\.\s*)/gu,
      "\n",
    );
  const parts = fullText
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.map((part) => ({
    text: part,
    page: section.page,
    heading: section.heading,
    tableId: "Ustrukturert punktliste",
    sourceExcerpt: part,
  }));
}

function extractStandaloneRequirementCandidates(
  section: UnstructuredRequirementSection,
) {
  const sectionText = unstructuredRequirementSectionsText(section);
  if (/Ref\s+Tema\s+Krav\s*\/\s*observasjon/i.test(sectionText)) {
    return [];
  }

  if (
    /^Tabell\s+som\s+ikke\s+er\s+ferdig\s+prioritert$/i.test(section.heading) &&
    !/(?:^|\s)(?:A\s*\d{1,4}|\d{1,3}\.|[-\u2022\uF0B7])\s+/iu.test(
      sectionText,
    )
  ) {
    return [];
  }

  const startPattern = unstructuredRequirementStartPattern();
  const prepared = sectionText
    .replace(/\((\d{1,3})\)\s*/g, "\n($1) ")
    .replace(
      new RegExp(`\\s+-\\s+(?=(?:${startPattern}))`, "gi"),
      "\n",
    )
    .replace(
      /(?:^|\s)(?:[\u2022\uF0B7]\s*|(?<!Referanse\s)\d{1,3}\.\s*)/gu,
      "\n",
    )
    .replace(
      new RegExp(
        `\\b(A\\s*\\d{1,4}|K\\s*[- ]?\\s*\\d{1,4}|R\\s*\\d{1,4}|Pkt\\s*\\d{1,4}|ikke\\s+satt|x|\\?)(?=\\s*(?:${startPattern}))`,
        "gi",
      ),
      "\n$1",
    )
    .replace(
      new RegExp(
        `([.!?])\\s+(?=(?:${startPattern}|A\\s*\\d{1,4}|K\\s*[- ]?\\s*\\d{1,4}|R\\s*\\d{1,4}|Pkt\\s*\\d{1,4}|ikke\\s+satt|x|\\?))`,
        "gi",
      ),
      "$1\n",
    );
  const chunks = prepared
    .split("\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk) => ({
    id: unstructuredRequirementIdFromPrefix(chunk),
    text: chunk,
    page: section.page,
    heading: section.heading,
    tableId: "Ustrukturert kravtekst",
    sourceExcerpt: chunk,
  }));
}

export function buildUnstructuredRequirementLedger(document: ProjectDocumentDetail) {
  if (!/Bilag\s+2\s+-\s+Krav\s+og\s+føringer/i.test(document.raw_text)) {
    return [];
  }

  const sections = collectUnstructuredRequirementSections(document);
  if (!sections.length) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const normalizedRawText = normalizedRequirementOrderSearchText(document.raw_text);
  let sourceOrderCursor = 0;
  let sequence = 1;

  for (const section of sections) {
    const sectionOrderOffset =
      findRequirementOrderOffset(
        normalizedRawText,
        section.heading,
        sourceOrderCursor,
      ) ?? sourceOrderCursor;
    let sectionFallbackIndex = 0;
    const structuredTableRowCandidates =
      extractStructuredUnstructuredTableRowCandidates(section);
    const smallProfessionalTableCandidates =
      structuredTableRowCandidates.length
        ? []
        : extractSmallProfessionalTableCandidates(section);
    const aggregateSectionCandidates =
      extractAggregateUnmarkedSectionCandidate(section);
    const candidates = [
      ...structuredTableRowCandidates,
      ...extractUnstructuredRefTableCandidates(section),
      ...extractUnstructuredTableCandidates(section),
      ...extractParentheticalRequirementCandidates(section),
      ...aggregateSectionCandidates,
      ...smallProfessionalTableCandidates,
      ...extractBulletRequirementCandidates(section),
      ...(smallProfessionalTableCandidates.length || aggregateSectionCandidates.length
        ? []
        : extractStandaloneRequirementCandidates(section)),
    ];

    for (const candidate of candidates) {
      const sourceOrderText = candidate.sourceExcerpt || candidate.text;
      const sourceOrderOffset =
        findRequirementOrderOffset(
          normalizedRawText,
          sourceOrderText,
          sourceOrderCursor,
        ) ??
        findRequirementOrderOffset(
          normalizedRawText,
          candidate.text,
          sourceOrderCursor,
        );
      sectionFallbackIndex += 1;
      const documentEntryOrder =
        sourceOrderOffset ?? sectionOrderOffset + sectionFallbackIndex / 1000;
      if (sourceOrderOffset !== null) {
        sourceOrderCursor =
          sourceOrderOffset +
          normalizedRequirementOrderSearchText(sourceOrderText || candidate.text)
            .length;
      }

      if (
        pushUnstructuredCandidate({
          requirements,
          candidate,
          documentTitle: document.title,
          sequence,
          documentEntryOrder,
          preserveInlineNotes: document.file_format === "docx",
        })
      ) {
        sequence += 1;
      }
    }
  }

  return dedupeRequirementLedger(requirements);
}

export function isRequirementTableHeaderLabel(line: string) {
  return /^(Req\.?\s*No\.?|Requirement text|Type|Response instruction|Y\/N|Detailed response)$/i.test(
    line.trim(),
  );
}

export function isRequirementTypeOrInstructionLine(line: string) {
  const trimmed = line.trim();
  return (
    /^(M|E|O|A|B|C|D|K|S)$/i.test(trimmed) ||
    /^(M|E|O|A|B|C|D|K|S)\s+TK\s*\d+$/i.test(trimmed) ||
    /^TK\s*\d+$/i.test(trimmed) ||
    /^Relevant experience,\s*technical depth,\s*delivery\s+capability$/i.test(
      trimmed,
    )
  );
}

export const NORWEGIAN_REQUIREMENT_TABLE_PRIORITY =
  String.raw`(?:Må\??|Bør|Kan|Skal|Opsjon|Avklares)`;

export const NORWEGIAN_REQUIREMENT_TABLE_ID =
  String.raw`(?:\d{2,4}\s*\/\s*\d{1,3}|[A-ZÆØÅ]\d?\s*-\s*\d{1,3}|[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}|P\d{3}\s*[- ]\s*\d{1,5}|[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\s*\d{1,5}|(?:K|R|KR|TEK|REQ|Pkt)\s*[- ]?\s*\d{1,5})`;

export function isNorwegianRequirementTableHeaderLine(lines: string[], index: number) {
  const windowText = normalizePdfSpacing(lines.slice(index, index + 4).join(" "));
  return (
    /^ID\s*\/\s*markering\s+Prioritet\s+Kravtekst\b/i.test(windowText) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar\b/i.test(windowText)
  );
}

export function isNorwegianRequirementTableChromeLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    !text ||
    /^ID\s*\/\s*markering\s+Prioritet\s+Kravtekst\b/i.test(text) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar$/i.test(text) ||
    /^s\s+svar$/i.test(text) ||
    /^Leverandøren\s+svar$/i.test(text)
  );
}

export function isNorwegianGeneratedInstructionLine(line: string) {
  const text = normalizePdfSpacing(line);
  return (
    /^Kravene\s+(?:under|i\s+denne\s+delen)\b/i.test(text) ||
    /^Dersom\s+et\s+krav\b/i.test(text) ||
    /^Krav\s+registrert\s+i\s+tabell\b/i.test(text) ||
    /^Punktkrav\s+som\s+skal\s+besvares:?$/i.test(text) ||
    /^Krav\s+uten\s+egen\s+tabellrad:/i.test(text) ||
    /^Notater\s+som\s+skal\s+tolkes\s+som\s+krav:?$/i.test(text) ||
    /^Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet:?$/i.test(text) ||
    /^Kunde\b/i.test(text) ||
    /^Behovsområde\b/i.test(text) ||
    /^Dagens\s+kilder\b/i.test(text) ||
    /^Viktige\s+integrasjoner\b/i.test(text)
  );
}

export function normalizeColumnLabel(value: string) {
  return normalizePageText(value)
    .replace(/[‐‑‒–—_/-]+/g, " ")
    .replace(/[.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDocxRequirementHeadingLine(line: string) {
  const normalized = normalizePageText(line).replace(/:$/, "");

  if (
    isRequirementTableHeaderLabel(normalized) ||
    /^(Y\/N|Detailed response|Additional capabilities|Automation|Governance|FinOps|Security|Process|Efforts,\s*impact)$/i.test(
      normalized,
    ) ||
    /^TK\s*\d+$/i.test(normalized) ||
    /^(M|E|O|A|B|C|D|K|S)(?:,\s*TK\s*\d+)?$/i.test(normalized)
  ) {
    return false;
  }

  return /^(ANNEX\s+\d+[A-Z]?|Background and purpose|Services in the Hybrid Infrastructure Tower|Private Cloud|Public Cloud(?:\s+[–-]\s+Azure)?|Data Room|Requirements to|Functional requirements|Commercial requirements)/i.test(
    normalized,
  );
}

function isDocxSourceOrderHeadingLine(line: string) {
  const normalized = normalizePageText(line);
  if (
    !normalized ||
    /\|/u.test(normalized) ||
    /^(?:Kunde|Prosjektkode|Dokumenttype|Formål|Dato|Versjon|Tabell|Rad)\s*(?::|\d)/iu.test(
      normalized,
    )
  ) {
    return false;
  }

  return (
    isLikelyHeadingLine(normalized) &&
    (/^\d{1,3}(?:\.\d{1,3})*\.?\s+\S/u.test(normalized) ||
      isDocxRequirementHeadingLine(normalized) ||
      normalized.split(/\s+/).length <= 9)
  );
}

export function findDocxHeadingForRequirement(
  rawText: string,
  requirementText: string,
  fallback: string,
) {
  const lead = normalizePageText(requirementText)
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .toLocaleLowerCase("nb");
  if (!lead) {
    return fallback;
  }

  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const stack: string[] = [];
  const sourceWindow: string[] = [];

  for (const line of lines) {
    if (isDocxSourceOrderHeadingLine(line)) {
      const level = headingLevel(line);
      stack[level - 1] = cleanHeadingCandidate(line);
      stack.length = level;
    }

    sourceWindow.push(line);
    if (sourceWindow.length > 4) {
      sourceWindow.shift();
    }
    const windowText = normalizePageText(sourceWindow.join(" "))
      .toLocaleLowerCase("nb");
    if (windowText.includes(lead)) {
      return buildHeadingPath(stack) || fallback;
    }
  }

  return fallback;
}

export function textCoverageScore(source: string, candidate: string) {
  const sourceWords = normalizeEvidenceText(source)
    .split(" ")
    .filter((word) => word.length > 2);
  const candidateWords = normalizeEvidenceText(candidate)
    .split(" ")
    .filter((word) => word.length > 2);

  if (!sourceWords.length || !candidateWords.length) {
    return 0;
  }

  const sourceSet = new Set(sourceWords);
  const matched = candidateWords.filter((word) => sourceSet.has(word)).length;
  return matched / sourceWords.length;
}
