import type { ProjectDocumentStructureEntry } from "@/lib/types";

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
  | "missing_terminal_punctuation";

export type CanonicalDocumentBlock = ProjectDocumentStructureEntry & {
  sourceText: string;
  canonicalText: string;
  diagnosticsBefore: NorwegianLanguageDiagnostic[];
  diagnosticsAfter: NorwegianLanguageDiagnostic[];
};

export type CanonicalDocumentProjection = {
  canonicalText: string;
  blocks: CanonicalDocumentBlock[];
  languageQuality: {
    locale: "nb-NO";
    sourcePreserved: true;
    sourceDiagnosticCount: number;
    canonicalDiagnosticCount: number;
    repairCount: number;
    score: number;
    sourceDiagnostics: NorwegianLanguageDiagnostic[];
    canonicalDiagnostics: NorwegianLanguageDiagnostic[];
  };
};

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
  if (/\b(?:L\s+everans|L\s+everandør|K\s+unden|leverandør\s+en|arbeids\s+stasjon)\b/iu.test(text)) {
    diagnostics.add("split_word");
  }
  if (/\b(?:Kunden|Leverandøren|Leveransen)(?:og|eller|skal|må|kan|har|er)\b/iu.test(text)) {
    diagnostics.add("joined_party_word");
  }
  if (/\bI\s+D\s*\d{1,3}\s*[-.]\s*\d{1,3}/iu.test(text)) {
    diagnostics.add("spaced_requirement_id");
  }
  if (/\s+[,.;:!?]/u.test(text)) diagnostics.add("space_before_punctuation");
  if (/[;,!?](?=[\p{L}\p{N}])/u.test(text) || /\.(?=[\p{Lu}ÆØÅ])/u.test(text)) {
    diagnostics.add("missing_space_after_punctuation");
  }
  if (count(text, /\(/gu) !== count(text, /\)/gu) || count(text, /\[/gu) !== count(text, /\]/gu)) {
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
    .replace(/\b(Kunden|Leverandøren|Leveransen)(?=(?:og|eller|skal|må|kan|har|er)\b)/giu, "$1 ")
    .replace(/\bI\s*D\s*(\d{1,3})\s*[-.]\s*(\d{1,3}[A-Z]?)\b/giu, "ID $1-$2")
    .replace(/[‐‑]/gu, "-")
    .replace(/[‒—]/gu, "–")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/([;,!?])(?=[\p{L}\p{N}])/gu, "$1 ")
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

function firstCell(cells: Record<string, string> | undefined, names: string[]) {
  if (!cells) return "";
  const key = Object.keys(cells).find((candidate) =>
    names.includes(candidate.trim().toLocaleLowerCase("nb-NO")),
  );
  return key ? String(cells[key] ?? "").trim() : "";
}

function canonicalBlockText(entry: ProjectDocumentStructureEntry) {
  const requirementText = firstCell(entry.cells, [
    "kravtekst",
    "krav",
    "requirement",
    "beskrivelse",
  ]);
  if (!requirementText) {
    return canonicalizeNorwegianDocumentText(entry.text);
  }

  const requirementId = firstCell(entry.cells, [
    "krav-id",
    "kravid",
    "id",
    "requirement id",
  ]);
  const priority = firstCell(entry.cells, ["prioritet", "priority"]);
  const sentence = canonicalizeNorwegianDocumentText(requirementText, {
    sentenceLike: true,
  });
  return [
    requirementId ? `Krav-ID: ${canonicalizeNorwegianDocumentText(requirementId)}` : "",
    priority ? `Prioritet: ${canonicalizeNorwegianDocumentText(priority)}` : "",
    `Kravtekst: ${sentence}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function canonicalBlockIsSentence(entry: ProjectDocumentStructureEntry) {
  return Boolean(
    firstCell(entry.cells, ["kravtekst", "krav", "requirement", "beskrivelse"]),
  );
}

export function buildCanonicalDocumentProjection(input: {
  rawText: string;
  structureMap: ProjectDocumentStructureEntry[];
  title?: string;
  parserUsed?: string;
}): CanonicalDocumentProjection {
  const sourceEntries = input.structureMap.length
    ? input.structureMap
    : input.rawText
        .split(/\n{2,}/u)
        .map((text, index): ProjectDocumentStructureEntry => ({
          reference: `${input.title || "Dokument"} – avsnitt ${index + 1}`,
          text,
          kind: "text",
          parser: input.parserUsed,
        }));
  const blocks = sourceEntries.flatMap((entry) => {
    const sourceText = String(entry.text ?? "").trim();
    if (!sourceText) return [];
    const canonicalText = canonicalBlockText(entry);
    if (!canonicalText) return [];
    const sentenceLike = canonicalBlockIsSentence(entry);
    return [{
      ...entry,
      sourceText,
      canonicalText,
      diagnosticsBefore: diagnoseNorwegianDocumentText(
        sentenceLike
          ? firstCell(entry.cells, ["kravtekst", "krav", "requirement", "beskrivelse"])
          : sourceText,
        { sentenceLike },
      ),
      diagnosticsAfter: diagnoseNorwegianDocumentText(canonicalText),
    }];
  });
  const sourceDiagnostics = [...new Set(blocks.flatMap((block) => block.diagnosticsBefore))];
  const canonicalDiagnostics = [...new Set(blocks.flatMap((block) => block.diagnosticsAfter))];
  const sourceDiagnosticCount = blocks.reduce(
    (sum, block) => sum + block.diagnosticsBefore.length,
    0,
  );
  const canonicalDiagnosticCount = blocks.reduce(
    (sum, block) => sum + block.diagnosticsAfter.length,
    0,
  );

  return {
    canonicalText: blocks.map((block) => block.canonicalText).join("\n\n"),
    blocks,
    languageQuality: {
      locale: "nb-NO",
      sourcePreserved: true,
      sourceDiagnosticCount,
      canonicalDiagnosticCount,
      repairCount: Math.max(0, sourceDiagnosticCount - canonicalDiagnosticCount),
      score: Number(
        (blocks.length
          ? Math.max(0, 1 - canonicalDiagnosticCount / Math.max(8, blocks.length * 2))
          : 0
        ).toFixed(3),
      ),
      sourceDiagnostics,
      canonicalDiagnostics,
    },
  };
}
