import {
  documentRequirementId,
  normalizePageText,
  normalizePdfSpacing,
} from "@/lib/server/requirements/pdf-normalization";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";

const COMPOUND_REQUIREMENT_ID =
  String.raw`\b[A-ZÆØÅ]{2,8}\s*-\s*[A-ZÆØÅ]{1,4}\s*[- ]?\d{1,5}[A-Z]?\b`;
const PREFIXED_REQ_ID =
  String.raw`\b[A-ZÆØÅ0-9]{2,12}\s*[- ]\s*REQ\s*[- ]\s*\d{1,5}[A-Z]?\b`;
const PROJECT_REQUIREMENT_ID = String.raw`\bP\d{3}\s*[- ]\s*\d{1,5}[A-Z]?\b`;
const POINT_REQUIREMENT_ID =
  String.raw`\bPkt\s*[- ]?\s*\d{1,5}(?=\s|[A-ZÆØÅ(]|$|[-:.;\]])`;
const SHORT_REQUIREMENT_ID =
  String.raw`\b(?:KRAV|KR|K|R|TEK)\s*[- ]?\s*\d{1,5}(?:\s*[.-]\s*\d{1,5})?(?:[A-ZÆØÅ](?=\s|$|[-:.;\]]))?(?=\s|[A-ZÆØÅ(]|$|[-:.;\]])`;
const K_REQUIREMENT_ID =
  String.raw`\bK\s*[- ]?\s*\d{2,5}(?=\s|[A-ZÆØÅ(]|$|[-:.;])`;
const TABLE_REQUIREMENT_ID =
  String.raw`\bID\s*\d{1,3}(?:\s*[.-]\s*\d{1,3}){1,5}[A-Z]?\b`;
const REQ_REQUIREMENT_ID = String.raw`\bREQ\s*[- ]?\s*\d{1,5}[A-Z]?\b`;
const SLASH_REQUIREMENT_ID = String.raw`\b\d{2,4}\s*/\s*\d{1,3}\b`;
const SHORT_ALPHANUMERIC_TABLE_ID =
  String.raw`\b[A-ZÆØÅ]\d?\s*-\s*\d{1,3}\b`;
const DOTTED_PREFIX_REQUIREMENT_ID =
  String.raw`\b[A-ZÆØÅ]{2,8}\s*\.\s*\d{1,3}(?:\s*\.\s*\d{1,3}){1,5}[A-Z]?\b`;
const SECTION_LIKE_REQUIREMENT_ID =
  String.raw`\b(?:[A-ZÆØÅ]{1,5}\s*)?\d{1,3}(?:\s*[.-]\s*\d{1,3}){1,5}[A-Z]?\b`;

function requirementIdPattern() {
  return new RegExp(
    [
      String.raw`\bKrav\s*(?:nr\.?|nummer)?\s*\d{1,3}(?:\s*[.-]\s*\d{1,3}){0,5}[A-Z]?\b`,
      COMPOUND_REQUIREMENT_ID,
      PREFIXED_REQ_ID,
      PROJECT_REQUIREMENT_ID,
      POINT_REQUIREMENT_ID,
      SHORT_REQUIREMENT_ID,
      K_REQUIREMENT_ID,
      TABLE_REQUIREMENT_ID,
      REQ_REQUIREMENT_ID,
      SLASH_REQUIREMENT_ID,
      SHORT_ALPHANUMERIC_TABLE_ID,
      DOTTED_PREFIX_REQUIREMENT_ID,
      SECTION_LIKE_REQUIREMENT_ID,
    ].join("|"),
    "gi",
  );
}

export function explicitRequirementIdPattern() {
  return new RegExp(
    [
      String.raw`\bKrav\s*(?:nr\.?|nummer)?\s*\d{1,3}(?:\s*[.-]\s*\d{1,3}){0,5}[A-Z]?\b`,
      COMPOUND_REQUIREMENT_ID,
      PREFIXED_REQ_ID,
      PROJECT_REQUIREMENT_ID,
      POINT_REQUIREMENT_ID,
      SHORT_REQUIREMENT_ID,
      K_REQUIREMENT_ID,
      TABLE_REQUIREMENT_ID,
      REQ_REQUIREMENT_ID,
      SLASH_REQUIREMENT_ID,
      SHORT_ALPHANUMERIC_TABLE_ID,
      DOTTED_PREFIX_REQUIREMENT_ID,
    ].join("|"),
    "gi",
  );
}

function isTableColumnHeaderRequirementMarker(markerPrefix: string) {
  return /\bSpesifiserte\s*$/i.test(normalizePdfSpacing(markerPrefix));
}

function isTableTitleRequirementMarker(markerPrefix: string) {
  return /\bTabell\s*$/i.test(normalizePdfSpacing(markerPrefix));
}

export function isTableOrColumnHeaderRequirementMarker(markerPrefix: string) {
  return (
    isTableTitleRequirementMarker(markerPrefix) ||
    isTableColumnHeaderRequirementMarker(markerPrefix)
  );
}

function isLikelyStandardsReferenceId(value: string) {
  const compact = value.toUpperCase().replace(/[\s._-]+/g, "");
  return /^(?:ISO|IEC|NS|EN|RFC|AES|TLS|SSL|SHA|HTTP|HTTPS|SAML|OIDC|NIST|CIS|OWASP)\d/.test(
    compact,
  );
}

function detectIds(text: string, pattern: RegExp) {
  const normalized = normalizePageText(text);
  const ids: string[] = [];

  for (const match of normalized.matchAll(pattern)) {
    const markerStart = match.index ?? 0;
    const markerPrefix = normalized.slice(
      Math.max(0, markerStart - 24),
      markerStart,
    );
    if (isTableOrColumnHeaderRequirementMarker(markerPrefix)) {
      continue;
    }

    const id = documentRequirementId(match[0]);
    if (isLikelyStandardsReferenceId(id)) {
      continue;
    }

    const normalizedId = normalizeRequirementId(id);
    if (!ids.some((existing) => normalizeRequirementId(existing) === normalizedId)) {
      ids.push(id);
    }
  }

  return ids;
}

export function detectRequirementIds(text: string) {
  return detectIds(text, requirementIdPattern());
}

export function detectExplicitRequirementIds(text: string) {
  return detectIds(text, explicitRequirementIdPattern());
}
