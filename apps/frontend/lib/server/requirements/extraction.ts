import "server-only";

import {
  buildRequirementSourceLedgerWithFiles,
  recoverAvailabilityFractionRequirement,
  recoverTruncatedRequirementLedgerEntries,
  recoverTruncatedRequirementLedgerEntryInline,
} from "@/lib/server/ai";
import {
  isLegacyMixedFofingerCorpus,
  repairLegacyFofingerTextArtifacts,
} from "@/lib/server/requirements/corpus-parsers";
import type { ProjectDocumentDetail } from "@/lib/types";

export async function extractRequirementLedgerForDocument(
  document: ProjectDocumentDetail,
): Promise<
  Array<{
    id: string;
    text: string;
    pages: number[];
    heading: string;
    documentTitle?: string;
    tableId?: string;
    service?: string;
    sourceExcerpt?: string;
    answerExcerpt?: string;
  }>
> {
  const ledger = recoverTruncatedRequirementLedgerEntries(
    await buildRequirementSourceLedgerWithFiles(document),
  )
    .map(recoverTruncatedRequirementLedgerEntryInline)
    .map(recoverAvailabilityFractionRequirement);
  if (!isLegacyMixedFofingerCorpus(document)) return ledger;

  return recoverTruncatedRequirementLedgerEntries(
    ledger.map((entry) => ({
      ...entry,
      text: repairLegacyFofingerTextArtifacts(entry.text),
    })),
  )
    .map(recoverTruncatedRequirementLedgerEntryInline)
    .map(recoverAvailabilityFractionRequirement);
}
