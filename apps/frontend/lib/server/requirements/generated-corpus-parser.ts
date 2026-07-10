import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";
import {
  findRequirementOrderOffset,
  isMixedRequirementBoilerplate,
  isMixedRequirementLineCandidate,
  isTrustedStructuredRequirementText,
  normalizedRequirementOrderSearchText,
} from "@/lib/server/requirements/mixed-corpus-rules";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

export function buildTrustedStructureMapRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  if (
    !isGeneratedKravspesifikasjonCorpus(document) ||
    !Array.isArray(document.structure_map)
  ) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const tableCounts = new Map<string, number>();
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;
  let activeHeading = "";

  for (const entry of document.structure_map) {
    const entryHeading = generatedStructureTextHeading(entry.text, context);
    if (entryHeading) {
      activeHeading = entryHeading;
    }

    if (!context.hasStructuredTableCells(entry)) {
      continue;
    }

    const cells = context.structureEntryCellMap(entry);
    if (!Object.keys(cells).length) {
      continue;
    }

    const parts = context.doclingRequirementRowParts(cells);
    const requirementText = context.stripRequirementChrome(
      parts.requirementText,
    );
    if (!isTrustedStructuredRequirementText(requirementText, context)) {
      continue;
    }

    const tableId = context.structureTableId(entry);
    const sequence = (tableCounts.get(tableId) ?? 0) + 1;
    tableCounts.set(tableId, sequence);
    const sourceOrderOffset = findRequirementOrderOffset(
      normalizedRawText,
      requirementText,
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
        context.structureRequirementFallbackId(entry, tableId, sequence),
      text: requirementText,
      pages: typeof entry.page === "number" ? [entry.page] : [],
      heading: activeHeading || normalizePageText(entry.reference ?? ""),
      tableId,
      service: parts.serviceText || undefined,
      sourceExcerpt: context.doclingRequirementRowSourceExcerpt(cells),
      answerExcerpt: parts.answerText || undefined,
      documentEntryOrder,
    });
  }

  return requirements;
}

export function stripGeneratedPriorityComment(value: string) {
  return normalizePageText(value)
    .replace(
      /\s+(?:Må|Bør|Kan)\s+(?:Gjelder\s+produksjonsløsning|Dokumentasjon\s+ønskes|Krever\s+løsningsforslag|Må\s+avklares\s+i\s+designfase|Kan\s+prises\s+som\s+opsjon|Besvares\s+av\s+leverandør)(?=\s+\S)/gi,
      " ",
    )
    .replace(
      /\s+(?:Må|Bør|Kan)\s+(?:Gjelder\s+produksjonsløsning|Dokumentasjon\s+ønskes|Krever\s+løsningsforslag|Må\s+avklares\s+i\s+designfase|Kan\s+prises\s+som\s+opsjon|Besvares\s+av\s+leverandør)$/i,
      "",
    )
    .trim();
}

function stripGeneratedWrapperLabel(value: string) {
  return normalizePageText(value)
    .replace(
      /^(?:Avklaring|Implisitt|Fra\s+arbeidsnotatet|Notat\s+fra\s+behovsarbeidet|Notat)\s*[:\-]\s*/i,
      "",
    )
    .replace(
      /^(?:Krav\s+uten\s+egen\s+tabellrad|Notater\s+som\s+skal\s+tolkes\s+som\s+krav|Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet)\s*:\s*/i,
      "",
    )
    .replace(/^:\s*/i, "")
    .trim();
}

function normalizeMixedRequirementLine(
  value: string,
  context: RequirementCorpusParserContext,
) {
  const withoutGeneratedMarker = stripGeneratedRequirementIdChrome(value);
  const cleaned = context
    .stripAnswerTextFromRequirement(
      context.stripRequirementChrome(withoutGeneratedMarker),
    )
    .replace(/^Notat\s*-\s*(?=Notat\s+fra\s+behovsarbeidet\s*:)/i, "");

  return repairGeneratedTextArtifacts(
    stripGeneratedWrapperLabel(stripGeneratedPriorityComment(cleaned)),
  );
}

