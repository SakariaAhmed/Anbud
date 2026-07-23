const MOJIBAKE_REPAIRS: ReadonlyArray<readonly [string, string]> = [
  ["Ã¦", "æ"],
  ["Ã¸", "ø"],
  ["Ã¥", "å"],
  ["Ã†", "Æ"],
  ["Ã˜", "Ø"],
  ["Ã…", "Å"],
];

export type NorwegianParseAnomalyCode =
  | "mojibake"
  | "replacement_character"
  | "split_word"
  | "joined_party_word"
  | "spaced_requirement_id"
  | "unstructured_requirement_table";

/**
 * Conservative search normalization for Norwegian procurement text. The
 * source text is never overwritten; exact evidence remains available for
 * citations and audits.
 */
export function normalizeNorwegianTextForSearch(value: string) {
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
    .replace(/\b(Kunden|Leverandøren|Leveransen)(?=(?:og|eller|skal|må|kan|har|er)\b)/giu, "$1 ")
    .replace(/\bI\s*D\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/giu, "ID $1-$2")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

export function detectNorwegianParseAnomalies(input: {
  text: string;
  hasStructuredTables: boolean;
}) {
  const text = String(input.text ?? "");
  const anomalies = new Set<NorwegianParseAnomalyCode>();
  if (/Ã[¦¸¥†˜…]/u.test(text)) anomalies.add("mojibake");
  if (text.includes("�")) anomalies.add("replacement_character");
  if (/\b(?:L\s+everans|L\s+everandør|K\s+unden|leverandør\s+en|arbeids\s+stasjon)/iu.test(text)) {
    anomalies.add("split_word");
  }
  if (/\b(?:Kunden|Leverandøren|Leveransen)(?:og|eller|skal|må|kan|har|er)\b/iu.test(text)) {
    anomalies.add("joined_party_word");
  }
  if (/\bI\s+D\s*\d{1,3}\s*[-.]\s*\d{1,3}/iu.test(text)) {
    anomalies.add("spaced_requirement_id");
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
