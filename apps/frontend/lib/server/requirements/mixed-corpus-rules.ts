import { normalizePageText } from "@/lib/server/requirements/pdf-normalization";
import type { RequirementCorpusParserContext } from "@/lib/server/requirements/corpus-parser-context";

export function isTrustedStructuredRequirementText(
  value: string,
  context: RequirementCorpusParserContext,
) {
  const text = normalizePageText(value);
  if (text.length < 18 || text.length > 1200) {
    return false;
  }

  if (
    /^(?:krav|requirement\s*text|hva\s+er\s+sagt\s*\/\s*ønsket|hva\s+er\s+sagt\s*\/\s*onsket)$/i.test(
      text,
    )
  ) {
    return false;
  }

  return (
    context.hasRequirementSignal(text) ||
    context.hasStandaloneRequirementLanguage(text) ||
    /^Brukere\s+som\b/i.test(text) ||
    /^Alle\s+endringer\b/i.test(text)
  );
}

export function normalizedRequirementOrderSearchText(value: string) {
  return normalizePageText(value).toLocaleLowerCase("nb");
}

export function findRequirementOrderOffset(
  normalizedRawText: string,
  value: string,
  cursor: number,
) {
  const needle = normalizedRequirementOrderSearchText(value);
  if (!needle) {
    return null;
  }

  const directIndex = normalizedRawText.indexOf(needle, cursor);
  if (directIndex >= 0) {
    return directIndex;
  }

  const leadWords = needle.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
  if (leadWords.length >= 24) {
    const leadIndex = normalizedRawText.indexOf(leadWords, cursor);
    if (leadIndex >= 0) {
      return leadIndex;
    }
  }

  return null;
}

export function isMixedRequirementBoilerplate(value: string) {
  const text = normalizePageText(value);
  return (
    !text ||
    /^Bilag\s+2\b/i.test(text) ||
    /^Kunde\s*:/i.test(text) ||
    /^Prosjektkode\s*:/i.test(text) ||
    /^Leverandøren\s+skal\s+besvare\s+kravene\b/i.test(text) ||
    /^Kravene\s+er\s+hentet\b/i.test(text) ||
    /^Kravene\s+(?:under|i\s+denne\s+delen)\b/i.test(text) ||
    /^Dersom\s+et\s+krav\b/i.test(text) ||
    /^Denne\s+delen\b/i.test(text) ||
    /^Tabell\s+\d{1,4}\b/i.test(text) ||
    /^Rad\s+\d{1,4}\s*:/i.test(text) ||
    /^Krav\s+registrert\s+i\s+tabell$/i.test(text) ||
    /^Punktkrav\s+som\s+skal\s+besvares:?$/i.test(text) ||
    /^Krav\s+uten\s+egen\s+tabellrad:?$/i.test(text) ||
    /^Notater\s+som\s+skal\s+tolkes\s+som\s+krav:?$/i.test(text) ||
    /^Avklaringer\/innspill\s+som\s+inngår\s+i\s+kravbildet:?$/i.test(text) ||
    /^Notatene\s+under\s+er\s+samlet\b/i.test(text) ||
    /^Markering\s+Avklaring\s*\/\s*kravnotat\s+Kommentar$/i.test(text) ||
    /^(?:ID\s*\/\s*markering|Ref)\s+Krav\s+Prioritet/i.test(text) ||
    /^(?:Prioritert\s+kravtabell|Punktliste\s+fra\s+workshop|Datadeling\s+og\s+grensesnitt|Drift\s+og\s+support|Notater\s+fra\s+fagansvarlige|Åpne\s+avklaringer|Løse\s+krav\s+fra\s+behovsmøte|Tabell\s+som\s+må\s+ryddes|Kommentarer\s+fra\s+drift|Uavklarte,\s*men\s+viktige\s+punkter|Tekstutdrag\s+fra\s+bestiller)$/i.test(
      text,
    ) ||
    /^(?:Ting\s+som\s+ikke\s+må\s+glemmes|Ikke\s+glem\s+dette)$/i.test(text)
  );
}

export function isMixedRequirementLineCandidate(
  value: string,
  context: RequirementCorpusParserContext,
) {
  const text = normalizePageText(value);
  if (text.length < 18 || text.length > 1000) {
    return false;
  }

  if (isMixedRequirementBoilerplate(text)) {
    return false;
  }

  return (
    context.hasRequirementSignal(text) ||
    context.hasStandaloneRequirementLanguage(text) ||
    /^Brukere\s+som\b/i.test(text) ||
    /^Alle\s+endringer\b/i.test(text) ||
    /^(?:Notat\s+fra\s+behovsarbeidet|Avklaring|Implisitt)\s*:/i.test(text)
  );
}
