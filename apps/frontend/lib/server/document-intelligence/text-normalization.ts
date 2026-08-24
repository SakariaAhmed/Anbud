export function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*#>_[\](){},.:;!?'"“”‘’/\\|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MEANING_SENSITIVE_TOKENS = new Set([
  "rto",
  "rpo",
  "sla",
  "ikke",
  "ingen",
  "aldri",
  "uten",
  "not",
  "no",
  "never",
  "without",
  "sekund",
  "sekunder",
  "second",
  "seconds",
  "minutt",
  "minutter",
  "minute",
  "minutes",
  "time",
  "timer",
  "hour",
  "hours",
  "dag",
  "dager",
  "day",
  "days",
  "uke",
  "uker",
  "week",
  "weeks",
  "måned",
  "måneder",
  "month",
  "months",
  "år",
  "year",
  "years",
  "prosent",
  "percent",
  "kb",
  "mb",
  "gb",
  "tb",
  "kr",
  "nok",
  "eur",
  "usd",
  "m2",
  "m²",
]);

function meaningSensitiveTokens(value: string) {
  return normalizeComparableText(value)
    .split(" ")
    .filter(
      (token) => /\d/u.test(token) || MEANING_SENSITIVE_TOKENS.has(token),
    );
}

export function tokenizeComparableText(value: string) {
  return normalizeComparableText(value)
    .split(" ")
    .filter((token) => token.length > 2 || /\d/u.test(token));
}

// Exported for normalization threshold contract tests.
// fallow-ignore-next-line unused-export, complexity
export function similarityScore(a: string, b: string) {
  const aTokens = new Set(tokenizeComparableText(a));
  const bTokens = new Set(tokenizeComparableText(b));

  if (!aTokens.size || !bTokens.size) {
    return 0;
  }

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.min(aTokens.size, bTokens.size);
}

export function isNearDuplicate(a: string, b: string, threshold = 0.72) {
  const normalizedA = normalizeComparableText(a);
  const normalizedB = normalizeComparableText(b);

  if (!normalizedA || !normalizedB) {
    return false;
  }

  if (normalizedA === normalizedB) {
    return true;
  }

  const sensitiveA = meaningSensitiveTokens(normalizedA);
  const sensitiveB = meaningSensitiveTokens(normalizedB);
  if (
    (sensitiveA.length || sensitiveB.length) &&
    sensitiveA.join("\u0000") !== sensitiveB.join("\u0000")
  ) {
    return false;
  }

  return similarityScore(normalizedA, normalizedB) >= threshold;
}

// Exported for normalization contract tests.
// fallow-ignore-next-line unused-export
export function normalizeUniqueList(items: string[]) {
  const result: string[] = [];

  for (const rawItem of items) {
    const item = rawItem.replace(/\s+/g, " ").trim();
    if (!item) {
      continue;
    }

    if (result.some((existing) => isNearDuplicate(existing, item))) {
      continue;
    }

    result.push(item);
  }

  return result;
}

export function capNormalizedList(
  items: string[],
  options?: { max?: number },
) {
  const max = options?.max ?? 10;
  return normalizeUniqueList(items).slice(0, max);
}

export function splitIntoSentences(value: string) {
  const abbreviationDot = "__ANBUD_ABBR_DOT__";
  const protectedValue = value
    .replace(
      /\b(?:f\.eks|dvs|bl\.a|m\.m|o\.l|kl|ca|nr)\./gi,
      (match) => match.replace(/\./g, abbreviationDot),
    )
    .replace(
      /\b(\d{1,2})\.(?=\s+(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\b)/giu,
      `$1${abbreviationDot}`,
    );

  return protectedValue
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replaceAll(abbreviationDot, "."))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function dedupeSummary(value: string, references: string[]) {
  const paragraphs = value
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph.replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim(),
    )
    .filter(Boolean);

  if (!paragraphs.length) {
    return value.replace(/\s+/g, " ").trim();
  }

  const keptParagraphs = paragraphs
    .map((paragraph) => {
      const sentences = splitIntoSentences(paragraph);
      if (!sentences.length) {
        return paragraph;
      }

      const keptSentences = sentences.filter((sentence) => {
        return !references.some((reference) =>
          isNearDuplicate(sentence, reference, 0.76),
        );
      });

      return keptSentences.join(" ").replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);

  return (keptParagraphs.length ? keptParagraphs : paragraphs)
    .join("\n\n")
    .trim();
}
