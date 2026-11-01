import "server-only";

import { isFormalRequirementDocument, isRequirementDocument } from "@/lib/document-processing";

import { detectExplicitRequirementIds } from "@/lib/server/requirements/id-detection";
import { meetsSmallRequirementTextMinimum, normalizeRequirementId } from "@/lib/server/requirements/normalization";

import { type RequirementLedgerConfidence } from "@/lib/server/ai/requirement-coverage";
import { correctedRequirementIds, withoutCorrectionsSection } from "@/lib/server/requirements/corrections";
import { isGeneratedRequirementId } from "@/lib/server/requirements/pdf-layout-ledger";
import { isReliableRequirementLedger } from "@/lib/server/requirements/source-ledger";
import { allRequirementsWithdrawn } from "@/lib/server/requirements/source-readiness";
import { spreadsheetRequirementIds } from "@/lib/server/requirements/spreadsheet-ledger";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";
import type { ProjectDocumentDetail } from "@/lib/types";

function ratio(part: number, total: number) {
  return total > 0 ? part / total : 0;
}

function roundedRatio(value: number) {
  return Math.round(value * 100) / 100;
}

function requirementLedgerEntryHasLocator(entry: RequirementLedgerEntry) {
  return Boolean(
    entry.sourceExcerpt ||
      entry.tableId ||
      entry.heading ||
      (Array.isArray(entry.pages) && entry.pages.length > 0),
  );
}

function requirementLedgerEntryIsStructured(entry: RequirementLedgerEntry) {
  return Boolean(
    entry.tableId ||
      entry.sourceExcerpt ||
      entry.answerExcerpt ||
      entry.pages.length > 0,
  );
}

function normalizedExplicitCompletenessId(value: string) {
  return normalizeRequirementId(value)
    .replace(/^TABELL\s+/i, "")
    .replace(/[^A-Z0-9ÆØÅ]+/gi, "")
    .toLocaleUpperCase("nb");
}

export function hasExplicitlyCompleteSmallRequirementLedger(input: {
  ledger: RequirementLedgerEntry[];
  requirementDocuments: ProjectDocumentDetail[];
}) {
  if (
    input.ledger.length === 0 ||
    input.ledger.length > 4 ||
    input.requirementDocuments.length === 0
  ) {
    return false;
  }

  const requirementDocumentIds = new Set(
    input.requirementDocuments.map((document) => document.id),
  );
  if (
    input.ledger.some(
      (entry) => !entry.documentId || !requirementDocumentIds.has(entry.documentId),
    )
  ) {
    return false;
  }

  return input.requirementDocuments.every((document) => {
    const documentEntries = input.ledger.filter(
      (entry) => entry.documentId === document.id,
    );
    const sourceIds = spreadsheetRequirementIds(document);
    const detectedIds = correctedRequirementIds(
      sourceIds.length ? sourceIds : detectExplicitRequirementIds(withoutCorrectionsSection(document.raw_text)),
      document.raw_text,
    )
      .map(normalizedExplicitCompletenessId)
      .filter(Boolean);
    if (!documentEntries.length) {
      // Generation also includes the primary customer as context for the
      // formal register. An ID-free context document contributes no explicit
      // rows to verify; the separate formal source must still pass every
      // completeness and row-quality check below.
      return allRequirementsWithdrawn(document) || (
        document.role === "primary_customer_document" &&
        detectedIds.length === 0 &&
        input.requirementDocuments.some((source) =>
          isFormalRequirementDocument(source) &&
          input.ledger.some((entry) => entry.documentId === source.id),
        )
      );
    }
    if (detectedIds.length !== documentEntries.length) {
      return false;
    }

    const remainingIds = [...detectedIds];
    return documentEntries.every((entry) => {
      if (
        isGeneratedRequirementId(entry.id) ||
        !requirementLedgerEntryHasLocator(entry) ||
        !requirementLedgerEntryIsStructured(entry) ||
        !meetsSmallRequirementTextMinimum(entry.text)
      ) {
        return false;
      }

      const candidates = [entry.id, entry.tableId ?? ""]
        .map(normalizedExplicitCompletenessId)
        .filter(Boolean);
      const detectedIndex = remainingIds.findIndex((detectedId) =>
        candidates.includes(detectedId),
      );
      if (detectedIndex < 0) {
        return false;
      }

      remainingIds.splice(detectedIndex, 1);
      return true;
    });
  });
}

