import { detectExplicitRequirementIds, explicitRequirementIdPattern, isLikelyStandardsReferenceId } from "@/lib/server/requirements/id-detection";
import { normalizeRequirementId } from "@/lib/server/requirements/normalization";

const technicalPrefixes = new Set(["AES", "SHA", "ISO", "IEC", "EN", "NS", "TLS", "SSL", "HTTP", "UTF", "RFC", "CVE", "CWE", "COVID", "FIPS", "NIST", "WCAG", "GPT", "FHIR", "NIS"]);

export function requirementIdentifierSpans(value: string) {
  const text = value.replace(/[‐‑‒–—]/gu, "-");
  const explicitIds = new Set(detectExplicitRequirementIds(text).map(normalizeRequirementId));
  const broad = [...text.matchAll(/\b[A-ZÆØÅ]{1,8}(?:-[A-ZÆØÅ]{1,8})*-?\d{1,5}(?:\.\d+)*(?:\.[a-z])?\b/g)];
  // A prose line followed by a Markdown bullet is not a compound ID:
  // "P1-leder\n- 1–2 L2-teknikere" must not invent LEDER-1-2.
  const explicit = [...text.matchAll(explicitRequirementIdPattern())].filter(match => !/[\r\n]\s*[-*+]\s/u.test(match[0]) && explicitIds.has(normalizeRequirementId(match[0])));
  // Prefer the complete, supported ID at each position. A prefix inside
  // ID2-14 or P001-REQ-03 must not become a second, invented identifier.
  const occurrences = [...broad, ...explicit].map(match => ({ id: normalizeRequirementId(match[0]), start: match.index, end: match.index + match[0].length }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const ids: Array<{ id: string; start: number; end: number }> = [];
  let end = -1;
  for (const occurrence of occurrences) {
    if (occurrence.start < end) continue;
    ids.push(occurrence);
    end = occurrence.end;
  }
  return ids;
}

export function extractRequirementIdentifiers(value: string) {
  return Array.from(new Set(requirementIdentifierSpans(value).map(span => span.id).filter(id => !isLikelyStandardsReferenceId(id) && !technicalPrefixes.has(id.match(/^[A-ZÆØÅ]+/u)?.[0] ?? ""))));
}

/** These are ordinary service/product/time labels unless a register explicitly
 * gives them requirement authority. They remain exact lexical search terms. */
export function isAmbiguousRequirementIdentifier(id: string) {
  return /^(?:P[0-5]|Q[1-4]|L[1-4]|[MDEFA]365|[EF][1-9]|(?:AZ|SC|MS|DP|AI|PL|MD|MB)-\d{3})$/u.test(id);
}

export function extractExactRetrievalTerms(value: string) {
  return Array.from(new Set([
    ...requirementIdentifierSpans(value).map(span => span.id),
    ...[...value.matchAll(/\b(?:SSA-[A-Z]|SLA|RTO|RPO|GDPR|DPIA|ISO\s*27001|NSM|WCAG)\b/gi)].map(match => match[0].replace(/\s+/g, " ").trim()),
  ])).slice(0, 12);
}
