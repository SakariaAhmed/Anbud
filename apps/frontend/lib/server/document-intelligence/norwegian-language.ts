const MOJIBAKE_REPAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Ã¦", "æ"],
  ["Ã¸", "ø"],
  ["Ã¥", "å"],
  ["Ã†", "Æ"],
  ["Ã˜", "Ø"],
  ["Ã…", "Å"],
];

export type NorwegianLanguageDiagnostic =
  | "mojibake"
  | "replacement_character"
  | "soft_hyphen"
  | "split_word"
  | "joined_party_word"
  | "spaced_requirement_id"
  | "space_before_punctuation"
  | "missing_space_after_punctuation"
  | "unbalanced_brackets"
  | "unbalanced_quotes"
  | "lowercase_sentence_start"
  | "missing_terminal_punctuation"
  | "unstructured_requirement_table";

// Exported for parser diagnostics consumed by evaluation tooling.
// fallow-ignore-next-line unused-type
export type NorwegianParseAnomalyCode = Extract<
  NorwegianLanguageDiagnostic,
  | "mojibake"
  | "replacement_character"
  | "split_word"
  | "joined_party_word"
  | "spaced_requirement_id"
  | "unstructured_requirement_table"
>;

function count(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}

export function diagnoseNorwegianDocumentText(
  value: string,
  options: { sentenceLike?: boolean } = {},
) {
  const text = String(value ?? "");
  const diagnostics = new Set<NorwegianLanguageDiagnostic>();
  if (/Ã[¦¸¥†˜…]/u.test(text)) diagnostics.add("mojibake");
  if (text.includes("�")) diagnostics.add("replacement_character");
  if (/\u00AD|\u200B|\uFEFF/u.test(text)) diagnostics.add("soft_hyphen");
  if (
    /\b(?:L\s+everans|L\s+everandør|K\s+unden|leverandør\s+en|arbeids\s+stasjon)\b/iu.test(
      text,
    )
  ) {
    diagnostics.add("split_word");
  }
  if (
    /\b(?:Kunden|Leverandøren|Leveransen)(?:og|eller|skal|må|kan|har|er)\b/iu.test(
      text,
    )
  ) {
    diagnostics.add("joined_party_word");
  }
  if (/\bI\s+D\s*\d{1,3}\s*[-.]\s*\d{1,3}/iu.test(text)) {
    diagnostics.add("spaced_requirement_id");
  }
  if (/\s+[,.;:!?]/u.test(text)) {
    diagnostics.add("space_before_punctuation");
  }
  if (
    /[;!?](?=[\p{L}\p{N}])/u.test(text) ||
    /[:,](?=\p{L})/u.test(text) ||
    /\.(?=[\p{Lu}ÆØÅ])/u.test(text)
  ) {
    diagnostics.add("missing_space_after_punctuation");
  }
  if (
    count(text, /\(/gu) !== count(text, /\)/gu) ||
    count(text, /\[/gu) !== count(text, /\]/gu)
  ) {
    diagnostics.add("unbalanced_brackets");
  }
  if (
    count(text, /«/gu) !== count(text, /»/gu) ||
    count(text, /"/gu) % 2 !== 0
  ) {
    diagnostics.add("unbalanced_quotes");
  }
  if (options.sentenceLike && /^\s*[\p{Ll}æøå]/u.test(text)) {
    diagnostics.add("lowercase_sentence_start");
  }
  if (
    options.sentenceLike &&
    /[\p{L}\p{N}\)\]»]\s*$/u.test(text) &&
    !/[.:;!?]\s*$/u.test(text)
  ) {
    diagnostics.add("missing_terminal_punctuation");
  }
  return [...diagnostics];
}

