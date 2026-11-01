import { applyRequirementCorrections, correctedRequirementIds, correctionsSectionRanges, findCorrectionsSection, withoutCorrectionsSection } from "@/lib/server/requirements/corrections";
import { requirementAdditionPosition } from "@/lib/server/requirements/id-order";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";
import { spreadsheetRequirementIds } from "@/lib/server/requirements/spreadsheet-ledger";
import {
  hasReadableRequirementDocumentContent,
  hasRequirementDocumentSignal,
  isApprovedSolutionEvaluationDocument,
  isDocumentReadyForEvaluation,
  isFormalRequirementDocument,
  isRequirementDocument,
} from "@/lib/document-processing";
import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { WorkflowPreconditionError } from "@/lib/server/workflow-errors";
import { explicitIdTableSourceIds } from "@/lib/server/requirements/explicit-id-table-parser";
import { hasRequirementSignal, hasStandaloneRequirementLanguage, stripAnswerTextFromRequirement } from "@/lib/server/requirements/pdf-layout-ledger";
import { buildExplicitIdDoclingTextRequirementLedger } from "@/lib/server/requirements/explicit-id-narrative-parser";
import { stripRequirementChrome } from "@/lib/server/requirements/heading-detection";
import { escapeRegExp } from "@/lib/server/document-intelligence/text-normalization";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

export function isExplicitRequirementSupportingSubtype(
  subtype: ProjectDocumentDetail["supporting_subtype"],
) {
  return subtype === "kravdokument" || subtype === "rfp";
}

export function hasRequirementSourceDocumentSignal(
  document: Pick<
    ProjectDocumentDetail,
    "supporting_subtype" | "title" | "file_name"
  >,
) {
  return (
    isExplicitRequirementSupportingSubtype(document.supporting_subtype) ||
    hasRequirementDocumentSignal(document)
  );
}

export function canonicalRequirementSourceDocuments(input: {
  customerDocument: ProjectDocumentDetail | null;
  documents: ProjectDocumentDetail[];
  selectedFormalDocumentIds?: readonly string[];
}) {
  const selectedIds = input.selectedFormalDocumentIds
    ? new Set(input.selectedFormalDocumentIds)
    : null;
  const formalDocuments = input.documents.filter(
    (document) =>
      isFormalRequirementDocument(document) &&
      (!selectedIds || selectedIds.has(document.id)),
  );
  const ordered = [input.customerDocument, ...formalDocuments].filter(
    (document): document is ProjectDocumentDetail => Boolean(document),
  );
  const seen = new Set<string>();
  return ordered.filter((document) => {
    if (seen.has(document.id)) {
      return false;
    }
    seen.add(document.id);
    return true;
  });
}

function canonicalRequirementText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00ad/gu, "")
    .replace(/([\p{L}\p{N}])[-‐‑‒–—]\s*\n\s*([\p{Ll}])/gu, "$1$2")
    .toLocaleLowerCase("nb")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedRequirementRowIdentity(value: string | undefined) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("nb")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  return normalized.length >= 6 &&
    !/^(?:side\d+krav\d+|dokumenttekstkrav\d+|krav|requirement)$/u.test(
      normalized,
    )
    ? normalized
    : "";
}

function normalizedExplicitRequirementId(value: string) {
  const normalized = canonicalRequirementText(value).replace(/\s+/g, "");
  return /\d/u.test(normalized) &&
    !/^(?:side\d+krav\d+|dokumenttekstkrav\d+)$/u.test(normalized)
    ? normalized
    : "";
}