const GENERATED_KRAV_SECTION_HEADINGS = [
  "Tilgang og roller - både faste og midlertidige brukere",
  "Dataflyt, API og gamle systemer",
  "Sikkerhet og kontrollpunkter som ikke kan glippe",
  "Drift, varsler og ting som må synes i hverdagen",
  "1. Formål, omfang og styringsregler",
  "Migrering og opprydding i gamle data",
  "Dataflyt som ble nevnt flere steder",
  "2. Plattform, arkitektur og miljøer",
  "Sikkerhet, revisjon og bekymringer fra fagmiljøet",
  "Rapporter som ledelsen faktisk bruker",
  "3. Identitet, tilgang og roller",
  "Driftsting som ikke må glemmes",
  "Mobil bruk, feltarbeid og svak dekning",
  "4. Data, integrasjoner og API-er",
  "Gamle data, migrering og rot i kilder",
  "5. Sikkerhet, personvern og logging",
  "Rapportønsker fra ledelsen og fagansvarlige",
  "6. Migrering, kvalitetssikring og test",
  "Feltbruk, mobil og praktiske hverdagsproblemer",
  "7. Drift, overvåking og hendelseshåndtering",
  "Avklaringer fra leverandørmøtet",
  "Leverandørens ansvar under innføring",
  "8. Ytelse, tilgjengelighet og kontinuitet",
  "Notater om overlevering og opplæring",
  "9. Rapportering, innsikt og eksport",
  "Kostnader, kapasitet og videreutvikling",
  "Åpne avklaringer som likevel skal prises",
  "10. Opplæring, dokumentasjon og overlevering",
  "Kostnader, skalerbarhet og miljøhensyn",
  "Ting som ligger mellom krav og kommentar",
];

const GENERATED_KRAV_SECTION_HEADING_SET = new Set(
  GENERATED_KRAV_SECTION_HEADINGS.map((heading) =>
    normalizePageText(heading).toLocaleLowerCase("nb"),
  ),
);

function generatedKravSectionHeadingPattern() {
  return /^(?:Funksjonelle\s+krav|Data,\s*migrering\s+og\s+kvalitet|Integrasjoner\s+og\s+API|Sikkerhet,\s*personvern\s+og\s+tilgang|Drift,\s*overvåking\s+og\s+ytelse|Leveranse,\s*test\s+og\s+opplæring|Prioritert\s+kravtabell|Punktliste\s+fra\s+workshop|Datadeling\s+og\s+grensesnitt|Drift\s+og\s+support|Notater\s+fra\s+fagansvarlige|Åpne\s+avklaringer|Løse\s+krav\s+fra\s+behovsmøte|Tabell\s+som\s+må\s+ryddes|Kommentarer\s+fra\s+drift|Ting\s+som\s+ikke\s+må\s+glemmes|Ikke\s+glem\s+dette|Uavklarte,\s*men\s+viktige\s+punkter|Tekstutdrag\s+fra\s+bestiller)$/i;
}

function isGeneratedKravSectionHeading(value: string) {
  const text = normalizePageText(value);
  return (
    GENERATED_KRAV_SECTION_HEADING_SET.has(text.toLocaleLowerCase("nb")) ||
    generatedKravSectionHeadingPattern().test(text)
  );
}

function isGeneratedInstructionOrRequirementLine(
  value: string,
  context: RequirementCorpusParserContext,
) {
  const text = normalizePageText(value);
  return (
    !text ||
    /^Bilag\s+2\b/i.test(text) ||
    /^Kunde\b/i.test(text) ||
    /^Behovsområde\b/i.test(text) ||
    /^Dagens\s+kilder\b/i.test(text) ||
    /^Viktige\s+integrasjoner\b/i.test(text) ||
    /^Kravene\s+(?:under|i\s+denne\s+delen)\b/i.test(text) ||
    /^Dersom\s+et\s+krav\b/i.test(text) ||
    /^Tabell\s+\d{1,4}\b/i.test(text) ||
    /^Rad\s+\d{1,4}\s*:/i.test(text) ||
    /^Krav\s+registrert\s+i\s+tabell$/i.test(text) ||
    /^Punktkrav\s+som\s+skal\s+besvares:?$/i.test(text) ||
    /^Krav\s+uten\s+egen\s+tabellrad:/i.test(text) ||
    /^Notater\s+som\s+skal\s+tolkes\s+som\s+krav:?$/i.test(text) ||
    /^Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet:?$/i.test(text) ||
    /^Notatene\s+under\s+er\s+samlet\b/i.test(text) ||
    /^Fra\s+arbeidsnotatet:/i.test(text) ||
    /^(?:NB|mangler\s+ID|se\s+notat|Avklaring|Implisitt)\s*[-:]/i.test(text) ||
    context.hasRequirementSignal(text) ||
    context.hasStandaloneRequirementLanguage(text)
  );
}