function repairKnownNorwegianArtifacts(value: string) {
  let text = String(value ?? "").normalize("NFKC");
  for (const [broken, repaired] of MOJIBAKE_REPAIRS) {
    text = text.replaceAll(broken, repaired);
  }
  return text
    .replace(/[\u00AD\u200B\uFEFF]/gu, "")
    .replace(/([\p{Ll}æøå])[-‐‑]\s*\n\s*([\p{Ll}æøå])/gu, "$1$2")
    .replace(
      /\b([LK])\s+(everans(?:e|en|ens)|everandør(?:en|ens)?|unden|undens)\b/gu,
      "$1$2",
    )
    .replace(
      /\b(Kunden|Leverandøren|Leveransen)(?=(?:og|eller|skal|må|kan|har|er)\b)/giu,
      "$1 ",
    )
    .replace(
      /\bI\s*D\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/giu,
      "ID $1-$2",
    )
    .replace(/[‐‑]/gu, "-")
    .replace(/[‒—]/gu, "–")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([;!?])(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/([:,])(?=\p{L})/gu, "$1 ")
    .replace(/\.(?=[\p{Lu}ÆØÅ])/gu, ". ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .replace(/\s*\n\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function canonicalizeNorwegianDocumentText(
  value: string,
  options: { sentenceLike?: boolean } = {},
) {
  let text = repairKnownNorwegianArtifacts(value);
  if (options.sentenceLike && /^\p{Ll}/u.test(text)) {
    text = `${text[0]?.toLocaleUpperCase("nb-NO") ?? ""}${text.slice(1)}`;
  }
  if (
    options.sentenceLike &&
    /[\p{L}\p{N}\)\]»]$/u.test(text) &&
    !/[.:;!?]$/u.test(text)
  ) {
    text = `${text}.`;
  }
  return text;
}

/**
 * Search text is a derived projection. Verbatim source evidence is never
 * overwritten or passed through this function.
 */
export function normalizeNorwegianTextForSearch(value: string) {
  return canonicalizeNorwegianDocumentText(value).replace(/[‐‑‒–—]/gu, "-");
}

/**
 * Conservative cleanup for model-generated prose. Callers must skip verbatim
 * excerpts, source references, signal words and Mermaid code.
 */
export function normalizeGeneratedNorwegianProse(value: string) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(
      /(\d),[ \t]+(\d{1,3})(?=[ \t]*(?:prosent|million(?:er)?|milliard(?:er)?|timer?|minutter?|sekunder?|kroner?|kr\b|%))/giu,
      "$1,$2",
    )
    .replace(
      /\b(USD|EUR)\s+(\d+)[.](\d+)\s+million\b/giu,
      "$1 $2,$3 millioner",
    )
    .replace(/\b(USD|EUR)\s+(\d+)\s+million\b/giu, "$1 $2 millioner")
    .replace(/\bkl[.]?\s+(\d{1,2}):(\d{2})\b/giu, "kl. $1.$2")
    .replace(/(\d)[ \t]*%/gu, "$1 prosent")
    .replace(/([;!?])(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/([:,])(?=\p{L})/gu, "$1 ")
    .replace(/([\p{Ll}\p{N}\)\]»])\.(?=[\p{Lu}ÆØÅ])/gu, "$1. ")
    .replace(
      /(\bUtløser:\s+)(?!(?:dersom|hvis|når|fordi)\b)([^.!?\n]{1,180}?)\s+ikke\s+(rettes|avklares|leveres|oppfylles|dokumenteres|verifiseres|gjennomføres|etableres|sikres|varsles|beskrives|følges|støttes|håndteres|lagres|behandles|kan|skal|må|vil|er|blir|har)\b/giu,
      "$1$2 $3 ikke",
    )
    .replace(
      /(\b(?:andel(?:en)?|nivå(?:et)?|rate(?:n)?|antall(?:et)?|volum(?:et)?)[^.!?\n]{0,140}\bsom\s+(?:må|skal|bør|kan)\s+[\p{L}-]+(?:es|eres))\s+(?=fra\s+\d[\d\s,.]*(?:prosent|%|million(?:er)?|milliard(?:er)?)?\s+til\b)/giu,
      "$1, ",
    )
    .replace(
      /(\b(?:hva|hvilke|hvordan|hvem|hvor|når)\b[^.!?\n]{1,180}?)(?<!,)\s+og\s+(?=(?:hva|hvilke|hvordan|hvem|hvor|når)\b)/giu,
      "$1, og ",
    )
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
}

export function detectNorwegianParseAnomalies(input: {
  text: string;
  hasStructuredTables: boolean;
}) {
  const text = String(input.text ?? "");
  const anomalies = new Set<NorwegianParseAnomalyCode>();
  for (const diagnostic of diagnoseNorwegianDocumentText(text)) {
    if (
      diagnostic === "mojibake" ||
      diagnostic === "replacement_character" ||
      diagnostic === "split_word" ||
      diagnostic === "joined_party_word" ||
      diagnostic === "spaced_requirement_id"
    ) {
      anomalies.add(diagnostic);
    }
  }

  const requirementIds =
    normalizeNorwegianTextForSearch(text).match(
      /\b(?:ID\s*)?[A-ZÆØÅ]{0,8}\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/giu,
    )?.length ?? 0;
  if (requirementIds >= 4 && !input.hasStructuredTables) {
    anomalies.add("unstructured_requirement_table");
  }
  return [...anomalies];
}