function requirementRowIdentityCandidates(entry: RequirementLedgerEntry) {
  const idSegments = entry.id
    .split(/\s+-\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = new Map<string, string>();
  for (const value of [entry.service, idSegments.at(-1)]) {
    const identity = normalizedRequirementRowIdentity(value);
    if (identity) {
      candidates.set(`label:${identity}`, canonicalRequirementText(value ?? ""));
    }
  }
  const explicitId = normalizedExplicitRequirementId(entry.id);
  if (explicitId) {
    candidates.set(`explicit:${explicitId}`, "");
  }
  const trailingExplicitId = normalizedExplicitRequirementId(
    idSegments.at(-1) ?? "",
  );
  if (trailingExplicitId) {
    candidates.set(`explicit:${trailingExplicitId}`, "");
  }
  return candidates;
}

type RequirementMatchDescriptor = {
  entry: RequirementLedgerEntry;
  canonical: string;
  compact: string;
  longPrefix: string;
  identityCandidates: Map<string, string>;
  serviceScope: string;
  headingScope: string;
  markers: ReturnType<typeof materialTextMarkers>;
  entities: Set<string>;
};

const LONG_REQUIREMENT_PREFIX_INDEX_CHARS = 320;
const LONG_REQUIREMENT_PREFIX_MIN_CHARS = 800;
const LONG_REQUIREMENT_PREFIX_MIN_RATIO = 0.8;

function sharedRequirementRowIdentity(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  const tokens = new Set<string>();
  let matched = false;
  for (const [identity, phrase] of left.identityCandidates) {
    if (!right.identityCandidates.has(identity)) {
      continue;
    }
    matched = true;
    for (const token of phrase.split(" ")) {
      if (token.length >= 4) {
        tokens.add(token);
      }
    }
  }
  return { matched, tokens };
}

function normalizedRequirementScope(value: string | undefined) {
  return canonicalRequirementText(value ?? "").replace(/\s+/g, "");
}

function requirementEntriesHaveConflictingScope(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  if (left.serviceScope && right.serviceScope) {
    return left.serviceScope !== right.serviceScope;
  }

  return Boolean(
    left.headingScope &&
      right.headingScope &&
      left.headingScope !== right.headingScope,
  );
}

const GENERIC_REQUIREMENT_SCOPE_TOKENS = new Set([
  "dokument",
  "dokumentet",
  "krav",
  "kravene",
  "kravet",
  "leveranse",
  "leveransen",
  "leveransekrav",
  "tjeneste",
  "tjenesten",
]);

function distinctiveRequirementScopeTokens(value: string | undefined) {
  return [
    ...new Set(
      canonicalRequirementText(value ?? "")
        .split(" ")
        .filter(
          (token) =>
            token.length >= 5 &&
            !GENERIC_REQUIREMENT_SCOPE_TOKENS.has(token),
        ),
    ),
  ];
}

function requirementScopeTokenMatchesTextToken(
  scopeToken: string,
  textToken: string,
) {
  if (scopeToken === textToken) {
    return true;
  }

  const comparableLength = Math.min(scopeToken.length, textToken.length);
  if (comparableLength < 7) {
    return false;
  }

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < comparableLength &&
    scopeToken[commonPrefixLength] === textToken[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }
  return commonPrefixLength >= 7;
}

function asymmetricServiceScopeIsGroundedInExactText(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  const scoped = left.serviceScope ? left : right;
  const scopeTokens = distinctiveRequirementScopeTokens(scoped.entry.service);
  if (scopeTokens.length < 2) {
    return false;
  }

  const textTokens = new Set(scoped.canonical.split(" ").filter(Boolean));
  let matchedTokens = 0;
  for (const scopeToken of scopeTokens) {
    if (
      [...textTokens].some((textToken) =>
        requirementScopeTokenMatchesTextToken(scopeToken, textToken),
      )
    ) {
      matchedTokens += 1;
      if (matchedTokens >= 2) {
        return true;
      }
    }
  }
  return false;
}

function longExactRequirementTextsShareScope(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  const leftHasService = Boolean(left.serviceScope);
  const rightHasService = Boolean(right.serviceScope);

  if (leftHasService && rightHasService) {
    return left.serviceScope === right.serviceScope;
  }

  if (!leftHasService && !rightHasService) {
    return !(
      left.headingScope &&
      right.headingScope &&
      left.headingScope !== right.headingScope
    );
  }

  return asymmetricServiceScopeIsGroundedInExactText(left, right);
}

function setsAreEqual(left: Set<string>, right: Set<string>) {
  return (
    left.size === right.size &&
    [...left].every((value) => right.has(value))
  );
}

const MATERIAL_CONTRAST_TOKEN_PATTERNS: Array<[string, RegExp]> = [
  ["internal", /^intern(?:e|t)?$/u],
  ["external", /^ekstern(?:e|t)?$/u],
  ["minimum", /^(?:minimum|minst)$/u],
  ["maximum", /^(?:maksimum|maksimalt|høyst)$/u],
  ["before", /^før$/u],
  ["after", /^etter$/u],
  ["included", /^inkludert$/u],
  ["excluded", /^ekskludert$/u],
  ["allowed", /^tillatt$/u],
  ["prohibited", /^forbudt$/u],
  ["encrypted", /^kryptert$/u],
  ["unencrypted", /^ukryptert$/u],
  ["active", /^aktiv(?:e|t)?$/u],
  ["passive", /^passiv(?:e|t)?$/u],
];

const REQUIREMENT_RESTRICTION_TOKENS = new Set([
  "aldri",
  "bare",
  "ingen",
  "ikke",
  "intet",
  "kun",
  "unntatt",
  "uten",
  "verken",
]);

const REQUIREMENT_UNIT_TOKENS = new Set([
  "bit",
  "byte",
  "dag",
  "dager",
  "gb",
  "gbps",
  "hz",
  "kb",
  "kbps",
  "kg",
  "km",
  "mb",
  "mbps",
  "minutt",
  "minutter",
  "ms",
  "måned",
  "måneder",
  "prosent",
  "sekund",
  "sekunder",
  "tb",
  "time",
  "timer",
  "uke",
  "uker",
  "år",
]);

function materialTextMarkers(value: string, canonical = canonicalRequirementText(value)) {
  const tokens = canonical.split(" ").filter(Boolean);
  const contrasts = new Set<string>();
  const restrictions = new Set<string>();
  const numericAndUnits = new Set<string>();

  for (const token of tokens) {
    const contrast = MATERIAL_CONTRAST_TOKEN_PATTERNS.find(([, pattern]) =>
      pattern.test(token),
    );
    if (contrast) {
      contrasts.add(contrast[0]);
    }
    if (REQUIREMENT_RESTRICTION_TOKENS.has(token)) {
      restrictions.add(token);
    }
    if (/^\d+(?:[.,]\d+)?$/u.test(token) || REQUIREMENT_UNIT_TOKENS.has(token)) {
      numericAndUnits.add(token);
    }
  }

  if (/[%‰°]/u.test(value)) {
    numericAndUnits.add(value.match(/[%‰°]/gu)?.sort().join("") ?? "");
  }

  return { contrasts, restrictions, numericAndUnits };
}

function distinctiveEntityMarkers(value: string) {
  const markers = new Set<string>();
  for (const match of value.normalize("NFKC").matchAll(
    /\b(?:\p{Lu}{2,}[\p{L}\p{N}]*|\p{Lu}\p{Ll}+[\p{Lu}][\p{L}\p{N}]*)\b/gu,
  )) {
    const marker = canonicalRequirementText(match[0]).replace(/\s+/g, "");
    if (marker) {
      markers.add(marker);
    }
  }
  return markers;
}

function requirementMatchDescriptor(entry: RequirementLedgerEntry) {
  const canonical = canonicalRequirementText(entry.text);
  const compact = canonical.replace(/\s+/g, "");
  return {
    entry,
    canonical,
    compact,
    longPrefix:
      compact.length >= LONG_REQUIREMENT_PREFIX_MIN_CHARS
        ? compact.slice(0, LONG_REQUIREMENT_PREFIX_INDEX_CHARS)
        : "",
    identityCandidates: requirementRowIdentityCandidates(entry),
    serviceScope: normalizedRequirementScope(entry.service),
    headingScope: normalizedRequirementScope(entry.heading),
    markers: materialTextMarkers(entry.text, canonical),
    entities: distinctiveEntityMarkers(entry.text),
  } satisfies RequirementMatchDescriptor;
}

function hasMaterialRequirementTextContrast(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  if (
    !setsAreEqual(left.markers.contrasts, right.markers.contrasts) ||
    !setsAreEqual(left.markers.restrictions, right.markers.restrictions) ||
    !setsAreEqual(left.markers.numericAndUnits, right.markers.numericAndUnits)
  ) {
    return true;
  }

  return (
    [...left.entities].some(
      (marker) => !right.compact.includes(marker),
    ) ||
    [...right.entities].some(
      (marker) => !left.compact.includes(marker),
    )
  );
}

function requirementTextWithoutIdentityTokens(
  canonical: string,
  identityTokens: Set<string>,
) {
  return canonical
    .split(" ")
    .filter((token) => !identityTokens.has(token))
    .join("")
    .trim();
}

function requirementTextsAreExactOrOcrEquivalent(
  left: RequirementMatchDescriptor,
  right: RequirementMatchDescriptor,
) {
  if (!left.canonical || !right.canonical) {
    return false;
  }
  const sharedIdentity = sharedRequirementRowIdentity(left, right);
  if (left.canonical === right.canonical) {
    if (Math.min(left.canonical.length, right.canonical.length) >= 160) {
      return longExactRequirementTextsShareScope(left, right);
    }
    return (
      sharedIdentity.matched &&
      !requirementEntriesHaveConflictingScope(left, right)
    );
  }


  const shorter =
    left.compact.length <= right.compact.length ? left : right;
  const longer = shorter === left ? right : left;
  if (
    shorter.compact.length >= LONG_REQUIREMENT_PREFIX_MIN_CHARS &&
    shorter.compact.length / longer.compact.length >=
      LONG_REQUIREMENT_PREFIX_MIN_RATIO &&
    longer.compact.startsWith(shorter.compact) &&
    longExactRequirementTextsShareScope(left, right)
  ) {
    return true;
  }

  if (
    !sharedIdentity.matched ||
    requirementEntriesHaveConflictingScope(left, right) ||
    hasMaterialRequirementTextContrast(left, right)
  ) {
    return false;
  }

  if (left.compact === right.compact) {
    return true;
  }

  return (
    sharedIdentity.tokens.size > 0 &&
    requirementTextWithoutIdentityTokens(left.canonical, sharedIdentity.tokens) ===
      requirementTextWithoutIdentityTokens(right.canonical, sharedIdentity.tokens)
  );
}

function addRequirementMatchIndexEntry(
  index: Map<string, RequirementMatchDescriptor[]>,
  key: string,
  descriptor: RequirementMatchDescriptor,
) {
  if (!key) {
    return;
  }
  const entries = index.get(key) ?? [];
  entries.push(descriptor);
  index.set(key, entries);
}

function requirementMatchCandidates(
  customer: RequirementMatchDescriptor,
  indexes: {
    canonical: Map<string, RequirementMatchDescriptor[]>;
    compact: Map<string, RequirementMatchDescriptor[]>;
    longPrefix: Map<string, RequirementMatchDescriptor[]>;
    identity: Map<string, RequirementMatchDescriptor[]>;
  },
) {
  const candidates = new Set<RequirementMatchDescriptor>();
  for (const descriptor of indexes.canonical.get(customer.canonical) ?? []) {
    candidates.add(descriptor);
  }
  for (const descriptor of indexes.compact.get(customer.compact) ?? []) {
    candidates.add(descriptor);
  }
  for (const descriptor of
    indexes.longPrefix.get(customer.longPrefix) ?? []) {
    candidates.add(descriptor);
  }
  for (const identity of customer.identityCandidates.keys()) {
    for (const descriptor of indexes.identity.get(identity) ?? []) {
      candidates.add(descriptor);
    }
  }
  return candidates;
}

type RequirementSourceLedgerInput = {
  sourceDocuments: ProjectDocumentDetail[];
  requirementLedgerResults: Array<{
    document: Pick<ProjectDocumentDetail, "id">;
    ledger: RequirementLedgerEntry[];
    originalLedger?: RequirementLedgerEntry[];
  }>;
};

const SERIES_REQUIREMENT_ID = /^([A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*)-\d/u;
const UNCLEAR_TARGET = "\u0000unclear";
const MENTIONED_REQUIREMENT_ID = /\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d{1,4}(?:\.\d{1,3}){0,4}\b/gu;

/**
 * The document that defines each numbered requirement. A tender names
 * Bilag 1's "K-4.1.2" in its corrections chapter, its Q&A and its award
 * criteria; those mentions are references, not further requirements. An ID
 * listed in several documents belongs to the formal requirement document
 * numbering the most requirements in that series.
 */
function requirementIdOwners(
  sourceDocuments: ProjectDocumentDetail[],
  ledgerByDocumentId: Map<string, RequirementLedgerEntry[]>,
) {
  const owners = new Map<string, { documentId: string; seriesSize: number }>();
  for (const document of sourceDocuments.filter(isFormalRequirementDocument)) {
    const seriesSizes = new Map<string, number>();
    const ids: Array<{ id: string; series: string }> = [];
    for (const entry of ledgerByDocumentId.get(document.id) ?? []) {
      const id = normalizeRequirementId(entry.id);
      const series = SERIES_REQUIREMENT_ID.exec(id)?.[1];
      if (!series) continue;
      ids.push({ id, series });
      seriesSizes.set(series, (seriesSizes.get(series) ?? 0) + 1);
    }
    for (const { id, series } of ids) {
      const seriesSize = seriesSizes.get(series) ?? 0;
      const current = owners.get(id);
      if (!current || seriesSize > current.seriesSize) {
        owners.set(id, { documentId: document.id, seriesSize });
      }
    }
  }
  return new Map([...owners].map(([id, owner]) => [id, owner.documentId]));
}

function requirementIdTokenPattern(id: string, lineStart: boolean) {
  const token = id
    .split("-")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(String.raw`\s*[-‐‑‒–—]\s*`);
  // A definition heads a line, a Markdown heading, a list item or a table
  // cell ("## K-1.1", "**K-1.1**", "Rad 1: Sikkerhet | K-1.1 | …").
  const lead = lineStart
    ? String.raw`(?:^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:[-•*–]\s*|\[\s*|Rad\s+\d+:\s*|Krav(?:-?ID)?\s*:?\s*)?|\|\s*(?:\*\*)?)`
    : String.raw`(?<![\p{L}\p{N}])`;
  return new RegExp(`${lead}${token}(?![\\p{L}\\p{N}]|\\.\\d)`, lineStart ? "imu" : "iu");
}

/**
 * A mention of an ID another formal document defines is a reference when
 * this document only names it inside sentences: corrections, questions and
 * award criteria ("bør-kravene K-3.1.3, K-3.2.3 inngår"). A truncated parent
 * read from such a mention ("K-4" from "K-4.1.2") is one as well. An ID that
 * heads a line, row or cell here is a requirement of this document too.
 */
function referenceToOwnedRequirementFilter(
  document: ProjectDocumentDetail,
  owners: Map<string, string>,
) {
  const ownedElsewhere = new Set<string>();
  const ancestorsOwnedElsewhere = new Set<string>();
  for (const [id, owner] of owners) {
    if (owner === document.id) continue;
    ownedElsewhere.add(id);
    for (let end = id.lastIndexOf("."); end > 0; end = id.lastIndexOf(".", end - 1)) {
      ancestorsOwnedElsewhere.add(id.slice(0, end));
    }
  }
  if (!ownedElsewhere.size) return () => false;
  const rawText = document.raw_text ?? "";
  const body = withoutCorrectionsSection(rawText);
  return (entry: RequirementLedgerEntry) => {
    const id = normalizeRequirementId(entry.id);
    const truncatedParent = ancestorsOwnedElsewhere.has(id);
    if (!truncatedParent && !ownedElsewhere.has(id)) return false;
    if (requirementIdTokenPattern(id, true).test(body)) return false;
    return truncatedParent || requirementIdTokenPattern(id, false).test(rawText);
  };
}

/** A corrections chapter may sit in another document than the requirements
 * it changes ("Krav K-4.1.2 i Bilag 1 endres og skal nå lyde: …"). It is
 * applied once to every document defining an ID it names. Additions prefer
 * their explicitly named register, then an unambiguous numeric parent. */
function correctionSourcePages(rawText: string, id: string) {
  const lines = rawText.split("\n");
  const ranges = correctionsSectionRanges(lines);
  const token = requirementIdTokenPattern(id, false);
  const pages = new Set<number>();
  let currentPage: number | undefined;
  let unlocated = false;
  lines.forEach((line, index) => {
    const markers = [...line.matchAll(/\[\[SIDE:(\d+)\]\]/gu)];
    if (markers.length) currentPage = Number(markers.at(-1)![1]);
    if (ranges.some(([start, end]) => index >= start && index < end) && token.test(line)) {
      if (currentPage && Number.isSafeInteger(currentPage)) pages.add(currentPage);
      else unlocated = true;
    }
  });
  return unlocated ? [] : [...pages].sort((left, right) => left - right);
}

function normalizedDestinationName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("nb")
    .replace(/\.(?:pdf|docx?|xlsx?|txt|md|csv)$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function attachmentNames(value: string) {
  return [...value.normalize("NFKC").matchAll(/(?<![\p{L}\p{N}])((?:bilag|vedlegg)[\s_-]*([a-z]|\d+(?:\.\d+)*[a-z]?))(?![\p{L}\p{N}]|\.\d)/giu)]
    .map(match => `${/^bilag/iu.test(match[1]) ? "bilag" : "vedlegg"} ${match[2].toLocaleLowerCase("nb").replace(/^0+(?=\d)/u, "")}`);
}

/** Only a destination bound to this addition's ID and verb counts. Document
 * references in other clauses or inside the new wording cannot move the row. */
function explicitAdditionDestination(
  entry: RequirementLedgerEntry,
  documents: ProjectDocumentDetail[],
) {
  const excerpt = entry.sourceExcerpt ?? "";
  const quotations = new Map<string, string>();
  let quotePrefix = "__QUOTED_CORRECTION_";
  while (excerpt.includes(quotePrefix)) quotePrefix = `_${quotePrefix}`;
  const unquoted = excerpt.replace(/«[^»]*»|“[^”]*”|"(?:\\.|[^"\\])*"/gu, span => {
    // Keep quotes opaque until the addition's destination phrase is isolated.
    // Punctuation in document names must not split that phrase; requirement
    // wording after its colon must never contribute a destination or an ID.
    const token = `${quotePrefix}${quotations.size}__`;
    quotations.set(token, span.slice(1, -1));
    return token;
  });
  const clauses = unquoted.split(/(?<=[.!?])\s+(?=[A-ZÆØÅ«])|\s+\|\s+|;\s*|(?=\bnytt\s+krav\s+[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d)/iu);
  const destinations = new Set<string>();
  const wordingToken = [...quotations].filter(([, text]) =>
    canonicalRequirementText(text) === canonicalRequirementText(entry.text),
  ).at(-1)?.[0];
  const anchorSyntax = String.raw`(?:etter|før)\s+(?:krav\s+)?[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d+(?:\.\d+)*`;
  const locationSyntax = String.raw`(?:(?:tabell|kapittel|punkt|avsnitt|del|seksjon)\s+\d+(?:\.\d+)*\.?(?:\s+i\s+kravspesifikasjonen)?(?:,?\s+${anchorSyntax})?(?:\s+i\s+kravspesifikasjonen)?|kravspesifikasjonen)`;
  const bareLocation = new RegExp(`^${locationSyntax}$`, "iu");
  const relativeLocation = new RegExp(`^${anchorSyntax}$`, "iu");
  const leadingLocation = new RegExp(`^${locationSyntax}\\s+i\\s+`, "iu");
  const trailingLocation = new RegExp(`(\\s+|[,;]\\s*)(i\\s+)?(?:${locationSyntax}|${anchorSyntax})$`, "iu");
  const resolveName = (name: string) => {
    const exact = documents.filter(document => [document.title, document.file_name]
      .some(value => normalizedDestinationName(value) === normalizedDestinationName(name)));
    if (exact.length) return exact;
    const attachments = [...new Set(attachmentNames(name))];
    return attachments.length === 1 ? documents.filter(document => [document.title, document.file_name]
      .some(value => attachmentNames(value).includes(attachments[0]))) : [];
  };
  const resolveLiteralSegment = (part: string): string | undefined => {
    const initial = part.trim().replace(/^[,;]+\s*|\s*[,;]+$/gu, "");
    let candidates = initial ? [initial] : [];
    const visited = new Set(candidates);
    let unresolved = false;
    while (candidates.length) {
      // Check every single-peel interpretation before removing more words.
      // No fixed descriptor/location order can preserve all literal titles.
      const exact = candidates.flatMap(name => documents.filter(document => [document.title, document.file_name]
        .some(value => normalizedDestinationName(value) === normalizedDestinationName(name)))
        .map(document => ({ name, id: document.id })));
      if (new Set(exact.map(match => match.id)).size > 1) {
        throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Kontroller dokumentnavnene og hvilke kravdokumenter som er valgt.`);
      }
      if (exact.length) return exact[0].name;
      const next = new Set<string>();
      for (const name of candidates) {
        const locationOnly = name.replace(/^i\s+/iu, "");
        if (bareLocation.test(locationOnly) || relativeLocation.test(locationOnly) ||
            (/\s+i$/iu.test(name) && bareLocation.test(name.replace(/\s+i$/iu, "")))) continue;
        const variants = [name.replace(leadingLocation, ""), name.replace(/^(?:dokumentet|dokument|vedlegget|bilaget|kravdokumentet)\b\s*/iu, "")];
        const trailing = trailingLocation.exec(name);
        if (trailing) {
          const prefix = name.slice(0, trailing.index).trim().replace(/[,;]+$/u, "");
          const explicitSeparator = /[,;]/u.test(trailing[1]) || Boolean(trailing[2]);
          const filename = /\.(?:pdf|docx?|xlsx?|txt|md|csv)$/iu.test(prefix);
          const attachment = /^(?:bilag|vedlegg)[\s_-]*(?:[a-z]|\d+(?:\.\d+)*[a-z]?)$/iu.test(prefix);
          if (explicitSeparator || filename || attachment || relativeLocation.test(name.slice(trailing.index).trim())) variants.push(prefix);
        }
        const changed = variants.map(value => value.trim().replace(/^[,;]+\s*|\s*[,;]+$/gu, "")).filter(value => value !== name);
        if (!changed.length) unresolved = true;
        for (const value of changed) {
          if (value && !visited.has(value)) { visited.add(value); next.add(value); }
        }
      }
      if (visited.size > 128) throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Kontroller dokumentnavnene og hvilke kravdokumenter som er valgt.`);
      candidates = [...next];
    }
    return unresolved ? undefined : "";
  };
  for (const clause of clauses) {
    const mention = requirementIdTokenPattern(normalizeRequirementId(entry.id), false).exec(clause);
    if (!mention) continue;
    const tail = clause.slice(mention.index + mention[0].length);
    const namedAddition = /\bnytt\s+krav\s*$/iu.test(clause.slice(0, mention.index));
    const phrase = /\b(?:legges\s+til|tilføyes)\s+i\s+(.+?)(?=\s*[:]|$)/iu.exec(tail)?.[1] ??
      /^\s+i\s+(.+?)\s+(?:skal\s+)?(?:legges\s+til|tilføyes)\b/iu.exec(tail)?.[1] ??
      (namedAddition ? /^\s+i\s+(.+?)(?=\s*[:]|$)/iu.exec(tail)?.[1] : undefined);
    if (!phrase) continue;
    // The correction parser identifies the added wording explicitly. End the
    // destination before that quote even when the customer omitted a colon.
    const beforeWording = wordingToken ? phrase.split(wordingToken, 1)[0] : phrase;
    const destinationName = beforeWording.split(/(?:,\s*|\s+)(?:jf\.?|jfr\.?|se)\s+/iu, 1)[0]
      .trim().replace(/(?:,\s*|\s+)(?:med\s+(?:følgende\s+)?(?:ordlyd(?:en)?|tekst(?:en)?)|(?:og\s+)?(?:skal\s+)?(?:nå\s+)?lyde(?:r)?(?:\s+slik)?)\s*$/iu, "")
      .replace(/[\s,;]+$/u, "");
    const quotedNames = [...quotations].filter(([token]) => destinationName.includes(token));
    // Preserve the boundary between a location before a quoted name and one
    // after it; removing the token outright would merge the two locations.
    const remainder = quotedNames.reduce((value, [token]) => value.replace(token, " og "), destinationName);
    const wholeName = !quotedNames.length ? resolveLiteralSegment(destinationName) : undefined;
    const joinedNames = (wholeName ? [] : remainder.split(/\b(?:og|samt|pluss)\b/iu)).map(part => {
      const literal = resolveLiteralSegment(part);
      if (literal !== undefined) return literal;
      if (resolveName(part).length === 1) return part;
      throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Kontroller dokumentnavnene og hvilke kravdokumenter som er valgt.`);
    }).filter(Boolean);
    const fullFilenames = joinedNames.filter(name => documents.some(document =>
      normalizedDestinationName(document.file_name) === normalizedDestinationName(name),
    ));
    const filenames = [...remainder.matchAll(/[^\s,;]+\.(?:pdf|docx?|xlsx?|txt|md|csv)\b/giu)]
      .map(match => match[0]).filter(name => !fullFilenames.some(full => full.toLocaleLowerCase("nb").endsWith(name.toLocaleLowerCase("nb"))));
    const names = wholeName ? [wholeName] : [...new Set([
      ...quotedNames.map(([, name]) => name), ...attachmentNames(remainder), ...filenames, ...joinedNames,
    ])];
    if (!names.length) names.push(destinationName);
    if (quotedNames.length) {
      const [lastToken] = quotedNames.at(-1)!;
      const suffix = destinationName.slice(destinationName.lastIndexOf(lastToken) + lastToken.length).trim();
      if (/^i\s+/iu.test(suffix) && !bareLocation.test(suffix.replace(/^i\s+/iu, ""))) {
        names.push(suffix.replace(/^i\s+/iu, ""));
      }
    }
    for (const name of names) {
      const matched = resolveName(name);
      // A location without an explicit document name belongs to the register
      // inferred from its IDs. Unknown document names still fail safely.
      if (!quotedNames.length && !matched.length && !attachmentNames(name).length &&
          bareLocation.test(name)) continue;
      if (matched.length !== 1) {
        throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Kontroller dokumentnavnene og hvilke kravdokumenter som er valgt.`);
      }
      destinations.add(matched[0].id);
    }
  }
  if (destinations.size > 1) {
    throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Oppgi ett dokument for det nye kravet.`);
  }
  return [...destinations][0];
}

function separateAdditionClauses(rawText: string) {
  const unquoted = rawText.replace(/[«“"][^«»“”"]*[»”"]/gu, span => " ".repeat(span.length));
  const starts = [...unquoted.matchAll(/\bnytt\s+krav\s+[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-\d/giu)]
    .map(match => match.index)
    .filter(index => {
      const prefix = rawText.slice(rawText.lastIndexOf("\n", index - 1) + 1, index);
      return prefix.trim() && !/^\s*(?:[-•*–]|\d{1,2}[.)])\s*$/u.test(prefix);
    });
  // One newline keeps the existing correction-block/request scope. It only
  // separates the new ID's clause, including when a quote contains its period.
  let cursor = 0;
  const parts = starts.map(index => {
    const part = rawText.slice(cursor, index);
    cursor = index;
    return part;
  });
  return [...parts, rawText.slice(cursor)].join("\n");
}

function withCrossDocumentCorrections(
  sourceDocuments: ProjectDocumentDetail[],
  ledgerByDocumentId: Map<string, RequirementLedgerEntry[]>,
  owners: Map<string, string>,
) {
  const corrected = new Map(ledgerByDocumentId);
  const series = (id: string) => SERIES_REQUIREMENT_ID.exec(normalizeRequirementId(id))?.[1];
  const definedIn = new Map<string, Set<string>>();
  for (const document of sourceDocuments.filter(isFormalRequirementDocument)) {
    for (const entry of ledgerByDocumentId.get(document.id) ?? []) {
      const id = normalizeRequirementId(entry.id);
      definedIn.set(id, (definedIn.get(id) ?? new Set()).add(document.id));
    }
  }
  const seriesOwner = (additionId: string) => {
    const seriesName = series(additionId);
    const parentParts = normalizeRequirementId(additionId).split(/[.-]/u).slice(0, -1);
    const candidates = new Map<string, number>();
    for (const [id, documents] of definedIn) {
      if (!seriesName || series(id) !== seriesName) continue;
      const parts = normalizeRequirementId(id).split(/[.-]/u);
      let depth = 0;
      while (depth < parentParts.length && parts[depth] === parentParts[depth]) depth++;
      for (const owner of documents) candidates.set(owner, Math.max(candidates.get(owner) ?? 0, depth));
    }
    // K-2.3 belongs with K-2.* even if a different register contains more K-1.*
    // rows. Letter-prefix frequency alone does not establish that ownership.
    const ranked = [...candidates].sort((left, right) => right[1] - left[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      throw new WorkflowPreconditionError(`Kravrettelsen for ${additionId} kan ikke knyttes entydig til et kravdokument. Oppgi dokumentnavnet for det nye kravet.`);
    }
    return ranked[0]?.[0];
  };
  for (const document of sourceDocuments) {
    const rawText = document.raw_text ?? "";
    const section = findCorrectionsSection(rawText);
    if (!section) continue;
    const correctionText = separateAdditionClauses(rawText);
    const namedOwners = new Map<string, number>();
    for (const match of section.matchAll(MENTIONED_REQUIREMENT_ID)) {
      const owner = owners.get(normalizeRequirementId(match[0]));
      if (owner && owner !== document.id) namedOwners.set(owner, (namedOwners.get(owner) ?? 0) + 1);
    }
    const targets = [...namedOwners].sort((left, right) => right[1] - left[1]).map(([id]) => id);
    const namedTargets = [...targets];
    // A new ID need not mention an existing requirement. Discover affirmative
    // additions with the correction parser, then resolve each clause's owner.
    const formalDocuments = sourceDocuments.filter(isFormalRequirementDocument);
    const newEntries = applyRequirementCorrections([], correctionText, { removeCorrectionRows: false }).ledger
      .filter(entry => !owners.has(normalizeRequirementId(entry.id)));
    const additionOwners = new Map<string, string>();
    for (const entry of newEntries) {
      const destination = explicitAdditionDestination(entry, formalDocuments) ?? seriesOwner(entry.id) ??
        (namedTargets.length === 1 ? namedTargets[0] : undefined);
      if (!destination) {
        throw new WorkflowPreconditionError(`Kravrettelsen for ${entry.id} kan ikke knyttes entydig til et kravdokument. Oppgi dokumentnavnet for det nye kravet.`);
      }
      additionOwners.set(entry.id, destination);
      if (!targets.includes(destination)) targets.push(destination);
    }
    if (!targets.length) continue;
    const additions = new Map<string, RequirementLedgerEntry>();
    for (const target of targets) {
      const before = corrected.get(target) ?? [];
      const beforeIds = new Set(before.map((entry) => entry.id));
      // An ID that several registers define cannot tell which one another
      // document's correction means; those rows are left as they are.
      const unclear = (entry: RequirementLedgerEntry) =>
        (definedIn.get(normalizeRequirementId(entry.id))?.size ?? 0) > 1;
      const masked = before.map((entry) => (unclear(entry) ? { ...entry, id: `${entry.id}${UNCLEAR_TARGET}` } : entry));
      const applied = applyRequirementCorrections(masked, correctionText, { removeCorrectionRows: false });
      const report = applied.report;
      const ledger = applied.ledger.map((entry) =>
        entry.id.endsWith(UNCLEAR_TARGET) ? { ...entry, id: entry.id.slice(0, -UNCLEAR_TARGET.length) } : entry);
      for (const entry of ledger) {
        if (report.added.includes(entry.id) && !beforeIds.has(entry.id) && !additions.has(entry.id)) {
          additions.set(entry.id, entry);
        }
      }
      corrected.set(target, ledger.filter((entry) => beforeIds.has(entry.id) || !report.added.includes(entry.id)));
    }
    for (const [id, entry] of additions) {
      const destination = additionOwners.get(id) ?? explicitAdditionDestination(entry, formalDocuments) ?? seriesOwner(id) ??
        (namedTargets.length === 1 ? namedTargets[0] : undefined);
      if (!destination) {
        throw new WorkflowPreconditionError(`Kravrettelsen for ${id} kan ikke knyttes entydig til et kravdokument. Oppgi dokumentnavnet for det nye kravet.`);
      }
      const ledger = corrected.get(destination) ?? [];
      const { index: at, anchor } = requirementAdditionPosition(ledger, id);
      const destinationDocument = sourceDocuments.find((source) => source.id === destination);
      const placed: RequirementLedgerEntry = {
        ...entry,
        // Numbering establishes logical placement, not a page in the original
        // register. The added wording is only attested by the correction.
        pages: [],
        heading: anchor?.heading ?? "",
        documentId: destination,
        documentTitle: anchor?.documentTitle ?? destinationDocument?.title,
        correctionSource: {
          documentId: document.id,
          documentTitle: document.title,
          pages: correctionSourcePages(rawText, id),
          excerpt: entry.sourceExcerpt ?? entry.text,
        },
      };
      corrected.set(destination, [...ledger.slice(0, at), placed, ...ledger.slice(at)]);
    }
  }
  return corrected;
}

export function canonicalizeRequirementSourceLedger(
  input: RequirementSourceLedgerInput,
  options: { applyCrossDocumentCorrections?: boolean } = {},
) {
  const blankEntries = input.requirementLedgerResults.flatMap((result) =>
    result.ledger
      .filter((entry) => !entry.text.trim())
      .map((entry) => `${result.document.id}:${entry.id}`),
  );
  if (blankEntries.length) {
    throw new Error(
      `Kravgrunnlaget inneholder ${blankEntries.length} rad(er) uten kravtekst: ${blankEntries
        .slice(0, 5)
        .join(", ")}. Arbeidsflyten stoppes for å unngå at kravrader forsvinner fra dekningen.`,
    );
  }

  const resultByDocumentId = new Map(
    input.requirementLedgerResults.map((result) => [result.document.id, result]),
  );
  const formalDescriptors = input.sourceDocuments
    .filter(isFormalRequirementDocument)
    .flatMap(
      (document) => {
        const result = resultByDocumentId.get(document.id);
        return [...(result?.ledger ?? []), ...(result?.originalLedger ?? [])];
      },
    )
    .map(requirementMatchDescriptor);
  const formalIndexes = {
    canonical: new Map<string, RequirementMatchDescriptor[]>(),
    compact: new Map<string, RequirementMatchDescriptor[]>(),
    longPrefix: new Map<string, RequirementMatchDescriptor[]>(),
    identity: new Map<string, RequirementMatchDescriptor[]>(),
  };
  for (const descriptor of formalDescriptors) {
    addRequirementMatchIndexEntry(
      formalIndexes.canonical,
      descriptor.canonical,
      descriptor,
    );
    addRequirementMatchIndexEntry(
      formalIndexes.compact,
      descriptor.compact,
      descriptor,
    );
    addRequirementMatchIndexEntry(
      formalIndexes.longPrefix,
      descriptor.longPrefix,
      descriptor,
    );
    for (const identity of descriptor.identityCandidates.keys()) {
      addRequirementMatchIndexEntry(
        formalIndexes.identity,
        identity,
        descriptor,
      );
    }
  }

  const ledgers = new Map(
    input.sourceDocuments.map((document) => [document.id, resultByDocumentId.get(document.id)?.ledger ?? []]),
  );
  const originalOwners = requirementIdOwners(input.sourceDocuments, ledgers);
  const correctedLedgers =
    options.applyCrossDocumentCorrections === false
      ? ledgers
      : withCrossDocumentCorrections(input.sourceDocuments, ledgers, originalOwners);
  // A requirement a correction added belongs to the document it joined; a
  // withdrawn one still belongs to the document that defined it, so another
  // document's mention ("K-1.2 i Bilag 1 utgår") stays a reference.
  const owners = new Map([...originalOwners, ...requirementIdOwners(input.sourceDocuments, correctedLedgers)]);

  return input.sourceDocuments.flatMap((document, documentIndex) => {
    const isReference = referenceToOwnedRequirementFilter(document, owners);
    const entries = (correctedLedgers.get(document.id) ?? []).filter((entry) => !isReference(entry));
    const canonicalEntries =
      document.role === "primary_customer_document"
        ? entries.filter(
            (customerEntry) => {
              const customerDescriptor =
                requirementMatchDescriptor(customerEntry);
              return ![
                ...requirementMatchCandidates(
                  customerDescriptor,
                  formalIndexes,
                ),
              ].some((formalDescriptor) =>
                requirementTextsAreExactOrOcrEquivalent(
                  customerDescriptor,
                  formalDescriptor,
                ),
              );
            },
          )
        : entries;

    return canonicalEntries.map((entry, entryIndex) => ({
      ...entry,
      documentId: entry.documentId ?? document.id,
      documentTitle: entry.documentTitle ?? document.title,
      documentOrder: documentIndex,
      ...(typeof entry.sourceDocumentEntryOrder === "number" &&
      Number.isFinite(entry.sourceDocumentEntryOrder)
        ? { sourceDocumentEntryOrder: entry.sourceDocumentEntryOrder }
        : typeof entry.documentEntryOrder === "number" &&
            Number.isFinite(entry.documentEntryOrder)
          ? { sourceDocumentEntryOrder: entry.documentEntryOrder }
          : {}),
      // Extractors use incompatible coordinate systems here (for example a
      // page/line offset beside a sequential table-row index). At the
      // canonical boundary the already source-ordered rows receive one dense,
      // comparable rank; the raw parser coordinate remains available above
      // for provenance and diagnostics.
      documentEntryOrder: entryIndex,
    }));
  });
}

function requirementSourceReadinessIssues(
  documents: ProjectDocumentDetail[],
  options: { requireReadableText?: boolean },
) {
  return documents
    .filter(isRequirementDocument)
    .flatMap((document) => {
      if (!isDocumentReadyForEvaluation(document)) {
        return [
          `${document.title} (${document.processing_status ?? "ukjent status"})`,
        ];
      }
      if (
        options.requireReadableText &&
        !hasReadableRequirementDocumentContent(document)
      ) {
        return [`${document.title} (mangler lesbar tekst etter hydrering)`];
      }
      return [];
    });
}

export function assertEvaluationRequirementSourcesReady(
  documents: ProjectDocumentDetail[],
  options: { requireReadableText?: boolean } = {},
) {
  const issues = requirementSourceReadinessIssues(documents, options);

  if (issues.length) {
    throw new Error(
      `Kravgrunnlaget er ikke klart for fullstendig løsningsvurdering: ${issues.join(
        ", ",
      )}. Vent til dokumentbehandlingen er ferdig eller last opp dokumentet på nytt.`,
    );
  }
}

export function assertCustomerAnalysisRequirementSourcesReady(
  documents: ProjectDocumentDetail[],
  options: { requireReadableText?: boolean } = { requireReadableText: true },
) {
  const issues = requirementSourceReadinessIssues(documents, options);
  if (issues.length) {
    throw new WorkflowPreconditionError(
      `Dokumentgrunnlaget er ikke klart for kundeanalyse: ${issues.join(
        ", ",
      )}. Vent til dokumentbehandlingen er ferdig eller last opp dokumentet på nytt.`,
    );
  }
}

export function assertSelectedSolutionDocumentReady(
  document: ProjectDocumentDetail,
  options: { requireReadableText?: boolean } = {},
) {
  if (!isApprovedSolutionEvaluationDocument(document)) {
    throw new Error(
      `Dokumentet ${document.title} er ikke en godkjent arkitektløsning. Velg et klart primært løsningsdokument; kravdokumenter og RFP-er kan ikke vurderes som løsning.`,
    );
  }
  if (!isDocumentReadyForEvaluation(document)) {
    throw new Error(
      `Arkitektløsningen ${document.title} er ikke klar for vurdering (${document.processing_status ?? "ukjent status"}).`,
    );
  }
  if (options.requireReadableText && !document.raw_text.trim()) {
    throw new Error(
      `Arkitektløsningen ${document.title} mangler lesbar tekst etter hydrering.`,
    );
  }
}

export function assertExplicitRequirementLedgersComplete(
  sourceDocuments: ProjectDocumentDetail[],
  requirementLedgerResults: Array<{
    document: Pick<ProjectDocumentDetail, "id">;
    ledger: RequirementLedgerEntry[];
  }>,
) {
  const resultByDocumentId = new Map(
    requirementLedgerResults.map((result) => [result.document.id, result]),
  );
  const emptyRequirementDocuments = sourceDocuments.filter(
    (document) =>
      isFormalRequirementDocument(document) &&
      (resultByDocumentId.get(document.id)?.ledger.length ?? 0) === 0 &&
      !allRequirementsWithdrawn(document)
  );

  if (emptyRequirementDocuments.length) {
    throw new Error(
      `Kravledgeren er tom for kravdokument: ${emptyRequirementDocuments
        .map((document) => document.title)
        .join(", ")}. Arbeidsflyten stoppes for å unngå ufullstendig kravdekning.`,
    );
  }

  const corruptedAuthoritativeInventories = sourceDocuments.flatMap(
    (document) => {
      if (!isFormalRequirementDocument(document)) return [];
      // Expected after the document's own corrections chapter, so a
      // withdrawn or renumbered row is not a corruption.
      // Counted without the corrections chapter (its reference rows are not
      // requirements); an inventory exists only if the original text has
      // one, and corrections then adjust it.
      const sourceIds = explicitIdTableSourceIds(withoutCorrectionsSection(document.raw_text));
      const expected = sourceIds.length
        ? correctedRequirementIds(sourceIds, document.raw_text).map(explicitInventoryId)
        : [];
      if (!expected.length) return [];

      const ledger = resultByDocumentId.get(document.id)?.ledger ?? [];
      const actualRows = ledger.map(explicitLedgerEntryIds);
      const actual = actualRows.flatMap((ids) =>
        ids.length === 1 ? ids : [],
      );
      const malformedRows = actualRows.filter((ids) => ids.length !== 1).length;
      const exactMatch =
        malformedRows === 0 &&
        actual.length === expected.length &&
        actual.every((id, index) => id === expected[index]);
      if (exactMatch) return [];

      const expectedSet = new Set(expected);
      const unexpected = actual.filter((id) => !expectedSet.has(id));
      const duplicate = actual.filter(
        (id, index) => actual.indexOf(id) !== index,
      );
      return [
        {
          title: document.title,
          expected: expected.length,
          actual: ledger.length,
          malformedRows,
          unexpected: [...new Set(unexpected)],
          duplicate: [...new Set(duplicate)],
        },
      ];
    },
  );

  if (corruptedAuthoritativeInventories.length) {
    throw new Error(
      `Kravledgeren avviker fra den eksplisitte kravtabellen: ${corruptedAuthoritativeInventories
        .map((issue) => {
          const details = [
            `${issue.title} (forventet ${issue.expected} rader i kildeorden, fikk ${issue.actual})`,
            issue.malformedRows
              ? `${issue.malformedRows} rader uten entydig krav-ID`
              : "",
            issue.unexpected.length
              ? `uventede ID-er: ${issue.unexpected.slice(0, 12).join(", ")}`
              : "",
            issue.duplicate.length
              ? `duplikater: ${issue.duplicate.slice(0, 12).join(", ")}`
              : "",
          ].filter(Boolean);
          return details.join("; ");
        })
        .join("; ")}. Arbeidsflyten stoppes før vurdering for å unngå misvisende dekningsgrad.`,
    );
  }

  const incompleteExplicitInventories = sourceDocuments.flatMap((document) => {
    if (!isFormalRequirementDocument(document)) return [];
    const ledger = resultByDocumentId.get(document.id)?.ledger ?? [];
    // A spreadsheet's inventory is its requirement matrix's ID column (every
    // data row, also one whose text could not be read); other sheets (award
    // criteria such as "K1") are not requirements. Matrix IDs are counted as
    // written on both sides, so lost rows are caught even for prefixed IDs
    // ("KD-01") that the generic ID detector does not read. The inventory is
    // taken after the document's corrections chapter.
    const matrixIds = spreadsheetRequirementIds(document);
    const entryIds = (entry: RequirementLedgerEntry) =>
      matrixIds.length
        ? [explicitInventoryId(entry.id)].filter(Boolean)
        : explicitLedgerEntryIds(entry);
    const expected = matrixIds.length
      ? correctedRequirementIds(matrixIds, document.raw_text).reduce((counts, id) => {
          const key = explicitInventoryId(id);
          return key ? counts.set(key, (counts.get(key) ?? 0) + 1) : counts;
        }, new Map<string, number>())
      : correctedExplicitRequirementSourceInventory(document);
    if (expected.size === 0) return [];

    const actual = new Map<string, number>();
    for (const entry of ledger) {
      for (const id of entryIds(entry)) {
        actual.set(id, (actual.get(id) ?? 0) + 1);
      }
    }
    const missing = [...expected.entries()].flatMap(([id, count]) => {
      const deficit = count - (actual.get(id) ?? 0);
      return deficit > 0 ? [`${id} × ${deficit}`] : [];
    });
    return missing.length
      ? [
          {
            title: document.title,
            expected: [...expected.values()].reduce(
              (sum, count) => sum + count,
              0,
            ),
            missing,
          },
        ]
      : [];
  });

  if (incompleteExplicitInventories.length) {
    throw new Error(
      `Kravledgeren mangler eksplisitte kilderader: ${incompleteExplicitInventories
        .map(
          (issue) =>
            `${issue.title} (forventet minst ${issue.expected}; mangler ${issue.missing
              .slice(0, 12)
              .join(", ")}${issue.missing.length > 12 ? ", …" : ""})`,
        )
        .join("; ")}. Arbeidsflyten stoppes for å unngå ufullstendig kravdekning.`,
    );
  }
}

function explicitInventoryId(value: string) {
  return canonicalRequirementText(value).replace(/\s+/gu, "");
}

function explicitLedgerEntryIds(entry: RequirementLedgerEntry) {
  return [
    ...new Set(
      [entry.id, entry.tableId ?? ""]
        .flatMap((value) => detectExplicitRequirementIds(value))
        .map(explicitInventoryId)
        .filter(Boolean),
    ),
  ];
}

/** Docling paragraphs must be present in the original source, not merely
 * mentioned in a correction, before they can establish row identities. */
function doclingRequirementSourceAnchors(document: ProjectDocumentDetail) {
  if (!document.structure_map?.length) return [];
  const source = withoutCorrectionsSection(document.raw_text ?? "").replace(/\s+/gu, " ");
  return buildExplicitIdDoclingTextRequirementLedger(document, {
    detectExplicitRequirementIds, stripAnswerTextFromRequirement, stripRequirementChrome,
    hasRequirementSignal, hasStandaloneRequirementLanguage,
  }).filter((entry) => entry.sourceExcerpt && source.includes(entry.sourceExcerpt.replace(/\s+/gu, " ").trim()));
}

/** Original explicit IDs and anchored multiplicity, without correction references. */
export function originalRequirementSourceIds(document: ProjectDocumentDetail) {
  const rawText = document.raw_text ?? "";
  const matrixIds = spreadsheetRequirementIds(document);
  if (matrixIds.length) return matrixIds;
  const { expected, rawIds } = explicitRequirementSourceInventoryWithRawIds(withoutCorrectionsSection(rawText));
  const anchored = new Map<string, number>();
  for (const entry of doclingRequirementSourceAnchors(document)) {
    const id = explicitInventoryId(entry.id);
    anchored.set(id, (anchored.get(id) ?? 0) + 1);
    rawIds.set(id, entry.id);
  }
  // Generic narrative scanning deduplicates references. Separate anchored
  // paragraphs prove distinct rows even when they repeat the same ID.
  for (const [id, count] of anchored) expected.set(id, Math.max(expected.get(id) ?? 0, count));
  return [...expected].flatMap(([id, count]) => Array.from({ length: count }, () => rawIds.get(id) ?? id));
}

export function allRequirementsWithdrawn(document: ProjectDocumentDetail) {
  const original = originalRequirementSourceIds(document);
  if (!original.length || correctedRequirementIds(original, document.raw_text ?? "").length > 0) return false;
  // The matrix inventory includes its source rows. An explicit-ID inventory
  // for prose/PDF does not. Docling paragraph anchors prove which wrapped
  // obligations belong to an explicit requirement; reuse the extraction
  // parser rather than assigning every following ID-less line to that ID.
  if (spreadsheetRequirementIds(document).length > 0) return true;
  let unanchoredSource = withoutCorrectionsSection(document.raw_text ?? "");
  for (const anchor of doclingRequirementSourceAnchors(document)) {
    // Remove only the complete source-bound excerpt, so an identical clause
    // in a separate unnumbered row still prevents an empty-ledger success.
    if (!anchor.sourceExcerpt) continue;
    const pattern = anchor.sourceExcerpt.split(/\s+/u).map(escapeRegExp).join("\\s+");
    unanchoredSource = unanchoredSource.replace(new RegExp(pattern, "gu"), "");
  }
  return !unanchoredSource.split(/\r?\n/u)
    .some((line) => hasRequirementSignal(line) && !detectExplicitRequirementIds(line).length);
}

/** Apply the same identity matching before and after corrections, so a
 * customer copy of a withdrawn formal row does not become an active source. */
export function allCanonicalRequirementsWithdrawn(input: RequirementSourceLedgerInput) {
  const originals = input.requirementLedgerResults.map((result) => ({
    ...result,
    ledger: result.originalLedger ?? result.ledger,
  }));
  const originalByDocument = new Map(originals.map((result) => [result.document.id, result.ledger]));
  // No parsed evidence cannot establish that explicit or unnumbered source
  // requirements were withdrawn, even if the corrected ledger is empty.
  if (input.sourceDocuments.some((document) =>
    !originalByDocument.get(document.id)?.length &&
    (isFormalRequirementDocument(document) || originalRequirementSourceIds(document).length > 0 ||
      withoutCorrectionsSection(document.raw_text ?? "").split(/\r?\n/u).some(hasRequirementSignal))
  )) return false;
  const canonicalOriginals = canonicalizeRequirementSourceLedger(
    { ...input, requirementLedgerResults: originals },
    { applyCrossDocumentCorrections: false },
  );
  const documents = new Map(input.sourceDocuments.map((document) => [document.id, document]));
  return canonicalOriginals.length > 0 && canonicalOriginals.every((entry) => {
    const document = documents.get(entry.documentId ?? "");
    return document !== undefined && allRequirementsWithdrawn(document);
  });
}

/** The generic explicit-ID inventory after the document's corrections
 * chapter, so an intended withdrawal or renumbering is not a lost row. */
function correctedExplicitRequirementSourceInventory(document: ProjectDocumentDetail) {
  return correctedRequirementIds(originalRequirementSourceIds(document), document.raw_text).reduce((counts, id) => {
    const key = explicitInventoryId(id);
    return key ? counts.set(key, (counts.get(key) ?? 0) + 1) : counts;
  }, new Map<string, number>());
}

function explicitRequirementSourceInventoryWithRawIds(rawText: string) {
  const expected = new Map<string, number>();
  const rawIds = new Map<string, string>();
  const structuredRowCounts = new Map<string, number>();
  const unstructuredIds = new Set<string>();
  for (const rawLine of rawText.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) continue;
    const detected = detectExplicitRequirementIds(line);
    for (const id of detected) {
      const key = explicitInventoryId(id);
      if (key && !rawIds.has(key)) rawIds.set(key, id);
    }
    const lineIds = [
      ...new Set(
        detected
          .map(explicitInventoryId)
          .filter(Boolean),
      ),
    ];
    if (!lineIds.length) continue;
    const tableCells = line.includes("|")
      ? line
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
      : [];
    const leadingCellIds = tableCells
      .slice(0, 2)
      .flatMap((cell) => detectExplicitRequirementIds(cell))
      .map(explicitInventoryId);
    const compactLine = canonicalRequirementText(line).replace(/\s+/gu, "");
    const hasRequirementLanguage =
      /\b(?:skal|må|bør|shall|must|required|krav)\b/iu.test(line);

    for (const id of lineIds) {
      const structuredTableRow = leadingCellIds.includes(id);
      const leadingRequirement =
        compactLine.startsWith(id) &&
        (hasRequirementLanguage || compactLine.length - id.length >= 18);
      if (structuredTableRow) {
        const count = (structuredRowCounts.get(id) ?? 0) + 1;
        structuredRowCounts.set(id, count);
        expected.set(id, Math.max(count, unstructuredIds.has(id) ? 1 : 0));
      } else if (leadingRequirement) {
        // Unstructured text can repeat an ID in both the table of contents and
        // its real source paragraph. Treat those sightings as presence only;
        // only explicit structured rows prove that multiplicity is required.
        unstructuredIds.add(id);
        expected.set(id, Math.max(structuredRowCounts.get(id) ?? 0, 1));
      }
    }
  }
  return { expected, rawIds };
}