export function generatedStructureTextHeading(
  value: string,
  context: RequirementCorpusParserContext,
) {
  const lines = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizePageText(line))
    .filter(Boolean);

  const numberedHeading = lines.find(
    (line) =>
      /^\d+(?:\.\d+)*\.?\s+\S/.test(line) &&
      context.isLikelyHeadingLine(line) &&
      !isGeneratedInstructionOrRequirementLine(line, context),
  );
  if (numberedHeading) {
    return context.cleanHeadingCandidate(numberedHeading);
  }

  const sectionHeading = lines.find(
    (line) =>
      isGeneratedKravSectionHeading(line) ||
      (context.isLikelyHeadingLine(line) &&
        !isGeneratedInstructionOrRequirementLine(line, context)),
  );

  return sectionHeading ? context.cleanHeadingCandidate(sectionHeading) : "";
}

function generatedPriorityCommentPattern() {
  return /(?:Må|Bør|Kan)\s+(?:Gjelder\s+produksjonsløsning|Dokumentasjon\s+ønskes|Krever\s+løsningsforslag|Må\s+avklares\s+i\s+designfase|Kan\s+prises\s+som\s+opsjon|Besvares\s+av\s+leverandør)/i;
}

function generatedPdfPriorityCommentLine(value: string) {
  return /^(?:Må\??|Bør|Kan|Skal|Opsjon|Avklares)\s+(?:Gjelder\s+produksjonsløsning|Dokumentasjon\s+ønskes|Krever\s+løsningsforslag|Må\s+avklares\s+i\s+designfase|Kan\s+prises\s+som\s+opsjon|Besvares\s+av\s+leverandør|kunden\s+ønsker\s+forslag|gjelder\s+fase\s+1\??|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|må\s+prises)\b/i.test(
    normalizePageText(value),
  );
}

const GENERATED_PDF_EXPLICIT_ID_START = String.raw`(?:P\d{3}\s*[- ]\s*[A-ZÆØÅ]{1,8}\s*[- ]?\s*\d{1,5}|P\d{3}\s*[- ]\s*\d{1,5}|\d{2,4}\s*\/\s*\d{1,3}|[A-ZÆØÅ]\d?\s*-\s*\d{1,3}|[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}|[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\s*\d{1,5}|(?:K|R|KR|TEK|REQ|Pkt)\s*[- ]?\s*\d{1,5}|[A-ZÆØÅ]{2,8}\s*-\s*\d{1,5})`;
const GENERATED_PDF_REQUIREMENT_START_PATTERN = new RegExp(
  String.raw`^(?:\[` +
    GENERATED_PDF_EXPLICIT_ID_START +
    String.raw`\]|` +
    GENERATED_PDF_EXPLICIT_ID_START +
    String.raw`(?![A-ZÆØÅ])|se\s+notat\b|mangler\s+ID\b|ikke\s+satt\b|uten\s+nr\.?\b|NB\b|Notat\s*-|Avklaring\s*:|Implisitt\s*:|\[(?:x|\?)\]|\?:|[x?]\s*(?::|\s+(?=\p{Lu})))`,
  "iu",
);

function generatedPdfLineIsIgnorable(value: string) {
  const text = normalizePageText(value);
  return (
    !text ||
    /^•$/.test(text) ||
    /^\[\[SIDE:\d+.*\]\]$/i.test(text) ||
    /^ID\s*\/\s*markering\s+(?:Krav\s+)?Prioritet\s+Kravtekst\b/i.test(text) ||
    /^ID\s*\/\s*markering\s+Krav\s+Prioritet\s+Merknad$/i.test(text) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar$/i.test(text) ||
    /^s\s+svar$/i.test(text) ||
    /^Ref\s+Hva\s+er\s+sagt\s*\/\s*(?:ønsket|onsket)\s+Må\s*\/\s*Bør\?\s+Kommentar$/i.test(
      text,
    ) ||
    /^Denne\s+delen\s+kombinerer\s+tabellrader\b/i.test(text) ||
    /^Denne\s+delen\s+består\s+av\s+rå\s+innspill\b/i.test(text) ||
    /^Svarformat$/i.test(text) ||
    /^Leverandøren\s+skal\s+besvare\s+kravene\b/i.test(text) ||
    /^Kravene\s+er\s+hentet\b/i.test(text) ||
    /^Kravene\s+(?:under|i\s+denne\s+delen)\b/i.test(text) ||
    /^Dersom\s+et\s+krav\b/i.test(text) ||
    /^Bilag\s+2\b/i.test(text) ||
    /^Prosjektkode\s*:/i.test(text) ||
    /^Kunde\b/i.test(text) ||
    /^Behovsområde\b/i.test(text) ||
    /^Dagens\s+kilder\b/i.test(text) ||
    /^Viktige\s+integrasjoner\b/i.test(text)
  );
}

