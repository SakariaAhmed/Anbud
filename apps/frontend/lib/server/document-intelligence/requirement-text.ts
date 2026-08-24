import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

const PLACEHOLDER_TEXT =
  /\b(?:mangler\s+ID|Punktkrav\s+som\s+skal\s+besvares|krav\s+registrert\s+i\s+tabell|Fra\s+arbeidsnotatet|Avklaringer?\/)\b/iu;

function comparableRequirementText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("nb-NO")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Replaces a truncated generated row only when a source-addressed local table
 * row starts with the exact generated text and contains a more complete value.
 */
export function preferTrustedStructuredRequirementText(
  generated: RequirementLedgerEntry,
  trustedLocal: RequirementLedgerEntry | undefined,
): RequirementLedgerEntry {
  if (!trustedLocal || trustedLocal.text.length < 12 || PLACEHOLDER_TEXT.test(trustedLocal.text)) {
    return generated;
  }
  const generatedText = comparableRequirementText(generated.text);
  const localText = comparableRequirementText(trustedLocal.text);
  const generatedContainsLocal = generatedText.includes(localText);
  const localCompletesTruncatedGenerated =
    localText.startsWith(generatedText) &&
    !/[.!?;:]$/u.test(generatedText) &&
    !/^\s*(?:[-•*]|\|)/u.test(localText.slice(generatedText.length));
  if (
    !generatedText ||
    (!generatedContainsLocal && !localCompletesTruncatedGenerated)
  ) {
    return generated;
  }
  return {
    ...generated,
    text: trustedLocal.text,
    sourceExcerpt: trustedLocal.sourceExcerpt || generated.sourceExcerpt,
    pages: trustedLocal.pages.length ? trustedLocal.pages : generated.pages,
  };
}
