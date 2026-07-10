import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

type StructureMapEntry = ProjectDocumentDetail["structure_map"][number];

export type StructureRequirementRowParts = {
  explicitId: string;
  requirementText: string;
  answerText: string;
  responseInstruction: string;
  serviceText: string;
  hasRequirementColumn: boolean;
};

export type RequirementCorpusParserContext = {
  cleanHeadingCandidate(value: string): string;
  dedupeRequirementLedger(
    entries: RequirementLedgerEntry[],
  ): RequirementLedgerEntry[];
  detectExplicitRequirementIds(text: string): string[];
  doclingRequirementRowParts(
    cells: Record<string, string>,
  ): StructureRequirementRowParts;
  doclingRequirementRowSourceExcerpt(cells: Record<string, string>): string;
  hasRequirementSignal(value: string): boolean;
  hasStandaloneRequirementLanguage(value: string): boolean;
  hasStructuredTableCells(entry: StructureMapEntry): boolean;
  isLikelyHeadingLine(line: string): boolean;
  normalizeColumnLabel(value: string): string;
  splitDocumentPagesForRequirementScan(
    document: ProjectDocumentDetail,
  ): Array<{ page: number; text: string }>;
  stripAnswerTextFromRequirement(value: string): string;
  stripRequirementChrome(text: string): string;
  structureEntryCellMap(entry: StructureMapEntry): Record<string, string>;
  structureRequirementFallbackId(
    entry: StructureMapEntry,
    tableId: string,
    sequence: number,
  ): string;
  structureTableId(entry: StructureMapEntry): string;
};