function generatedPdfLineIsRequirementBoundary(value: string) {
  const text = normalizePageText(value);
  return (
    /^Krav\s+registrert\s+i\s+tabell\b/i.test(text) ||
    /^Punktkrav\s+som\s+skal\s+besvares:?$/i.test(text) ||
    /^Notater\s+som\s+skal\s+tolkes\s+som\s+krav:?$/i.test(text) ||
    /^Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet:?$/i.test(text) ||
    /^ID\s*\/\s*markering\s+(?:Krav\s+)?Prioritet\s+Kravtekst\b/i.test(text) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar$/i.test(text) ||
    /^s\s+svar$/i.test(text)
  );
}

type GeneratedPdfSectionKind =
  | "general"
  | "table"
  | "point"
  | "text"
  | "note"
  | "clarification";

function generatedPdfBoundaryKind(
  value: string,
): Exclude<GeneratedPdfSectionKind, "general" | "text"> | null {
  const text = normalizePageText(value);
  if (
    /^Krav\s+registrert\s+i\s+tabell\b/i.test(text) ||
    /^ID\s*\/\s*markering\s+(?:Krav\s+)?Prioritet\s+Kravtekst\b/i.test(text)
  ) {
    return "table";
  }
  if (/^Punktkrav\s+som\s+skal\s+besvares:?$/i.test(text)) {
    return "point";
  }
  if (/^Notater\s+som\s+skal\s+tolkes\s+som\s+krav:?$/i.test(text)) {
    return "note";
  }
  if (
    /^Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet:?$/i.test(text) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar$/i.test(text)
  ) {
    return "clarification";
  }

  return null;
}

function generatedPdfInlineSectionKind(
  value: string,
): GeneratedPdfSectionKind | null {
  const text = normalizePageText(value);
  if (
    /^Krav\s+uten\s+egen\s+tabellrad:/i.test(text) ||
    /^Fra\s+arbeidsnotatet:/i.test(text)
  ) {
    return "text";
  }
  if (/^(?:Notat\s+fra\s+behovsarbeidet|Notat)\s*[:\-]/i.test(text)) {
    return "note";
  }
  if (/^(?:Avklaring|Implisitt)\s*:/i.test(text)) {
    return "clarification";
  }

  return null;
}

function generatedPdfTableRowStartPattern() {
  return new RegExp(
    String.raw`^(?:` +
      GENERATED_PDF_EXPLICIT_ID_START +
      String.raw`(?![A-ZÆØÅ])|(?:[\u2022\uF0B7*–—-]\s*)?(?:(?:x|\?|ikke\s+satt|mangler\s+ID|NB)\s+)?(?:Må\??|Bør|Kan|Skal|Opsjon|Avklares)\s+(?=\p{Lu}))`,
    "iu",
  );
}

function generatedPdfPointRowStartPattern() {
  return new RegExp(
    String.raw`^[\u2022\uF0B7*–—-]\s*(?:` +
      GENERATED_PDF_EXPLICIT_ID_START +
      String.raw`|x|\?)\s*(?::|[-–—]|\s+)`,
    "iu",
  );
}

function generatedPdfFallbackKind(sectionKind: GeneratedPdfSectionKind) {
  switch (sectionKind) {
    case "table":
      return "Tabellkrav";
    case "point":
      return "Punktkrav";
    case "text":
      return "Tekstkrav";
    case "note":
      return "Notatkrav";
    case "clarification":
      return "Avklaringskrav";
    default:
      return "";
  }
}

function generatedPdfFallbackId(
  sectionKind: GeneratedPdfSectionKind,
  counts: Map<string, number>,
) {
  const kind = generatedPdfFallbackKind(sectionKind);
  if (!kind) {
    return "";
  }

  const next = (counts.get(kind) ?? 0) + 1;
  counts.set(kind, next);
  return `${kind}-${String(next).padStart(2, "0")}`;
}

