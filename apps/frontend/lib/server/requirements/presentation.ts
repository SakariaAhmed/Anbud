import "server-only";

import { sortByRequirementOrder } from "@/lib/requirement-order";
import { toMarkdownTableRow } from "@/lib/server/requirements/markdown-table";
import { lastHeadingSegment, normalizeRequirementId } from "@/lib/server/requirements/normalization";
import type { RequirementLedgerEntry } from "@/lib/server/requirements/types";

export function requirementLedgerSource(entry: RequirementLedgerEntry) {
  const pageLabel = requirementPageRange(entry);
  const normalizedId = normalizeRequirementId(entry.id);
  const normalizedTableId = entry.tableId
    ? normalizeRequirementId(entry.tableId)
    : "";
  const normalizedService = entry.service
    ? normalizeRequirementId(entry.service)
    : "";
  const sourceAlreadyDescribesId = Boolean(
    entry.tableId &&
      entry.service &&
      normalizedId.includes(normalizedTableId) &&
      normalizedId.includes(normalizedService),
  );
  const sourceRowReference =
    entry.sourceExcerpt?.match(/\bRad\s+\d{1,4}\b/i)?.[0] ?? "";

  return [
    entry.documentTitle,
    pageLabel,
    requirementReferenceHeadingLabel(entry),
    entry.tableId,
    entry.service,
    sourceRowReference,
    sourceAlreadyDescribesId ? "" : entry.id,
  ]
    .filter(Boolean)
    .join(", ");
}

export function requirementHeadingPath(entry: RequirementLedgerEntry) {
  if (hasCanonicalPdfTableReference(entry)) {
    return [];
  }

  return entry.heading
    .split(">")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => !isPdfHeadingArtifact(part))
    .filter(Boolean);
}

export function requirementPageRange(entry: RequirementLedgerEntry) {
  const pages = [...entry.pages].sort((a, b) => a - b);
  if (!pages.length) {
    return "";
  }

  return pages.length === 1
    ? `Side ${pages[0]}`
    : `Side ${pages[0]}-${pages[pages.length - 1]}`;
}

export function requirementSubtitle(entry: RequirementLedgerEntry) {
  return requirementGroupHeading(entry) || null;
}

export function requirementFullReference(entry: RequirementLedgerEntry) {
  const normalizedId = normalizeRequirementId(entry.id);
  const normalizedTableId = entry.tableId
    ? normalizeRequirementId(entry.tableId)
    : "";
  const normalizedService = entry.service
    ? normalizeRequirementId(entry.service)
    : "";
  const sourceAlreadyDescribesId = Boolean(
    entry.tableId &&
      entry.service &&
      normalizedId.includes(normalizedTableId) &&
      normalizedId.includes(normalizedService),
  );

  return [
    entry.documentTitle,
    requirementPageRange(entry),
    requirementReferenceHeadingLabel(entry),
    entry.tableId,
    entry.service,
    entry.sourceExcerpt?.match(/\bRad\s+\d{1,4}\b/i)?.[0] ?? "",
    sourceAlreadyDescribesId ? "" : entry.id,
  ]
    .filter(Boolean)
    .join(", ");
}

export function sortRequirementLedgerInDocumentOrder(
  entries: RequirementLedgerEntry[],
) {
  return sortByRequirementOrder(entries, (entry, index) => {
    const heading = requirementGroupHeading(entry);
    const stableEntryOrder =
      typeof entry.documentEntryOrder === "number" &&
      Number.isFinite(entry.documentEntryOrder)
        ? entry.documentEntryOrder
        : null;
    return {
      reference: requirementDisplayRef(entry, heading),
      sourceReference: requirementDisplaySource(entry, heading),
      group: heading || entry.tableId || entry.heading,
      documentOrderIndex:
        typeof entry.documentOrder === "number" &&
        Number.isFinite(entry.documentOrder)
          ? entry.documentOrder
          : null,
      entryOrderIndex: stableEntryOrder,
      orderIndex:
        typeof entry.documentOrder === "number" &&
        Number.isFinite(entry.documentOrder)
          ? null
          : stableEntryOrder,
      fallbackIndex: index,
    };
  });
}

