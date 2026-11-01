import "server-only";

import { tokenizeComparableText } from "@/lib/server/document-intelligence/text-normalization";

import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

const REQUIREMENT_RETRIEVAL_STOP_WORDS = new Set([
  "atea",
  "eller",
  "etter",
  "for",
  "fra",
  "gjennom",
  "hvor",
  "ikke",
  "innen",
  "krav",
  "kravet",
  "kunde",
  "kunden",
  "kunne",
  "med",
  "mot",
  "skal",
  "som",
  "the",
  "til",
  "ved",
]);

export function requirementRetrievalTokens(entries: RequirementLedgerEntry[]) {
  const tokens = entries.flatMap((entry) =>
    tokenizeComparableText(`${entry.id} ${entry.text} ${entry.heading}`),
  );

  return Array.from(
    new Set(
      tokens
        .filter((token) => token.length >= 4)
        .filter((token) => !REQUIREMENT_RETRIEVAL_STOP_WORDS.has(token))
        .slice(0, 140),
    ),
  );
}

export function coverageEvidenceLinkTokens(value: string) {
  return new Set(
    tokenizeComparableText(value)
      .filter((token) => token.length >= 4)
      .filter((token) => !REQUIREMENT_RETRIEVAL_STOP_WORDS.has(token)),
  );
}
