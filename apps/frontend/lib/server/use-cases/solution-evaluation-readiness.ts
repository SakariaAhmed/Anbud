import {
  hasReadableRequirementDocumentContent,
  hasRequirementDocumentSignal,
  isApprovedSolutionEvaluationDocument,
  isDocumentReadyForEvaluation,
  isFormalRequirementDocument,
  isRequirementDocument,
} from "@/lib/document-processing";
import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
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

export function isLikelyRequirementSourceDocument(
  document: ProjectDocumentDetail,
) {
  return isRequirementDocument(document);
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

export function canonicalizeRequirementSourceLedger(input: {
  sourceDocuments: ProjectDocumentDetail[];
  requirementLedgerResults: Array<{
    document: Pick<ProjectDocumentDetail, "id">;
    ledger: RequirementLedgerEntry[];
  }>;
}) {
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
      (document) => resultByDocumentId.get(document.id)?.ledger ?? [],
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

  return input.sourceDocuments.flatMap((document, documentIndex) => {
    const entries = resultByDocumentId.get(document.id)?.ledger ?? [];
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
    .filter(isLikelyRequirementSourceDocument)
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
    throw new Error(
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

export function requiresNonEmptyRequirementLedger(
  document: ProjectDocumentDetail,
) {
  return isFormalRequirementDocument(document);
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
      requiresNonEmptyRequirementLedger(document) &&
      (resultByDocumentId.get(document.id)?.ledger.length ?? 0) === 0
  );

  if (emptyRequirementDocuments.length) {
    throw new Error(
      `Kravledgeren er tom for kravdokument: ${emptyRequirementDocuments
        .map((document) => document.title)
        .join(", ")}. Arbeidsflyten stoppes for å unngå ufullstendig kravdekning.`,
    );
  }

  const incompleteExplicitInventories = sourceDocuments.flatMap((document) => {
    if (!requiresNonEmptyRequirementLedger(document)) return [];
    const ledger = resultByDocumentId.get(document.id)?.ledger ?? [];
    const expected = explicitRequirementSourceInventory(document.raw_text);
    if (expected.size === 0) return [];

    const actual = new Map<string, number>();
    for (const entry of ledger) {
      const ids = explicitLedgerEntryIds(entry);
      for (const id of ids) {
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

function explicitRequirementSourceInventory(rawText: string) {
  const expected = new Map<string, number>();
  const structuredRowCounts = new Map<string, number>();
  const unstructuredIds = new Set<string>();
  for (const rawLine of rawText.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineIds = [
      ...new Set(
        detectExplicitRequirementIds(line)
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
  return expected;
}