function stripGeneratedDocumentFooter(value: string) {
  return value
    .replace(
      /\b[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+){0,8}\s+-\s+Bilag\s+2\b/giu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stripGeneratedRequirementIdChrome(value: string) {
  return normalizePageText(value)
    .replace(/^\s*\[P\d{3}\s*[- ]\s*\d{1,5}\]\s*/iu, "")
    .replace(/^\s*P\d{3}\s*[- ]\s*\d{1,5}\s*(?:[:.)]|[-–—])?\s*/iu, "")
    .replace(/^\s*\[\d{2,4}\s*\/\s*\d{1,3}\]\s*/u, "")
    .replace(/^\s*\d{2,4}\s*\/\s*\d{1,3}\s*(?:[:.)]|[-–—])?\s*/u, "")
    .replace(/^\s*\[[A-ZÆØÅ]\d?\s*-\s*\d{1,3}\]\s*/iu, "")
    .replace(/^\s*[A-ZÆØÅ]\d?\s*-\s*\d{1,3}\s*(?:[:.)]|[-–—])?\s*/iu, "")
    .replace(/^\s*\[[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}\]\s*/iu, "")
    .replace(/^\s*[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}\s*(?:[:.)]|[-–—])?\s*/iu, "")
    .replace(
      /^\s*\[(?:P\d{3}\s*[- ]\s*)?(?:[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\d{1,5}|(?:[A-ZÆØÅ]{1,8}|Pkt)\s*[- ]?\s*\d{1,5})\]\s*/iu,
      "",
    )
    .replace(
      /^\s*(?:P\d{3}\s*[- ]\s*)?(?:[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\d{1,5}|(?:[A-ZÆØÅ]{1,8}|Pkt)\s*[- ]?\s*\d{1,5})\s*(?:[:.)]|[-–—])?\s*/u,
      "",
    )
    .replace(
      /^\s*\[(?:se\s+notat|uten\s+nr\.?|må\s+avklares|rad\s+i\s+tabell|ikke\s+satt|x|\?)\]\s*/iu,
      "",
    )
    .replace(
      /^\s*(?:se\s+notat|uten\s+nr\.?|må\s+avklares|rad\s+i\s+tabell|ikke\s+satt|x|\?)\s*(?:[:.)]|[-–—])\s*/iu,
      "",
    )
    .replace(
      /^\s*(?:se\s+notat|uten\s+nr\.?|må\s+avklares|rad\s+i\s+tabell|ikke\s+satt|x|\?)\s+(?=\p{Lu})/iu,
      "",
    )
    .replace(/^\s*(?:mangler\s+ID|NB)\s*(?:[:.)]|[-–—])?\s*/iu, "")
    .replace(
      /^\s*(?:Krav\s+uten\s+egen\s+tabellrad|Notater\s+som\s+skal\s+tolkes\s+som\s+krav)\s*:\s*/iu,
      "",
    )
    .replace(/^(?:Må|Bør|Kan|Skal|Opsjon|Avklares)\s+(?=\p{Lu})/iu, "")
    .replace(
      /^\s*se\s+notat\s+(?=(?:rapport|integrasjon|data|sikkerhet|drift|bruker|uklart)\b)/iu,
      "",
    )
    .trim();
}

