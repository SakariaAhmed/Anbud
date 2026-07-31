import type { ProjectDocumentStructureEntry } from "@/lib/types";
import {
  canonicalizeNorwegianDocumentText,
  diagnoseNorwegianDocumentText,
  type NorwegianLanguageDiagnostic,
} from "@/lib/server/document-intelligence/norwegian-language";

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
