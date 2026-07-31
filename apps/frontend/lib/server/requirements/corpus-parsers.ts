export type {
  RequirementCorpusParserContext,
} from "@/lib/server/requirements/corpus-parser-context";
export {
  buildExplicitIdPdfLayoutRequirementLedger,
  buildExplicitIdTableRequirementLedger,
  // Re-exported for corpus evaluation tooling.
  // fallow-ignore-next-line unused-export
  explicitIdTableSourceIds,
} from "@/lib/server/requirements/explicit-id-table-parser";
export {
  buildExplicitIdPdfNarrativeRequirementLedger,
} from "@/lib/server/requirements/explicit-id-narrative-parser";
export {
  buildPrefixedLineRequirementLedger,
  isLegacyMixedFofingerCorpus,
  repairLegacyFofingerTextArtifacts,
} from "@/lib/server/requirements/legacy-corpus-parser";
export {
  buildGeneratedPdfRequirementLedger,
  buildMixedTextRequirementLedger,
  buildTrustedStructureMapRequirementLedger,
  generatedStructureTextHeading,
  hasLegacyKravFeringStructuredRows,
  isGeneratedFlattenedTableDump,
  isGeneratedKravspesifikasjonCorpus,
  repairGeneratedTextArtifacts,
  stripGeneratedPriorityComment,
} from "@/lib/server/requirements/generated-corpus-parser";
export {
  findRequirementOrderOffset,
  normalizedRequirementOrderSearchText,
} from "@/lib/server/requirements/mixed-corpus-rules";