export function repairGeneratedTextArtifacts(value: string) {
  return value
    .replace(
      /(?<![\p{L}\p{N}])leverandør\s+er(?![\p{L}\p{N}])/giu,
      "leverandører",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stripGeneratedPdfRefTableChrome(value: string) {
  return normalizePageText(value)
    .replace(
      /^(?:rapport|integrasjon|data|sikkerhet|drift|bruker|uklart)\s+(?=(?:Leverandøren|Tilbyder|Kunden|Løsningen|Tjenesten|Systemet|Plattformen|Det|API-er|Masterdata)\b)/iu,
      "",
    )
    .replace(
      /\bskal\s+ta\s+(?:Må\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+høyde\b/giu,
      "skal ta høyde",
    )
    .replace(
      /(?:Må\??|Bør|Avklares|Opsjon)(?:\s+(?:gjelder\s+fase\s+1\?|henger\s+sammen\s+med(?:\s+annet\s+punkt)?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises))*\s+(?=(?:tydelig|dokumenteres|under|uten|kunne|skal|måles|med|gjennomføres|lagre|overvåking|hente|høyde|planlagt|brukes|rapportgrunnlag|avbrudd|revisjon|testmiljø|produksjonsmiljø|kontrollert))/giu,
      "",
    )
    .replace(
      /\b(?:henger\s+sammen\s+med|annet\s+punkt|gjelder\s+fase\s+1\?|fase\s+1\?|ikke\s+ferdig\s+formulert|kunden\s+ønsker\s+forslag|må\s+prises)\b/giu,
      " ",
    )
    .replace(/\bfase\s+1\?\s*/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGeneratedPdfRequirementText(
  value: string,
  context: RequirementCorpusParserContext,
) {
  return repairGeneratedTextArtifacts(
    stripGeneratedDocumentFooter(
      stripGeneratedPriorityComment(
        context.stripAnswerTextFromRequirement(
          stripGeneratedRequirementIdChrome(
            context.stripRequirementChrome(stripGeneratedRequirementIdChrome(value)),
          ),
        ),
      )
        .replace(/\s+(?:Må|Bør|Kan)\s+Gjelder\s+/gi, " ")
        .replace(/\s+produksjonsløsning\b/gi, "")
        .replace(/^Notat\s*-\s*(?=Notat\s+fra\s+behovsarbeidet\s*:)/i, "")
        .replace(/^(?:Avklaring|Implisitt)\s*:\s*/i, "")
        .replace(/\bID\s*\/\s*markering\s+Krav\s+Prioritet\s+Merknad\b.*$/i, "")
        .replace(/\bID\s*\/\s*markering\s+(?:Krav\s+)?Prioritet\s+Kravtekst\b.*$/i, "")
        .replace(/\bMarkering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar\b.*$/i, "")
        .replace(/\bDenne\s+delen\s+kombinerer\s+tabellrader\b.*$/i, "")
        .replace(/\bSkal\s+besvares\b/gi, " ")
        .replace(/^(.+)$/u, (_match, text) =>
          stripGeneratedPdfRefTableChrome(text),
        )
        .replace(/\s+/g, " ")
        .trim(),
    ),
  );
}

function startsGeneratedPdfRequirementRow(
  line: string,
  currentRawText: string,
  context: RequirementCorpusParserContext,
  sectionKind: GeneratedPdfSectionKind,
) {
  const text = normalizePageText(line);
  if (generatedPdfLineIsIgnorable(text) || isGeneratedKravSectionHeading(text)) {
    return false;
  }
  if (generatedPdfPriorityCommentLine(text)) {
    return false;
  }

  const hasStrongMarkerStart =
    GENERATED_PDF_REQUIREMENT_START_PATTERN.test(text) ||
    /^Krav\s+uten\s+egen\s+tabellrad:/i.test(text) ||
    /^(?:Fra\s+arbeidsnotatet|Notat\s+fra\s+behovsarbeidet|Notat|Avklaring|Implisitt)\s*[:\-]/i.test(
      text,
    ) ||
    generatedPdfPointRowStartPattern().test(text);
  if (hasStrongMarkerStart) {
    return true;
  }

  if (sectionKind === "table") {
    return generatedPdfTableRowStartPattern().test(text);
  }

  if (sectionKind === "text") {
    return false;
  }

  if (
    currentRawText &&
    (sectionKind === "note" || sectionKind === "clarification")
  ) {
    return false;
  }

  const candidate = cleanGeneratedPdfRequirementText(text, context);
  if (!isMixedRequirementLineCandidate(candidate, context)) {
    return false;
  }

  if (!currentRawText) {
    return true;
  }

  const currentCleaned = cleanGeneratedPdfRequirementText(
    currentRawText,
    context,
  );
  return (
    /[.!?]$/.test(currentCleaned) ||
    generatedPriorityCommentPattern().test(currentRawText)
  );
}

function generatedPdfHeadingForLine(
  line: string,
  context: RequirementCorpusParserContext,
) {
  const heading = generatedStructureTextHeading(line, context);
  const cleaned = context.cleanHeadingCandidate(heading || line);
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const hasDisallowedHeadingPunctuation =
    /[!?]/.test(cleaned) ||
    (/\./.test(cleaned) && !/^\d+(?:\.\d+)*\.?\s+\S/.test(cleaned));
  const isTitleShaped =
    cleaned.length >= 4 &&
    cleaned.length <= 90 &&
    wordCount <= 10 &&
    /^[A-ZÆØÅ0-9]/.test(cleaned) &&
    !hasDisallowedHeadingPunctuation &&
    !/:$/.test(cleaned) &&
    !generatedPdfLineIsIgnorable(cleaned) &&
    !generatedPdfLineIsRequirementBoundary(cleaned) &&
    !generatedPdfPriorityCommentLine(cleaned) &&
    !/^(?:Må\??|Bør|Kan|Skal|Opsjon|Avklares)\s+\S/i.test(cleaned) &&
    !context.detectExplicitRequirementIds(cleaned).length &&
    !/^(?:Kunden|Leverandøren|Tilbyder|Oppdragstaker|Avtalepart|Leveransen|Løsningen|Tjenesten|Systemet|Plattformen|Konfigurasjonen)\b.{0,160}\b(?:skal|må|bør|kan|bes)\b/i.test(
      cleaned,
    ) &&
    !context.hasStandaloneRequirementLanguage(cleaned);

  if (heading && !generatedPdfLineIsIgnorable(line) && isTitleShaped) {
    return cleaned;
  }

  if (!heading && isTitleShaped) {
    return cleaned;
  }

  return "";
}

export function buildGeneratedPdfRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  if (
    document.file_format !== "pdf" ||
    !isGeneratedKravspesifikasjonCorpus(document)
  ) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let current:
    | {
        rawLines: string[];
        sourceLines: string[];
        pages: number[];
        heading: string;
        order: number;
        sectionKind: GeneratedPdfSectionKind;
      }
    | null = null;
  let heading = "";
  let sectionKind: GeneratedPdfSectionKind = "general";
  let sequence = 0;
  const fallbackCounts = new Map<string, number>();
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;

  function flushCurrent() {
    if (!current) {
      return;
    }

    const rawText = current.rawLines.join(" ");
    const text = cleanGeneratedPdfRequirementText(rawText, context);
    if (
      isMixedRequirementLineCandidate(text, context) &&
      !isMixedRequirementBoilerplate(text)
    ) {
      sequence += 1;
      const explicitId = context.detectExplicitRequirementIds(rawText)[0] ?? "";
      const fallbackId =
        explicitId ||
        generatedPdfFallbackId(current.sectionKind, fallbackCounts) ||
        `Dokumenttekst krav ${sequence}`;
      requirements.push({
        id: fallbackId,
        text,
        pages: current.pages,
        heading: current.heading,
        tableId: explicitId ? "PDF krav-ID" : "Dokumenttekst",
        sourceExcerpt: current.sourceLines.join(" "),
        documentEntryOrder: current.order,
      });
    }

    current = null;
  }

  for (const page of context.splitDocumentPagesForRequirementScan(document)) {
    const lines = page.text
      .replace(/\r\n/g, "\n")
      .split(/\n+/)
      .map((line) => normalizePageText(line));

    for (const line of lines) {
      const lineHeading = generatedPdfHeadingForLine(line, context);
      if (lineHeading) {
        flushCurrent();
        heading = lineHeading;
        sectionKind = "general";
        continue;
      }

      const boundaryKind = generatedPdfBoundaryKind(line);
      if (boundaryKind || generatedPdfLineIsRequirementBoundary(line)) {
        flushCurrent();
        sectionKind = boundaryKind ?? sectionKind;
        continue;
      }

      if (generatedPdfLineIsIgnorable(line)) {
        continue;
      }

      const startsNewRow = startsGeneratedPdfRequirementRow(
        line,
        current?.rawLines.join(" ") ?? "",
        context,
        generatedPdfInlineSectionKind(line) ?? sectionKind,
      );
      if (startsNewRow) {
        flushCurrent();
        sectionKind = generatedPdfInlineSectionKind(line) ?? sectionKind;
        const sourceOrderOffset = findRequirementOrderOffset(
          normalizedRawText,
          line,
          sourceOrderCursor,
        );
        const documentEntryOrder =
          sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
        if (sourceOrderOffset !== null) {
          sourceOrderCursor =
            sourceOrderOffset + normalizedRequirementOrderSearchText(line).length;
        }
        current = {
          rawLines: [line],
          sourceLines: [line],
          pages: [page.page],
          heading,
          order: documentEntryOrder,
          sectionKind,
        };
        continue;
      }

      if (current) {
        current.rawLines.push(line);
        current.sourceLines.push(line);
        if (!current.pages.includes(page.page)) {
          current.pages.push(page.page);
        }
      }
    }
  }

  flushCurrent();
  return context.dedupeRequirementLedger(requirements);
}

export function buildMixedTextRequirementLedger(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  if (!isGeneratedKravspesifikasjonCorpus(document)) {
    return [];
  }

  const requirements: RequirementLedgerEntry[] = [];
  let sequence = 0;
  const normalizedRawText = normalizedRequirementOrderSearchText(
    document.raw_text,
  );
  let sourceOrderCursor = 0;
  let fallbackDocumentEntryOrder = 1_000_000;
  let activeHeading = "";
  let sectionKind: GeneratedPdfSectionKind = "general";
  const fallbackCounts = new Map<string, number>();

  for (const page of context.splitDocumentPagesForRequirementScan(document)) {
    const lines = page.text
      .replace(/\r\n/g, "\n")
      .split(/\n+/)
      .map((line) => ({
        raw: line,
        text: normalizePageText(line),
      }))
      .map((line) => ({
        ...line,
        rawText: normalizePageText(line.raw),
      }))
      .filter(Boolean);

    for (const lineEntry of lines) {
      const line = lineEntry.text;
      const boundaryKind = generatedPdfBoundaryKind(line);
      if (boundaryKind) {
        sectionKind = boundaryKind;
        continue;
      }

      const heading = generatedStructureTextHeading(lineEntry.raw, context);
      if (heading) {
        activeHeading = heading;
        sectionKind = "general";
        continue;
      }

      if (
        isMixedRequirementBoilerplate(line) ||
        /^Rad\s+\d{1,4}\s*:/i.test(line)
      ) {
        continue;
      }

      const text = normalizeMixedRequirementLine(line, context);
      const inlineSectionKind = generatedPdfInlineSectionKind(line);
      if (inlineSectionKind) {
        sectionKind = inlineSectionKind;
      }
      if (!isMixedRequirementLineCandidate(text, context)) {
        continue;
      }

      sequence += 1;
      const explicitId = context.detectExplicitRequirementIds(line)[0] ?? "";
      const sourceOrderOffset =
        findRequirementOrderOffset(
          normalizedRawText,
          lineEntry.rawText || line,
          sourceOrderCursor,
        ) ??
        findRequirementOrderOffset(normalizedRawText, text, sourceOrderCursor);
      const documentEntryOrder =
        sourceOrderOffset ?? (fallbackDocumentEntryOrder += 1);
      if (sourceOrderOffset !== null) {
        sourceOrderCursor =
          sourceOrderOffset +
          normalizedRequirementOrderSearchText(lineEntry.rawText || text).length;
      }
      requirements.push({
        id:
          explicitId ||
          generatedPdfFallbackId(sectionKind, fallbackCounts) ||
          `Dokumenttekst krav ${sequence}`,
        text,
        pages: [page.page],
        heading: activeHeading,
        tableId: explicitId ? undefined : "Dokumenttekst",
        sourceExcerpt: line,
        documentEntryOrder,
      });
    }
  }

  return requirements;
}

export function isGeneratedKravspesifikasjonCorpus(
  document: ProjectDocumentDetail,
) {
  const rawText = document.raw_text;
  if (
    /Bilag\s+2\s*-\s*Kravspesifikasjon/i.test(rawText) &&
    /\bProsjektkode\s*:\s*P\d{3}\b/i.test(rawText)
  ) {
    return true;
  }

  if (!/Bilag\s+2\s*-\s*Krav\s+til\s+leverandørens\s+løsning/i.test(rawText)) {
    return false;
  }

  const markers = [
    /\bKrav\s+registrert\s+i\s+tabell\b/i,
    /\bPunktkrav\s+som\s+skal\s+besvares\b/i,
    /\bKrav\s+uten\s+egen\s+tabellrad\b/i,
    /\bNotater\s+som\s+skal\s+tolkes\s+som\s+krav\b/i,
    /\bAvklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet\b/i,
    /\bID\s*\/\s*markering\s+Prioritet\s+Kravtekst\b/i,
  ];
  const markerHits = markers.filter((pattern) => pattern.test(rawText)).length;

  return markerHits >= 3;
}

export function hasLegacyKravFeringStructuredRows(
  document: ProjectDocumentDetail,
  context: RequirementCorpusParserContext,
) {
  if (!Array.isArray(document.structure_map)) {
    return false;
  }

  return document.structure_map.some((entry) => {
    if (!context.hasStructuredTableCells(entry)) {
      return false;
    }

    const cells = context.structureEntryCellMap(entry);
    if (
      !Object.keys(cells).some((label) =>
        /^krav\s*føring$/i.test(context.normalizeColumnLabel(label)),
      )
    ) {
      return false;
    }

    const parts = context.doclingRequirementRowParts(cells);
    return isTrustedStructuredRequirementText(parts.requirementText, context);
  });
}

export function isGeneratedFlattenedTableDump(entry: RequirementLedgerEntry) {
  const text = normalizePageText(entry.text);
  return (
    /^Tabell\s+\d+\s+Rad\s+1:\s+ID\s*\/\s*markering\s*\|\s*krav\s*\|/i.test(
      text,
    ) ||
    /^\|\s*.+\|\s*(?:Må|Bør|Kan)\s*\|.+/i.test(text) ||
    /^\|\s*.+\|\s*(?:Må|Bør|Kan)\s*\|.+\bRad\s+\d+:/i.test(text) ||
    /\bRad\s+\d+:\s+.*\|\s*(?:Må|Bør|Kan)\s*\|.*\bRad\s+\d+:/i.test(text)
  );
}