function requirementLedgerExtractionMethods(entries: RequirementLedgerEntry[]) {
  const methods = new Set<string>();
  for (const entry of entries) {
    const source = `${entry.tableId ?? ""} ${entry.heading ?? ""}`;
    if (/docling/i.test(source)) methods.add("docling");
    if (/docx/i.test(source)) methods.add("docx-table");
    if (/strukturert/i.test(source)) methods.add("structured-table");
    if (entry.sourceExcerpt) methods.add("source-excerpt");
    if (entry.pages.length) methods.add("page-locator");
  }

  return Array.from(methods).sort();
}

export function assessRequirementLedgerConfidence(input: {
  ledger: RequirementLedgerEntry[];
  hasExplicitRequirementDocuments: boolean;
  requirementDocuments: ProjectDocumentDetail[];
}): RequirementLedgerConfidence {
  const count = input.ledger.length;
  const locatorCoverage = ratio(
    input.ledger.filter(requirementLedgerEntryHasLocator).length,
    count,
  );
  const structuredRatio = ratio(
    input.ledger.filter(requirementLedgerEntryIsStructured).length,
    count,
  );
  const generatedReferenceCount = input.ledger.filter((entry) =>
    isGeneratedRequirementId(entry.id),
  ).length;
  const explicitReferenceRatio = ratio(count - generatedReferenceCount, count);
  const countScore =
    count >= 20 ? 1 : count >= 8 ? 0.75 : count >= 5 ? 0.5 : count > 0 ? 0.25 : 0;
  const score = roundedRatio(
    countScore * 0.35 +
      locatorCoverage * 0.35 +
      structuredRatio * 0.2 +
      explicitReferenceRatio * 0.1,
  );
  const hasRequirementDocumentSignal =
    input.hasExplicitRequirementDocuments ||
    input.requirementDocuments.some(isRequirementDocument);
  const explicitlyCompleteSmallLedger =
    hasExplicitlyCompleteSmallRequirementLedger({
      ledger: input.ledger,
      requirementDocuments: input.requirementDocuments,
    });
  const reasons: string[] = [];

  if (count === 0) reasons.push("no_requirements_found");
  if (isReliableRequirementLedger(input.ledger)) reasons.push("reliable_ledger_shape");
  if (hasRequirementDocumentSignal) reasons.push("requirement_document_selected");
  if (locatorCoverage >= 0.9) reasons.push("source_locators_present");
  if (locatorCoverage < 0.6) reasons.push("weak_source_locator_coverage");
  if (structuredRatio >= 0.7) reasons.push("structured_rows_present");
  if (generatedReferenceCount > 0) reasons.push("generated_requirement_refs");
  if (explicitlyCompleteSmallLedger) {
    reasons.push("explicitly_complete_small_ledger");
  }

  const level =
    explicitlyCompleteSmallLedger && score >= 0.7
      ? "medium"
      : count >= 8 && locatorCoverage >= 0.85 && score >= 0.7
      ? "high"
      : count >= 5 && locatorCoverage >= 0.6 && score >= 0.55
        ? "medium"
        : "low";

  return {
    level,
    score,
    requirement_count: count,
    source_locator_coverage: roundedRatio(locatorCoverage),
    structured_entry_ratio: roundedRatio(structuredRatio),
    explicit_reference_ratio: roundedRatio(explicitReferenceRatio),
    generated_reference_count: generatedReferenceCount,
    extraction_methods: requirementLedgerExtractionMethods(input.ledger),
    reasons,
  };
}