export function requirementGroupHeading(entry: RequirementLedgerEntry) {
  if (hasCanonicalPdfTableReference(entry)) {
    return "";
  }

  const heading = lastHeadingSegment(entry.heading);
  if (
    !heading ||
    /^kravtabell$/i.test(heading) ||
    isPdfHeadingArtifact(heading)
  ) {
    return "";
  }

  return heading;
}

function isPdfAnswerSubsectionHeadingArtifact(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (
    /^\d{1,2}\)\s+/.test(text) ||
    /\bLeverandørens\s*svar\b/i.test(text) ||
    /\bLeverandørenssvar\b/i.test(text)
  );
}

function isPdfFooterHeadingArtifact(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (
    /^Konfidensiell$/i.test(text) ||
    /^,?\d+\s*TIL\s*SSA-D\s*\d{4}$/i.test(text) ||
    /^RA-\d+\s*BILAG/i.test(text) ||
    /^Side\s*\d+\s*av\s*\d+$/i.test(text)
  );
}

function isPdfHeadingArtifact(value: string) {
  return (
    isPdfFooterHeadingArtifact(value) ||
    isPdfAnswerSubsectionHeadingArtifact(value) ||
    isPdfTableHeadingArtifact(value) ||
    isPdfTextFragmentHeadingArtifact(value)
  );
}

function cleanRequirementHeadingLabel(value: string) {
  return value
    .split(">")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part && !isPdfHeadingArtifact(part))
    .join(" > ");
}

function hasCanonicalPdfTableReference(entry: RequirementLedgerEntry) {
  return Boolean(
    entry.service &&
      /^Tabell\s+ID\s+\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?/i.test(
        entry.tableId ?? "",
      ),
  );
}

function requirementReferenceHeadingLabel(entry: RequirementLedgerEntry) {
  return hasCanonicalPdfTableReference(entry)
    ? ""
    : cleanRequirementHeadingLabel(entry.heading);
}

function isPdfTableHeadingArtifact(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (
    /\bTabell\s+ID\s+\d{1,3}\s*[-.]\s*\d{1,3}[A-Z]?\b/i.test(text) &&
    /\b(?:krav|Petor|sikkerhetskrav|IT\s*Si)\b/i.test(text)
  );
}

function isPdfTextFragmentHeadingArtifact(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (
    /^D\s*el$/i.test(text) ||
    /^24\/7(?:\/365)?\.?$/i.test(text) ||
    /^30\s+dager\).*/i.test(text)
  );
}

function normalizeRequirementLabel(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripRepeatedRequirementHeading(value: string, heading: string) {
  const text = value.replace(/\s+/g, " ").trim();
  const headingText = heading.replace(/\s+/g, " ").trim();
  if (!text || !headingText) {
    return text;
  }

  if (normalizeRequirementLabel(text) === normalizeRequirementLabel(headingText)) {
    return "";
  }

  if (
    normalizeRequirementLabel(text).startsWith(
      `${normalizeRequirementLabel(headingText)} `,
    )
  ) {
    return text
      .slice(headingText.length)
      .replace(/^\s*[-:,]\s*/, "")
      .trim();
  }

  return text;
}

export function requirementDisplayRef(
  entry: RequirementLedgerEntry,
  heading: string,
) {
  const id = entry.id.replace(/\s+/g, " ").trim();
  const headingText = heading.replace(/\s+/g, " ").trim();
  if (
    !entry.tableId &&
    /^ID\s+\d{1,3}-\d{1,3}[A-Z]?$/i.test(id) &&
    headingText &&
    !isPdfHeadingArtifact(headingText)
  ) {
    return `${id} - ${headingText}`;
  }

  return stripRepeatedRequirementHeading(entry.id, heading) || entry.id;
}

export function requirementDisplaySource(
  entry: RequirementLedgerEntry,
  heading: string,
) {
  return requirementLedgerSource(entry)
    .split(",")
    .map((part) => stripRepeatedRequirementHeading(part.trim(), heading))
    .filter(Boolean)
    .filter(
      (part) =>
        normalizeRequirementLabel(part) !== normalizeRequirementLabel(heading),
    )
    .join(", ");
}

export function requirementTableMarkdown(rows: string[][]) {
  return [
    "| Kravref. | Krav | Svar | Svargrunnlag | Kildegrunnlag |",
    "|---|---|---|---|---|",
    ...rows.map(toMarkdownTableRow),
  ];
}
